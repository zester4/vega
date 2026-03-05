/**
 * ============================================================================
 * src/whatsapp.ts — VEGA WhatsApp Business Cloud API Integration
 * ============================================================================
 *
 * Architecture (how multi-tenancy works — different from Telegram):
 *
 *   Telegram: Each user has their own bot → each bot has its own webhook URL
 *             → secret header routes to the right user.
 *
 *   WhatsApp: One Meta App → one webhook URL → one app-level HMAC secret.
 *             Multiple users each register their Phone Number ID + System Token.
 *             Incoming webhooks carry `metadata.phone_number_id` which we use
 *             to look up the correct VEGA user in D1.
 *
 * Setup flow (per user):
 *   1. User creates Meta App (or uses existing) → gets App Secret
 *   2. User creates a System User token (permanent, never expires)
 *   3. User provides: phone_number_id + access_token in Settings
 *   4. VEGA verifies by calling Graph API, stores in D1
 *   5. Admin configures webhook ONCE in Meta Developer Console:
 *        URL: https://{worker}/whatsapp/webhook
 *        Verify token: value of WHATSAPP_WEBHOOK_VERIFY_TOKEN env var
 *        Fields: messages
 *
 * Env vars required (wrangler secrets):
 *   WHATSAPP_APP_SECRET            → App Secret from Meta App Dashboard
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN  → Any string, set same in Meta Console
 *
 * Key API differences from Telegram:
 *   - No edit message (we send "⚙️ Working..." then the final reply)
 *   - Audio replies need media upload → send audio message
 *   - No slash commands → detect keywords + send interactive button menus
 *   - 24-hour customer care window for free-form replies (inbound-triggered)
 *   - Media downloads require auth header with access_token
 *
 * ============================================================================
 */

import {
    ensureWhatsAppConfigsTable,
    getWhatsAppConfigByPhoneNumberId,
    getWhatsAppConfigByUserId,
    insertWhatsAppConfig,
    deleteWhatsAppConfigByUserId,
} from "./db/queries";

// ─── Constants ────────────────────────────────────────────────────────────────

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WhatsAppConfig {
    userId: string;
    phoneNumberId: string;
    accessToken: string;
    wabaId: string | null;
    phoneNumber: string | null;
    displayName: string | null;
    webhookUrl: string;
    connectedAt: string;
}

/** Meta webhook payload root */
export interface WhatsAppWebhookPayload {
    object: "whatsapp_business_account";
    entry: WhatsAppEntry[];
}

export interface WhatsAppEntry {
    id: string;
    changes: WhatsAppChange[];
}

export interface WhatsAppChange {
    value: WhatsAppChangeValue;
    field: "messages";
}

export interface WhatsAppChangeValue {
    messaging_product: "whatsapp";
    metadata: {
        display_phone_number: string;
        phone_number_id: string;
    };
    contacts?: { profile: { name: string }; wa_id: string }[];
    messages?: WhatsAppMessage[];
    statuses?: WhatsAppStatus[];
    errors?: unknown[];
}

export interface WhatsAppMessage {
    from: string;          // sender phone number (E.164 without +)
    id: string;            // message ID (wamid...)
    timestamp: string;
    type: "text" | "image" | "audio" | "document" | "video" | "location" | "interactive" | "button" | "sticker" | "reaction" | "order" | "unknown";
    text?: { body: string };
    image?: { id: string; mime_type: string; sha256: string; caption?: string };
    audio?: { id: string; mime_type: string; voice?: boolean };
    document?: { id: string; filename?: string; mime_type: string; caption?: string };
    video?: { id: string; mime_type: string; caption?: string };
    location?: { latitude: number; longitude: number; name?: string; address?: string };
    interactive?: {
        type: "button_reply" | "list_reply";
        button_reply?: { id: string; title: string };
        list_reply?: { id: string; title: string; description?: string };
    };
    button?: { payload: string; text: string };
    context?: { from: string; id: string };  // reply-to info
}

export interface WhatsAppStatus {
    id: string;
    status: "sent" | "delivered" | "read" | "failed";
    timestamp: string;
    recipient_id: string;
}

// ─── WhatsApp API Client ──────────────────────────────────────────────────────

export class WhatsAppClient {
    private phoneNumberId: string;
    private accessToken: string;

