-- ============================================================================
-- migrations/0003_audit_log.sql — Production Audit Log
-- ============================================================================
-- Apply:  npx wrangler d1 execute vega-d1 --remote --file=./migrations/0003_audit_log.sql
--
-- Design:
--   • Append-only. One row per tool call.
--   • result_summary: truncated to 500 chars — not full output.
--   • args_summary: sanitized — secrets are redacted before insert.
--   • D1 WAL mode for high-throughput concurrent writes.
--   • Partitioned query access via user_id + created_at index.
-- ============================================================================

-- PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS audit_log (
  id             TEXT    NOT NULL PRIMARY KEY,  -- uuid
  user_id        TEXT,                          -- null for system/cron calls
  session_id     TEXT    NOT NULL,
  tool_name      TEXT    NOT NULL,
  args_summary   TEXT    NOT NULL,              -- JSON, secrets redacted
  result_summary TEXT,                          -- first 500 chars of result
  status         TEXT    NOT NULL DEFAULT 'ok', -- ok | error | denied
  error_message  TEXT,                          -- null unless status=error
  duration_ms    INTEGER,                       -- wall clock ms for the tool call
  created_at     TEXT    NOT NULL               -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_created
  ON audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_session
  ON audit_log (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_tool
  ON audit_log (tool_name, created_at DESC);