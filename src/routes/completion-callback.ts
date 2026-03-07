/**
 * ============================================================================
 * src/routes/completion-callback.ts — Agent Result Push-Back Handler
 * ============================================================================
 *
 * This is the MISSING BRIDGE that workflow.ts and subagent.ts both fire but
 * nothing was handling. Without this, agent results silently die in Redis and
 * VEGA never knows they finished.
 *
 * Called by: fireCompletionCallback() in workflow.ts AND subagent.ts
 * Protected by: x-internal-secret header (same TELEGRAM_INTERNAL_SECRET)
 *
 * What it does when an agent completes:
 *   1. Stores result as a "pending push" in Redis (SSE/polling consumers read this)
 *   2. Pushes via Telegram proactive_notify if user has Telegram connected
 *   3. Pushes via WhatsApp if user has WhatsApp connected
 *   4. Injects result into the parent session's conversation history so VEGA
 *      "sees" it on the next user message — closing the feedback loop
 *
 * ADD TO src/index.ts:
 *   import { handleCompletionCallback } from "./routes/completion-callback";
 *
 *   app.post("/agents/completion-callback", async (c) => {
 *     const secret = c.req.header("x-internal-secret");
 *     const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
 *     if (internalSecret && secret !== internalSecret) {
 *       return c.json({ error: "Unauthorized" }, 401);
 *     }
 *     const payload = await c.req.json();
 *     c.executionCtx.waitUntil(handleCompletionCallback(payload, c.env));
 *     return c.json({ received: true });
 *   });
 *
 * ============================================================================
 */

