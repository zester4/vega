/**
 * src/db/queries.ts — D1 query helpers.
 * ADD the WhatsApp section below the existing Telegram section.
 * Keep all existing Telegram exports unchanged.
 */

// ── EXISTING Telegram exports (keep as-is) ────────────────────────────────────
import { TELEGRAM_CONFIGS_TABLE, WHATSAPP_CONFIGS_TABLE } from "./schema";

export type TelegramConfigRow = {
  user_id: string;
  token: string;
  secret: string;
  bot_id: number;
  username: string;
  first_name: string;
  webhook_url: string;
  connected_at: string;
};

export async function ensureTelegramConfigsTable(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${TELEGRAM_CONFIGS_TABLE} (user_id TEXT NOT NULL PRIMARY KEY, token TEXT NOT NULL, secret TEXT NOT NULL UNIQUE, bot_id INTEGER NOT NULL, username TEXT NOT NULL, first_name TEXT NOT NULL, webhook_url TEXT NOT NULL, connected_at TEXT NOT NULL)`
  ).run();
  await db.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_configs_secret ON ${TELEGRAM_CONFIGS_TABLE}(secret)`
  ).run();
}

export async function getTelegramConfigBySecret(db: D1Database, secret: string): Promise<TelegramConfigRow | null> {
  const row = await db.prepare(`SELECT * FROM ${TELEGRAM_CONFIGS_TABLE} WHERE secret = ?`).bind(secret).first<TelegramConfigRow>();
  return row ?? null;
}

export async function getTelegramConfigByUserId(db: D1Database, userId: string): Promise<TelegramConfigRow | null> {
  const row = await db.prepare(`SELECT * FROM ${TELEGRAM_CONFIGS_TABLE} WHERE user_id = ?`).bind(userId).first<TelegramConfigRow>();
  return row ?? null;
}

export async function insertTelegramConfig(db: D1Database, userId: string, row: Omit<TelegramConfigRow, "user_id">): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO ${TELEGRAM_CONFIGS_TABLE} (user_id, token, secret, bot_id, username, first_name, webhook_url, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(userId, row.token, row.secret, row.bot_id, row.username, row.first_name, row.webhook_url, row.connected_at).run();
}

export async function deleteTelegramConfigByUserId(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM ${TELEGRAM_CONFIGS_TABLE} WHERE user_id = ?`).bind(userId).run();
}

// ── NEW: WhatsApp ─────────────────────────────────────────────────────────────

export type WhatsAppConfigRow = {
  user_id: string;
  phone_number_id: string;   // Meta Phone Number ID — the primary routing key
  access_token: string;      // Permanent System User Token
  waba_id: string | null;    // WhatsApp Business Account ID
  phone_number: string | null;
  display_name: string | null;
  webhook_url: string;
  connected_at: string;
};

/** Ensure whatsapp_configs table and index exist (idempotent). */
export async function ensureWhatsAppConfigsTable(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${WHATSAPP_CONFIGS_TABLE} (` +
    `user_id TEXT NOT NULL PRIMARY KEY, ` +
    `phone_number_id TEXT NOT NULL UNIQUE, ` +
    `access_token TEXT NOT NULL, ` +
    `waba_id TEXT, ` +
    `phone_number TEXT, ` +
    `display_name TEXT, ` +
    `webhook_url TEXT NOT NULL, ` +
    `connected_at TEXT NOT NULL)`
  ).run();
  await db.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_configs_phone_number_id ON ${WHATSAPP_CONFIGS_TABLE}(phone_number_id)`
  ).run();
}

/** Look up config by Meta phone_number_id (used in webhook routing). */
export async function getWhatsAppConfigByPhoneNumberId(
  db: D1Database,
  phoneNumberId: string
): Promise<WhatsAppConfigRow | null> {
  const row = await db
    .prepare(`SELECT * FROM ${WHATSAPP_CONFIGS_TABLE} WHERE phone_number_id = ?`)
    .bind(phoneNumberId)
    .first<WhatsAppConfigRow>();
  return row ?? null;
}

/** Look up config by VEGA user_id. */
export async function getWhatsAppConfigByUserId(
  db: D1Database,
  userId: string
): Promise<WhatsAppConfigRow | null> {
  const row = await db
    .prepare(`SELECT * FROM ${WHATSAPP_CONFIGS_TABLE} WHERE user_id = ?`)
    .bind(userId)
    .first<WhatsAppConfigRow>();
  return row ?? null;
}

/** Insert or replace config for a user. */
export async function insertWhatsAppConfig(
  db: D1Database,
  userId: string,
  row: Omit<WhatsAppConfigRow, "user_id">
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO ${WHATSAPP_CONFIGS_TABLE} ` +
      `(user_id, phone_number_id, access_token, waba_id, phone_number, display_name, webhook_url, connected_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      userId,
      row.phone_number_id,
      row.access_token,
      row.waba_id ?? null,
      row.phone_number ?? null,
      row.display_name ?? null,
      row.webhook_url,
      row.connected_at
    )
    .run();
}

/** Delete config for a user. */
export async function deleteWhatsAppConfigByUserId(
  db: D1Database,
  userId: string
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${WHATSAPP_CONFIGS_TABLE} WHERE user_id = ?`)
    .bind(userId)
    .run();
}