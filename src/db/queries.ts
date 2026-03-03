/**
 * src/db/queries.ts — D1 query helpers. All SQL lives here; callers pass D1Database.
 */
import { TELEGRAM_CONFIGS_TABLE } from "./schema";

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

/** Ensure telegram_configs table and index exist. */
export async function ensureTelegramConfigsTable(db: D1Database): Promise<void> {
  // Use prepare().run() instead of exec() — exec() is unreliable in Wrangler local D1
  // for multi-line DDL statements. prepare().run() works in both local and remote.
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${TELEGRAM_CONFIGS_TABLE} (user_id TEXT NOT NULL PRIMARY KEY, token TEXT NOT NULL, secret TEXT NOT NULL UNIQUE, bot_id INTEGER NOT NULL, username TEXT NOT NULL, first_name TEXT NOT NULL, webhook_url TEXT NOT NULL, connected_at TEXT NOT NULL)`
  ).run();
  await db.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_configs_secret ON ${TELEGRAM_CONFIGS_TABLE}(secret)`
  ).run();
}

/** Get a single row by secret. */
export async function getTelegramConfigBySecret(
  db: D1Database,
  secret: string
): Promise<TelegramConfigRow | null> {
  const stmt = db
    .prepare(`SELECT * FROM ${TELEGRAM_CONFIGS_TABLE} WHERE secret = ?`)
    .bind(secret);
  const row = await stmt.first<TelegramConfigRow>();
  return row ?? null;
}

/** Get a single row by user_id. */
export async function getTelegramConfigByUserId(
  db: D1Database,
  userId: string
): Promise<TelegramConfigRow | null> {
  const stmt = db
    .prepare(`SELECT * FROM ${TELEGRAM_CONFIGS_TABLE} WHERE user_id = ?`)
    .bind(userId);
  const row = await stmt.first<TelegramConfigRow>();
  return row ?? null;
}

/** Insert or replace config for a user. */
export async function insertTelegramConfig(
  db: D1Database,
  userId: string,
  row: Omit<TelegramConfigRow, "user_id">
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO ${TELEGRAM_CONFIGS_TABLE} (user_id, token, secret, bot_id, username, first_name, webhook_url, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      userId,
      row.token,
      row.secret,
      row.bot_id,
      row.username,
      row.first_name,
      row.webhook_url,
      row.connected_at
    )
    .run();
}

/** Delete config for a user. */
export async function deleteTelegramConfigByUserId(
  db: D1Database,
  userId: string
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${TELEGRAM_CONFIGS_TABLE} WHERE user_id = ?`)
    .bind(userId)
    .run();
}
