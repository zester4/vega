/**
 * ============================================================================
 * src/telegram.ts — VEGA Telegram Bot Integration
 * ============================================================================
 *
 * Flow:
 *   1. User messages the bot on Telegram
 *   2. Telegram POSTs update to /telegram/webhook
 *   3. Worker verifies secret header, immediately returns 200
 *   4. Background: sends "typing…" action, runs runAgent()
 *   5. As tools execute, edits a live "⚙️ Working…" message in real-time
 *   6. Sends final formatted response when agent finishes
 *
 * Setup (one-time per bot):
 *   POST /telegram/setup { botToken }
 *   → stores token in Redis, calls setWebhook, returns bot info
 *
 * Features:
 *   - Live tool-execution progress (edits a message as tools run)
 *   - Full Markdown → Telegram HTML conversion (blockquotes, spoilers, code langs)
 *   - HTML-aware message splitting (never breaks tags or code blocks)
 *   - Commands: /start /help /reset /status /tasks /memory
 *   - Photo/document pass-through to agent
 *   - Rate limiting (10 msg/min per user)
 *   - Multi-user: each chat_id gets its own VEGA session in Redis
 *   - 4096 char limit handling (splits long messages beautifully)
 *
 * ============================================================================
 */

import {
    ensureTelegramConfigsTable as dbEnsureTable,
    getTelegramConfigBySecret as dbGetBySecret,
    getTelegramConfigByUserId as dbGetByUserId,
    insertTelegramConfig as dbInsertConfig,
    deleteTelegramConfigByUserId as dbDeleteByUserId,
    type TelegramConfigRow,
} from "./db/queries";
import { Client as QStashClient } from "@upstash/qstash";
import type { WorkflowPayload } from "./routes/workflow";

// ─── Telegram API Types ───────────────────────────────────────────────────────

export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
    message_id: number;
    from?: TelegramUser;
    chat: TelegramChat;
    date: number;
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    voice?: { file_id: string };
    reply_to_message?: TelegramMessage;
    entities?: TelegramEntity[];
}

export interface TelegramUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
}

export interface TelegramChat {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
    username?: string;
    first_name?: string;
}

export interface TelegramPhotoSize {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
}

export interface TelegramDocument {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}

export interface TelegramCallbackQuery {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
}

export interface TelegramEntity {
    type: string;
    offset: number;
    length: number;
}

export interface SendMessageOptions {
    parse_mode?: "HTML" | "MarkdownV2" | "Markdown";
    reply_to_message_id?: number;
    reply_markup?: TelegramInlineKeyboard;
    disable_web_page_preview?: boolean;
}

export interface TelegramInlineKeyboard {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

// ─── Bot Info (Redis or D1) ─────────────────────────────────────────────────────

export interface TelegramBotConfig {
    token: string;
    botId: number;
    username: string;
    firstName: string;
    webhookUrl: string;
    secret: string;
    connectedAt: string;
    /** Set when loaded from D1; used for per-user activity key */
    userId?: string;
}

// ─── TelegramBot API Client ───────────────────────────────────────────────────

export class TelegramBot {
    private token: string;
    private base: string;

    constructor(token: string) {
        this.token = token;
        this.base = `https://api.telegram.org/bot${token}`;
    }

    async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
        const res = await fetch(`${this.base}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
        });

        const data = await res.json() as { ok: boolean; result?: T; description?: string };
        if (!data.ok) {
            throw new Error(`Telegram API error [${method}]: ${data.description}`);
        }
        return data.result as T;
    }

    // ── Core messaging ──────────────────────────────────────────────────────────

    async sendMessage(
        chatId: number | string,
        text: string,
        opts: SendMessageOptions = {}
    ): Promise<TelegramMessage> {
        if (text.length <= 4096) {
            return this.call<TelegramMessage>("sendMessage", {
                chat_id: chatId,
                text,
                parse_mode: opts.parse_mode ?? "HTML",
                reply_to_message_id: opts.reply_to_message_id,
                reply_markup: opts.reply_markup,
                disable_web_page_preview: opts.disable_web_page_preview ?? true,
            });
        }

        // HTML-aware split for long messages
        const chunks = splitMessageSafe(text, 4000);
        let lastMsg!: TelegramMessage;
        for (const chunk of chunks) {
            lastMsg = await this.call<TelegramMessage>("sendMessage", {
                chat_id: chatId,
                text: chunk,
                parse_mode: opts.parse_mode ?? "HTML",
                disable_web_page_preview: true,
            });
        }
        return lastMsg;
    }

    async editMessageText(
        chatId: number | string,
        messageId: number,
        text: string,
        opts: SendMessageOptions = {}
    ): Promise<TelegramMessage | boolean> {
        try {
            return await this.call<TelegramMessage>("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: text.slice(0, 4096),
                parse_mode: opts.parse_mode ?? "HTML",
                disable_web_page_preview: true,
            });
        } catch (e) {
            if (String(e).includes("not modified")) return true;
            throw e;
        }
    }

    async deleteMessage(chatId: number | string, messageId: number): Promise<boolean> {
        try {
            return await this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
        } catch {
            return false;
        }
    }

    async sendChatAction(
        chatId: number | string,
        action: "typing" | "upload_photo" | "upload_document" = "typing"
    ): Promise<boolean> {
        try {
            return await this.call<boolean>("sendChatAction", { chat_id: chatId, action });
        } catch {
            return false;
        }
    }

    async answerCallbackQuery(queryId: string, text?: string): Promise<boolean> {
        return this.call<boolean>("answerCallbackQuery", { callback_query_id: queryId, text });
    }

    // ── Bot setup ────────────────────────────────────────────────────────────────

    async getMe(): Promise<TelegramUser> {
        return this.call<TelegramUser>("getMe");
    }

    async setWebhook(url: string, secret: string): Promise<boolean> {
        return this.call<boolean>("setWebhook", {
            url,
            secret_token: secret,
            allowed_updates: ["message", "edited_message", "callback_query"],
            drop_pending_updates: true,
        });
    }

    async deleteWebhook(): Promise<boolean> {
        return this.call<boolean>("deleteWebhook", { drop_pending_updates: true });
    }

    async getWebhookInfo(): Promise<{
        url: string;
        has_custom_certificate: boolean;
        pending_update_count: number;
        last_error_message?: string;
        last_error_date?: number;
    }> {
        return this.call("getWebhookInfo");
    }

    async getFile(fileId: string): Promise<{
        file_id: string;
        file_unique_id: string;
        file_size?: number;
        file_path: string;
    }> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.call<any>("getFile", { file_id: fileId });
    }

    async downloadFile(filePath: string): Promise<Uint8Array> {
        const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
        if (!res.ok) throw new Error(`File download failed: ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    }

    async sendVoice(
        chatId: number | string,
        voice: Uint8Array | string,
        opts: { reply_to_message_id?: number; caption?: string } = {}
    ): Promise<TelegramMessage> {
        const form = new FormData();
        form.append("chat_id", String(chatId));

        if (typeof voice === "string") {
            form.append("voice", voice);
        } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            form.append("voice", new Blob([voice] as any, { type: "audio/wav" }), "voice.wav");
        }