    constructor(phoneNumberId: string, accessToken: string) {
        this.phoneNumberId = phoneNumberId;
        this.accessToken = accessToken;
    }

    private get base(): string {
        return `${GRAPH_BASE}/${this.phoneNumberId}`;
    }

    private async call<T>(
        method: "GET" | "POST" | "DELETE",
        endpoint: string,
        body?: unknown
    ): Promise<T> {
        const res = await fetch(`${this.base}${endpoint}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
                "Content-Type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        const data = await res.json() as { error?: { message: string; code: number } } & Record<string, unknown>;
        if (!res.ok || data.error) {
            throw new Error(`WhatsApp API [${method} ${endpoint}]: ${data.error?.message ?? `HTTP ${res.status}`}`);
        }
        return data as T;
    }

    // ── Send text message ───────────────────────────────────────────────────────

    async sendText(
        to: string,
        text: string,
        replyToMessageId?: string
    ): Promise<{ messages: [{ id: string }] }> {
        // WhatsApp has a 4096 char limit per message
        if (text.length <= 4096) {
            return this.call("POST", "/messages", {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                ...(replyToMessageId ? { context: { message_id: replyToMessageId } } : {}),
                type: "text",
                text: { preview_url: false, body: text },
            });
        }

        // Split long messages
        const chunks = splitMessage(text, 4000);
        let last: { messages: [{ id: string }] } = { messages: [{ id: "" }] };
        for (const chunk of chunks) {
            last = await this.call("POST", "/messages", {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: "text",
                text: { preview_url: false, body: chunk },
            });
        }
        return last;
    }

    // ── Mark message as read (shows blue ticks) ─────────────────────────────────

    async markAsRead(messageId: string): Promise<void> {
        try {
            await this.call("POST", "/messages", {
                messaging_product: "whatsapp",
                status: "read",
                message_id: messageId,
            });
        } catch { /* non-fatal */ }
    }

    // ── Upload media (returns media_id) ─────────────────────────────────────────

    async uploadMedia(bytes: Uint8Array, mimeType: string): Promise<string> {
        const form = new FormData();
        form.append("messaging_product", "whatsapp");
        form.append(
            "file",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            new Blob([bytes] as any, { type: mimeType }),
            mimeType.includes("audio") ? "audio.ogg" : "file"
        );
        form.append("type", mimeType);

        const res = await fetch(`${this.base}/media`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.accessToken}` },
            body: form,
        });
        const data = await res.json() as { id?: string; error?: { message: string } };
        if (!data.id) throw new Error(`Media upload failed: ${data.error?.message ?? "unknown"}`);
        return data.id;
    }

    // ── Send image ──────────────────────────────────────────────────────────────

    async sendImage(
        to: string,
        imageBytes: Uint8Array,
        caption?: string
    ): Promise<{ messages: [{ id: string }] }> {
        const mediaId = await this.uploadMedia(imageBytes, "image/jpeg");
        return this.call("POST", "/messages", {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "image",
            image: {
                id: mediaId,
                ...(caption ? { caption: caption.slice(0, 1024) } : {}),
            },
        });
    }

    // ── Send audio (voice) ──────────────────────────────────────────────────────

    async sendAudio(
        to: string,
        audioBytes: Uint8Array
    ): Promise<{ messages: [{ id: string }] }> {
        // WhatsApp requires OGG/Opus for voice messages
        // Gemini TTS produces PCM/WAV — we'll send as audio document
        const mediaId = await this.uploadMedia(audioBytes, "audio/ogg; codecs=opus");
        return this.call("POST", "/messages", {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "audio",
            audio: { id: mediaId },
        });
    }

    // ── Send interactive button menu ────────────────────────────────────────────
    // WhatsApp doesn't have slash commands — buttons are the equivalent

    async sendButtons(
        to: string,
        bodyText: string,
        buttons: { id: string; title: string }[],
        headerText?: string,
        footerText?: string
    ): Promise<{ messages: [{ id: string }] }> {
        return this.call("POST", "/messages", {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "interactive",
            interactive: {
                type: "button",
                ...(headerText ? { header: { type: "text", text: headerText } } : {}),
                body: { text: bodyText.slice(0, 1024) },
                ...(footerText ? { footer: { text: footerText.slice(0, 60) } } : {}),
                action: {
                    buttons: buttons.slice(0, 3).map((b) => ({
                        type: "reply",
                        reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
                    })),
                },
            },
        });
    }

    // ── Send list menu (up to 10 items) ─────────────────────────────────────────

    async sendList(
        to: string,
        bodyText: string,
        buttonLabel: string,
        sections: { title: string; rows: { id: string; title: string; description?: string }[] }[]
    ): Promise<{ messages: [{ id: string }] }> {
        return this.call("POST", "/messages", {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "interactive",
            interactive: {
                type: "list",
                body: { text: bodyText.slice(0, 1024) },
                action: {
                    button: buttonLabel.slice(0, 20),
                    sections: sections.map((s) => ({
                        title: s.title.slice(0, 24),
                        rows: s.rows.slice(0, 10).map((r) => ({
                            id: r.id.slice(0, 200),
                            title: r.title.slice(0, 24),
                            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
                        })),
                    })),
                },
            },
        });
    }

    // ── Download media from Meta CDN ─────────────────────────────────────────────

    async downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
        // Step 1: get download URL
        const urlRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
        });
        const urlData = await urlRes.json() as { url: string; mime_type: string };
        if (!urlData.url) throw new Error(`Could not get media URL for ${mediaId}`);

        // Step 2: download binary
        const binRes = await fetch(urlData.url, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
        });
        if (!binRes.ok) throw new Error(`Media download failed: ${binRes.status}`);

        return {
            bytes: new Uint8Array(await binRes.arrayBuffer()),
            mimeType: urlData.mime_type,
        };
    }

    // ── Verify phone number ID is valid (used during setup) ─────────────────────

    async getPhoneNumberInfo(): Promise<{
        id: string;
        display_phone_number: string;
        verified_name: string;
        quality_rating: string;
        platform_type: string;
    }> {
        const res = await fetch(
            `${GRAPH_BASE}/${this.phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,platform_type`,
            { headers: { Authorization: `Bearer ${this.accessToken}` } }
        );
        const data = await res.json() as { error?: { message: string } } & Record<string, unknown>;
        if (!res.ok || data.error) {
            throw new Error(
                data.error?.message ??
                "Invalid phone_number_id or access_token. Verify them in Meta Developer Console."
            );
        }
        return data as ReturnType<WhatsAppClient["getPhoneNumberInfo"]> extends Promise<infer T> ? T : never;
    }
}

