/**
 * worker-configuration.d.ts
 * Cloudflare Worker environment bindings for VEGA
 *
 * Secrets (set via: wrangler secret put SECRET_NAME):
 *   GEMINI_API_KEY, SERPER_API_KEY, QSTASH_TOKEN,
 *   QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY,
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
 *   UPSTASH_VECTOR_REST_URL, UPSTASH_VECTOR_REST_TOKEN,
 *   E2B_API_KEY, GITHUB_TOKEN, RESEND_API_KEY, RESEND_FROM_EMAIL,
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
 *   BROWSERLESS_TOKEN
 *
 * Bindings (set in wrangler.toml):
 *   FILES_BUCKET → R2 bucket "vega-agent-files"
 */

interface Env {
  // ── Core ──────────────────────────────────────────────────────────────────
  UPSTASH_WORKFLOW_URL: string;  // ngrok or deployed worker URL
  TELEGRAM_BOT_TOKEN?: string;   // Optional fallback token

  // ── AI & Search ───────────────────────────────────────────────────────────
  GEMINI_API_KEY: string;  // Google Gemini API key
  SERPER_API_KEY: string;  // Serper.dev for Google search

  // ── Queue & Orchestration ─────────────────────────────────────────────────
  QSTASH_TOKEN: string;  // Upstash QStash API token
  QSTASH_CURRENT_SIGNING_KEY: string;  // QStash signature verification
  QSTASH_NEXT_SIGNING_KEY: string;  // QStash signature rotation

  // ── Redis (Memory & State) ────────────────────────────────────────────────
  UPSTASH_REDIS_REST_URL: string;  // Upstash Redis REST URL
  UPSTASH_REDIS_REST_TOKEN: string;  // Upstash Redis REST token

  // ── Vector Memory ─────────────────────────────────────────────────────────
  UPSTASH_VECTOR_REST_URL: string;  // Upstash Vector index URL
  UPSTASH_VECTOR_REST_TOKEN: string;  // Upstash Vector index token

  // ── Code Execution ────────────────────────────────────────────────────────
  E2B_API_KEY: string;  // E2B code sandbox API key

  // ── Integrations ──────────────────────────────────────────────────────────
  GITHUB_TOKEN: string;  // GitHub personal access token
  RESEND_API_KEY: string;  // Resend email API key
  RESEND_FROM_EMAIL: string;  // Verified "from" address for emails
  TWILIO_ACCOUNT_SID: string;  // Twilio account SID
  TWILIO_AUTH_TOKEN: string;  // Twilio auth token
  TWILIO_FROM_NUMBER: string;  // Twilio phone number (E.164)
  BROWSERLESS_TOKEN: string;  // Browserless.io API token for headless browser

  // ── Cloudflare Bindings ────────────────────────────────────────────────────
  FILES_BUCKET: R2Bucket;              // R2 bucket for persistent file storage
}