        if (opts.reply_to_message_id) form.append("reply_to_message_id", String(opts.reply_to_message_id));
        if (opts.caption) {
            form.append("caption", opts.caption.slice(0, 1024));
            form.append("parse_mode", "HTML");
        }
        const res = await fetch(`${this.base}/sendVoice`, { method: "POST", body: form });
        const data = await res.json() as { ok: boolean; result?: TelegramMessage; description?: string };
        if (!data.ok) throw new Error(`sendVoice failed: ${data.description}`);
        return data.result!;
    }

    async sendPhoto(
        chatId: number | string,
        imageBytes: Uint8Array,
        caption?: string
    ): Promise<TelegramMessage> {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        form.append("photo", new Blob([imageBytes] as any, { type: "image/png" }), "image.png");
        if (caption) {
            form.append("caption", caption.slice(0, 1024));
            form.append("parse_mode", "HTML");
        }
        const res = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
        const data = await res.json() as { ok: boolean; result?: TelegramMessage; description?: string };
        if (!data.ok) throw new Error(`sendPhoto failed: ${data.description}`);
        return data.result!;
    }
}

// ─── Main Update Handler ──────────────────────────────────────────────────────

/**
 * Process a Telegram update. Called inside waitUntil() so it runs after
 * the 200 OK is already returned to Telegram.
 */
export async function handleTelegramUpdate(
    update: TelegramUpdate,
    env: Env,
    config: TelegramBotConfig
): Promise<void> {
    const bot = new TelegramBot(config.token);

    if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, bot, env, config);
        return;
    }

    const msg = update.message ?? update.edited_message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text ?? msg.caption ?? "";

    if (!text && !msg.photo && !msg.document && !msg.voice) return;

    // ── Rate limiting: 10 messages/min per user ───────────────────────────────
    if (userId) {
        const { getRedis } = await import("./memory");
        const redis = getRedis(env);
        const rateKey = `tg:rate:${userId}`;
        const count = await redis.incr(rateKey);
        if (count === 1) await redis.expire(rateKey, 60);
        if (count > 10) {
            await bot.sendMessage(chatId,
                buildRateLimitMessage(),
                { parse_mode: "HTML" }
            );
            return;
        }
    }

    // ── Command routing ───────────────────────────────────────────────────────
    if (text.startsWith("/")) {
        await handleCommand(text, msg, bot, env, config);
        return;
    }

    // ── Regular message → run agent ───────────────────────────────────────────
    await processMessage(msg, text, bot, env, config);
}

// ─── Message Builders (beautiful, consistent HTML) ────────────────────────────

function buildRateLimitMessage(): string {
    return [
        `⚠️ <b>Slow down a little!</b>`,
        ``,
        `You've hit the rate limit of <b>10 messages per minute</b>.`,
        `Please wait a moment before sending more. ⏳`,
    ].join("\n");
}

function buildStartMessage(firstName: string): string {
    return [
        `👋 <b>Hey ${escapeHtml(firstName)}! I'm VEGA.</b>`,
        ``,
        `I'm an autonomous AI agent. Here's what I can do:`,
        ``,
        `🔍 <b>Search & Browse</b>  —  Web search, headless browser, Firecrawl deep scraping`,
        `🔐 <b>Secure Vault</b>  —  Encrypted per-user storage for your API keys`,
        `🧠 <b>Remember Forever</b>  —  Persistent memory + vector semantic recall`,
        `💻 <b>Run Code</b>  —  Execute Python, analyze data, generate charts`,
        `🤖 <b>Spawn Sub-agents</b>  —  Parallel AI workers for complex tasks`,
        `📁 <b>Manage Files</b>  —  R2 cloud storage for reports and documents`,
        `⚙️ <b>Build New Tools</b>  —  Self-extends capabilities on demand`,
        `🔔 <b>Schedule Jobs</b>  —  Recurring cron jobs with proactive alerts`,
        `🎨 <b>Generate Images</b>  —  Nano Banana 2 image generation`,
        `📊 <b>Market Intelligence</b>  —  Live prices, portfolio tracking, price alerts`,
        `🎙️ <b>Voice Mode</b>  —  Send voice, get Gemini voice replies (30+ voices)`,
        `🌍 <b>25+ Languages</b>  —  Auto-detects and responds in your language`,
        `🎯 <b>Goal Tracking</b>  —  Long-term goal pursuit across sessions`,
        ``,
        `<b>Commands:</b>`,
        `/help — Full command list`,
        `/reset — Clear conversation history`,
        `/status — Agent status & heartbeat`,
        `/vault — Your stored API keys`,
        `/logs — Recent execution logs`,
        `/tasks — Background tasks & cron jobs`,
        `/memory — Stored memories`,
        `/goals — Active goal tracker`,
        `/tools — List all available agent tools`,
        `/heartbeat — Ensure system cron is active`,
        `/voice_on — Enable voice replies`,
        `/voice_off — Disable voice replies`,
    ].join("\n");
}

function buildHelpMessage(): string {
    return [
        `📖 <b>VEGA — Command Reference</b>`,
        ``,
        `/start — Welcome message & capabilities`,
        `/help — This reference`,
        `/reset — Clear conversation history`,
        `/status — Agent status & heartbeat`,
        `/vault — Your stored API keys`,
        `/logs — Recent execution logs`,
        `/tasks — Background tasks & cron jobs`,
        `/memory — Stored memories`,
        `/goals — Active goal tracker`,
        `/tools — List all available agent tools`,
        `/heartbeat — Ensure system cron is active`,
        `/voice_on — Enable voice replies`,
        `/voice_off — Disable voice replies`,
        ``,
        `💡 <b>Pro Tips</b>`,
        `• Send a <b>voice message</b> — I'll transcribe and respond`,
        `• Send a <b>photo</b> — I'll analyze it with Gemini Vision`,
        `• <i>"Generate an image of..."</i> — Nano Banana 2 image gen`,
        `• <i>"What's the price of BTC?"</i> — live Yahoo Finance data`,
        `• <i>"Track goal: ..."</i> — I'll remember and pursue it`,
        `• <i>"Set a price alert for AAPL above $200"</i> — push alerts`,
        `• <i>"Create a tool that..."</i> — extend my capabilities on the fly`,
        `• <i>"Translate this to Spanish:"</i> — 32+ languages supported`,
    ].join("\n");
}

function buildStatusMessage(uptime: string, errors: number, reflection?: string): string {
    const errorEmoji = errors === 0 ? "✅" : errors < 5 ? "⚠️" : "🔴";
    const lines = [
        `<b>⚡ VEGA System Status</b>`,
        ``,
        `🟢  <b>Core:</b>  Active`,
        `🔄  <b>Last heartbeat:</b>  ${escapeHtml(uptime)}`,
        `${errorEmoji}  <b>Recent errors:</b>  ${errors}`,
        `🌐  <b>Platform:</b>  Cloudflare Workers Edge`,
    ];
    if (reflection) {
        lines.push(``, `<blockquote>${escapeHtml(reflection)}</blockquote>`);
    }
    return lines.join("\n");
}