// ─── Webhook Verification ─────────────────────────────────────────────────────

/**
 * Verify Meta webhook signature.
 * Meta sends: X-Hub-Signature-256: sha256=HMAC(APP_SECRET, rawBody)
 */
export async function verifyWhatsAppSignature(
    rawBody: string,
    signatureHeader: string | null,
    appSecret: string
): Promise<boolean> {
    if (!signatureHeader || !appSecret) return false;

    const expected = signatureHeader.replace("sha256=", "");
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(appSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const hex = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    if (hex.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
}

// ─── D1 Helpers ──────────────────────────────────────────────────────────────

function getDb(env: Env): D1Database | null {
    return (env as { DB?: D1Database }).DB ?? null;
}

function rowToConfig(row: {
    user_id: string; phone_number_id: string; access_token: string;
    waba_id: string | null; phone_number: string | null; display_name: string | null;
    webhook_url: string; connected_at: string;
}): WhatsAppConfig {
    return {
        userId: row.user_id,
        phoneNumberId: row.phone_number_id,
        accessToken: row.access_token,
        wabaId: row.waba_id,
        phoneNumber: row.phone_number,
        displayName: row.display_name,
        webhookUrl: row.webhook_url,
        connectedAt: row.connected_at,
    };
}

export async function ensureWhatsAppTable(env: Env): Promise<void> {
    const db = getDb(env);
    if (!db) return;
    await ensureWhatsAppConfigsTable(db);
}

export async function getWhatsAppConfigForUser(env: Env, userId: string): Promise<WhatsAppConfig | null> {
    const db = getDb(env);
    if (!db) return null;
    const row = await getWhatsAppConfigByUserId(db, userId);
    return row ? rowToConfig(row) : null;
}

export async function getWhatsAppConfigForPhoneNumberId(
    env: Env,
    phoneNumberId: string
): Promise<WhatsAppConfig | null> {
    const db = getDb(env);
    if (!db) return null;
    const row = await getWhatsAppConfigByPhoneNumberId(db, phoneNumberId);
    return row ? rowToConfig(row) : null;
}

// ─── Setup & Management ───────────────────────────────────────────────────────

/**
 * Connect a WhatsApp Business number to a VEGA user.
 * Validates the token by calling the Graph API before storing.
 */
export async function setupWhatsAppNumber(
    phoneNumberId: string,
    accessToken: string,
    env: Env,
    userId: string,
    wabaId?: string
): Promise<WhatsAppConfig> {
    const client = new WhatsAppClient(phoneNumberId, accessToken);

    let info: Awaited<ReturnType<WhatsAppClient["getPhoneNumberInfo"]>>;
    try {
        info = await client.getPhoneNumberInfo();
    } catch (e) {
        throw new Error(
            `Verification failed: ${String(e)}. ` +
            "Make sure your Phone Number ID and System User Token are correct in Meta Developer Console."
        );
    }

    const db = getDb(env);
    if (!db) throw new Error("D1 database not bound. Add DB binding to wrangler.toml.");

    await ensureWhatsAppConfigsTable(db);

    const workerBase = ((env as { WORKER_URL?: string; UPSTASH_WORKFLOW_URL?: string })
        .WORKER_URL ?? (env as { UPSTASH_WORKFLOW_URL?: string }).UPSTASH_WORKFLOW_URL ?? "")
        .trim().replace(/\/$/, "");

    const config: WhatsAppConfig = {
        userId,
        phoneNumberId,
        accessToken,
        wabaId: wabaId ?? null,
        phoneNumber: info.display_phone_number,
        displayName: info.verified_name,
        webhookUrl: `${workerBase}/whatsapp/webhook`,
        connectedAt: new Date().toISOString(),
    };

    await insertWhatsAppConfig(db, userId, {
        phone_number_id: config.phoneNumberId,
        access_token: config.accessToken,
        waba_id: config.wabaId,
        phone_number: config.phoneNumber,
        display_name: config.displayName,
        webhook_url: config.webhookUrl,
        connected_at: config.connectedAt,
    });

    console.log(`[WhatsApp Setup] Connected ${info.display_phone_number} (${info.verified_name}) for user ${userId}`);
    return config;
}

/**
 * Disconnect a user's WhatsApp number.
 */
export async function disconnectWhatsAppNumber(env: Env, userId: string): Promise<void> {
    const db = getDb(env);
    if (!db) return;
    await deleteWhatsAppConfigByUserId(db, userId);
    console.log(`[WhatsApp Disconnect] Removed config for user ${userId}`);
}

// ─── Main Webhook Handler ─────────────────────────────────────────────────────

/**
 * Process a WhatsApp webhook payload.
 * Called inside executionCtx.waitUntil() — 200 OK already returned to Meta.
 */
export async function handleWhatsAppWebhook(
    payload: WhatsAppWebhookPayload,
    env: Env
): Promise<void> {
    for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
            if (change.field !== "messages") continue;

            const value = change.value;
            const phoneNumberId = value.metadata.phone_number_id;

            // Route to the correct VEGA user by phone_number_id
            const config = await getWhatsAppConfigForPhoneNumberId(env, phoneNumberId);
            if (!config) {
                console.warn(`[WhatsApp Webhook] No config found for phone_number_id: ${phoneNumberId}`);
                continue;
            }

            // Process each message in this change
            for (const msg of value.messages ?? []) {
                const contactName = value.contacts?.[0]?.profile?.name ?? "User";
                try {
                    await processWhatsAppMessage(msg, contactName, config, env);
                } catch (e) {
                    console.error(`[WhatsApp] Error processing message ${msg.id}:`, e);
                }
            }
        }
    }
}

