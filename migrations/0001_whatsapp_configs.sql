-- D1: whatsapp_configs (per-user WhatsApp Business Cloud API config)
-- Run: wrangler d1 execute vega-d1 --remote --file=./migrations/0001_whatsapp_configs.sql
--
-- How multi-tenancy works for WhatsApp (different from Telegram):
--   - All webhooks arrive at one endpoint: /whatsapp/webhook
--   - Meta sends `metadata.phone_number_id` in each event
--   - We look up which VEGA user owns that phone_number_id here
--   - App-level HMAC (WHATSAPP_APP_SECRET) verifies all webhooks — NOT per-user
--   - Each user provides their own phone_number_id + access_token

CREATE TABLE IF NOT EXISTS whatsapp_configs (
  user_id         TEXT NOT NULL PRIMARY KEY,
  phone_number_id TEXT NOT NULL UNIQUE,   -- Meta Phone Number ID (from API Setup page)
  access_token    TEXT NOT NULL,          -- Permanent System User Token (never expires)
  waba_id         TEXT,                   -- WhatsApp Business Account ID (optional)
  phone_number    TEXT,                   -- Actual number e.g. +233501234567
  display_name    TEXT,                   -- Business display name shown to users
  webhook_url     TEXT NOT NULL,
  connected_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_configs_phone_number_id
  ON whatsapp_configs(phone_number_id);