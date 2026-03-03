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
  WORKER_URL: string;             // Deployed Worker URL (for webhooks/workflows)
  BRIDGE_URL: string;             // Next.js Bridge URL (local or Vercel)
  UPSTASH_WORKFLOW_URL: string;   // Required by Upstash Workflow (must match WORKER_URL)
  TELEGRAM_BOT_TOKEN?: string;    // Legacy global bot token (unused in per-user D1 setup)

  // ── AI & Search ───────────────────────────────────────────────────────────
  GEMINI_API_KEY: string;  // Google Gemini API key
  SERPER_API_KEY: string;  // Serper.dev for Google search

  // ── Queue & Orchestration ─────────────────────────────────────────────────
  QSTASH_TOKEN: string;  // Upstash QStash API token
  QSTASH_CURRENT_SIGNING_KEY: string;  // QStash signature verification
  QSTASH_NEXT_SIGNING_KEY: string;  // QStash signature rotation
  QSTASH_URL: string;  // Regional QStash base URL (e.g. https://qstash-us-east-1.upstash.io)

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
  ELEVENLABS_API_KEY: string;  // ElevenLabs API key for text-to-speech

  // ── Cloudflare Bindings ────────────────────────────────────────────────────
  FILES_BUCKET: vega_agent_files;              // R2 bucket for persistent file storage
  DB: D1Database;                              // D1 for telegram_configs (per-user bot tokens)

  // ── Internal (Next.js ↔ Worker) ───────────────────────────────────────────
  TELEGRAM_INTERNAL_SECRET?: string;          // Shared secret for /telegram/* from Next.js (wrangler secret)
}