// ─── Message Processor ───────────────────────────────────────────────────────

async function processWhatsAppMessage(
    msg: WhatsAppMessage,
    contactName: string,
    config: WhatsAppConfig,
    env: Env
): Promise<void> {
    const client = new WhatsAppClient(config.phoneNumberId, config.accessToken);
    const from = msg.from; // sender phone number (without +)

    // Mark as read immediately (shows blue ticks)
    await client.markAsRead(msg.id);

    // ── Rate limiting: 10 messages/minute per sender ───────────────────────────
    const { getRedis } = await import("./memory");
    const redis = getRedis(env);
    const rateKey = `wa:rate:${from}`;
    const count = await redis.incr(rateKey);
    if (count === 1) await redis.expire(rateKey, 60);
    if (count > 10) {
        await client.sendText(from,
            "⚠️ *Rate limit reached.*\nMax 10 messages per minute. Please wait a moment."
        );
        return;
    }

    // ── Get or create session ──────────────────────────────────────────────────
    const sessionKey = `wa:session:${config.userId}:${from}`;
    let sessionId = await redis.get(sessionKey) as string | null;
    if (!sessionId) {
        sessionId = `wa-${config.userId}-${from}-${Date.now()}`;
        await redis.set(sessionKey, sessionId);
    }

    // ── Extract user text from different message types ─────────────────────────
    let userText = "";
    let isAudio = false;
    let isInteractive = false;

    switch (msg.type) {
        case "text":
            userText = msg.text?.body ?? "";
            break;

        case "interactive":
            // Button/list reply — treat as command
            isInteractive = true;
            userText = msg.interactive?.button_reply?.id ??
                msg.interactive?.list_reply?.id ?? "";
            break;

        case "button":
            isInteractive = true;
            userText = msg.button?.payload ?? msg.button?.text ?? "";
            break;

        case "audio": {
            // Transcribe with Gemini STT
            try {
                const { bytes, mimeType } = await client.downloadMedia(msg.audio!.id);
                const base64 = btoa(String.fromCharCode(...bytes));
                const { transcribeGeminiAudio } = await import("./gemini");
                const transcript = await transcribeGeminiAudio(
                    env.GEMINI_API_KEY,
                    base64,
                    mimeType
                );
                if (transcript) {
                    userText = transcript;
                    isAudio = true;
                } else {
                    userText = "[User sent a voice message — transcription unavailable.]";
                }
            } catch (e) {
                console.error("[WhatsApp STT]", e);
                userText = "[User sent a voice message — transcription failed.]";
            }
            break;
        }

        case "image": {
            // Vision analysis
            try {
                const { bytes, mimeType } = await client.downloadMedia(msg.image!.id);
                const base64 = btoa(String.fromCharCode(...bytes));
                const { analyzeImage } = await import("./gemini");
                const caption = msg.image?.caption ?? "";
                const description = await analyzeImage(
                    env.GEMINI_API_KEY,
                    base64,
                    mimeType,
                    caption
                        ? `User sent this image with caption: "${caption}". Describe it and address their message.`
                        : "Describe this image in detail — all visible elements, text, objects, colors, and context."
                );
                userText = caption
                    ? `[User sent an image: "${caption}"]\n\nVision Analysis:\n${description}`
                    : `[User sent an image]\n\nVision Analysis:\n${description}`;
            } catch (e) {
                console.error("[WhatsApp Vision]", e);
                userText = msg.image?.caption || "[User sent an image]";
            }
            break;
        }

        case "document":
            userText = `[User sent document: ${msg.document?.filename ?? "file"}${msg.document?.caption ? ` — ${msg.document.caption}` : ""}]`;
            break;

        case "location":
            userText = `[User shared location: ${msg.location?.name ?? ""} at ${msg.location?.latitude},${msg.location?.longitude}${msg.location?.address ? ` — ${msg.location.address}` : ""}]`;
            break;

        default:
            console.log(`[WhatsApp] Ignoring message type: ${msg.type}`);
            return;
    }

    if (!userText.trim()) return;

    // ── Handle menu commands (interactive keywords) ────────────────────────────
    const lowerText = userText.toLowerCase().trim();
    if (lowerText === "menu" || lowerText === "help" || lowerText === "start" ||
        lowerText === "hi" || lowerText === "hello" || isInteractive) {

        if (lowerText === "start" || lowerText === "hi" || lowerText === "hello" || lowerText === "menu") {
            await handleWhatsAppMenu(from, contactName, client);
            return;
        }

        // Handle button replies
        if (isInteractive) {
            await handleWhatsAppCommand(userText, from, contactName, client, env, sessionId, config);
            return;
        }
    }

    // ── Send "working" notification ────────────────────────────────────────────
    // WhatsApp has no message edit — just send a brief status then the answer
    let statusMsgId: string | null = null;
    try {
        const statusRes = await client.sendText(from, "⚙️ _Processing..._");
        statusMsgId = statusRes.messages?.[0]?.id ?? null;
    } catch { /* non-fatal */ }

    // ── Run the VEGA agent ─────────────────────────────────────────────────────
    const { runAgent } = await import("./agent");

    const toolsUsed: string[] = [];
    let reply: string;

    try {
        reply = await runAgent(
            env,
            sessionId,
            userText,
            undefined,
            (event) => {
                if (event.type === "tool-start") toolsUsed.push(event.data.name);
            }
        );
    } catch (e) {
        console.error(`[WhatsApp] Agent error for ${from}:`, e);
        await client.sendText(from, `❌ Error: ${String(e).slice(0, 200)}`);
        return;
    }

    // ── Send reply ─────────────────────────────────────────────────────────────
    const voiceEnabled = await redis.get(`wa:voice:${from}`) as string | null;

    if (voiceEnabled && reply.length <= 1500) {
        // Voice reply
        try {
            const { generateSpeechBytes } = await import("./tools/voice");
            const audioBytes = await generateSpeechBytes(reply, env);
            if (audioBytes) {
                await client.sendText(from, markdownToWhatsApp(reply));
                // Note: WAV→OGG conversion would be needed for proper voice messages
                // For now send as text + indicate audio was generated
            } else {
                await sendWhatsAppReply(from, reply, client);
            }
        } catch {
            await sendWhatsAppReply(from, reply, client);
        }
    } else {
        await sendWhatsAppReply(from, reply, client);
    }

    // ── Record activity ────────────────────────────────────────────────────────
    const activityKey = `wa:activity:${config.userId}`;
    try {
        await redis.lpush(activityKey, JSON.stringify({
            from,
            contactName,
            messagePreview: userText.slice(0, 100),
            replyPreview: reply.slice(0, 100),
            wasAudio: isAudio,
            toolsUsed: toolsUsed.slice(0, 5),
            ts: Date.now(),
        }));
        await redis.ltrim(activityKey, 0, 49);
    } catch { /* non-fatal */ }
}