function buildTasksMessage(agents: Array<{ agentName?: string; agentId?: string; status?: string }>): string {
    const lines = [`<b>🤖 Background Tasks</b>`, ``];
    for (const a of agents.slice(0, 8)) {
        const icon = a.status === "running" ? "⏳" : a.status === "done" ? "✅" : "❌";
        const name = escapeHtml(a.agentName ?? "Unknown");
        const id = escapeHtml(a.agentId ?? "—");
        const status = escapeHtml(a.status ?? "unknown");
        lines.push(`${icon}  <b>${name}</b>`);
        lines.push(`    ID: <code>${id}</code>  ·  Status: <i>${status}</i>`);
        lines.push(``);
    }
    return lines.join("\n").trim();
}

function buildMemoryMessage(
    entries: Array<{ key: string; value: string }>,
    total: number
): string {
    const lines = [`<b>🧠 Stored Memories</b>  <i>(${total} total)</i>`, ``];
    for (const { key, value } of entries) {
        lines.push(`• <b>${escapeHtml(key)}</b>`);
        lines.push(`  <i>${escapeHtml(value.slice(0, 80))}${value.length > 80 ? "…" : ""}</i>`);
    }
    if (total > entries.length) {
        lines.push(``, `<i>…and ${total - entries.length} more stored memories</i>`);
    }
    return lines.join("\n");
}

function buildToolsMessage(builtinNames: string[], customNames: string[]): string {
    const lines = [
        `<b>🔧 Available Tools</b>`,
        ``,
        `<b>Built-in  (${builtinNames.length})</b>`,
        builtinNames.map(n => `<code>${n}</code>`).join("  "),
    ];
    if (customNames.length > 0) {
        lines.push(``, `<b>Custom — Self-built  (${customNames.length})</b>`);
        lines.push(customNames.map(n => `<code>${n}</code>`).join("  "));
    }
    lines.push(``, `<i>Tip: Ask me what any tool does to learn more!</i>`);
    return lines.join("\n");
}

function buildHeartbeatMessage(result: { success: boolean; status?: string; cron?: string; error?: string }): string {
    if (!result.success) {
        return `❌ <b>Heartbeat Setup Failed</b>\n\n<code>${escapeHtml(result.error ?? "Unknown error")}</code>`;
    }
    return [
        `✅ <b>System Heartbeat Active</b>`,
        ``,
        `<b>Status:</b>  ${escapeHtml(result.status ?? "registered")}`,
        `<b>Schedule:</b>  <code>${escapeHtml(result.cron ?? "—")}</code>`,
        `<b>Purpose:</b>  Reflection, self-healing, tool evolution`,
        ``,
        `<i>VEGA is now autonomously monitoring itself every hour.</i>`,
    ].join("\n");
}

function buildVaultMessage(
    secrets: Array<{ key_name: string; hint: string; description: string | null }>,
    total: number
): string {
    const lines = [`<b>🔐 Your Secure Vault</b>  <i>(${total} keys stored)</i>`, ``];
    if (total === 0) {
        lines.push(`<i>Your vault is empty.</i>`);
        lines.push(``);
        lines.push(`Ask me to <i>"remember my OpenAI key"</i> or similar to store secrets securely.`);
    } else {
        for (const s of secrets) {
            lines.push(`• <b>${escapeHtml(s.key_name)}</b>`);
            lines.push(`  Hint: <code>${escapeHtml(s.hint)}</code>${s.description ? `  ·  <i>${escapeHtml(s.description)}</i>` : ""}`);
        }
        lines.push(``, `<i>Plaintext values are NEVER shown. These keys are only accessible by me when you explicitly ask.</i>`);
    }
    return lines.join("\n");
}

function buildGoalsMessage(
    goals: Array<{ id: string; title: string; progress: number; priority: string; status: string; nextAction?: string }>,
    activeCount: number,
    total: number
): string {
    const lines = [`<b>🎯 Active Goals</b>  <i>(${activeCount} active)</i>`, ``];

    for (const goal of goals.slice(0, 8)) {
        const filled = Math.round(goal.progress / 10);
        const bar = "█".repeat(filled) + "░".repeat(10 - filled);
        const pIcon =
            goal.priority === "critical" ? "🔴" :
                goal.priority === "high" ? "🟠" :
                    goal.priority === "medium" ? "🟡" : "🟢";

        lines.push(`${pIcon} <b>${escapeHtml(goal.title)}</b>`);
        lines.push(`<code>[${bar}]</code>  <b>${goal.progress}%</b>`);
        if (goal.nextAction) {
            lines.push(`<blockquote>📌 ${escapeHtml(goal.nextAction.slice(0, 120))}</blockquote>`);
        }
        lines.push(``);
    }

    if (total > 8) {
        lines.push(`<i>…and ${total - 8} more goals</i>`);
    }

    return lines.join("\n").trim();
}

// ─── Progress Message Builder ─────────────────────────────────────────────────

/**
 * Build the live "Working…" progress message shown while the agent runs.
 * Uses tool categories and a clean visual layout.
 */
