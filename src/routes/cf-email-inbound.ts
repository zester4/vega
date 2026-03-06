/**
 * ============================================================================
 * src/routes/cf-email-inbound.ts — Cloudflare Email Inbound Agent
 * ============================================================================
 *
 * FEATURE NAME: "CF Email Inbound" (distinct from existing Resend-based outbound).
 * Outbound email (send_email tool) continues to use Resend — unchanged.
 * This file handles INCOMING email only.
 *
 * How it works:
 *   1. User sets up a custom address, e.g. vega@yourdomain.com, in Cloudflare
 *      Email Routing dashboard → Email Workers → route to this Worker.
 *   2. Every inbound email fires this Worker's email() handler (added to index.ts).
 *   3. Handler:
 *      a. Parses the email with postal-mime (subject, text, html, attachments).
 *      b. Looks up the sender's email in D1 → maps to a VEGA userId.
 *         (Users register their sending address via /cf-email/register endpoint.)
 *      c. Dispatches the email as a VEGA task via QStash so the agent loop
 *         processes it asynchronously (avoids CF's 10s email handler timeout).
 *      d. Sends an immediate ACK reply via CF's EmailMessage API so the user
 *         knows their message was received.
 *   4. QStash invokes POST /cf-email/process → runAgent() with the email as context.
 *   5. Agent's reply is sent back to the user via the existing Resend send_email tool
 *      (keeping Resend for reliability on outbound).
 *
 * wrangler.toml additions required:
 *   # CF Email send binding (for ACK replies — separate from Resend)
 *   [[send_email]]
 *   name = "CF_EMAIL_SENDER"
 *   # No destination_address = can send to any verified address
 *
 * npm install:
 *   npm install postal-mime
 *
 * Routes:
 *   POST /cf-email/register   — register a sender email for a VEGA userId
 *   DELETE /cf-email/register — unregister
 *   GET  /cf-email/senders    — list registered senders for a user
 *   POST /cf-email/process    — QStash-invoked endpoint to run agent on email
 *
 * ============================================================================
 */

import { Hono } from "hono";
import { Receiver } from "@upstash/qstash";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CfEmailSenderRow = {
    id: string;
    user_id: string;
    sender_email: string;    // lowercased, trimmed
    label: string | null;    // e.g. "Personal", "Work"
    active: number;          // 1 = active, 0 = paused
    registered_at: string;
};

export type CfEmailTaskPayload = {
    userId: string;
    sessionId: string;
    from: string;
    subject: string;
    textBody: string;
    htmlBody: string | null;
    attachmentNames: string[];
    receivedAt: string;
    messageId: string | null;
};

// ─── D1 Helpers ───────────────────────────────────────────────────────────────

async function getSenderByEmail(
    db: D1Database,
    senderEmail: string
): Promise<CfEmailSenderRow | null> {
    return db
        .prepare(
            "SELECT * FROM cf_email_senders WHERE sender_email = ? AND active = 1 LIMIT 1"
        )
        .bind(senderEmail.toLowerCase().trim())
        .first<CfEmailSenderRow>();
}

async function listSendersByUserId(
    db: D1Database,
    userId: string
): Promise<CfEmailSenderRow[]> {
    const result = await db
        .prepare(
            "SELECT * FROM cf_email_senders WHERE user_id = ? ORDER BY registered_at DESC"
        )
        .bind(userId)
        .all<CfEmailSenderRow>();
    return result.results ?? [];
}

// ─── CF Email Handler (export for index.ts) ───────────────────────────────────

/**
 * The email() handler for the CF Worker.
 * Wire in index.ts:
 *
 *   import { handleCfEmailInbound } from "./routes/cf-email-inbound";
 *   export default {
 *     ...app,
 *     email: handleCfEmailInbound,
 *   };
 *
 * NOTE: CF's email handler has a ~10s wall-clock budget. We do minimal work
 * here and dispatch the actual agent task to QStash immediately.
 */
