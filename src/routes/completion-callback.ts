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
    parentSessionId: string | null;   // "user-{userId}" format from /chat proxy
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
    const { taskId, agentName, parentSessionId, status, result, completedAt } = payload;

    console.log(`[CompletionCallback] ${taskId} (${agentName}) → session: ${parentSessionId ?? "none"}, status: ${status}`);

    const redis = getRedis(env);

    // ── 1. Format the push message ─────────────────────────────────────────────
    const isError = status === "error";
    const icon = isError ? "❌" : "✅";
    const pushMessage = isError
        ? `${icon} *Agent '${agentName}' failed*\n\n${result.slice(0, 500)}`
        : `${icon} *Agent '${agentName}' completed*\n\n${result.length > 1500 ? result.slice(0, 1500) + "\n\n_...truncated. Full result stored in memory._" : result}`;

    // ── 2. Store as a pending push message (SSE / chat polling consumers) ──────
    // Any active chat SSE connection for this session will receive this immediately.
    // If the user is not online, they'll see it on their next chat load.
    const pendingKey = `session:pending-push:${parentSessionId ?? "global"}`;
    await redis.lpush(pendingKey, JSON.stringify({
        type: "agent-complete",
        taskId,
        agentName,
        status,
        message: pushMessage,
        result: result.slice(0, 5000),
        completedAt,
        ts: Date.now(),
    })).catch(() => { });
    await redis.expire(pendingKey, 60 * 60 * 24).catch(() => { }); // 24h TTL

    // ── 3. Inject into parent session history so VEGA "sees" it ────────────────
    // This is the key to VEGA being aware of agent results without the user
    // having to ask. On next user message, VEGA will have this in context.
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

    // ── 4. Extract userId from parentSessionId ─────────────────────────────────
    // parentSessionId format: "user-{userId}" (set by /chat proxy in index.ts)
    let userId: string | null = null;
    if (parentSessionId) {
        const match = parentSessionId.match(/^user-(.+)$/);
        if (match) userId = match[1];
    }

    if (!userId) {
        console.log(`[CompletionCallback] No userId from session ${parentSessionId} — stored in Redis only`);
        return;
    }

    // ── 5. Push via Telegram (if connected) ────────────────────────────────────
    await pushViaTelegram(env, redis, userId, pushMessage, taskId).catch((e) =>
        console.warn(`[CompletionCallback] Telegram push failed: ${String(e)}`)
    );

    // ── 6. Push via WhatsApp (if connected) ────────────────────────────────────
    await pushViaWhatsApp(env, userId, pushMessage, parentSessionId).catch((e) =>
        console.warn(`[CompletionCallback] WhatsApp push failed: ${String(e)}`)
    );
}

// ─── Telegram Push ────────────────────────────────────────────────────────────

async function pushViaTelegram(
    env: Env,
    redis: ReturnType<typeof getRedis>,
    userId: string,
    message: string,
    taskId: string
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
    const { markdownToHtml: markdownToTelegramHtml } = await import("../telegram");
    const htmlMessage = markdownToTelegramHtml(message);

    // Send via Telegram Bot API
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
        throw new Error(`Telegram send failed: ${err.description}`);
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