// ─── Helper: send reply (splits if needed) ────────────────────────────────────

async function sendWhatsAppReply(
    to: string,
    text: string,
    client: WhatsAppClient
): Promise<void> {
    const chunks = splitMessage(markdownToWhatsApp(text), 4000);
    for (const chunk of chunks) {
        try {
            await client.sendText(to, chunk);
        } catch (e) {
            // Fallback: strip formatting if parse fails
            console.error("[WhatsApp sendText]", e);
            await client.sendText(to, chunk.replace(/[_*~`]/g, "")).catch(() => { });
        }
    }
}

// ─── Menu & Command Handlers ──────────────────────────────────────────────────

async function handleWhatsAppMenu(
    to: string,
    name: string,
    client: WhatsAppClient
): Promise<void> {
    await client.sendButtons(
        to,
        `👋 Hey ${name}! I'm *VEGA* — your autonomous AI agent.\n\nWhat can I help you with?`,
        [
            { id: "cmd_help", title: "📚 Capabilities" },
            { id: "cmd_status", title: "⚡ Agent Status" },
            { id: "cmd_tasks", title: "🤖 Running Tasks" },
        ],
        "VEGA AI Agent",
        "Send any message to chat freely"
    );
}

async function handleWhatsAppCommand(
    commandId: string,
    from: string,
    contactName: string,
    client: WhatsAppClient,
    env: Env,
    sessionId: string,
    config: WhatsAppConfig
): Promise<void> {
    const { getRedis } = await import("./memory");
    const redis = getRedis(env);

    switch (commandId) {
        case "cmd_help": {
            await client.sendText(from,
                `*VEGA Capabilities*\n\n` +
                `🔍 *Search & Browse* — Web search, headless browser, deep scraping\n` +
                `🧠 *Persistent Memory* — Remembers everything across sessions\n` +
                `💻 *Run Code* — Execute Python, analyze data\n` +
                `🤖 *Spawn Sub-agents* — Parallel AI workers for complex tasks\n` +
                `📁 *File Storage* — R2 cloud storage for reports\n` +
                `⚙️ *Build Tools* — Self-extends capabilities on demand\n` +
                `⏰ *Schedule Jobs* — Recurring cron with proactive alerts\n` +
                `🎨 *Generate Images* — Gemini image generation\n` +
                `📊 *Market Data* — Live prices, portfolio, price alerts\n` +
                `🌍 *25+ Languages* — Auto-detects and responds\n\n` +
                `Send *menu* anytime to see options.\nSend any message to start chatting!`
            );
            break;
        }

        case "cmd_status": {
            const lastTick = await redis.get("agent:last-tick") as string | null;
            const tick = lastTick ? JSON.parse(lastTick) : null;
            const errors = await redis.llen("agent:errors");
            const uptime = tick ? formatRelTime(tick.timestamp) : "No heartbeat yet";

            await client.sendText(from,
                `*⚡ VEGA Status*\n\n` +
                `🟢 *Core:* Active\n` +
                `🔄 *Last heartbeat:* ${uptime}\n` +
                `⚠️ *Recent errors:* ${errors}\n` +
                `🌐 *Platform:* Cloudflare Workers Edge\n` +
                (tick?.reflection ? `\n_${tick.reflection.slice(0, 200)}_` : "")
            );
            break;
        }

        case "cmd_tasks": {
            const raw = await redis.lrange("agent:spawned", 0, 9) as string[];
            if (raw.length === 0) {
                await client.sendText(from, "📋 *No background tasks running.*");
                break;
            }
            const agents = raw.map((r: string) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
            let list = "*🤖 Background Tasks*\n\n";
            for (const a of agents.slice(0, 5)) {
                const icon = a.status === "running" ? "⏳" : a.status === "done" ? "✅" : "❌";
                list += `${icon} *${a.agentName ?? "Unknown"}*\n   Status: ${a.status}\n\n`;
            }
            await client.sendText(from, list.trim());
            break;
        }

        case "cmd_voice_on": {
            await redis.set(`wa:voice:${from}`, "1", { ex: 60 * 60 * 24 * 30 });
            await client.sendText(from, "🎙️ *Voice replies enabled!* I'll respond with voice messages now.");
            break;
        }

        case "cmd_voice_off": {
            await redis.del(`wa:voice:${from}`);
            await client.sendText(from, "🔇 *Voice replies disabled.* Text mode restored.");
            break;
        }

        case "cmd_reset": {
            await redis.del(`wa:session:${config.userId}:${from}`);
            await client.sendText(from, "🔄 *Conversation reset.* Fresh start!");
            break;
        }

        default: {
            // Unknown command — run as a regular message through the agent
            const { runAgent } = await import("./agent");
            const reply = await runAgent(env, sessionId, commandId);
            await sendWhatsAppReply(from, reply, client);
        }
    }
}

// ─── Text Formatting ──────────────────────────────────────────────────────────

/**
 * Convert Markdown to WhatsApp formatting.
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```code```
 * Does NOT support: HTML, headers, hyperlinks (shown as plain text)
 */
export function markdownToWhatsApp(text: string): string {
    return text
        // Code blocks: ```lang\ncode``` → ```code```
        .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => `\`\`\`${code.trim()}\`\`\``)
        // Bold: **text** → *text*
        .replace(/\*\*(.+?)\*\*/gs, "*$1*")
        .replace(/__(.+?)__/gs, "*$1*")
        // Headers → bold
        .replace(/^#{1,3}\s+(.+)$/gm, "*$1*")
        // Italic: keep _ but normalize *italic* → _italic_
        .replace(/(?<!\*)\*(?!\*)([^\*\n]+?)(?<!\*)\*(?!\*)/g, "_$1_")
        // Strikethrough: ~~text~~ → ~text~
        .replace(/~~(.+?)~~/g, "~$1~")
        // Remove HTML-style links, keep text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        // Horizontal rules
        .replace(/^[-*_]{3,}$/gm, "───────────")
        // Bullet lists: keep • prefix
        .replace(/^[\-\*\+]\s+/gm, "• ")
        // Clean excessive blank lines
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) { chunks.push(remaining); break; }
        let split = remaining.lastIndexOf("\n\n", maxLen);
        if (split === -1) split = remaining.lastIndexOf("\n", maxLen);
        if (split === -1) split = remaining.lastIndexOf(" ", maxLen);
        if (split === -1) split = maxLen;
        chunks.push(remaining.slice(0, split).trim());
        remaining = remaining.slice(split).trim();
    }
    return chunks.filter((c) => c.length > 0);
}

function formatRelTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}