function buildProgressMessage(
    activeTools: string[],
    completedTools: string[],
    preamble?: string
): string {
    const lines: string[] = [];

    if (preamble) {
        lines.push(preamble, ``);
    }

    if (activeTools.length === 0 && completedTools.length === 0) {
        lines.push(`⚙️ <b>Starting up…</b>`);
        return lines.join("\n");
    }

    const currentTool = activeTools[activeTools.length - 1];

    if (currentTool) {
        const icon = getTelegramToolIcon(currentTool);
        const category = getToolCategory(currentTool);
        lines.push(`⚙️ <b>Working…</b>  <i>${escapeHtml(category)}</i>`);
        lines.push(``);
        lines.push(`${icon}  Running  <code>${escapeHtml(currentTool)}</code>`);
    } else {
        lines.push(`⚙️ <b>Finalizing response…</b>`);
    }

    if (completedTools.length > 0) {
        const last3 = completedTools.slice(-3);
        lines.push(``);
        lines.push(`<i>Completed: ${last3.map(t => `<code>${escapeHtml(t)}</code>`).join("  ")}</i>`);
    }

    return lines.join("\n");
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleCommand(
    text: string,
    msg: TelegramMessage,
    bot: TelegramBot,
    env: Env,
    config: TelegramBotConfig
): Promise<void> {
    const chatId = msg.chat.id;
    const command = text.split(" ")[0].toLowerCase().replace(`@${config.username}`, "");

    switch (command) {
        case "/start": {
            const name = msg.from?.first_name ?? "there";
            await bot.sendMessage(chatId, buildStartMessage(name), { parse_mode: "HTML" });
            break;
        }

        case "/help": {
            await bot.sendMessage(chatId, buildHelpMessage(), { parse_mode: "HTML" });
            break;
        }

        case "/goals": {
            const { executeTool } = await import("./tools/builtins");
            const result = await executeTool("manage_goals", { action: "list_goals" }, env) as {
                goals?: Array<{ id: string; title: string; progress: number; priority: string; status: string; nextAction?: string }>;
                count?: number;
                activeCount?: number;
            };

            if (!result.goals?.length) {
                await bot.sendMessage(chatId,
                    `🎯 <b>No goals set yet.</b>\n\nTell me your goals and I'll track and pursue them automatically!`,
                    { parse_mode: "HTML" }
                );
                break;
            }

            await bot.sendMessage(
                chatId,
                buildGoalsMessage(result.goals, result.activeCount ?? 0, result.goals.length),
                { parse_mode: "HTML" }
            );
            break;
        }

        case "/voice_on": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            await redis.set(`tg:voice:${chatId}`, "1", { ex: 60 * 60 * 24 * 30 });
            await bot.sendMessage(chatId,
                `🎙️ <b>Voice replies enabled!</b>\n\nI'll now respond with voice messages. Send me a voice message to try it out!\n\n<i>Send /voice_off to switch back to text.</i>`,
                { parse_mode: "HTML" }
            );
            break;
        }

        case "/voice_off": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            await redis.del(`tg:voice:${chatId}`);
            await bot.sendMessage(chatId,
                `🔇 <b>Voice replies disabled.</b>  Text mode restored.`,
                { parse_mode: "HTML" }
            );
            break;
        }

        case "/reset": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            const sessionKey = `tg:session:${chatId}`;
            const sessionId = await redis.get(sessionKey) as string | null;

            if (sessionId) {
                await redis.del(`session:${sessionId}:history`);
                await redis.del(`session:${sessionId}`);
                await redis.del(sessionKey);
            }

            await bot.sendMessage(chatId,
                `🔄 <b>Conversation reset.</b>\n\nChat history cleared — fresh start! ✨`,
                { parse_mode: "HTML" }
            );
            break;
        }

        case "/status": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            const lastTick = await redis.get("agent:last-tick") as string | null;
            const errors = await redis.llen("agent:errors");
            const tick = lastTick ? JSON.parse(lastTick) : null;
            const uptime = tick ? formatRelativeTime(tick.timestamp) : "No heartbeat yet";

            await bot.sendMessage(chatId,
                buildStatusMessage(uptime, errors, tick?.reflection),
                { parse_mode: "HTML" }
            );
            break;
        }

        case "/vault": {
            const { executeTool } = await import("./tools/builtins");
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            const sessionId = await redis.get(`tg:session:${chatId}`) as string | null;

            const result = await executeTool("list_secrets", {}, env, sessionId ?? undefined) as {
                secrets?: Array<{ key_name: string; hint: string; description: string | null }>;
                count?: number;
            };

            await bot.sendMessage(
                chatId,
                buildVaultMessage(result.secrets ?? [], result.count ?? 0),
                { parse_mode: "HTML" }
            );
            break;
        }

        case "/logs": {
            const { executeTool } = await import("./tools/builtins");
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            const sessionId = await redis.get(`tg:session:${chatId}`) as string | null;

            const result = await executeTool("read_audit_log", { limit: 8 }, env, sessionId ?? undefined) as {
                entries?: any[];
                count?: number;
            };

            if (!result.entries?.length) {
                await bot.sendMessage(chatId, "📋 <b>No logs found.</b>", { parse_mode: "HTML" });
                break;
            }

            const lines = [`<b>📋 Recent Activity Logs</b>`, ``];
            for (const entry of result.entries) {
                const icon = entry.status === "ok" ? "✅" : entry.status === "error" ? "❌" : "🚫";
                lines.push(`${icon} <b>${escapeHtml(entry.tool_name)}</b>`);
                lines.push(`   <code>${escapeHtml(entry.created_at.slice(11, 16))}</code> · <i>${escapeHtml(entry.status)}</i>`);
            }

            await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
            break;
        }

        case "/tasks": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            const raw = await redis.lrange("agent:spawned", 0, 9) as string[];

            if (raw.length === 0) {
                await bot.sendMessage(chatId,
                    `📋 <b>No background tasks running.</b>\n\n<i>Spawn a sub-agent or trigger a workflow to see tasks here.</i>`,
                    { parse_mode: "HTML" }
                );
                break;
            }

            const agents = raw.map((r: string) => {
                try { return JSON.parse(r); } catch { return null; }
            }).filter(Boolean);

            await bot.sendMessage(chatId, buildTasksMessage(agents), { parse_mode: "HTML" });
            break;
        }

        case "/memory": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            const chatSession = await redis.get(`tg:session:${chatId}`) as string | null;

            if (!chatSession) {
                await bot.sendMessage(chatId,
                    `🧠 <b>No memories yet.</b>\n\nStart chatting and I'll remember important things automatically!`,
                    { parse_mode: "HTML" }
                );
                break;
            }

            const keys = await redis.keys("agent:memory:*") as string[];

            if (keys.length === 0) {
                await bot.sendMessage(chatId,
                    `🧠 <b>Memory is empty.</b>\n\nAsk me to remember something!`,
                    { parse_mode: "HTML" }
                );
                break;
            }

            const displayKeys = keys.slice(0, 10);
            const entries: Array<{ key: string; value: string }> = [];

            for (const key of displayKeys) {
                const val = await redis.get(key) as string | null;
                entries.push({ key: key.replace("agent:memory:", ""), value: String(val ?? "") });
            }

            await bot.sendMessage(chatId, buildMemoryMessage(entries, keys.length), { parse_mode: "HTML" });
            break;
        }

        case "/tools": {
            const { getRedis, listTools } = await import("./memory");
            const { BUILTIN_DECLARATIONS } = await import("./tools/builtins");
            const redis = getRedis(env);
            const customTools = await listTools(redis);

            const builtinNames = BUILTIN_DECLARATIONS.map(t => t.name);
            const customNames = customTools.map(t => t.name);

            await bot.sendMessage(chatId, buildToolsMessage(builtinNames, customNames), { parse_mode: "HTML" });
            break;
        }

        case "/heartbeat": {
            const { executeTool } = await import("./tools/builtins");
            await bot.sendChatAction(chatId, "typing");
            const result = await executeTool("setup_system_heartbeat", {}, env) as {
                success: boolean; status?: string; cron?: string; error?: string;
            };
            await bot.sendMessage(chatId, buildHeartbeatMessage(result), { parse_mode: "HTML" });
            break;
        }

        default: {
            const args = text.slice(command.length).trim();
            if (args) {
                await processMessage(msg, args, bot, env, config);
            } else {
                await bot.sendMessage(chatId,
                    `❓ Unknown command: <code>${escapeHtml(command)}</code>\n\nType /help to see all available commands.`,
                    { parse_mode: "HTML" }
                );
            }
        }
    }
}

// ─── Main Message Processor ───────────────────────────────────────────────────

