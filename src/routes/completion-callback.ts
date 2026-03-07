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
    await pushViaTelegram(env, redis, finalUserId, pushMessage, taskId, agentName, memoryPrefix).catch((e) =>
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
    memoryPrefix: string
): Promise<void> {
    const db = (env as { DB?: D1Database }).DB;
    if (!db) return;

    const { getTelegramConfigByUserId } = await import("../db/queries");
    const tgConfig = await getTelegramConfigByUserId(db, userId).catch(() => null);
    if (!tgConfig?.token) return;

    const activityKey = `tg:activity:${userId}`;
    const recent = await redis.lrange(activityKey, 0, 0) as string[];
    if (!recent.length) return;

    let chatId: number | null = null;
    try {
        chatId = (JSON.parse(recent[0]) as { chatId: number }).chatId;
    } catch { return; }
    if (!chatId) return;

    const { markdownToHtml: markdownToTelegramHtml, TelegramBot } = await import("../telegram");
    const bot = new TelegramBot(tgConfig.token);

    // ── Detect media URLs broadly (any /files/ path with a media extension) ──
    const MEDIA_REGEX = /https?:\/\/[^\s)<>"]+\/files\/([^\s)<>"]+\.(?:png|jpg|jpeg|gif|webp|wav|mp3|ogg|mp4))/gi;
    const audioExts = new Set([".wav", ".mp3", ".ogg"]);
    const imageExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

    const audioFiles: string[] = [];   // R2 keys
    const imageFiles: string[] = [];   // R2 keys

    let match;
    while ((match = MEDIA_REGEX.exec(message)) !== null) {
        const r2Key = match[1];  // path after /files/
        const ext = r2Key.slice(r2Key.lastIndexOf(".")).toLowerCase();
        if (audioExts.has(ext)) audioFiles.push(r2Key);
        else if (imageExts.has(ext)) imageFiles.push(r2Key);
    }

    // Strip all media URLs and their markdown wrappers from the text message
    let cleanMessage = message;
    const allMediaRegex = /https?:\/\/[^\s)<>"]+\/files\/[^\s)<>"]+\.(?:png|jpg|jpeg|gif|webp|wav|mp3|ogg|mp4)/gi;
    const foundUrls: string[] = [];
    let urlMatch;
    while ((urlMatch = allMediaRegex.exec(message)) !== null) foundUrls.push(urlMatch[0]);
    for (const url of foundUrls) {
        const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        cleanMessage = cleanMessage
            .replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, "gi"), "")
            .replace(new RegExp(`\\[[^\\]]*\\]\\(${escaped}\\)`, "gi"), "")
            .replace(new RegExp(escaped, "gi"), "");
    }
    cleanMessage = cleanMessage.replace(/\n{3,}/g, "\n\n").trim();

    // Send text (if anything left)
    const htmlMessage = markdownToTelegramHtml(cleanMessage);
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

    // Send audio files — read directly from R2, no HTTP self-call
    for (const r2Key of audioFiles) {
        try {
            const obj = env.FILES_BUCKET ? await (env.FILES_BUCKET as R2Bucket).get(r2Key) : null;
            if (!obj) {
                console.warn(`[CompletionCallback] Audio not found in R2: ${r2Key}`);
                continue;
            }
            const audioBytes = new Uint8Array(await obj.arrayBuffer());
            await bot.sendVoice(chatId, audioBytes, { caption: `🔊 ${agentName}` });
        } catch (e) {
            console.warn(`[CompletionCallback] Audio send failed for ${r2Key}:`, String(e));
        }
    }

    // Send image files — read directly from R2, no HTTP self-call
    for (const r2Key of imageFiles) {
        try {
            const obj = env.FILES_BUCKET ? await (env.FILES_BUCKET as R2Bucket).get(r2Key) : null;
            if (!obj) {
                console.warn(`[CompletionCallback] Image not found in R2: ${r2Key}`);
                continue;
            }
            const imageBytes = new Uint8Array(await obj.arrayBuffer());
            const ext = r2Key.slice(r2Key.lastIndexOf(".") + 1).toLowerCase();
            const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
                : ext === "gif" ? "image/gif"
                    : ext === "webp" ? "image/webp"
                        : "image/png";
            const form = new FormData();
            form.append("chat_id", String(chatId));
            form.append("photo", new Blob([imageBytes], { type: mime }), `image.${ext}`);
            form.append("caption", `🎨 ${agentName}`);
            const res = await fetch(
                `https://api.telegram.org/bot${tgConfig.token}/sendPhoto`,
                { method: "POST", body: form }
            );
            if (!res.ok) {
                const err = await res.json() as { description?: string };
                console.warn(`[CompletionCallback] Photo send failed: ${err.description}`);
            }
        } catch (e) {
            console.warn(`[CompletionCallback] Image send failed for ${r2Key}:`, String(e));
        }
    }

    console.log(`[CompletionCallback] ✅ Pushed to Telegram chat ${chatId} for user ${userId} (audio: ${audioFiles.length}, images: ${imageFiles.length})`);
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