-- ============================================================================
-- migrations/0002_approvals.sql — Human-in-the-Loop Approval Gates
-- ============================================================================
-- Apply:  npx wrangler d1 execute vega-d1 --remote --file=./migrations/0002_approvals.sql
--
-- Design:
--   • Created when a tool with requiresApproval=true is called.
--   • status: "pending" | "approved" | "denied" | "modified" | "timeout"
--   • The agent workflow waits (polls Redis) until status changes or expires_at passes.
--   • Telegram callback_query_id links back to the inline keyboard message.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pending_approvals (
  id                  TEXT    NOT NULL PRIMARY KEY,  -- uuid
  user_id             TEXT    NOT NULL,
  session_id          TEXT    NOT NULL,              -- agent session that triggered it
  tool_name           TEXT    NOT NULL,
  tool_args           TEXT    NOT NULL,              -- JSON string
  status              TEXT    NOT NULL DEFAULT 'pending',  -- pending|approved|denied|modified|timeout
  modified_args       TEXT,                          -- JSON string, set if user picked "modify"
  telegram_message_id TEXT,                          -- Telegram message_id for editing
  telegram_chat_id    TEXT,                          -- Telegram chat_id for editing
  decision_note       TEXT,                          -- optional user note
  created_at          TEXT    NOT NULL,
  expires_at          TEXT    NOT NULL,              -- ISO — auto-deny after this
  decided_at          TEXT                           -- ISO — when decision was made
);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_user_id
  ON pending_approvals (user_id, status);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_session
  ON pending_approvals (session_id, status);