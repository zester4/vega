-- ============================================================================
-- migrations/0001_vault.sql — Per-User Encrypted Keys Vault
-- ============================================================================
-- Apply:  npx wrangler d1 execute vega-d1 --remote --file=./migrations/0001_vault.sql
--
-- Design:
--   • One row per (user_id, key_name) pair.
--   • encrypted_value stores:  base64(iv [12 bytes] || ciphertext)
--     produced by AES-256-GCM using a key derived from VAULT_ENCRYPTION_SECRET + userId.
--   • Cloudflare ALSO encrypts D1 at rest with AES-256-GCM (double-layered).
--   • key_hint is optional — last 4 chars of the original value, shown in UI only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_secrets (
  id              TEXT    NOT NULL PRIMARY KEY,   -- uuid
  user_id         TEXT    NOT NULL,               -- VEGA userId
  key_name        TEXT    NOT NULL,               -- e.g. "openai_key", "github_token"
  encrypted_value TEXT    NOT NULL,               -- base64(iv || ciphertext)
  key_hint        TEXT,                           -- last 4 chars, shown in UI  e.g. "...Xk3z"
  description     TEXT,                           -- user-provided label
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_secrets_user_key
  ON user_secrets (user_id, key_name);

CREATE INDEX IF NOT EXISTS idx_user_secrets_user_id
  ON user_secrets (user_id);