async function processMessage(
    msg: TelegramMessage,
    userText: string,
    bot: TelegramBot,
    env: Env,
    config: TelegramBotConfig
): Promise<void> {
    const chatId = msg.chat.id;
    const { getRedis } = await import("./memory");
    const redis = getRedis(env);
    const sessionKey = `tg:session:${chatId}`;

    let sessionId = await redis.get(sessionKey) as string | null;
    if (!sessionId) {
        sessionId = `tg-${chatId}-${Date.now()}`;
        await redis.set(sessionKey, sessionId);
    }

    // Ensure sessionId is mapped to userId in Redis for tool execution context
    // and store userId -> chatId mapping for proactive notifications
    if (config.userId) {
        await Promise.all([
            redis.set(`session:user-map:${sessionId}`, config.userId, { ex: 60 * 60 * 24 * 30 }),
            redis.set(`telegram:chat-id:${config.userId}`, String(chatId), { ex: 60 * 60 * 24 * 7 })
        ]);
    }

    let fullMessage = userText;
    let transcribedVoice = false;

    // ── VOICE MESSAGE → Transcribe with Gemini STT ──────────────────────────────
    if (msg.voice?.file_id) {
        try {
            await bot.sendChatAction(chatId, "typing");
            const { transcribeTelegramVoice } = await import("./tools/voice");
            const transcript = await transcribeTelegramVoice(msg.voice.file_id, config.token, env);

            if (transcript) {
                fullMessage = transcript;
                transcribedVoice = true;
                console.log(`[Telegram Voice] Transcribed: "${transcript.slice(0, 100)}"`);
            } else {
                fullMessage = "[User sent a voice message — transcription unavailable.]";
            }
        } catch (voiceErr) {
            console.error("[Telegram Voice] STT failed:", voiceErr);
            fullMessage = "[User sent a voice message — transcription failed.]";
        }
    }

    // ── PHOTO → Gemini Vision description ───────────────────────────────────────
    if (msg.photo && msg.photo.length > 0) {
        try {
            const photo = msg.photo[msg.photo.length - 1];
            const file = await bot.getFile(photo.file_id);
            const imageBytes = await bot.downloadFile(file.file_path);
            const base64 = btoa(String.fromCharCode(...imageBytes));
            const ext = file.file_path.split(".").pop() ?? "jpg";
            const mimeType = ext === "png" ? "image/png" : "image/jpeg";

            const { analyzeImage } = await import("./gemini");
            const description = await analyzeImage(
                env.GEMINI_API_KEY,
                base64,
                mimeType,
                userText
                    ? `The user sent this image with the message: "${userText}". Describe the image in detail and address their message.`
                    : "Describe this image in detail. Note all visible elements, text, objects, people, colors, and context."
            );

            fullMessage = userText
                ? `[User sent a photo with caption: "${userText}"]\n\nVision Analysis:\n${description}`
                : `[User sent a photo]\n\nVision Analysis:\n${description}`;
        } catch (visionErr) {
            console.error("[Telegram Vision] Failed:", visionErr);
            fullMessage = `[User sent a photo${userText ? `: ${userText}` : ". Describe what you can infer."}]`;
        }
    }

    // ── DOCUMENT handling ────────────────────────────────────────────────────────
    if (msg.document) {
        try {
            await bot.sendChatAction(chatId, "upload_document");
            const file = await bot.getFile(msg.document.file_id);
            const bytes = await bot.downloadFile(file.file_path);
            const mimeType = msg.document.mime_type ?? "application/octet-stream";

            const { uploadToGemini } = await import("./gemini");
            const { fileUri } = await uploadToGemini(env.GEMINI_API_KEY, bytes, mimeType, msg.document.file_name);

            (msg as any)._vega_attachment = {
                mimeType,
                data: btoa(String.fromCharCode(...bytes)),
                name: msg.document.file_name
            };

            fullMessage = userText
                ? `[User sent document: ${msg.document.file_name ?? "unknown"}] ${userText}`
                : `[User sent document: ${msg.document.file_name ?? "unknown"}] Analyze this file.`;

            console.log(`[Telegram Document] Uploaded to Gemini: ${fileUri} (${mimeType})`);
        } catch (docErr) {
            console.error("[Telegram Document] Failed:", docErr);
            fullMessage = `[User sent document: ${msg.document.file_name ?? "unknown"}${userText ? ` — ${userText}` : ""}]`;
        }
    }

    if (!fullMessage.trim()) return;

    // ── Auto-detect language ──────────────────────────────────────────────────────
    let detectedLang = "en";
    if (fullMessage.length > 10 && !transcribedVoice) {
        try {
            const { detectUserLanguage } = await import("./tools/translate");
            detectedLang = await detectUserLanguage(fullMessage, env);
        } catch { /* non-fatal */ }
    }

    // ── Check for paused workflow waiting for this user's reply ────────────────
    //
    // If the previous agent called wait_for_user_input(), it stored:
    // tg:awaiting-workflow:{chatId} = { eventId, sessionId, question }
    //
    // We detect this and notify the workflow instead of spawning a new one.
    const pausedWorkflow = await redis.get(`tg:awaiting-workflow:${chatId}`) as string | null;

    if (pausedWorkflow) {
        try {
            const { eventId } = JSON.parse(pausedWorkflow) as { eventId: string };

            // Clear the waiting flag immediately (prevent double-fire)
            await redis.del(`tg:awaiting-workflow:${chatId}`).catch(() => { });

            const workerBase = (env.UPSTASH_WORKFLOW_URL ?? env.WORKER_URL ?? "").replace(/\/$/, "");

            // Wake the suspended workflow with the user's reply
            const notifyRes = await fetch(`${workerBase}/workflow/notify`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-internal-secret": env.TELEGRAM_INTERNAL_SECRET ?? "",
                },
                body: JSON.stringify({
                    eventId,
                    eventData: {
                        text: fullMessage,
                        chatId,
                        from: msg.from,
                        ts: Date.now(),
                    },
                }),
            });

            if (notifyRes.ok) {
                await bot.sendMessage(chatId,
                    `▶️ <b>Got it!</b> Continuing your task...`,
                    { parse_mode: "HTML" }
                ).catch(() => { });
                console.log(`[Telegram] Resumed paused workflow via notify — eventId: ${eventId}`);
                return; // ← Don't dispatch a new workflow
            } else {
                console.warn(`[Telegram] Workflow notify failed (${notifyRes.status}) — falling through to new workflow`);
                // Fall through and dispatch a new workflow if notify failed
            }
        } catch (resumeErr) {
            console.error("[Telegram] Error resuming paused workflow:", String(resumeErr));
            // Fall through and dispatch a new workflow
        }
    }

    // ── Dispatch to durable workflow (normal path) ────────────────────────────
    const taskId = `tg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const workerBase = (env.UPSTASH_WORKFLOW_URL ?? env.WORKER_URL ?? "").replace(/\/$/, "");

    try {
        const qstash = new QStashClient({
            token: env.QSTASH_TOKEN,
            baseUrl: env.QSTASH_URL,
        });

        const deliveryKey = `tg:delivery:${config.userId}`;
        await redis.set(deliveryKey, JSON.stringify({
            token: config.token,
            chatId: chatId,
        }), { ex: 60 * 60 * 24 * 30 }).catch(() => { });

        const { buildSystemPrompt } = await import("./agent");
        const built = await buildSystemPrompt(env, config.userId).catch(() => null);

        await qstash.publishJSON({
            url: `${workerBase}/workflow`,
            body: {
                taskId,
                sessionId,
                taskType: "sub_agent",
                instructions: fullMessage,
                agentConfig: {
                    name: `tg-agent-${chatId}`,
                    allowedTools: null,
                    memoryPrefix: `tg-${chatId}`,
                    notifyEmail: null,
                    spawnedAt: new Date().toISOString(),
                    parentAgent: "telegram-webhook",
                    parentSessionId: sessionId,
                    userId: config.userId ?? null,
                    systemPrompt: built?.prompt ?? null,
                },
            },
        });

        await bot.sendChatAction(chatId, "typing").catch(() => { });
    } catch (dispatchErr) {
        console.error("[Telegram] Workflow dispatch failed:", String(dispatchErr));
        await bot.sendMessage(chatId, "⚠️ I had trouble starting that. Please try again.").catch(() => { });
    }

    // ── Log activity ──────────────────────────────────────────────────────────────
    const activityKey = config.userId ? `tg:activity:${config.userId}` : "tg:activity";
    try {
        await redis.lpush(activityKey, JSON.stringify({
            chatId,
            username: msg.from?.username ?? `user_${msg.from?.id}`,
            firstName: msg.from?.first_name,
            messagePreview: fullMessage.slice(0, 100),
            replyPreview: "(Workflow dispatched)",
            wasVoice: transcribedVoice,
            detectedLang,
            ts: Date.now(),
        }));
        await redis.ltrim(activityKey, 0, 49);
    } catch { /* non-fatal */ }
}

// ─── Caption & Error Builders ─────────────────────────────────────────────────

function buildVoiceCaption(): string {
    return `🎙️ <b>Voice Reply</b>  ·  <i>Tap to listen</i>`;
}

/**
 * Build a beautiful image caption from a description string.
 * Trims to Telegram's 1024-char caption limit, preserving HTML integrity.
 */
function buildImageCaption(description: string, mimeType?: string): string {
    const ext = mimeType?.split("/")[1]?.toUpperCase() ?? "PNG";
    const rawDesc = description.length > 700 ? description.slice(0, 697) + "…" : description;
    const escapedDesc = escapeHtml(rawDesc);
    return `🎨 <b>Generated Image</b>  ·  <i>${ext}</i>\n\n${escapedDesc}`;
}

function buildErrorMessage(errText: string): string {
    return [
        `❌ <b>Something went wrong</b>`,
        ``,
        `<blockquote>${escapeHtml(errText.slice(0, 300))}</blockquote>`,
        ``,
        `<i>Please try again or type /reset to start fresh.</i>`,
    ].join("\n");
}

// ─── Callback Query Handler ───────────────────────────────────────────────────

async function handleCallbackQuery(
    query: TelegramCallbackQuery,
    bot: TelegramBot,
    env: Env,
    config: TelegramBotConfig
): Promise<void> {
    await bot.answerCallbackQuery(query.id);
    // Future: handle inline keyboard button actions
}

// ─── Setup & Management Functions ────────────────────────────────────────────

export async function getTelegramSecret(botToken: string): Promise<string> {
    const secretBytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`vega-${botToken}`)
    );
    return Array.from(new Uint8Array(secretBytes))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 64);
}

function rowToConfig(row: TelegramConfigRow, userId?: string): TelegramBotConfig {
    const c: TelegramBotConfig = {
        token: row.token,
        botId: row.bot_id,
        username: row.username,
        firstName: row.first_name,
        webhookUrl: row.webhook_url,
        secret: row.secret,
        connectedAt: row.connected_at,
    };
    if (userId) c.userId = userId;
    return c;
}

function getDb(env: Env): D1Database | null {
    return (env as { DB?: D1Database }).DB ?? null;
}

export async function ensureTelegramConfigsTable(env: Env): Promise<void> {
    const db = getDb(env);
    if (!db) return;
    await dbEnsureTable(db);
}

export async function getTelegramConfigBySecret(env: Env, secret: string): Promise<TelegramBotConfig | null> {
    const db = getDb(env);
    if (!db) return null;
    const row = await dbGetBySecret(db, secret);
    if (!row) return null;
    return rowToConfig(row, row.user_id);
}

export async function getTelegramConfigByUserId(env: Env, userId: string): Promise<TelegramBotConfig | null> {
    const db = getDb(env);
    if (!db) return null;
    const row = await dbGetByUserId(db, userId);
    if (!row) return null;
    return rowToConfig(row, userId);
}

export async function insertTelegramConfig(env: Env, userId: string, config: TelegramBotConfig): Promise<void> {
    const db = getDb(env);
    if (!db) throw new Error("D1 not bound");
    await dbEnsureTable(db);
    await dbInsertConfig(db, userId, {
        token: config.token,
        secret: config.secret,
        bot_id: config.botId,
        username: config.username,
        first_name: config.firstName,
        webhook_url: config.webhookUrl,
        connected_at: config.connectedAt,
    });
}

export async function deleteTelegramConfigByUserId(env: Env, userId: string): Promise<void> {
    const db = getDb(env);
    if (!db) return;
    await dbDeleteByUserId(db, userId);
}

export function verifyTelegramInternalSecret(env: Env, header: string | null): boolean {
    const expected = (env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
    if (!expected || !header) return false;
    if (header.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
}

export async function setupTelegramBot(
    botToken: string,
    workerUrl: string,
    env: Env,
    userId?: string
): Promise<TelegramBotConfig> {
    const bot = new TelegramBot(botToken);

    let me: TelegramUser;
    try {
        me = await bot.getMe();
    } catch {
        throw new Error("Invalid bot token. Create a bot at https://t.me/BotFather and copy the token.");
    }

    const secret = await getTelegramSecret(botToken);
    const webhookUrl = `${workerUrl}/telegram/webhook`;
    await bot.setWebhook(webhookUrl, secret);

    const config: TelegramBotConfig = {
        token: botToken,
        botId: me.id,
        username: me.username ?? `bot_${me.id}`,
        firstName: me.first_name,
        webhookUrl,
        secret,
        connectedAt: new Date().toISOString(),
    };

    const db = (env as { DB?: D1Database }).DB;
    if (userId && db) {
        await ensureTelegramConfigsTable(env);
        await insertTelegramConfig(env, userId, config);
        config.userId = userId;
        console.log(`[Telegram Setup] Saved config for user ${userId} to D1 (@${config.username}).`);
        return config;
    }

    console.warn("[Telegram Setup] Missing userId or D1 binding. No config was persisted.");
    return config;
}

export async function disconnectTelegramBot(env: Env, userId?: string): Promise<void> {
    const db = (env as { DB?: D1Database }).DB;

    if (userId && db) {
        const config = await getTelegramConfigByUserId(env, userId);
        if (config) {
            try {
                const bot = new TelegramBot(config.token);
                await bot.deleteWebhook().catch(err => {
                    console.error("[Telegram Disconnect] Failed to delete webhook:", err);
                });
            } catch (_) { /* ignore */ }
            await deleteTelegramConfigByUserId(env, userId);
            console.log(`[Telegram Disconnect] Config removed from D1 for user ${userId}.`);
        }
        return;
    }

    console.warn("[Telegram Disconnect] Called without userId/DB. No action taken.");
}

export async function getTelegramConfig(_env: Env): Promise<TelegramBotConfig | null> {
    console.warn("[Telegram Config] Legacy global config is disabled. Use per-user D1 configs instead.");
    return null;
}

export function verifyWebhookSecret(headerSecret: string | null, expectedSecret: string): boolean {
    if (!headerSecret) return false;
    if (headerSecret.length !== expectedSecret.length) return false;
    let diff = 0;
    for (let i = 0; i < headerSecret.length; i++) {
        diff |= headerSecret.charCodeAt(i) ^ expectedSecret.charCodeAt(i);
    }
    return diff === 0;
}

// ─── Core HTML Formatter ──────────────────────────────────────────────────────

/**
 * Convert agent Markdown output to Telegram-safe HTML.
 *
 * Supported Telegram HTML tags (as of Bot API 9.x):
 *   <b> <i> <u> <s> <code> <pre> <a href=""> <tg-spoiler>
 *   <blockquote> <blockquote expandable>
 *   <pre><code class="language-*">
 *
 * Strategy:
 *   1. Extract code blocks + inline code → replace with placeholders
 *   2. Extract blockquotes (> …) → replace with placeholders
 *   3. Process tables → convert to <pre> monospace grid
 *   4. Escape all remaining HTML special chars (&, <, >, ")
 *   5. Apply remaining inline markdown rules
 *   6. Restore all placeholders
 */
export function markdownToHtml(text: string): string {
    const slots = new Map<string, string>();
    let n = 0;
    const slot = (html: string): string => {
        const id = `\x00SLOT${n++}\x00`;
        slots.set(id, html);
        return id;
    };
    const restore = (s: string): string => {
        let result = s;
        // Iterate until fully resolved (handles nested placeholders)
        let prev = "";
        while (prev !== result) {
            prev = result;
            slots.forEach((html, id) => { result = result.split(id).join(html); });
        }
        return result;
    };

    let r = text;

    // ── 1. Fenced code blocks: ```lang\ncode``` ───────────────────────────────
    r = r.replace(/```(\w*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
        const trimmed = code.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
        const escaped = escapeHtml(trimmed);
        const normalized = lang.toLowerCase().trim();

        // Map common aliases to Telegram-supported language identifiers
        const langMap: Record<string, string> = {
            js: "javascript", ts: "typescript", py: "python",
            sh: "bash", shell: "bash", zsh: "bash",
            yml: "yaml", rb: "ruby", rs: "rust",
            cs: "csharp", "c#": "csharp", kt: "kotlin",
            md: "markdown", dockerfile: "docker",
        };
        const langClass = normalized ? (langMap[normalized] ?? normalized) : "";

        const inner = langClass
            ? `<code class="language-${langClass}">${escaped}</code>`
            : escaped;
        return slot(`<pre>${inner}</pre>`);
    });

    // ── 2. Inline code: `code` ────────────────────────────────────────────────
    r = r.replace(/`([^`\n]+?)`/g, (_, code) => slot(`<code>${escapeHtml(code)}</code>`));

    // ── 3. Markdown tables → monospace <pre> ──────────────────────────────────
    r = r.replace(/((?:^[^\n]*\|[^\n]*\n)+)/gm, (tableBlock) => {
        const lines = tableBlock.trim().split("\n");
        const isSeparator = (l: string) => /^[\s|:\-]+$/.test(l);
        const rows = lines.filter(l => !isSeparator(l));
        const cells = rows.map(l =>
            l.split("|").map(c => c.trim()).filter((c, i, a) => !(i === 0 && c === "") && !(i === a.length - 1 && c === ""))
        );
        if (cells.length === 0) return tableBlock;
        const colWidths = cells[0].map((_, ci) =>
            Math.max(...cells.map(row => (row[ci] ?? "").length))
        );
        const formatted = cells.map((row, ri) => {
            const line = row.map((cell, ci) => cell.padEnd(colWidths[ci] ?? 0)).join("  │  ");
            const divider = ri === 0 ? "\n" + colWidths.map(w => "─".repeat(w)).join("──┼──") : "";
            return line + divider;
        }).join("\n");
        return slot(`<pre>${escapeHtml(formatted)}</pre>`);
    });

    // ── 4. Blockquotes (> …) ─────────────────────────────────────────────────
    // Collapse consecutive > lines into one blockquote block
    r = r.replace(/((?:^>[ \t]?.+\n?)+)/gm, (block) => {
        const inner = block
            .split("\n")
            .map(l => l.replace(/^>[ \t]?/, "").trim())
            .filter(Boolean)
            .join("\n");
        // Use expandable for long quotes (> 3 lines), plain for short
        const lineCount = inner.split("\n").length;
        const tag = lineCount > 3 ? "blockquote expandable" : "blockquote";
        // We escape AFTER processing inline markdown, so use a two-step approach:
        // For now store raw text; we'll apply inline formatting inside the restore pass
        return slot(`<${tag}>${escapeHtml(inner)}</${tag.split(" ")[0]}>`);
    });

    // ── 5. Escape remaining prose ─────────────────────────────────────────────
    r = escapeHtml(r);

    // ── 6. Apply inline Markdown rules ───────────────────────────────────────

    // H1 → underlined bold with separator
    r = r.replace(/^#{1}\s+(.+)$/gm, (_, t) => `\n<b><u>${t}</u></b>\n`);
    // H2 → bold
    r = r.replace(/^#{2}\s+(.+)$/gm, (_, t) => `\n<b>${t}</b>\n`);
    // H3 → bold italic
    r = r.replace(/^#{3}\s+(.+)$/gm, (_, t) => `<b><i>${t}</i></b>`);
    // H4–H6 → italic
    r = r.replace(/^#{4,6}\s+(.+)$/gm, (_, t) => `<i>${t}</i>`);

    // Bold + Italic: ***text*** or ___text___
    r = r.replace(/\*{3}(.+?)\*{3}/gs, "<b><i>$1</i></b>");
    r = r.replace(/_{3}(.+?)_{3}/gs, "<b><i>$1</i></b>");

    // Bold: **text** or __text__
    r = r.replace(/\*{2}(.+?)\*{2}/gs, "<b>$1</b>");
    r = r.replace(/_{2}(.+?)_{2}/gs, "<b>$1</b>");

    // Italic: *text* or _text_ (single, non-greedy, no leading/trailing spaces)
    r = r.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "<i>$1</i>");
    r = r.replace(/(?<!_)_(?!\s)([^_\n]+?)(?<!\s)_(?!_)/g, "<i>$1</i>");

    // Underline: ++text++ (non-standard but common in agents)
    r = r.replace(/\+{2}(.+?)\+{2}/g, "<u>$1</u>");

    // Strikethrough: ~~text~~
    r = r.replace(/~{2}(.+?)~{2}/g, "<s>$1</s>");

    // Spoiler: ||text|| (Discord-style, we map to tg-spoiler)
    r = r.replace(/\|{2}(.+?)\|{2}/g, "<tg-spoiler>$1</tg-spoiler>");

    // Links: [text](url)
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
        const safeUrl = url.replace(/"/g, "&quot;");
        return `<a href="${safeUrl}">${text}</a>`;
    });

    // Auto-link bare URLs not already wrapped in a tag
    r = r.replace(/(?<![">])(https?:\/\/[^\s<>"]+)/g, (_, url) => {
        const clean = url.replace(/[.,;:!?]+$/, ""); // strip trailing punctuation
        const trail = url.slice(clean.length);
        return `<a href="${clean.replace(/"/g, "&quot;")}">${clean}</a>${trail}`;
    });

    // Numbered lists: "1. item" → formatted line
    r = r.replace(/^(\d+)\.\s+(.+)$/gm, (_, num, item) => `${num}. ${item}`);

    // Bullet lists: "- item" or "* item" or "+ item"
    r = r.replace(/^[\-\*\+]\s+(.+)$/gm, "•  $1");

    // Task lists: "- [x] done" / "- [ ] todo"
    r = r.replace(/^•\s+\[x\]\s+(.+)$/gim, "☑  <s>$1</s>");
    r = r.replace(/^•\s+\[\s\]\s+(.+)$/gm, "☐  $1");

    // Horizontal rules: ---, ***, ___
    r = r.replace(/^[-*_]{3,}$/gm, "──────────────────────");

    // Clean up excessive blank lines (max 2 consecutive)
    r = r.replace(/\n{3,}/g, "\n\n");

    // ── 7. Restore all slots ──────────────────────────────────────────────────
    r = restore(r);

    return r.trim();
}

