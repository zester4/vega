/**
 * src/db/schema.ts — Single source of truth for D1 table names and SQL DDL.
 * Used by queries and by migrations (run migrations from this SQL).
 */

export const TELEGRAM_CONFIGS_TABLE = "telegram_configs" as const;

/** SQL to create telegram_configs and its index. Run once per environment (e.g. wrangler d1 execute ... --file=). */
export const SQL_CREATE_TELEGRAM_CONFIGS = `
CREATE TABLE IF NOT EXISTS ${TELEGRAM_CONFIGS_TABLE} (
  user_id TEXT NOT NULL PRIMARY KEY,
  token TEXT NOT NULL,
  secret TEXT NOT NULL UNIQUE,
  bot_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  first_name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  connected_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_configs_secret ON ${TELEGRAM_CONFIGS_TABLE}(secret);
`.trim();
