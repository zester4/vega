-- ============================================================================
-- migrations/0006_triggers.sql — Proactive Trigger Engine
-- Run: npx wrangler d1 execute vega-d1 --remote --file=./migrations/0006_triggers.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS triggers (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  type            TEXT NOT NULL CHECK(type IN ('schedule','recurring','price_alert','keyword','goal_due','manual')),
  label           TEXT,
  condition_json  TEXT NOT NULL DEFAULT '{}',
  action_prompt   TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  fire_at         TEXT,               -- ISO datetime for 'schedule' type
  cron            TEXT,               -- cron expression for 'recurring' type
  last_fired_at   TEXT,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_triggers_user_enabled ON triggers(user_id, enabled);
CREATE INDEX IF NOT EXISTS idx_triggers_fire_at ON triggers(fire_at) WHERE fire_at IS NOT NULL;