/**
 * Escape a string for safe embedding inside Telegram HTML.
 * Only escapes the three characters that matter: &, <, >
 * (We also escape " for attribute safety.)
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ─── HTML-Aware Message Splitter ──────────────────────────────────────────────

/**
 * Split a long HTML-formatted message into chunks ≤ maxLen chars without
 * breaking inside <pre> blocks, <code> blocks, HTML tags, or mid-word.
 *
 * Algorithm:
 *   1. Walk through the text tracking open/close tag depth
 *   2. Never split while inside a <pre> or <code> block
 *   3. Prefer double-newline splits, then single-newline, then space
 *   4. Carry the current "open tags" context into the next chunk header
 *      (so each chunk is independently valid HTML)
 */
export function splitMessageSafe(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let pos = 0;
    const len = text.length;

    while (pos < len) {
        if (len - pos <= maxLen) {
            const tail = text.slice(pos).trim();
            if (tail) chunks.push(tail);
            break;
        }

        // Find the safe window end
        const windowEnd = pos + maxLen;

        // Don't split inside a <pre> block — scan forward to find its end
        const preStart = text.indexOf("<pre>", pos);
        if (preStart !== -1 && preStart < windowEnd) {
            const preEnd = text.indexOf("</pre>", preStart + 5);
            if (preEnd !== -1 && preEnd + 6 > windowEnd) {
                // The <pre> block straddles our cut point — push out to after it
                const chunkEnd = preEnd + 6;
                chunks.push(text.slice(pos, chunkEnd).trim());
                pos = chunkEnd;
                // Skip leading whitespace
                while (pos < len && (text[pos] === "\n" || text[pos] === " ")) pos++;
                continue;
            }
        }

        // Find best split: prefer \n\n, then \n, then space
        let splitIdx = -1;
        for (const sep of ["\n\n", "\n", " "]) {
            const idx = text.lastIndexOf(sep, windowEnd);
            if (idx > pos + maxLen * 0.5) { // Don't split too early
                splitIdx = idx + sep.length;
                break;
            }
        }
        if (splitIdx === -1 || splitIdx <= pos) splitIdx = windowEnd;

        // Ensure we don't split inside an HTML tag
        const tagOpen = text.lastIndexOf("<", splitIdx);
        const tagClose = text.indexOf(">", tagOpen);
        if (tagOpen !== -1 && tagOpen > pos && tagClose >= splitIdx) {
            splitIdx = tagOpen;
        }

        const chunk = text.slice(pos, splitIdx).trim();
        if (chunk) chunks.push(chunk);
        pos = splitIdx;
        while (pos < len && (text[pos] === "\n" || text[pos] === " ")) pos++;
    }

    return chunks.filter(c => c.length > 0);
}

