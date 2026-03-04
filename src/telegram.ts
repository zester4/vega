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
 *   - Full Markdown → Telegram HTML conversion
 *   - Commands: /start /help /reset /status /tasks /memory
 *   - Photo/document pass-through to agent
 *   - Rate limiting (10 msg/min per user)
 *   - Multi-user: each chat_id gets its own VEGA session in Redis
 *   - 4096 char limit handling (splits long messages automatically)
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
        // Split if over 4096 chars — Telegram hard limit
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

        // Split long message into chunks
        const chunks = splitMessage(text, 4000);
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
            // Ignore "message is not modified" errors — content was the same
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
        audioBytes: Uint8Array,
        opts: { reply_to_message_id?: number; caption?: string } = {}
    ): Promise<TelegramMessage> {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        form.append("voice", new Blob([audioBytes] as any, { type: "audio/wav" }), "voice.wav");
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

    // Handle callback query (inline button press)
    if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, bot, env, config);
        return;
    }

    const msg = update.message ?? update.edited_message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text ?? msg.caption ?? "";

    // Ignore non-text non-media messages (stickers, polls, etc.)
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
                "⚠️ <b>Rate limit reached.</b>\nMax 10 messages/minute. Please wait a moment.",
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
            await bot.sendMessage(chatId, `
👋 <b>Hey ${escapeHtml(name)}! I'm VEGA.</b>

I'm an autonomous AI agent that can:

🔍 <b>Search & Browse</b> — Web search, headless browser, Firecrawl deep scraping
🧠 <b>Remember Forever</b> — Persistent memory + vector semantic recall across all sessions
💻 <b>Run Code</b> — Execute Python, analyze data, generate charts
🤖 <b>Spawn Sub-agents</b> — Parallel AI workers for complex tasks
📁 <b>Manage Files</b> — R2 cloud storage for reports and documents
⚙️ <b>Build New Tools</b> — Self-extends capabilities on demand
🔔 <b>Schedule Jobs</b> — Recurring cron jobs with proactive alerts
🎨 <b>Generate Images</b> — Gemini Nano Banana 2 image generation
📊 <b>Market Intelligence</b> — Live prices, portfolio tracking, price alerts
🎙️ <b>Voice Mode</b> — Send voice, get Gemini voice replies (30+ voices)
🌍 <b>25+ Languages</b> — Auto-detects, translates, responds in your language
🎯 <b>Goal Tracking</b> — Long-term goal pursuit across sessions

<b>Commands:</b>
/help — Full command list
/reset — Clear conversation history
/status — Agent status & heartbeat
/tasks — Background tasks & cron jobs
/memory — Stored memories
/goals — Active goal tracker
/voice_on — Enable voice replies
/voice_off — Disable voice replies
      `.trim(), { parse_mode: "HTML" });
            break;
        }

        case "/help": {
            await bot.sendMessage(chatId, `
<b>VEGA Commands</b>

/start — Welcome message & capabilities
/help — This help message
/reset — Clear this conversation's history
/status — Check agent status and uptime
/tasks — Background tasks (sub-agents & workflows)
/memory — Stored memories for this chat
/goals — Active goal tracker with progress bars
/voice_on — Enable Gemini voice replies
/voice_off — Disable voice replies

<b>Tips:</b>
• Send a voice message — I'll transcribe and respond
• Send a photo — I'll analyze it with Gemini Vision
• "Generate an image of..." — Nano Banana 2 image gen
• "What's the price of BTC?" — live Yahoo Finance data
• "Track goal: ..." — I'll remember and pursue it
• "Translate this to Spanish: ..." — 32+ languages
• "Set a price alert for AAPL above $200" — proactive push
• "Create a tool that..." — extend my capabilities on the fly
      `.trim(), { parse_mode: "HTML" });
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
                    "\ud83c\udfaf <b>No goals set yet.</b>\n\nTell me your goals and I'll track and pursue them automatically!",
                    { parse_mode: "HTML" }
                );
                break;
            }

            let goalsText = `<b>\ud83c\udfaf Active Goals</b> (${result.activeCount ?? 0} active)\n\n`;
            for (const goal of result.goals.slice(0, 8)) {
                const filled = Math.round(goal.progress / 10);
                const bar = "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
                const pIcon = goal.priority === "critical" ? "\ud83d\udd34" : goal.priority === "high" ? "\ud83d\udfe0" : goal.priority === "medium" ? "\ud83d\udfe1" : "\ud83d�";
                goalsText += `${pIcon} <b>${escapeHtml(goal.title)}</b>\n`;
                goalsText += `[${bar}] ${goal.progress}%\n`;
                if (goal.nextAction) goalsText += `\ud83d\udccc <i>${escapeHtml(goal.nextAction.slice(0, 80))}</i>\n`;
                goalsText += "\n";
            }
            if ((result.goals.length ?? 0) > 8) goalsText += `<i>\u2026and ${result.goals.length - 8} more</i>`;

            await bot.sendMessage(chatId, goalsText.trim(), { parse_mode: "HTML" });
            break;
        }

        case "/voice_on": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            await redis.set(`tg:voice:${chatId}`, "1", { ex: 60 * 60 * 24 * 30 });
            await bot.sendMessage(chatId,
                "🎙️ <b>Voice replies enabled!</b>\nI'll respond with voice messages now. Send me a voice message to try it!\n\nSend /voice_off to disable.",
                { parse_mode: "HTML" }
            );
            break;
        }

        case "/voice_off": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            await redis.del(`tg:voice:${chatId}`);
            await bot.sendMessage(chatId, "\ud83d\udd07 <b>Voice replies disabled.</b> Text mode restored.", { parse_mode: "HTML" });
            break;
        }

        case "/reset": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            const sessionKey = `tg:session:${chatId}`;
            const sessionId = await redis.get(sessionKey) as string | null;

            if (sessionId) {
                // Clear the session history
                await redis.del(`session:${sessionId}:history`);
                await redis.del(`session:${sessionId}`);
                await redis.del(sessionKey);
            }

            await bot.sendMessage(chatId,
                "🔄 <b>Conversation reset.</b>\nI've cleared our chat history. Fresh start!",
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

            const uptime = tick
                ? formatRelativeTime(tick.timestamp)
                : "No heartbeat yet";

            await bot.sendMessage(chatId, `
<b>⚡ VEGA Status</b>

🟢 <b>Core:</b> Active
🔄 <b>Last heartbeat:</b> ${uptime}
⚠️ <b>Recent errors:</b> ${errors}
🌐 <b>Platform:</b> Cloudflare Workers Edge

${tick?.reflection ? `\n<i>${escapeHtml(tick.reflection)}</i>` : ""}
      `.trim(), { parse_mode: "HTML" });
            break;
        }

        case "/tasks": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            const raw = await redis.lrange("agent:spawned", 0, 9) as string[];

            if (raw.length === 0) {
                await bot.sendMessage(chatId,
                    "📋 <b>No background tasks running.</b>",
                    { parse_mode: "HTML" }
                );
                break;
            }

            const agents = raw.map((r: string) => {
                try { return JSON.parse(r); } catch { return null; }
            }).filter(Boolean);

            let list = "<b>🤖 Background Tasks</b>\n\n";
            for (const a of agents.slice(0, 8)) {
                const icon = a.status === "running" ? "⏳" : a.status === "done" ? "✅" : "❌";
                list += `${icon} <b>${escapeHtml(a.agentName ?? "Unknown")}</b>\n`;
                list += `   ID: <code>${a.agentId}</code>\n`;
                list += `   Status: ${a.status}\n\n`;
            }

            await bot.sendMessage(chatId, list.trim(), { parse_mode: "HTML" });
            break;
        }

        case "/memory": {
            const { getRedis } = await import("./memory");
            const redis = getRedis(env);
            const chatSession = await redis.get(`tg:session:${chatId}`) as string | null;

            if (!chatSession) {
                await bot.sendMessage(chatId,
                    "🧠 <b>No memories yet.</b>\nStart chatting and I'll remember important things!",
                    { parse_mode: "HTML" }
                );
                break;
            }

            const keys = await redis.keys("agent:memory:*") as string[];
            const tgKeys = keys.slice(0, 15);

            if (tgKeys.length === 0) {
                await bot.sendMessage(chatId,
                    "🧠 <b>Memory is empty.</b>\nAsk me to remember something!",
                    { parse_mode: "HTML" }
                );
                break;
            }

            let memList = `<b>🧠 Stored Memories</b> (${tgKeys.length})\n\n`;
            for (const key of tgKeys.slice(0, 10)) {
                const cleanKey = key.replace("agent:memory:", "");
                const val = await redis.get(key) as string | null;
                memList += `• <b>${escapeHtml(cleanKey)}</b>: ${escapeHtml(String(val ?? "").slice(0, 60))}\n`;
            }
            if (tgKeys.length > 10) memList += `\n<i>…and ${tgKeys.length - 10} more</i>`;

            await bot.sendMessage(chatId, memList.trim(), { parse_mode: "HTML" });
            break;
        }

        default: {
            // Unknown command — treat as regular message
            const args = text.slice(command.length).trim();
            if (args) {
                await processMessage(msg, args, bot, env, config);
            } else {
                await bot.sendMessage(chatId,
                    `Unknown command. Type /help to see available commands.`,
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
            // Download highest resolution photo
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
        fullMessage = `[User sent document: ${msg.document.file_name ?? "unknown"}${userText ? ` — ${userText}` : ""}]`;
    }

    if (!fullMessage.trim()) return;

    // ── Auto-detect language for multi-language support ──────────────────────────
    let detectedLang = "en";
    if (fullMessage.length > 10 && !transcribedVoice) {
        try {
            const { detectUserLanguage } = await import("./tools/translate");
            detectedLang = await detectUserLanguage(fullMessage, env);
        } catch { /* non-fatal */ }
    }

    // ── Send typing indicator + progress message ─────────────────────────────────
    await bot.sendChatAction(chatId, "typing");
    let progressMsg: TelegramMessage | null = null;
    const activeTools: string[] = [];
    let lastEditTs = 0;

    try {
        progressMsg = await bot.sendMessage(chatId,
            transcribedVoice
                ? `🎙️ <b>Heard:</b> <i>"${escapeHtml(fullMessage.slice(0, 150))}..."</i>\n\n⚙️ <b>Processing…</b>`
                : "⚙️ <b>Processing…</b>",
            { parse_mode: "HTML" }
        );
    } catch { /* non-fatal */ }

    const updateProgressMessage = async (toolName: string, status: "start" | "done" | "error") => {
        if (!progressMsg) return;
        const now = Date.now();
        if (now - lastEditTs < 1000) return;
        lastEditTs = now;

        if (status === "start") activeTools.push(toolName);
        else {
            const idx = activeTools.lastIndexOf(toolName);
            if (idx !== -1) activeTools.splice(idx, 1);
        }

        const toolIcon = getTelegramToolIcon(toolName);
        const currentTool = activeTools[activeTools.length - 1];
        const progressText = currentTool
            ? `⚙️ <b>Working…</b>\n${toolIcon} <code>${currentTool}</code> ${status === "error" ? "❌" : "running"}`
            : "⚙️ <b>Finalizing…</b>";

        try {
            await bot.editMessageText(chatId, progressMsg.message_id, progressText, { parse_mode: "HTML" });
        } catch { /* ignore */ }
    };

    const { runAgent } = await import("./agent");

    // Collect images generated by the agent during this turn
    const generatedImages: Array<{ url: string; description: string; mimeType: string }> = [];

    let reply: string;
    try {
        reply = await runAgent(env, sessionId, fullMessage, undefined, async (event) => {
            if (event.type === "tool-start") await updateProgressMessage(event.data.name, "start");
            else if (event.type === "tool-result" || event.type === "tool-error") {
                await updateProgressMessage(event.data.name, event.type === "tool-error" ? "error" : "done");

                // ── Capture generate_image results ──────────────────────────────
                if (event.type === "tool-result" && event.data.name === "generate_image") {
                    const output = event.data.output as Record<string, unknown>;
                    if (output?.success && output?.imageUrl && typeof output.imageUrl === "string") {
                        // Only capture real HTTP URLs (not base64 data URIs)
                        if (output.imageUrl.startsWith("http")) {
                            generatedImages.push({
                                url: output.imageUrl as string,
                                description: (output.description as string) || "Generated image",
                                mimeType: (output.mimeType as string) || "image/png",
                            });
                        }
                    }
                }
            }
        });
    } catch (err) {
        if (progressMsg) await bot.deleteMessage(chatId, progressMsg.message_id);
        await bot.sendMessage(chatId,
            `❌ <b>Error:</b> ${escapeHtml(String(err))}`,
            { parse_mode: "HTML" }
        );
        return;
    }

    // Delete progress message
    if (progressMsg) await bot.deleteMessage(chatId, progressMsg.message_id);

    // When we send images as photos, remove image URLs from the text so we don't show links
    if (generatedImages.length > 0) {
        const imageUrls = new Set(generatedImages.map((i) => i.url));
        reply = reply
            .split("\n")
            .filter((line) => {
                const t = line.trim();
                if (!t) return true;
                if (imageUrls.has(t)) return false;
                const mdImg = /!\[([^\]]*)\]\(([^)]+)\)/.exec(t);
                if (mdImg && imageUrls.has(mdImg[2].trim())) return false;
                return true;
            })
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    // ── Send final reply (as text or voice) ──────────────────────────────────────
    // 1. Split Markdown into chunks that will likely fit in 4096-char HTML messages
    const replyChunks = splitMessage(reply, 3800);
    const voiceEnabled = await redis.get(`tg:voice:${chatId}`) as string | null;

    for (let i = 0; i < replyChunks.length; i++) {
        const chunk = replyChunks[i];
        const formatted = markdownToHtml(chunk);

        // Only use voice if it's the only chunk and within reasonable length
        if (i === 0 && replyChunks.length === 1 && voiceEnabled && reply.length <= 2000) {
            try {
                await bot.sendChatAction(chatId, "upload_document");
                const { generateSpeechBytes } = await import("./tools/voice");
                const audioBytes = await generateSpeechBytes(reply, env);

                if (audioBytes) {
                    await bot.sendMessage(chatId, formatted, {
                        parse_mode: "HTML",
                        reply_to_message_id: msg.message_id,
                        disable_web_page_preview: true,
                    });
                    await bot.sendVoice(chatId, audioBytes, {
                        reply_to_message_id: msg.message_id,
                        caption: "🎙️ Voice reply",
                    });
                } else {
                    await bot.sendMessage(chatId, formatted, {
                        parse_mode: "HTML",
                        reply_to_message_id: msg.message_id,
                        disable_web_page_preview: true,
                    });
                }
            } catch (ttsErr) {
                console.error("[Telegram TTS] Failed:", ttsErr);
                await bot.sendMessage(chatId, formatted, {
                    parse_mode: "HTML",
                    reply_to_message_id: msg.message_id,
                    disable_web_page_preview: true,
                });
            }
        } else {
            // Regular text chunk delivery
            await bot.sendMessage(chatId, formatted, {
                parse_mode: "HTML",
                reply_to_message_id: msg.message_id,
                disable_web_page_preview: true,
            });
        }
    }

    // ── Send generated images as Telegram photos ─────────────────────────────────
    if (generatedImages.length > 0) {
        for (const img of generatedImages) {
            try {
                await bot.sendChatAction(chatId, "upload_photo");
                const imgRes = await fetch(img.url);
                if (!imgRes.ok) throw new Error(`Fetch status ${imgRes.status}`);

                const imageBytes = new Uint8Array(await imgRes.arrayBuffer());

                // Truncate description for caption limit (1024 chars), ensure HTML is safe
                const rawCaption = img.description.length > 500
                    ? img.description.slice(0, 497) + "..."
                    : img.description;
                const htmlCaption = markdownToHtml(rawCaption);

                await bot.sendPhoto(chatId, imageBytes, htmlCaption);
            } catch (imgErr) {
                console.error("[Telegram Image] Failed to send photo:", imgErr);
            }
        }
    }

    const activityKey = config.userId ? `tg:activity:${config.userId}` : "tg:activity";
    try {
        await redis.lpush(activityKey, JSON.stringify({
            chatId,
            username: msg.from?.username ?? `user_${msg.from?.id}`,
            firstName: msg.from?.first_name,
            messagePreview: fullMessage.slice(0, 100),
            replyPreview: reply.slice(0, 100),
            wasVoice: transcribedVoice,
            detectedLang,
            ts: Date.now(),
        }));
        await redis.ltrim(activityKey, 0, 49);
    } catch { /* non-fatal */ }
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

/**
 * Generate a deterministic webhook secret from the bot token.
 */
export async function getTelegramSecret(botToken: string): Promise<string> {
    const secretBytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`vega-${botToken}`)
    );
    return Array.from(new Uint8Array(secretBytes))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 64);
}

