# VEGA — Autonomous AI Agent

Production-ready AI agent: **Next.js** (Vercel) for the app and auth, **Cloudflare Worker** for the agent, with **Neon** (Postgres), **D1** (Telegram configs), **Redis**, and **QStash**.

---

## Architecture

- **Next.js (Vercel)** — App UI, auth (Better Auth + Drizzle + Neon), `/api/*` proxies to Worker. Chat and settings are session-aware; chat history is **persistent per user** when logged in.
- **Cloudflare Worker** — Agent brain (Gemini), tools, workflows, Telegram webhook, and inbound email. Uses Redis (sessions/history), D1 (configs, vault, audit), R2 (files, screenshots), and QStash (cron + workflows).

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Next.js (Vercel)                                                        │
│  /sign-in, /sign-up, /chat, /settings, /api/auth/*, /api/chat, /api/…   │
│  Better Auth + Drizzle → Neon Postgres                                   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ proxy (WORKER_URL)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                                       │
│  POST /chat, /task, /workflow, /telegram/webhook, /cron/tick, …         │
│  Redis (sessions, history) · D1 (telegram_configs) · QStash              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Project structure

```
├── app/                    # Next.js App Router
│   ├── (auth)/sign-in, sign-up
│   ├── api/auth/[...all]/  # Better Auth
│   ├── api/chat/           # Proxy → Worker (injects user sessionId when logged in)
│   ├── api/telegram/       # Proxy → Worker (session + internal secret)
│   ├── chat/, settings/, playground/, …
│   └── layout.tsx
├── lib/                    # Next.js shared
│   ├── auth.ts             # Better Auth (Drizzle + Neon)
│   ├── auth-client.ts
│   ├── db.ts               # Drizzle + Neon
│   └── db/schema.ts        # Better Auth tables (user, session, account, verification)
├── src/                    # Cloudflare Worker
│   ├── index.ts            # Hono routes
│   ├── agent.ts, gemini.ts, memory.ts
│   ├── telegram.ts
│   ├── db/schema.ts        # D1 table names + DDL (telegram_configs)
│   ├── db/queries.ts       # D1 queries
│   └── tools/, routes/
├── drizzle/                # Drizzle migrations (from lib/db/schema.ts)
├── migrations/             # D1 SQL (telegram_configs)
├── wrangler.toml
├── drizzle.config.ts
└── package.json
```

---

## Scripts

| Script | Purpose |
|--------|--------|
| `npm run dev` | Next.js dev server |
| `npm run local` | Run Worker locally (wrangler dev) |
| `npm run build` | **Runs `db:migrate` then `next build`** — requires `NEON_DATABASE_URL` for migrations |
| `npm run db:generate` | Generate Drizzle migrations from `lib/db/schema.ts` |
| `npm run db:migrate` | Apply Drizzle migrations to Neon |
| `npm run db:push` | Push schema to Neon without migration files (dev) |
| `npm run deploy` | Deploy Worker to Cloudflare |

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Next.js (Vercel) — Auth & DB

- **Neon**: Create a Postgres database at [neon.tech](https://neon.tech), copy the connection string.
- **Better Auth**: Generate a secret, e.g. `openssl rand -base64 32`.

Create `.env.local` (or set in Vercel):

```env
NEON_DATABASE_URL=postgresql://...?sslmode=require
BETTER_AUTH_SECRET=<your-secret>
BETTER_AUTH_API_KEY=<from-dash.better-auth.com-create-project>
BETTER_AUTH_URL=https://your-app.vercel.app
WORKER_URL=https://your-worker.workers.dev
TELEGRAM_INTERNAL_SECRET=<shared-secret-with-worker>
```

**Vercel**: Set the same vars in the project (Environment Variables). You need at least: `NEON_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_API_KEY`, `WORKER_URL`, `TELEGRAM_INTERNAL_SECRET`. Optional: `BETTER_AUTH_URL` (your deployed app URL, e.g. `https://vega-ebon.vercel.app`) to fix redirect/callback URLs.

- **Better Auth dashboard**: Install `@better-auth/infra`, add the `dash()` plugin in `lib/auth.ts`, then create a project at [dash.better-auth.com](https://dash.better-auth.com). Set `BETTER_AUTH_API_KEY` to the key shown there (required on Vercel for “Connect Your App”). In “Connect Your App” use your deployed URL (e.g. `https://vega-ebon.vercel.app`) and path `/api/auth`. If you get “Connection Failed” or `GET /api/auth/dash/config 401`: (1) Add `BETTER_AUTH_API_KEY` in Vercel Environment Variables with the exact key from the dashboard, (2) Redeploy so the new env is applied.

- Run migrations once (or let `npm run build` do it):

```bash
npm run db:generate   # only if you change lib/db/schema.ts
npm run db:migrate
```

### 3. Cloudflare Worker — env and D1

- **wrangler.toml**: Set `WORKER_URL`, `UPSTASH_WORKFLOW_URL`, `QSTASH_URL` (e.g. `https://qstash-us-east-1.upstash.io`).
- Create D1 and bind it:

```bash
npx wrangler d1 create vega-d1
```

Put the returned `database_id` in `wrangler.toml` under `[[d1_databases]]`. Then apply the D1 schema:

```bash
npx wrangler d1 execute vega-d1 --remote --file=./migrations/0000_telegram_configs.sql
```

- Set secrets (Worker):

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put QSTASH_TOKEN
npx wrangler secret put QSTASH_CURRENT_SIGNING_KEY
npx wrangler secret put QSTASH_NEXT_SIGNING_KEY
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
npx wrangler secret put QSTASH_URL
npx wrangler secret put TELEGRAM_INTERNAL_SECRET
```

Use the **same** `TELEGRAM_INTERNAL_SECRET` value in Vercel (Next.js) and in the Worker so the Telegram proxy can authenticate to the Worker.

### 4. Run locally

- Terminal 1: `npm run local` (Worker).
- Terminal 2: `npm run dev` (Next.js). Set `WORKER_URL=http://127.0.0.1:8787` in `.env.local`.

---

## Production (Vercel + Cloudflare)

- **Vercel**: Deploy the Next.js app. Set env vars: `NEON_DATABASE_URL`, `BETTER_AUTH_SECRET`, `WORKER_URL` (your deployed Worker URL), `TELEGRAM_INTERNAL_SECRET`.
- **Build**: `npm run build` runs `db:migrate` then `next build`. Ensure `NEON_DATABASE_URL` is set in Vercel so migrations apply.
- **Cloudflare**: Deploy the Worker (`npm run deploy`). Ensure all secrets and `QSTASH_URL` (regional) are set so spawn/cron and Telegram work.

Everything works when:

- Next.js can reach the Worker at `WORKER_URL` and shares `TELEGRAM_INTERNAL_SECRET`.
- Worker has Neon (not used by Worker), D1 and Redis bindings, and QStash/Redis secrets with **regional** `QSTASH_URL` (e.g. `https://qstash-us-east-1.upstash.io`).

---

## Auth and pages

- **Sign up / Sign in**: `/sign-up`, `/sign-in` (email + password). Session is cookie-based.
- **Settings** (`/settings`): Protected; redirects to `/sign-in` if not logged in. Users can connect their **Telegram bot** (token stored per user in D1).
- **Chat** (`/chat`): **Requires sign-in.** Redirects to `/sign-in?callbackURL=/chat` if not logged in. Chat history is **persistent per user** (sessionId is set to `user-{id}` in the API).

---

## Telegram bot

- Each user can connect **one bot** from Settings (token stored in D1, keyed by user).
- Telegram sends updates to the **Worker** URL (`/telegram/webhook`). The Worker resolves the bot by `X-Telegram-Bot-Api-Secret-Token` from D1 and processes the update.
- The bot works well when: D1 is created and bound, `TELEGRAM_INTERNAL_SECRET` is set on both Next.js and Worker, and the Worker URL is reachable from the internet.

---

## API (Worker)

| Endpoint | Description |
|----------|-------------|
| `POST /chat` | Agent chat; body can include `sessionId` (Next.js sets `user-{id}` when logged in). |
| `POST /task` | Queue long-running task. |
| `GET /task/:id` | Task status. |
| `POST /workflow` | Upstash Workflow (durable). |
| `POST /telegram/webhook` | Telegram webhook (resolve bot by secret from D1). |
| `POST /cron/tick` | QStash cron heartbeat. |

---

## Built-in tools (examples)

| Tool | Description |
|------|-------------|
| `web_search` | Web search. |
| `schedule_cron` | Create QStash cron jobs. |
| `trigger_workflow` | Launch durable workflows. |
| `spawn_agent` | Spawn sub-agents (uses QStash; requires correct `QSTASH_URL`). |
| `store_memory` / `recall_memory` | Redis key-value memory. |
| `cf_browse_page` | Advanced headless browser with JS rendering. |
| `set_secret` / `get_secret` | Secure per-user encrypted keys vault. |
| `create_tool` | Register new tools at runtime. |

---

## Summary

- **Build**: `npm run build` = `db:migrate` + `next build`; Drizzle generates SQL from `lib/db/schema.ts` via `db:generate`.
- **Vercel**: Set `NEON_DATABASE_URL`, `BETTER_AUTH_SECRET`, `WORKER_URL`, `TELEGRAM_INTERNAL_SECRET`; deploy; migrations run on build.
- **Chat**: Persistent per user when logged in (API injects `user-{id}` as `sessionId`).
- **Bot**: Per-user Telegram config in D1; webhook on Worker; works when D1 and shared secret are configured.