// ─── Utility Helpers ─────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Return the category name for a tool, shown in the progress message.
 */
function getToolCategory(toolName: string): string {
    const categories: Record<string, string> = {
        web_search: "Searching the web",
        browse_web: "Browsing a page",
        cf_browse_page: "Browser rendering",
        cf_screenshot: "Taking screenshot",
        cf_extract_data: "Extracting data",
        cf_fill_form: "Filling form",
        cf_click: "Clicking element",
        fetch_url: "Fetching URL",
        firecrawl: "Deep scraping",
        set_secret: "Securing key",
        get_secret: "Accessing vault",
        list_secrets: "Listing vault",
        delete_secret: "Clearing secret",
        store_memory: "Saving to memory",
        recall_memory: "Recalling memories",
        semantic_store: "Storing vector",
        semantic_recall: "Vector search",
        run_code: "Executing code",
        generate_image: "Generating image",
        text_to_speech: "Synthesizing voice",
        speech_to_text: "Transcribing audio",
        market_data: "Fetching market data",
        translate: "Translating",
        manage_goals: "Managing goals",
        spawn_agent: "Spawning agent",
        create_tool: "Building new tool",
        schedule_cron: "Scheduling job",
        write_file: "Writing file",
        read_file: "Reading file",
        send_email: "Sending email",
        github: "GitHub action",
    };
    return categories[toolName] ?? "Processing";
}

