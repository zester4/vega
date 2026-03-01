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

// ─── Bot Info stored in Redis ─────────────────────────────────────────────────

export interface TelegramBotConfig {
    token: string;
    botId: number;
    username: string;
    firstName: string;
    webhookUrl: string;
    secret: string;
    connectedAt: string;
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

🔍 <b>Search & Browse</b> — Real-time web search, full browser for JS sites
🧠 <b>Remember</b> — Persistent memory across all our conversations
💻 <b>Run Code</b> — Execute Python, analyze data, generate charts
🤖 <b>Spawn Sub-agents</b> — Create parallel AI workers for complex tasks
📁 <b>Store Files</b> — Save reports, data, and documents
⚙️ <b>Build Tools</b> — Create new capabilities on demand
🔔 <b>Schedule Jobs</b> — Set up recurring automated tasks

Just send me any message and I'll get to work.

<b>Commands:</b>
/help — Show this message
/reset — Clear conversation history
/status — My current status
/tasks — View running background tasks
/memory — See what I remember about you
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
/tasks — List running background tasks (sub-agents & workflows)
/memory — See stored memories for this chat

<b>Tips:</b>
• For long research tasks, I'll kick off a background workflow and notify you when done
• I remember our conversations — reference previous context freely
• I can handle images and documents you send me
• Say "create a tool that..." to extend my capabilities on the fly
      `.trim(), { parse_mode: "HTML" });
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

    // Get or create a stable VEGA session for this Telegram chat
    const { getRedis } = await import("./memory");
    const redis = getRedis(env);
    const sessionKey = `tg:session:${chatId}`;

    let sessionId = await redis.get(sessionKey) as string | null;
    if (!sessionId) {
        sessionId = `tg-${chatId}-${Date.now()}`;
        await redis.set(sessionKey, sessionId);
    }

    // Build the user message — include image description if photo sent
    let fullMessage = userText;
    if (msg.photo && msg.photo.length > 0) {
        fullMessage = `[User sent a photo${userText ? `: ${userText}` : ". Describe what you can infer from this context."}]`;
    } else if (msg.document) {
        fullMessage = `[User sent a document: ${msg.document.file_name ?? "unknown file"}${userText ? ` — ${userText}` : ""}]`;
    } else if (msg.voice) {
        fullMessage = `[User sent a voice message${userText ? ` — ${userText}` : ". Respond helpfully."}]`;
    }

    // Send typing indicator
    await bot.sendChatAction(chatId, "typing");

    // Send a live "working" message that we'll update as tools run
    let progressMsg: TelegramMessage | null = null;
    const activeTools: string[] = [];
    let lastEditTs = 0;

    try {
        progressMsg = await bot.sendMessage(chatId,
            "⚙️ <b>Processing…</b>",
            { parse_mode: "HTML" }
        );
    } catch {
        // Non-fatal if this fails
    }

    const updateProgressMessage = async (toolName: string, status: "start" | "done" | "error") => {
        if (!progressMsg) return;

        const now = Date.now();
        // Throttle edits to max 1 per second (Telegram rate limit: 30 edits/min)
        if (now - lastEditTs < 1000) return;
        lastEditTs = now;

        if (status === "start") {
            activeTools.push(toolName);
        } else {
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

    // Run the agent
    const { runAgent } = await import("./agent");

    let reply: string;
    try {
        reply = await runAgent(env, sessionId, fullMessage, undefined, async (event) => {
            if (event.type === "tool-start") {
                await updateProgressMessage(event.data.name, "start");
            } else if (event.type === "tool-result" || event.type === "tool-error") {
                await updateProgressMessage(event.data.name, event.type === "tool-error" ? "error" : "done");
            }
        });
    } catch (err) {
        // Delete progress message
        if (progressMsg) await bot.deleteMessage(chatId, progressMsg.message_id);
        await bot.sendMessage(chatId,
            `❌ <b>Error:</b> ${escapeHtml(String(err))}`,
            { parse_mode: "HTML" }
        );
        return;
    }

    // Delete the "working" progress message
    if (progressMsg) {
        await bot.deleteMessage(chatId, progressMsg.message_id);
    }

    // Format and send the final response
    const formatted = markdownToHtml(reply);
    await bot.sendMessage(chatId, formatted, {
        parse_mode: "HTML",
        reply_to_message_id: msg.message_id,
        disable_web_page_preview: true,
    });

    // Log to Redis for the frontend activity feed
    try {
        await redis.lpush("tg:activity", JSON.stringify({
            chatId,
            username: msg.from?.username ?? `user_${msg.from?.id}`,
            firstName: msg.from?.first_name,
            messagePreview: fullMessage.slice(0, 100),
            replyPreview: reply.slice(0, 100),
            ts: Date.now(),
        }));
        await redis.ltrim("tg:activity", 0, 49); // keep last 50
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

/**
 * Register a Telegram bot: validate token, set webhook, store in Redis.
 * Called from POST /telegram/setup
 */
export async function setupTelegramBot(
    botToken: string,
    workerUrl: string,
    env: Env
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

    // Persist to Redis
    const { getRedis } = await import("./memory");
    const redis = getRedis(env);
    console.log(`[Telegram Setup] Saving configuration for @${config.username} to Redis...`);
    await redis.set("tg:config", JSON.stringify(config));
    await redis.set("tg:enabled", "1");

    // Double check if it was saved
    const verify = await redis.get("tg:config");
    if (verify) {
        console.log("[Telegram Setup] Verification successful: config exists in Redis.");
    } else {
        console.error("[Telegram Setup] ERROR: Config was NOT saved to Redis!");
    }

    return config;
}

/**
 * Disconnect the Telegram bot: delete webhook, clear Redis config.
 */
export async function disconnectTelegramBot(env: Env): Promise<void> {
    const { getRedis } = await import("./memory");
    const redis = getRedis(env);

    const raw = await redis.get("tg:config") as string | null;
    if (raw) {
        try {
            const config: TelegramBotConfig = JSON.parse(raw);
            const bot = new TelegramBot(config.token);
            await bot.deleteWebhook();
        } catch { /* ignore if token is invalid */ }
    }

    await redis.del("tg:config");
    await redis.del("tg:enabled");
}

/**
 * Load the current bot config from Redis or environment fallback.
 * Returns null if no bot is connected.
 */
export async function getTelegramConfig(env: Env): Promise<TelegramBotConfig | null> {
    const { getRedis } = await import("./memory");
    const redis = getRedis(env);

    // 1. Try Redis first (dynamic config)
    const raw = await redis.get("tg:config") as string | null;
    if (raw) {
        try {
            const config = JSON.parse(raw) as TelegramBotConfig;
            console.log(`[Telegram Config] Found config in Redis for @${config.username}`);
            return config;
        } catch {
            // Ignore parse error and fallback
        }
    }

    // 2. Try Environment Variable Fallback
    if (env.TELEGRAM_BOT_TOKEN) {
        console.log("[Telegram Config] Redis config missing, trying environment variable...");
        const token = env.TELEGRAM_BOT_TOKEN;
        const secret = await getTelegramSecret(token);
        const bot = new TelegramBot(token);

        try {
            // We need the bot username for command parsing
            const me = await bot.getMe();
            const config: TelegramBotConfig = {
                token,
                botId: me.id,
                username: me.username || "bot",
                firstName: me.first_name,
                webhookUrl: `${env.UPSTASH_WORKFLOW_URL}/telegram/webhook`,
                secret,
                connectedAt: new Date().toISOString(),
            };
            console.log(`[Telegram Config] Using fallback environment config for @${config.username}`);
            return config;
        } catch (err) {
            console.error("[Telegram Config] Fallback token is invalid or API error:", err);
            return null;
        }
    }

    console.warn("[Telegram Config] No bot configuration found in Redis or Environment.");
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
    // 1. Escape HTML special chars in the raw text first
    //    We'll re-add tags intentionally below
    let result = text;

    // 2. Code blocks (``` ... ```) — must be done before inline code
    result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
        return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
    });

    // 3. Inline code (`code`)
    result = result.replace(/`([^`\n]+)`/g, (_, code) => {
        return `<code>${escapeHtml(code)}</code>`;
    });

    // 4. Bold: **text** or __text__
    result = result.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
    result = result.replace(/__(.+?)__/gs, "<b>$1</b>");

    // 5. Italic: *text* or _text_ (single)
    result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
    result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");

    // 6. Strikethrough: ~~text~~
    result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

    // 7. Links: [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // 8. Headers (h1–h3 → bold line)
    result = result.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");

    // 9. Horizontal rules
    result = result.replace(/^[-*_]{3,}$/gm, "─────────────");

    // 10. Bullet lists
    result = result.replace(/^[\-\*\+]\s+(.+)$/gm, "• $1");

    // 11. Numbered lists — keep as-is (Telegram renders plain text fine)

    // 12. Blockquotes
    result = result.replace(/^>\s*(.+)$/gm, "<i>│ $1</i>");

    // 13. Escape any raw HTML angle brackets that aren't our intentional tags
    //     (already escaped above via escapeHtml in code blocks — but protect
    //      stray < > in normal prose)
    // This is tricky — only escape chars that aren't part of our allowed tags
    // Simplest safe approach: only the code sections were escaped; the rest
    // might have user-generated < > — wrap any remaining untagged < > 
    result = result.replace(/<(?!\/?(?:b|i|u|s|code|pre|a)[> /])/g, "&lt;");

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
 * Split a message into chunks at paragraph boundaries, respecting max length.
 */
function splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    const paragraphs = text.split("\n\n");
    let current = "";

    for (const para of paragraphs) {
        if ((current + "\n\n" + para).length > maxLen) {
            if (current) chunks.push(current.trim());
            current = para;
        } else {
            current = current ? current + "\n\n" + para : para;
        }
    }
    if (current) chunks.push(current.trim());

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
        web_search: "🔍",
        browse_web: "🌐",
        fetch_url: "📄",
        store_memory: "💾",
        recall_memory: "🧠",
        list_memories: "📋",
        semantic_store: "🔮",
        semantic_recall: "🔮",
        run_code: "💻",
        calculate: "🧮",
        github: "🐙",
        send_email: "📧",
        send_sms: "📱",
        trigger_workflow: "⚙️",
        spawn_agent: "🤖",
        get_agent_result: "📊",
        create_tool: "🔧",
        write_file: "📁",
        read_file: "📂",
        get_datetime: "🕐",
        schedule_cron: "⏰",
    };
    return icons[toolName] ?? "🛠️";
}