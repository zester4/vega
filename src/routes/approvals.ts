/**
 * ============================================================================
 * src/routes/approvals.ts — Human-in-the-Loop Approval Gates
 * ============================================================================
 *
 * How it works:
 *   1. When a tool marked requiresApproval=true is about to execute, call
 *      requestApproval() before running the tool.
 *   2. requestApproval() creates a pending_approvals row in D1 and sends a
 *      Telegram inline keyboard message to the user.
 *   3. The agent polls waitForApproval() (via context.run or Redis polling).
 *   4. When the user taps a button, handleApprovalCallback() is invoked from
 *      the Telegram callback_query handler in index.ts.
 *   5. The approval record is updated. waitForApproval() returns the decision.
 *   6. Auto-timeout: if no response within APPROVAL_TIMEOUT_MS, status → "timeout"
 *      and the tool call is denied.
 *
 * Tool-level protection:
 *   Tools declare themselves as requiring approval by including
 *   requiresApproval: true in their definition. The executeTool() wrapper
 *   in builtins.ts calls requestApproval() before running them.
 *
 * Routes:
 *   POST /approvals/callback  — Telegram callback_query forwarded from the
 *                               Telegram webhook handler.
 *   GET  /approvals           — List pending approvals for a user (frontend).
 *   GET  /approvals/:id       — Get a single approval record (for polling).
 *
 * ============================================================================
 */

import { Hono } from "hono";

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long (ms) to wait for user approval before auto-denying. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Tools that ALWAYS require human approval before execution.
 * The agent cannot bypass this — the check is in executeTool(), not the prompt.
 */
export const APPROVAL_REQUIRED_TOOLS = new Set([
  "send_email",
  "spawn_agent",
  "trigger_workflow",
  "schedule_cron",
  "delete_secret",
  "run_code",
  "cf_fill_form",
  "cf_click",
]);