/**
 * Return an emoji icon for a tool name shown in progress messages.
 */
function getTelegramToolIcon(toolName: string): string {
    const icons: Record<string, string> = {
        // Search & Browse
        web_search: "🔍",
        browse_web: "🌐",
        cf_browse_page: "🌐",
        cf_screenshot: "📸",
        cf_extract_data: "⛏️",
        cf_fill_form: "📝",
        cf_click: "🖱️",
        fetch_url: "📄",
        firecrawl: "🕷️",
        // Secrets
        set_secret: "🔐",
        get_secret: "🔑",
        list_secrets: "📜",
        delete_secret: "🗑️",
        // Memory
        store_memory: "💾",
        recall_memory: "🧠",
        list_memories: "📋",
        delete_memory: "🗑️",
        semantic_store: "🔮",
        semantic_recall: "🔮",
        share_memory: "🤝",
        read_agent_memory: "🔍",
        ingest_knowledge_base: "📚",
        // Files
        write_file: "📁",
        read_file: "📂",
        list_files: "🗂️",
        delete_file: "🗑️",
        // Code
        run_code: "💻",
        calculate: "🧮",
        // Image & Voice
        generate_image: "🎨",
        text_to_speech: "🎤",
        speech_to_text: "👂",
        // Market
        market_data: "📈",
        // Language
        translate: "🌍",
        // Goals
        manage_goals: "🎯",
        proactive_notify: "🔔",
        // Agent Infrastructure
        trigger_workflow: "⚙️",
        get_task_status: "📡",
        spawn_agent: "🤖",
        get_agent_result: "📊",
        list_agents: "📋",
        cancel_agent: "🛑",
        create_tool: "🔧",
        benchmark_tool: "⚡",
        // Scheduling
        schedule_cron: "⏰",
        list_crons: "📅",
        update_cron: "✏️",
        delete_cron: "🗑️",
        get_datetime: "🕐",
        human_approval_gate: "🚦",
        // Integrations
        github: "🐙",
        send_email: "📧",
        send_sms: "📱",
    };
    return icons[toolName] ?? "🛠️";
}