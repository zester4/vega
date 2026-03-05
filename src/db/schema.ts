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

// ── NEW: WhatsApp ─────────────────────────────────────────────────────────────
export const WHATSAPP_CONFIGS_TABLE = "whatsapp_configs" as const;

/**
 * SQL DDL for whatsapp_configs.
 * One row per VEGA user. phone_number_id is the unique routing key used to
 * match incoming webhook events to the correct user session.
 */
export const SQL_CREATE_WHATSAPP_CONFIGS = `
CREATE TABLE IF NOT EXISTS ${WHATSAPP_CONFIGS_TABLE} (
  user_id         TEXT NOT NULL PRIMARY KEY,
  phone_number_id TEXT NOT NULL UNIQUE,
  access_token    TEXT NOT NULL,
  waba_id         TEXT,
  phone_number    TEXT,
  display_name    TEXT,
  webhook_url     TEXT NOT NULL,
  connected_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_configs_phone_number_id
  ON ${WHATSAPP_CONFIGS_TABLE}(phone_number_id);
`.trim();