// Thresholds for conditional approval (these only require approval when params look risky)
export const APPROVAL_CONDITIONAL: Record<string, (args: Record<string, unknown>) => boolean> = {
  // Only require approval for spawn_agent if maxIterations > 10
  spawn_agent: (a) => (Number(a.maxIterations ?? 0) > 10),
  // Only require approval for send_email if it's outbound (has a 'to' field)
  send_email: (a) => Boolean(a.to),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "denied" | "modified" | "timeout";

export type ApprovalRecord = {
  id: string;
  user_id: string;
  session_id: string;
  tool_name: string;
  tool_args: string;          // JSON
  status: ApprovalStatus;
  modified_args: string | null;  // JSON, set if user modified
  telegram_message_id: string | null;
  telegram_chat_id: string | null;
  decision_note: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
};

export type ApprovalDecision =
  | { approved: true; args: Record<string, unknown> }
  | { approved: false; reason: string };

// ─── D1 Helpers ───────────────────────────────────────────────────────────────

async function insertApproval(db: D1Database, record: ApprovalRecord): Promise<void> {
  await db.prepare(
    `INSERT INTO pending_approvals
      (id, user_id, session_id, tool_name, tool_args, status,
       modified_args, telegram_message_id, telegram_chat_id,
       decision_note, created_at, expires_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    record.id, record.user_id, record.session_id, record.tool_name,
    record.tool_args, record.status, record.modified_args ?? null,
    record.telegram_message_id ?? null, record.telegram_chat_id ?? null,
    record.decision_note ?? null, record.created_at, record.expires_at,
    record.decided_at ?? null
  ).run();
}

async function updateApprovalStatus(
  db: D1Database,
  id: string,
  status: ApprovalStatus,
  opts?: {
    modifiedArgs?: string;
    decisionNote?: string;
    telegramMessageId?: string;
    telegramChatId?: string;
  }
): Promise<void> {
  const decidedAt = ["pending"].includes(status) ? null : new Date().toISOString();
  await db.prepare(
    `UPDATE pending_approvals SET
       status = ?,
       modified_args = COALESCE(?, modified_args),
       decision_note = COALESCE(?, decision_note),
       telegram_message_id = COALESCE(?, telegram_message_id),
       telegram_chat_id = COALESCE(?, telegram_chat_id),
       decided_at = ?
     WHERE id = ?`
  ).bind(
    status,
    opts?.modifiedArgs ?? null,
    opts?.decisionNote ?? null,
    opts?.telegramMessageId ?? null,
    opts?.telegramChatId ?? null,
    decidedAt,
    id
  ).run();
}

export async function getApprovalById(db: D1Database, id: string): Promise<ApprovalRecord | null> {
  return db.prepare("SELECT * FROM pending_approvals WHERE id = ? LIMIT 1")
    .bind(id).first<ApprovalRecord>();
}

// ─── Approval Gate — called from tool executor ────────────────────────────────

/**
 * Check whether a tool call needs approval for this user.
 * Returns true if the tool should be held for human review.
 */
export function toolNeedsApproval(
  toolName: string,
  args: Record<string, unknown>
): boolean {
  if (APPROVAL_REQUIRED_TOOLS.has(toolName)) {
    // Check if there's a conditional override
    const condition = APPROVAL_CONDITIONAL[toolName];
    if (condition) return condition(args);
    return true;
  }
  return false;
}

/**
 * Create an approval request, notify user via Telegram, and return the approval ID.
 * The agent should then call waitForApproval() with this ID.
 */
export async function requestApproval(
  db: D1Database,
  env: Env,
  opts: {
    userId: string;
    sessionId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + APPROVAL_TIMEOUT_MS);

  // Redact any values that look like secrets before storing
  const safeArgs = redactSecrets(opts.toolArgs);

  const record: ApprovalRecord = {
    id,
    user_id: opts.userId,
    session_id: opts.sessionId,
    tool_name: opts.toolName,
    tool_args: JSON.stringify(safeArgs),
    status: "pending",
    modified_args: null,
    telegram_message_id: null,
    telegram_chat_id: null,
    decision_note: null,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    decided_at: null,
  };

  await insertApproval(db, record);

  // Notify via Telegram inline keyboard if user has a bot configured
  await sendTelegramApprovalMessage(env, opts.userId, id, opts.toolName, safeArgs)
    .catch((e) => console.warn("[Approvals] Telegram notify failed:", String(e)));

  return id;
}

/**
 * Poll D1 for an approval decision.
 * Blocks (polls every 3s) for up to APPROVAL_TIMEOUT_MS.
 * Returns the decision — caller executes or aborts accordingly.
 */
export async function waitForApproval(
  db: D1Database,
  approvalId: string,
  originalArgs: Record<string, unknown>
): Promise<ApprovalDecision> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  const POLL_INTERVAL_MS = 3000;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const record = await getApprovalById(db, approvalId);
    if (!record) return { approved: false, reason: "Approval record not found." };

    switch (record.status) {
      case "approved":
        return { approved: true, args: originalArgs };

      case "modified": {
        const modifiedArgs = record.modified_args
          ? JSON.parse(record.modified_args)
          : originalArgs;
        return { approved: true, args: modifiedArgs };
      }

      case "denied":
        return {
          approved: false,
          reason: record.decision_note ?? "User denied the action.",
        };

      case "timeout":
        return { approved: false, reason: "Approval timed out (no response within 5 minutes)." };

      case "pending":
        // Check if expired
        if (new Date(record.expires_at).getTime() < Date.now()) {
          await updateApprovalStatus(db, approvalId, "timeout");
          return { approved: false, reason: "Approval timed out." };
        }
        // Still waiting — continue polling
        continue;
    }
  }

  // Deadline exceeded
  await updateApprovalStatus(db, approvalId, "timeout").catch(() => { });
  return { approved: false, reason: "Approval timed out (no response within 5 minutes)." };
}

// ─── Telegram Approval Message ────────────────────────────────────────────────

async function sendTelegramApprovalMessage(
  env: Env,
  userId: string,
  approvalId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<void> {
  // Get user's Telegram config from D1
  const config = await env.DB.prepare(
    "SELECT * FROM telegram_configs WHERE user_id = ? LIMIT 1"
  ).bind(userId).first<{ token: string; bot_id: number } & Record<string, unknown>>();

  if (!config?.token) return; // User has no Telegram bot — skip silently

  // Get the user's telegram chat_id from Redis
  const { getRedis } = await import("../memory");
  const redis = getRedis(env);
  const chatId = await redis.get<string>(`telegram:chat-id:${userId}`);
  if (!chatId) return;

  const argsText = JSON.stringify(args, null, 2).slice(0, 800);
  const toolEmoji = TOOL_EMOJIS[toolName] ?? "🔧";
  const text =
    `${toolEmoji} *VEGA Action Request*\n\n` +
    `Tool: \`${toolName}\`\n\n` +
    `*Parameters:*\n\`\`\`json\n${argsText}\n\`\`\`\n\n` +
    `⏱ Auto-denies in 5 minutes if no response.`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `approve:${approvalId}` },
        { text: "❌ Deny", callback_data: `deny:${approvalId}` },
      ],
    ],
  };

  const res = await fetch(
    `https://api.telegram.org/bot${config.token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }),
    }
  );

  const data = await res.json<{ ok: boolean; result?: { message_id: number } }>();
  if (data.ok && data.result?.message_id) {
    // Store message_id so we can edit it when the decision comes in
    await env.DB.prepare(
      "UPDATE pending_approvals SET telegram_message_id = ?, telegram_chat_id = ? WHERE id = ?"
    ).bind(String(data.result.message_id), String(chatId), approvalId).run();
  }
}

const TOOL_EMOJIS: Record<string, string> = {
  send_email: "📧",
  spawn_agent: "🤖",
  trigger_workflow: "⚙️",
  schedule_cron: "⏰",
  delete_secret: "🗑️",
  run_code: "💻",
  cf_fill_form: "📝",
  cf_click: "🖱️",
};

// ─── Telegram Callback Query Handler ─────────────────────────────────────────
// Called from the Telegram webhook handler in index.ts when a callback_query
// arrives with data matching "approve:UUID" or "deny:UUID".

export async function handleApprovalCallback(
  db: D1Database,
  env: Env,
  callbackQuery: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  }
): Promise<boolean> {
  const data = callbackQuery.data ?? "";
  const approveMatch = data.match(/^approve:([0-9a-f-]{36})$/);
  const denyMatch = data.match(/^deny:([0-9a-f-]{36})$/);

  if (!approveMatch && !denyMatch) return false; // not our callback

  const approvalId = (approveMatch ?? denyMatch)![1];
  const approved = !!approveMatch;
  const record = await getApprovalById(db, approvalId);

  if (!record) {
    await answerCallbackQuery(env, callbackQuery.id, record, "❌ Approval not found.", db);
    return true;
  }

  if (record.status !== "pending") {
    await answerCallbackQuery(env, callbackQuery.id, record, "Already decided.", db);
    return true;
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    await updateApprovalStatus(db, approvalId, "timeout");
    await answerCallbackQuery(env, callbackQuery.id, record, "⏱ Expired.", db);
    return true;
  }

  const status: ApprovalStatus = approved ? "approved" : "denied";
  await updateApprovalStatus(db, approvalId, status, {
    decisionNote: approved ? "Approved via Telegram." : "Denied via Telegram.",
  });

  const responseText = approved
    ? `✅ Approved — VEGA will proceed with \`${record.tool_name}\`.`
    : `❌ Denied — VEGA will skip \`${record.tool_name}\`.`;

  await answerCallbackQuery(env, callbackQuery.id, record, responseText, db);
  return true;
}