export async function handleCfEmailInbound(
    message: {
        from: string;
        to: string;
        raw: ReadableStream;
        headers: Headers;
        forward: (addr: string) => Promise<void>;
        reply: (msg: unknown) => Promise<void>;
        setReject: (reason: string) => void;
    },
    env: Env,
    ctx: ExecutionContext
): Promise<void> {
    const receivedAt = new Date().toISOString();

    try {
        // ── 1. Parse the email ────────────────────────────────────────────────
        const PostalMime = (await import("postal-mime")).default;
        const parser = new PostalMime();
        const email = await parser.parse(message.raw);

        const from = (email.from?.address ?? message.from).toLowerCase().trim();
        const subject = email.subject ?? "(no subject)";
        const textBody = email.text ?? "";
        const htmlBody = email.html ?? null;
        const attachments = email.attachments ?? [];
        const messageId = email.messageId ?? null;

        console.log(`[CF Email Inbound] from=${from}, subject="${subject}"`);

        // ── 2. Look up VEGA user by sender email ──────────────────────────────
        const senderRow = await getSenderByEmail(env.DB, from);
        if (!senderRow) {
            // Unknown sender — reject or forward to a catch-all
            console.warn(`[CF Email Inbound] Unknown sender: ${from} — rejecting`);
            message.setReject("Sender not registered with VEGA. Visit VEGA to register your email address.");
            return;
        }

        const userId = senderRow.user_id;
        const sessionId = `email-${userId}-${Date.now()}`;

        // ── 3. Queue the agent task via QStash ───────────────────────────────
        const workerUrl = (env as any).WORKER_URL ?? "";
        if (!workerUrl) {
            console.error("[CF Email Inbound] WORKER_URL not set — cannot dispatch task");
            return;
        }

        const payload: CfEmailTaskPayload = {
            userId,
            sessionId,
            from,
            subject,
            textBody: textBody.slice(0, 10_000), // cap at 10k chars
            htmlBody: htmlBody ? htmlBody.slice(0, 20_000) : null,
            attachmentNames: attachments.map((a) => a.filename ?? "attachment"),
            receivedAt,
            messageId,
        };

        const qstashUrl = (env as any).QSTASH_URL ?? "https://qstash.upstash.io";
        const qstashToken = (env as any).QSTASH_TOKEN ?? "";

        // Use ctx.waitUntil so QStash publish doesn't race with the ACK reply
        ctx.waitUntil(
            fetch(`${qstashUrl}/v2/publish/${workerUrl}/cf-email/process`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${qstashToken}`,
                    "Content-Type": "application/json",
                    // Retry up to 3 times if agent fails
                    "Upstash-Retries": "3",
                    "Upstash-Retry-After": "30",
                },
                body: JSON.stringify(payload),
            }).catch((e) => console.warn("[CF Email Inbound] QStash dispatch failed:", String(e)))
        );

        // ── 4. Send immediate ACK reply ───────────────────────────────────────
        // Uses CF's native EmailMessage for the ACK, keeping Resend for substantive replies.
        try {
            const { EmailMessage } = await import("cloudflare:email");
            const { createMimeMessage } = await import("mimetext");

            const ackMsg = createMimeMessage();
            ackMsg.setSender({
                addr: message.to,
                name: "VEGA Agent",
            });
            ackMsg.setRecipient(message.from);
            ackMsg.setSubject(`Re: ${subject}`);
            ackMsg.addMessage({
                contentType: "text/plain",
                data:
                    `Hi! I received your email and I'm working on it.\n\n` +
                    `Subject: ${subject}\n` +
                    `Received: ${receivedAt}\n\n` +
                    `I'll reply when I'm done. You can also check progress at VEGA.\n\n` +
                    `— VEGA 🤖`,
            });

            const ackEmail = new EmailMessage(message.to, message.from, ackMsg.asRaw());
            await (env as any).CF_EMAIL_SENDER.send(ackEmail);
        } catch (ackErr) {
            // ACK failure is non-fatal — task is already queued
            console.warn("[CF Email Inbound] ACK send failed:", String(ackErr));
        }
    } catch (err) {
        console.error("[CF Email Inbound] Handler failed:", String(err));
        // Don't reject on parse errors — the email arrived, we just failed to process it
    }
}

// ─── POST /cf-email/process — QStash-invoked agent runner ────────────────────

