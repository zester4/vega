/**
 * ============================================================================
 * src/routes/workflow-events.ts — Workflow Event Bus
 * ============================================================================
 *
 * This route enables the waitForEvent / notify pattern in Upstash Workflow.
 * Any external trigger (Telegram reply, webhook, cron, other agent) can
 * wake a sleeping workflow by publishing an event here.
 *
 * Routes:
 *   POST /workflow/notify      — Wake a workflow waiting for an eventId
 *   POST /workflow/resume-dlq  — Scan DLQ and resume failed workflows
 *
 * How the pause/resume cycle works:
 *   1. Agent calls wait_for_user_input("What's your budget?")
 *   2. Tool sends question to Telegram, stores: tg:awaiting-workflow:{chatId}
 *      = { eventId: "...", taskId: "...", sessionId: "..." }
 *   3. workflow.ts calls: context.waitForEvent("pause-iter-N", eventId, {timeout:"7d"})
 *      → Worker exits entirely, ZERO CPU held
 *   4. User replies on Telegram
 *   5. telegram.ts processMessage detects tg:awaiting-workflow:{chatId}
 *   6. Calls POST /workflow/notify { eventId, eventData: { text: "my budget..." } }
 *   7. This route calls: client.notify({ eventId, eventData })
 *   8. QStash re-invokes the workflow at the exact waitForEvent step
 *   9. Agent receives the user's reply and continues
 *
 * ADD TO src/index.ts:
 *   import { workflowEventsRoute } from "./routes/workflow-events"
 *   app.route("/workflow", workflowEventsRoute)
 *
 * ============================================================================
 */

import { Hono } from "hono";
import { Client as WorkflowClient } from "@upstash/workflow";
import { Client as QStashClient } from "@upstash/qstash";
import { getRedis } from "../memory";

const app = new Hono<{ Bindings: Env }>();

// ─── POST /workflow/notify ────────────────────────────────────────────────────
// Wake a workflow run that is sleeping inside context.waitForEvent().
// Protected by x-internal-secret (same as Telegram proxy secret).

app.post("/notify", async (c) => {
    const secret = c.req.header("x-internal-secret");
    const internalSecret = c.env.TELEGRAM_INTERNAL_SECRET;
    if (internalSecret && secret !== internalSecret) {
        return c.json({ error: "Unauthorized" }, 401);
    }

    let body: { eventId: string; eventData?: unknown };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    const { eventId, eventData } = body;
    if (!eventId) {
        return c.json({ error: "eventId is required" }, 400);
    }

    try {
        // Use the Workflow Client to notify the waiting workflow
        const client = new WorkflowClient({ token: c.env.QSTASH_TOKEN });

        const result = await client.notify({ eventId, eventData: eventData ?? {} });

        const notified = (result as any).waiters?.length ?? 0;
        console.log(`[WorkflowEvents] Notified eventId: ${eventId} — ${notified} waiters woken`);

        // If no workflow was waiting yet, retry once after 3s
        // (handles race condition where Telegram reply arrives before workflow suspends)
        if (notified === 0) {
            console.log(`[WorkflowEvents] No waiters for ${eventId} — will retry in 3s`);
            // Publish a delayed retry via QStash
            const workerBase = (c.env.WORKER_URL ?? c.env.UPSTASH_WORKFLOW_URL ?? "").replace(/\/$/, "");
            const qstash = new QStashClient({
                token: c.env.QSTASH_TOKEN,
                baseUrl: c.env.QSTASH_URL,
            });
            await qstash.publishJSON({
                url: `${workerBase}/workflow/notify`,
                body: { eventId, eventData: eventData ?? {} },
                headers: { "x-internal-secret": internalSecret ?? "" },
                delay: "3s",
            }).catch((e) => console.warn("[WorkflowEvents] Retry schedule failed:", String(e)));
        }

        return c.json({ ok: true, woken: notified, retryScheduled: notified === 0 });
    } catch (e) {
        console.error("[WorkflowEvents] notify error:", String(e));
        return c.json({ error: String(e) }, 500);
    }
});

// ─── POST /workflow/resume-dlq ────────────────────────────────────────────────
// Scan the QStash Dead Letter Queue for failed workflows and resume them.
// Safe to call as a cron job — idempotent, retries only genuinely failed steps.
// Protected by x-internal-secret.

app.post("/resume-dlq", async (c) => {
    const secret = c.req.header("x-internal-secret");
    const internalSecret = c.env.TELEGRAM_INTERNAL_SECRET;
    if (internalSecret && secret !== internalSecret) {
        return c.json({ error: "Unauthorized" }, 401);
    }

    try {
        const client = new WorkflowClient({ token: c.env.QSTASH_TOKEN });
        const redis = getRedis(c.env);

        const { messages } = await (client as any).dlq.list();
        if (!messages?.length) {
            return c.json({ ok: true, resumed: 0, message: "DLQ is empty" });
        }

        let resumed = 0;
        let skipped = 0;

        for (const msg of messages.slice(0, 20)) { // Process up to 20 at a time
            const dlqId = msg.dlqId as string;
            const skipKey = `dlq:skipped:${dlqId}`;

            // Don't retry messages we've already marked as permanently failed
            const alreadySkipped = await redis.get(skipKey).catch(() => null);
            if (alreadySkipped) { skipped++; continue; }

            try {
                await (client as any).dlq.resume({ dlqId, retries: 3 });
                resumed++;
                console.log(`[WorkflowEvents] Resumed DLQ message: ${dlqId}`);
            } catch (resumeErr) {
                // Mark as permanently failed after resume error
                await redis.set(skipKey, "1", { ex: 60 * 60 * 24 * 7 }).catch(() => { });
                skipped++;
                console.warn(`[WorkflowEvents] Could not resume ${dlqId}: ${String(resumeErr)}`);
            }
        }

        console.log(`[WorkflowEvents] DLQ scan: ${resumed} resumed, ${skipped} skipped`);
        return c.json({ ok: true, resumed, skipped, total: messages.length });
    } catch (e) {
        console.error("[WorkflowEvents] DLQ scan error:", String(e));
        return c.json({ error: String(e) }, 500);
    }
});

// ─── POST /workflow/status/:taskId ────────────────────────────────────────────
// Check if a workflow task is currently paused waiting for an event.

app.get("/paused/:chatId", async (c) => {
    const secret = c.req.header("x-internal-secret");
    const internalSecret = c.env.TELEGRAM_INTERNAL_SECRET;
    if (internalSecret && secret !== internalSecret) {
        return c.json({ error: "Unauthorized" }, 401);
    }

    const chatId = c.req.param("chatId");
    const redis = getRedis(c.env);
    const waiting = await redis.get(`tg:awaiting-workflow:${chatId}`).catch(() => null);

    return c.json({ paused: !!waiting, data: waiting ?? null });
});

export default app;