async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  record: ApprovalRecord | null,
  text: string,
  db: D1Database
): Promise<void> {
  if (!record) return;

  // Get bot token
  const config = await db.prepare(
    "SELECT token FROM telegram_configs WHERE user_id = ? LIMIT 1"
  ).bind(record.user_id).first<{ token: string }>();
  if (!config?.token) return;

  // Answer the callback (clears the loading spinner on Telegram's side)
  await fetch(`https://api.telegram.org/bot${config.token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  }).catch(() => { });

  // Edit the original message to show the decision
  if (record.telegram_message_id && record.telegram_chat_id) {
    const emoji = text.startsWith("✅") ? "✅" : text.startsWith("❌") ? "❌" : "⏱";
    await fetch(`https://api.telegram.org/bot${config.token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: record.telegram_chat_id,
        message_id: Number(record.telegram_message_id),
        text: `${emoji} *Decision recorded* for \`${record.tool_name}\`\n\n${text}`,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [] }, // remove buttons
      }),
    }).catch(() => { });
  }
}

// ─── Hono Routes ──────────────────────────────────────────────────────────────

const approvals = new Hono<{ Bindings: Env }>();

/** GET /approvals — list pending approvals for a user */
approvals.get("/", async (c) => {
  const userId = c.req.header("X-User-Id")?.trim();
  if (!userId) return c.json({ error: "X-User-Id required" }, 401);

  const status = c.req.query("status") ?? "pending";
  const rows = await c.env.DB.prepare(
    `SELECT id, tool_name, tool_args, status, created_at, expires_at, decided_at, decision_note
     FROM pending_approvals
     WHERE user_id = ? AND status = ?
     ORDER BY created_at DESC LIMIT 50`
  ).bind(userId, status).all<Partial<ApprovalRecord>>();

  return c.json({ approvals: rows.results ?? [] });
});

/** GET /approvals/:id — poll a single approval (for agent polling) */
approvals.get("/:id", async (c) => {
  const userId = c.req.header("X-User-Id")?.trim();
  if (!userId) return c.json({ error: "X-User-Id required" }, 401);

  const record = await getApprovalById(c.env.DB, c.req.param("id"));
  if (!record || record.user_id !== userId) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ approval: record });
});

export default approvals;

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Redact values that look like API keys or secrets before storing in D1. */
function redactSecrets(args: Record<string, unknown>): Record<string, unknown> {
  const SECRET_PATTERNS = /key|token|secret|password|credential|auth/i;
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => {
      if (SECRET_PATTERNS.test(k) && typeof v === "string" && v.length > 8) {
        return [k, `...${v.slice(-4)}`];
      }
      return [k, v];
    })
  );
}