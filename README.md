# 🤖 Autonomous AI Agent

A powerful, self-aware AI agent built on **Cloudflare Workers** + **Gemini 3 Flash** with persistent memory, tool calling, durable workflows, and self-scheduling.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker (Edge)                  │
│                                                             │
│  POST /chat        → Agent Brain (Gemini + Tool Loop)       │
│  POST /task        → Queue long-running workflow            │
│  GET  /task/:id    → Check task status                      │
│  POST /workflow    → Upstash Workflow (durable steps)       │
│  POST /cron/tick   → QStash periodic heartbeat              │
│  GET  /health      → Health check                           │
└──────────────┬──────────────────────────────────────────────┘
               │
       ┌───────┴────────┐
       │                │
  ┌────▼─────┐    ┌─────▼──────────────┐
  │ Upstash  │    │    Upstash         │
  │  Redis   │    │    Workflow        │
  │ (Memory) │    │  (Durable Tasks)   │
  └──────────┘    └─────────────────────┘
                         │
                  ┌──────▼──────┐
                  │   QStash    │
                  │  (Cron +    │
                  │  Messaging) │
                  └─────────────┘
```

---

## Project Structure

```
agent/
├── src/
│   ├── index.ts          # Cloudflare Worker + Hono router
│   ├── agent.ts          # Agent brain (think → tool → chat loop)
│   ├── gemini.ts         # Gemini AI client (thinking, chat, tools, vision)
│   ├── memory.ts         # Redis state (sessions, history, tasks, tools)
│   ├── tools/
│   │   └── builtins.ts   # Built-in tools (fetch, schedule, workflow, memory)
│   └── routes/
│       └── workflow.ts   # Upstash Workflow durable pipeline
├── wrangler.toml  
|__ cli.ts        # Cloudflare Worker config
├── worker-configuration.d.ts  # Env bindings types
├── tsconfig.json
├── package.json
└── .dev.vars             # Local dev secrets (never commit!)
```

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Get your credentials

| Service | Where to get it |
|---------|----------------|
| **Gemini API Key** | [aistudio.google.com](https://aistudio.google.com) |
| **QStash Token + Signing Keys** | [console.upstash.com → QStash](https://console.upstash.com) |
| **Redis URL + Token** | [console.upstash.com → Redis](https://console.upstash.com) |

### 3. Fill in `.dev.vars` for local dev
```env
QSTASH_TOKEN=...
QSTASH_CURRENT_SIGNING_KEY=...
QSTASH_NEXT_SIGNING_KEY=...
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
GEMINI_API_KEY=...
SERPER_API_KEY=...
```

### 4. Update `wrangler.toml`
Set `UPSTASH_WORKFLOW_URL` to your deployed worker URL.

### 5. Run locally
```bash
npm run dev
```
> For local workflow testing, use [Upstash Workflow local dev server](https://upstash.com/docs/qstash/workflow/local-development).

### 6. Deploy to Cloudflare
```bash
npm run deploy
```

Then set secrets via Wrangler:
```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put QSTASH_TOKEN
wrangler secret put QSTASH_CURRENT_SIGNING_KEY
wrangler secret put QSTASH_NEXT_SIGNING_KEY
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
wrangler secret put SERPER_API_KEY
```

### 7. Set up the cron heartbeat (optional)
After deploying, create a QStash schedule to call `/cron/tick` periodically:
```bash
curl -X POST https://qstash.upstash.io/v2/schedules/https://YOUR_WORKER.workers.dev/cron/tick \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: 0 * * * *"
```

---

## API Reference

### `POST /chat` — Conversational Agent
```json
{
  "message": "Fetch https://example.com and summarize it",
  "sessionId": "user-123",
  "thinkingLevel": "LOW"
}
```
Response:
```json
{
  "reply": "Here's the summary...",
  "sessionId": "user-123"
}
```

### `POST /task` — Long-Running Task
```json
{
  "taskType": "research",
  "instructions": "Research the latest AI papers on chain-of-thought prompting",
  "sessionId": "user-123"
}
```
Response:
```json
{
  "success": true,
  "taskId": "task-1234567890-abc123",
  "message": "Task queued. Poll /task/:id for status."
}
```

### `GET /task/:id` — Task Status
```json
{
  "id": "task-1234567890-abc123",
  "status": "done",
  "result": {
    "summary": "...",
    "steps": ["Step 1: ...", "Step 2: ..."]
  }
}
```

---

## Built-in Agent Tools

| Tool | What it does |
|------|-------------|
| `fetch_url` | HTTP GET/POST any public URL |
| `schedule_cron` | Create QStash cron jobs (self-scheduling) |
| `trigger_workflow` | Launch durable long-running pipelines |
| `store_memory` | Persist key-value data to Redis |
| `recall_memory` | Retrieve stored data by key |
| `create_tool` | Dynamically register new tools at runtime |

---

## Gemini Features Used

| Feature | How |
|---------|-----|
| **Thinking (Low/High)** | `thinkingConfig.thinkingLevel` |
| **Tool calling** | `functionDeclarations` in config |
| **Multi-turn chat** | `ai.chats.create()` with history |
| **Vision** | `inlineData` with base64 image |
| **System prompts** | `systemInstruction` in config |

Model: `gemini-3-flash-preview` throughout.
