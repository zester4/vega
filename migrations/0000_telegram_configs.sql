-- D1: telegram_configs (source of truth: src/db/schema.ts)
-- Run: wrangler d1 execute vega-d1 --remote --file=./migrations/0000_telegram_configs.sql

CREATE TABLE IF NOT EXISTS telegram_configs (
  user_id TEXT NOT NULL PRIMARY KEY,
  token TEXT NOT NULL,
  secret TEXT NOT NULL UNIQUE,
  bot_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  first_name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  connected_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_configs_secret ON telegram_configs(secret);
