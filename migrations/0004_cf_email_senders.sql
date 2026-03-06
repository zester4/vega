-- ============================================================================
-- migrations/0004_cf_email_senders.sql — CF Email Inbound Sender Registry
-- ============================================================================
-- Apply:  npx wrangler d1 execute vega-d1 --remote --file=./migrations/0004_cf_email_senders.sql
--
-- Maps inbound email sender addresses to VEGA userIds.
-- One user can register multiple sender addresses (personal, work, etc.).
-- active=0 is a soft-delete (preserves history).
-- ============================================================================

CREATE TABLE IF NOT EXISTS cf_email_senders (
  id             TEXT    NOT NULL PRIMARY KEY,  -- uuid
  user_id        TEXT    NOT NULL,              -- VEGA userId
  sender_email   TEXT    NOT NULL UNIQUE,       -- lowercased sender address
  label          TEXT,                          -- user label e.g. "Personal"
  active         INTEGER NOT NULL DEFAULT 1,    -- 1=active, 0=paused
  registered_at  TEXT    NOT NULL               -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_cf_email_senders_user_id
  ON cf_email_senders (user_id);

CREATE INDEX IF NOT EXISTS idx_cf_email_senders_email_active
  ON cf_email_senders (sender_email, active);