import { getRedis } from "../memory";
import {
    getWhatsAppConfigForUser,
    WhatsAppClient,
    markdownToWhatsApp,
} from "../whatsapp";
import { addPendingItem } from "../vega-state";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompletionCallbackPayload {
    taskId: string;
    agentName: string;
    parentSessionId: string | null;   // The specific UI session ID
    userId?: string;                  // Explicit userId from execSpawnAgent
    memoryPrefix: string;
    status: "done" | "error" | string;
    result: string;
    completedAt: string;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function handleCompletionCallback(
    payload: CompletionCallbackPayload,
    env: Env
): Promise<void> {
    const { taskId, agentName, parentSessionId, userId: explicitUserId, memoryPrefix, status, result, completedAt } = payload;

    console.log(`[CompletionCallback] ${taskId} (${agentName}) → session: ${parentSessionId ?? "none"}, user: ${explicitUserId ?? "none"}, status: ${status}`);

    const redis = getRedis(env);

    // ── 1. Format the push message ─────────────────────────────────────────────
    const isError = status === "error";
    const icon = isError ? "❌" : "✅";
    const pushMessage = isError
        ? `${icon} *Agent '${agentName}' failed*\n\n${result}`
        : `${icon} *Agent '${agentName}' completed*\n\n${result}`;

    const pushMsgData = {
        type: "assistant",
        agentName,
        status,
        message: pushMessage,
        result: result.slice(0, 5000),
        completedAt,
        ts: Date.now(),
    };

    // ── 2. Store as a pending push message (SSE / chat polling consumers) ──────

    // A. Push to the SPECIFIC session that started the agent (for active UI tab)
    if (parentSessionId) {
        const sessionKey = `session:pending-push:${parentSessionId}`;
        await redis.lpush(sessionKey, JSON.stringify(pushMsgData)).catch(() => { });
        await redis.expire(sessionKey, 60 * 60 * 24).catch(() => { }); // 24h
        await redis.ltrim(sessionKey, 0, 19).catch(() => { }); // Keep last 20
    }

    // B. Push to the USER-WIDE key (for cross-session history and Telegram)
    // We prefer the explicit userId, but fall back to extracting it from parentSessionId
    let finalUserId = explicitUserId;
    if (!finalUserId && parentSessionId?.startsWith("user-")) {
        finalUserId = parentSessionId.replace("user-", "");
    }

    if (!finalUserId && parentSessionId) {
        // Covers Telegram (tg-...) and WhatsApp (wa-...) sessions that stored
        // their userId in the session:user-map when the session was created.
        const mapped = await redis.get(`session:user-map:${parentSessionId}`) as string | null;
        if (mapped) finalUserId = mapped;
    }

    // Fallback: look up the session-to-user mapping stored by the /chat proxy
    // This handles the common case where the UI session is "session-XXXXXXXX" (nanoid)
    // and was mapped to a userId during authentication.
    if (!finalUserId && parentSessionId) {
        try {
            const mapped = await redis.get(`session:user-map:${parentSessionId}`) as string | null;
            if (mapped) finalUserId = mapped;
        } catch { /* non-fatal */ }
    }

    if (finalUserId) {
        const userKey = `session:pending-push:user-${finalUserId}`;
        await redis.lpush(userKey, JSON.stringify(pushMsgData)).catch(() => { });
        await redis.expire(userKey, 60 * 60 * 24 * 7).catch(() => { }); // 7 days
        await redis.ltrim(userKey, 0, 19).catch(() => { }); // Keep last 20
    }

    // ── 3. Inject into parent session history so VEGA "sees" it ────────────────
    if (parentSessionId) {
        try {
            const historyKey = `agent:history:${parentSessionId}`;
            const injectedMessage = {
                role: "user",
                parts: [{
                    text:
                        `[Background agent '${agentName}' (task: ${taskId}) completed.\n` +
                        `Status: ${status} | At: ${completedAt}\n\n` +
                        `Result:\n${result.slice(0, 3000)}` +
                        (result.length > 3000
                            ? `\n\n[Output truncated. Full result: read_agent_memory('${memoryPrefix}', 'result')]`
                            : ""),
                }],
            };
            await redis.rpush(historyKey, JSON.stringify(injectedMessage)).catch(() => { });
        } catch (e) {
            console.warn(`[CompletionCallback] History injection failed: ${String(e)}`);
        }
    }

    // ── 4. Add to Cognitive State (surface at next chat) ──────────────────────
    if (finalUserId) {
        await addPendingItem(redis, finalUserId, {
            type: status === "error" ? "agent_error" : "task_complete",
            summary: `Agent "${agentName}" finished: ${result.slice(0, 120)}`,
        }).catch(() => { });
    }

    if (!finalUserId) {
        console.log(`[CompletionCallback] No userId from session ${parentSessionId} — stored in Redis only`);
        return;
    }

    // ── 5. Push via Telegram (if connected) ────────────────────────────────────
    await pushViaTelegram(env, redis, finalUserId, pushMessage, taskId, agentName, parentSessionId).catch((e) =>
        console.warn(`[CompletionCallback] Telegram push failed: ${String(e)}`)
    );

    // ── 6. Push via WhatsApp (if connected) ────────────────────────────────────
    await pushViaWhatsApp(env, finalUserId, pushMessage, parentSessionId).catch((e) =>
        console.warn(`[CompletionCallback] WhatsApp push failed: ${String(e)}`)
    );
}

// ─── Telegram Push ────────────────────────────────────────────────────────────

async function pushViaTelegram(
    env: Env,
    redis: ReturnType<typeof getRedis>,
    userId: string,
    message: string,
    taskId: string,
    agentName: string,
    parentSessionId: string | null
): Promise<void> {
    // Use Redis cache — D1 is unavailable in workflow context.env (not JSON-serializable via QStash)
    const deliveryRaw = await redis.get<string>(`tg:delivery:${userId}`).catch(() => null);
    let token: string | null = null;
    let chatId: number | null = null;

    if (deliveryRaw) {
        try {
            const d = typeof deliveryRaw === "string" ? JSON.parse(deliveryRaw) : deliveryRaw as { token: string; chatId: number };
            token = d.token;
            chatId = d.chatId;
        } catch { /* noop */ }
    }

    // Fallback: parse chatId from parentSessionId "tg-{chatId}-{timestamp}"
    if (!chatId && parentSessionId?.startsWith("tg-")) {
        const m = parentSessionId.match(/^tg-(-?\d+)-\d+$/);
        if (m) chatId = parseInt(m[1], 10);
    }

    // Fallback: activity log for chatId
    if (!chatId) {
        const recent = await redis.lrange(`tg:activity:${userId}`, 0, 0) as string[];
        if (recent.length) {
            try { chatId = (JSON.parse(recent[0]) as { chatId: number }).chatId; } catch { /* noop */ }
        }
    }

    if (!token || !chatId) {
        console.log(`[CompletionCallback] Missing token=${!!token} or chatId=${chatId} for user ${userId}`);
        return;
    }

    // Convert markdown → Telegram HTML
    const { markdownToHtml: markdownToTelegramHtml, TelegramBot } = await import("../telegram");

    const audioUrls: string[] = [];
    const imageUrls: string[] = [];
    const audioRegex = /https?:\/\/[^\s)]+\/files\/voice\/[^\s)]+\.wav/gi;
    const imageRegex = /https?:\/\/[^\s)]+\/files\/generated\/[^\s)]+\.(?:png|jpg|jpeg)/gi;

    let m;
    while ((m = audioRegex.exec(message)) !== null) audioUrls.push(m[0]);
    while ((m = imageRegex.exec(message)) !== null) imageUrls.push(m[0]);

    let cleanMessage = message;
    for (const url of [...audioUrls, ...imageUrls]) {
        const mdRegex = new RegExp(`!\\[[^\\]]*\\]\\(${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "gi");
        cleanMessage = cleanMessage.replace(mdRegex, "").replace(url, "");
    }
    cleanMessage = cleanMessage.replace(/\n{3,}/g, "\n\n").trim();

    const htmlMessage = markdownToTelegramHtml(cleanMessage);
    const bot = new TelegramBot(token);

    if (htmlMessage.trim()) {
        // Split into 4000-char chunks — Telegram's limit is 4096
        const { splitMessageSafe } = await import("../telegram");
        const chunks = splitMessageSafe(htmlMessage, 4000);

        for (const chunk of chunks) {
            const sendRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: chunk,
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                }),
            });
            if (!sendRes.ok) {
                const err = await sendRes.json() as { description?: string };
                console.warn(`[CompletionCallback] Telegram send failed: ${err.description}`);
            }
        }
    }

    for (const audioUrl of audioUrls) {
        await bot.sendVoice(chatId, audioUrl, { caption: `🔊 ${agentName}` }).catch((e) =>
            console.warn(`[CompletionCallback] Voice send failed: ${String(e)}`)
        );
    }

    for (const imageUrl of imageUrls) {
        try {
            const imgRes = await fetch(imageUrl);
            const imageBytes = new Uint8Array(await imgRes.arrayBuffer());
            await bot.sendPhoto(chatId, imageBytes, `🎨 ${agentName}`);
        } catch (e) {
            console.warn(`[CompletionCallback] Photo send failed: ${String(e)}`);
        }
    }

    console.log(`[CompletionCallback] ✅ Pushed to Telegram chat ${chatId} for user ${userId}`);
}

// ─── WhatsApp Push ────────────────────────────────────────────────────────────

async function pushViaWhatsApp(
    env: Env,
    userId: string,
    message: string,
    parentSessionId: string | null
): Promise<void> {
    const { getRedis } = await import("../memory");
    const redis = getRedis(env);

    // Use Redis cache — D1 is unavailable in workflow context.env
    const deliveryRaw = await redis.get<string>(`wa:delivery:${userId}`).catch(() => null);
    let waConfig: any = null;

    if (deliveryRaw) {
        try {
            waConfig = typeof deliveryRaw === "string" ? JSON.parse(deliveryRaw) : deliveryRaw;
        } catch { /* noop */ }
    }

    if (!waConfig) {
        const { getWhatsAppConfigForUser } = await import("../whatsapp");
        waConfig = await getWhatsAppConfigForUser(env, userId).catch(() => null);
    }

    if (!waConfig) return;

    // FIX: Extract senderPhone directly from parentSessionId: "wa-{userId}-{from}-{timestamp}"
    // The 'from' is always numeric (phone number) and timestamp is always 13 digits.
    let senderPhone: string | null = null;
    if (parentSessionId?.startsWith("wa-")) {
        // Strip "wa-" prefix and the trailing 13-digit timestamp
        const inner = parentSessionId.slice(3).replace(/-\d{13}$/, ""); // → "{userId}-{from}"
        const m = inner.match(/-(\d+)$/);
        if (m) senderPhone = m[1];
    }
    // Fall back to activity log
    if (!senderPhone) {
        const redis = getRedis(env);
        const recent = await redis.lrange(`wa:activity:${userId}`, 0, 0) as string[];
        if (recent.length) {
            try { senderPhone = (JSON.parse(recent[0]) as { from: string }).from; } catch { /* noop */ }
        }
    }

    if (!senderPhone) {
        console.log(`[CompletionCallback] Could not resolve WhatsApp sender for user ${userId}`);
        return;
    }

    const client = new WhatsAppClient(waConfig.phoneNumberId, waConfig.accessToken);
    await client.sendText(senderPhone, markdownToWhatsApp(message));

    console.log(`[CompletionCallback] ✅ Pushed to WhatsApp ${senderPhone} for user ${userId}`);
}