async function processCfEmailTask(
    env: Env,
    payload: CfEmailTaskPayload
): Promise<void> {
    const { runAgent } = await import("../agent");

    const prompt =
        `You received an email from ${payload.from}.\n\n` +
        `Subject: ${payload.subject}\n` +
        `Received: ${payload.receivedAt}\n\n` +
        `--- Email Body ---\n${payload.textBody}\n` +
        (payload.attachmentNames.length > 0
            ? `\nAttachments: ${payload.attachmentNames.join(", ")}`
            : "") +
        `\n---\n\n` +
        `Please read this email and respond appropriately. ` +
        `When you're ready to reply, use the send_email tool to send your response to ${payload.from} ` +
        `with subject "Re: ${payload.subject}". ` +
        `Be concise and helpful. Sign your reply as "VEGA 🤖".`;

    const reply = await runAgent(env, payload.sessionId, prompt);

    console.log(
        `[CF Email Process] ${payload.userId} — subject: "${payload.subject}" — reply: ${reply.slice(0, 100)}...`
    );
}

// ─── Hono Routes ──────────────────────────────────────────────────────────────

const cfEmailRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /cf-email/register
 * Register a sender email address for a VEGA userId.
 * Body: { sender_email, label? }
 */
cfEmailRoutes.post("/register", async (c) => {
    const userId = c.req.header("X-User-Id")?.trim();
    if (!userId) return c.json({ error: "X-User-Id required" }, 401);

    const body = await c.req.json<{ sender_email: string; label?: string }>();
    if (!body.sender_email) return c.json({ error: "sender_email required" }, 400);

    const normalized = body.sender_email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        return c.json({ error: "Invalid email address" }, 400);
    }

    await c.env.DB.prepare(
        `INSERT INTO cf_email_senders (id, user_id, sender_email, label, active, registered_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT (sender_email) DO UPDATE SET
       user_id = excluded.user_id,
       label = excluded.label,
       active = 1`
    ).bind(
        crypto.randomUUID(),
        userId,
        normalized,
        body.label ?? null,
        new Date().toISOString()
    ).run();

    return c.json({
        ok: true,
        sender_email: normalized,
        message: `Emails from ${normalized} will now be routed to VEGA.`,
    });
});

/** DELETE /cf-email/register — unregister a sender address */
cfEmailRoutes.delete("/register", async (c) => {
    const userId = c.req.header("X-User-Id")?.trim();
    if (!userId) return c.json({ error: "X-User-Id required" }, 401);

    const body = await c.req.json<{ sender_email: string }>();
    if (!body.sender_email) return c.json({ error: "sender_email required" }, 400);

    await c.env.DB.prepare(
        "UPDATE cf_email_senders SET active = 0 WHERE user_id = ? AND sender_email = ?"
    ).bind(userId, body.sender_email.toLowerCase().trim()).run();

    return c.json({ ok: true });
});

/** GET /cf-email/senders — list registered sender addresses for a user */
cfEmailRoutes.get("/senders", async (c) => {
    const userId = c.req.header("X-User-Id")?.trim();
    if (!userId) return c.json({ error: "X-User-Id required" }, 401);

    const senders = await listSendersByUserId(c.env.DB, userId);
    return c.json({ senders });
});

/**
 * POST /cf-email/process — QStash-invoked
 * Verify QStash signature, run the agent on the email task.
 */
cfEmailRoutes.post("/process", async (c) => {
    // Verify this came from QStash
    const receiver = new Receiver({
        currentSigningKey: c.env.QSTASH_CURRENT_SIGNING_KEY,
        nextSigningKey: c.env.QSTASH_NEXT_SIGNING_KEY,
    });

    const body = await c.req.text();
    const isValid = await receiver
        .verify({
            signature: c.req.header("upstash-signature") ?? "",
            body,
            url: `${c.env.WORKER_URL}/cf-email/process`,
        })
        .catch(() => false);

    if (!isValid) {
        return c.json({ error: "Invalid QStash signature" }, 401);
    }

    const payload = JSON.parse(body) as CfEmailTaskPayload;

    // Run async — return 200 immediately so QStash doesn't retry
    c.executionCtx.waitUntil(
        processCfEmailTask(c.env, payload).catch((e) =>
            console.error("[CF Email Process] Agent failed:", String(e))
        )
    );

    return c.json({ ok: true, queued: true });
});

export default cfEmailRoutes;