// ─── D1 helpers (use src/db/schema.ts + src/db/queries.ts) ─────────────────────

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

/** Resolve bot config by webhook secret (for POST /telegram/webhook). Returns null if no D1 or no row. */
export async function getTelegramConfigBySecret(env: Env, secret: string): Promise<TelegramBotConfig | null> {
    const db = getDb(env);
    if (!db) return null;
    const row = await dbGetBySecret(db, secret);
    if (!row) return null;
    return rowToConfig(row, row.user_id);
}

/** Get config by user id (for GET /telegram/status, DELETE /telegram/disconnect). */
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

/** Verify internal secret (Next.js → Worker). */
export function verifyTelegramInternalSecret(env: Env, header: string | null): boolean {
    const expected = (env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
    if (!expected || !header) return false;
    if (header.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
}

/**
 * Register a Telegram bot: validate token, set webhook, store in D1 (if userId + DB) or Redis.
 * Called from POST /telegram/setup
 */
export async function setupTelegramBot(
    botToken: string,
    workerUrl: string,
    env: Env,
    userId?: string
): Promise<TelegramBotConfig> {
    const bot = new TelegramBot(botToken);

    // Validate the token by calling getMe
    let me: TelegramUser;
    try {
        me = await bot.getMe();
    } catch {
        throw new Error("Invalid bot token. Create a bot at https://t.me/BotFather and copy the token.");
    }

    // Generate a webhook secret from the token (deterministic, no extra storage needed)
    const secret = await getTelegramSecret(botToken);

    // Register the webhook with Telegram
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

    // Multi-tenant mode requires a userId + D1 binding.
    console.warn("[Telegram Setup] Missing userId or D1 binding. Per-user setup is required; no config was persisted.");
    return config;
}

/**
 * Disconnect the Telegram bot: delete webhook, remove from D1 (if userId + DB) or Redis.
 */
export async function disconnectTelegramBot(env: Env, userId?: string): Promise<void> {
    const db = (env as { DB?: D1Database }).DB;

    if (userId && db) {
        const config = await getTelegramConfigByUserId(env, userId);
        if (config) {
            try {
                const bot = new TelegramBot(config.token);
                await bot.deleteWebhook().catch((err) => {
                    console.error("[Telegram Disconnect] Failed to delete webhook from Telegram:", err);
                });
            } catch (_) { /* ignore */ }
            await deleteTelegramConfigByUserId(env, userId);
            console.log(`[Telegram Disconnect] Config removed from D1 for user ${userId}.`);
        }
        return;
    }

    // Legacy global config via Redis has been removed; nothing to do here.
    console.warn("[Telegram Disconnect] Called without userId/DB. No action taken in multi-tenant mode.");
}

/**
 * Legacy helper for a single global bot config.
 * In the new multi-tenant design we no longer load Telegram tokens
 * from Redis or TELEGRAM_BOT_TOKEN — all configs live in D1 per user.
 * This now always returns null but is kept for backwards compatibility.
 */
export async function getTelegramConfig(_env: Env): Promise<TelegramBotConfig | null> {
    console.warn("[Telegram Config] Legacy global config is disabled. Use per-user D1 configs instead.");
    return null;
}

/**
 * Verify that a webhook request is authentically from Telegram.
 * Telegram sets X-Telegram-Bot-Api-Secret-Token header.
 */
export function verifyWebhookSecret(
    headerSecret: string | null,
    expectedSecret: string
): boolean {
    if (!headerSecret) return false;
    // Constant-time comparison to prevent timing attacks
    if (headerSecret.length !== expectedSecret.length) return false;
    let diff = 0;
    for (let i = 0; i < headerSecret.length; i++) {
        diff |= headerSecret.charCodeAt(i) ^ expectedSecret.charCodeAt(i);
    }
    return diff === 0;
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

/**
 * Convert agent's Markdown output to Telegram-safe HTML.
 *
 * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">
 * Everything else must be escaped.
 */
export function markdownToHtml(text: string): string {
    const placeholders: Map<string, string> = new Map();
    let placeholderCounter = 0;

    // 1. Protect Code Blocks (``` ... ```)
    let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
        const id = `\x00CODE_${placeholderCounter++}\x00`;
        placeholders.set(id, `<pre><code>${escapeHtml(code.trim())}</code></pre>`);
        return id;
    });

    // 2. Protect Inline Code (`code`) — exclude already replaced blocks
    result = result.replace(/`([^`\n]+)`/g, (_, code) => {
        const id = `\x00CODE_${placeholderCounter++}\x00`;
        placeholders.set(id, `<code>${escapeHtml(code)}</code>`);
        return id;
    });

    // 3. Escape raw HTML special chars in the remaining prose
    result = escapeHtml(result);

    // 4. Apply non-code Markdown rules to the escaped prose
    // Headers (h1–h3 → bold line)
    result = result.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");

    // Bold: **text** or __text__
    result = result.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
    result = result.replace(/__(.+?)__/gs, "<b>$1</b>");

    // Italic: *text* or _text_ (single)
    // We use more restrictive regex to avoid matching across multiple lines unnecessarily
    result = result.replace(/(?<!\*)\*(?!\*)([^\*\n]+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
    result = result.replace(/(?<!_)_(?!_)([^_\n]+?)(?<!_)_(?!_)/g, "<i>$1</i>");

    // Strikethrough: ~~text~~
    result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

    // Links: [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Horizontal rules
    result = result.replace(/^[-*_]{3,}$/gm, "─────────────");

    // Bullet lists
    result = result.replace(/^[\-\*\+]\s+(.+)$/gm, "• $1");

    // Blockquotes
    result = result.replace(/^>\s*(.+)$/gm, "<i>│ $1</i>");

    // 5. Restore code segments from placeholders
    placeholders.forEach((html, id) => {
        result = result.replace(id, html);
    });

    return result.trim();
}

/**
 * Escape a string for safe use inside HTML.
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Split a message into chunks at paragraph or newline boundaries, respecting max length.
 * Attempt to be extremely conservative to avoid splitting in the middle of a tag.
 */
function splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }

        // Try to find a good break point: double newline, then single newline, then space
        let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
        if (splitIdx === -1) splitIdx = remaining.lastIndexOf("\n", maxLen);
        if (splitIdx === -1) splitIdx = remaining.lastIndexOf(" ", maxLen);

        // If no good break point found, hard split at maxLen
        if (splitIdx === -1) splitIdx = maxLen;

        chunks.push(remaining.slice(0, splitIdx).trim());
        remaining = remaining.slice(splitIdx).trim();
    }

    return chunks.filter((c) => c.length > 0);
}

/**
 * Format a Unix timestamp as a relative time string.
 */
function formatRelativeTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Get a simple emoji icon for a tool name (shown in Telegram progress messages).
 */
function getTelegramToolIcon(toolName: string): string {
    const icons: Record<string, string> = {
        // Search & Browse
        web_search: "🔍",
        browse_web: "🌐",
        fetch_url: "📄",
        firecrawl: "🕷️",
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