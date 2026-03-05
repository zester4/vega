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
    const { taskId, agentName, parentSessionId, userId: explicitUserId, status, result, completedAt } = payload;

    console.log(`[CompletionCallback] ${taskId} (${agentName}) → session: ${parentSessionId ?? "none"}, user: ${explicitUserId ?? "none"}, status: ${status}`);

    const redis = getRedis(env);

    // ── 1. Format the push message ─────────────────────────────────────────────
    const isError = status === "error";
    const icon = isError ? "❌" : "✅";
    const pushMessage = isError
        ? `${icon} *Agent '${agentName}' failed*\n\n${result.slice(0, 500)}`
        : `${icon} *Agent '${agentName}' completed*\n\n${result.length > 1500 ? result.slice(0, 1500) + "\n\n_...truncated. Full result stored in memory._" : result}`;

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
            const historyKey = `session:history:${parentSessionId}`;
            const injectedMessage = {
                role: "user",
                parts: [{
                    text: `[SYSTEM: Background agent '${agentName}' (task: ${taskId}) has completed.\n` +
                        `Status: ${status}\n` +
                        `Completed at: ${completedAt}\n\n` +
                        `Result:\n${result.slice(0, 3000)}` +
                        (result.length > 3000 ? "\n\n[Result truncated — full output in memory]" : "")
                }],
                _injected: true,
                _agentCompletion: true,
                _taskId: taskId,
                _ts: Date.now(),
            };
            await redis.rpush(historyKey, JSON.stringify(injectedMessage)).catch(() => { });
        } catch (e) {
            console.warn(`[CompletionCallback] History injection failed: ${String(e)}`);
        }
    }

    if (!finalUserId) {
        console.log(`[CompletionCallback] No userId from session ${parentSessionId} — stored in Redis only`);
        return;
    }

    // ── 5. Push via Telegram (if connected) ────────────────────────────────────
    await pushViaTelegram(env, redis, finalUserId, pushMessage, taskId, agentName).catch((e) =>
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
    agentName: string
): Promise<void> {
    // Look up the user's Telegram config from D1
    const db = (env as { DB?: D1Database }).DB;
    if (!db) return;

    const { getTelegramConfigByUserId } = await import("../db/queries");
    const tgConfig = await getTelegramConfigByUserId(db, userId).catch(() => null);
    if (!tgConfig?.token) {
        console.log(`[CompletionCallback] No Telegram config for user ${userId}`);
        return;
    }

    // Find the most recent chat ID for this user's bot
    // We store activity as: { chatId, username, ... } in Redis
    const activityKey = `tg:activity:${userId}`;
    const recent = await redis.lrange(activityKey, 0, 0) as string[];
    if (!recent.length) {
        console.log(`[CompletionCallback] No recent Telegram chat for user ${userId}`);
        return;
    }

    let chatId: number | null = null;
    try {
        const item = JSON.parse(recent[0]) as { chatId: number };
        chatId = item.chatId;
    } catch { return; }

    if (!chatId) return;

    // Convert markdown → Telegram HTML
    const { markdownToHtml: markdownToTelegramHtml, TelegramBot } = await import("../telegram");

    // Detect audio and image URLs in the completion message (e.g. from a sub-agent podcast or designer tool)
    const audioUrls: string[] = [];
    const imageUrls: string[] = [];
    const audioRegex = /https?:\/\/[^\s)]+\/files\/voice\/[^\s)]+\.wav/gi;
    const imageRegex = /https?:\/\/[^\s)]+\/files\/generated\/[^\s)]+\.(?:png|jpg|jpeg)/gi;

    let match;
    while ((match = audioRegex.exec(message)) !== null) audioUrls.push(match[0]);
    while ((match = imageRegex.exec(message)) !== null) imageUrls.push(match[0]);

    // Clean the message by removing media URLs and their Markdown containers
    let cleanMessage = message;
    for (const url of [...audioUrls, ...imageUrls]) {
        const mdRegex = new RegExp(`!\\[[^\\]]*\\]\\(${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "gi");
        cleanMessage = cleanMessage.replace(mdRegex, "");
        cleanMessage = cleanMessage.replace(url, "");
    }
    cleanMessage = cleanMessage.replace(/\n{3,}/g, "\n\n").trim();

    const htmlMessage = markdownToTelegramHtml(cleanMessage);
    const bot = new TelegramBot(tgConfig.token);

    // 1. Send text message (if anything left after removing media links)
    if (htmlMessage.trim()) {
        const sendRes = await fetch(
            `https://api.telegram.org/bot${tgConfig.token}/sendMessage`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: htmlMessage,
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                }),
            }
        );

        if (!sendRes.ok) {
            const err = await sendRes.json() as { description?: string };
            console.warn(`[CompletionCallback] Telegram text send failed: ${err.description}`);
        }
    }

    // 2. Send detected audio files as voice messages (Fetch-then-Push: fetch bytes, not URL)
    if (audioUrls.length > 0) {
        for (const audioUrl of audioUrls) {
            try {
                const audioRes = await fetch(audioUrl);
                if (!audioRes.ok) throw new Error(`Fetch status ${audioRes.status}`);
                const audioBytes = new Uint8Array(await audioRes.arrayBuffer());
                await bot.sendVoice(chatId, audioBytes, {
                    caption: `🔊 ${agentName} Audio`,
                });
            } catch (aErr) {
                console.warn(`[CompletionCallback] Telegram voice send failed: ${String(aErr)}`);
            }
        }
    }

    // 3. Send detected image files as photos
    if (imageUrls.length > 0) {
        for (const imageUrl of imageUrls) {
            try {
                const imgRes = await fetch(imageUrl);
                if (!imgRes.ok) throw new Error(`Fetch status ${imgRes.status}`);
                const imageBytes = new Uint8Array(await imgRes.arrayBuffer());
                await bot.sendPhoto(chatId, imageBytes, `🎨 ${agentName} Image`);
            } catch (imgErr) {
                console.warn(`[CompletionCallback] Telegram photo send failed: ${String(imgErr)}`);
            }
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
    const waConfig = await getWhatsAppConfigForUser(env, userId);
    if (!waConfig) return;

    const redis = getRedis(env);

    // Find the most recent WhatsApp sender for this user
    const activityKey = `wa:activity:${userId}`;
    const recent = await redis.lrange(activityKey, 0, 0) as string[];
    if (!recent.length) return;

    let senderPhone: string | null = null;
    try {
        const item = JSON.parse(recent[0]) as { from: string };
        senderPhone = item.from;
    } catch { return; }

    if (!senderPhone) return;

    const client = new WhatsAppClient(waConfig.phoneNumberId, waConfig.accessToken);
    await client.sendText(senderPhone, markdownToWhatsApp(message));

    console.log(`[CompletionCallback] ✅ Pushed to WhatsApp ${senderPhone} for user ${userId}`);
}