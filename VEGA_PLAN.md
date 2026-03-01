# VEGA — Autonomous Agent: Master Build Plan

> **Stack:** Next.js 16 · Cloudflare Workers · Gemini 3 Flash · Upstash Redis + Vector + Workflow · QStash · ngrok (local)

---

## 0. Context & Current State

You have a dual-architecture setup:

| Layer | Location | Status |
|---|---|---|
| **AI Agent Engine** | `src/` (Cloudflare Worker, port `:8787`) | ✅ Working |
| **Next.js UI** | `app/` | ❌ Default boilerplate — needs full rebuild |
| **CLI** | `cli.ts` | ✅ Working |
| **Upstash Vector** | installed + credentials | ❌ Not wired |
| **E2B Code Interpreter** | installed + key | ❌ Not wired |
| **GitHub (Octokit)** | installed + token | ❌ Not wired |
| **Email (Resend)** | key in `.env` | ❌ Not installed / not wired |
| **SMS (Twilio)** | credentials in `.env` | ❌ Not installed / not wired |

**ngrok** is running and tunneling `:8787` → your current public URL.  
Set `NEXT_PUBLIC_WORKER_URL` in `.env.local` to your ngrok URL so Next.js can talk to the Worker.

---

## PHASE 1 — Fix the Core Agent (Critical, Do First)

### 1.1 — Remove the Keyword Detector (30 min)

**File:** `src/agent.ts`

The `detectToolNeed()` function gates tool use on dumb keyword matching. If the user asks "Who runs OpenAI?" without the word "search", the agent hallucinates instead of searching. The Gemini model is smart enough to decide when to call tools on its own.

**Change:**
```typescript
// REMOVE THIS (agent.ts ~line 45):
response = detectToolNeed(userMessage)
  ? await agenticLoop(...)
  : await chat(...);

// REPLACE WITH:
response = await agenticLoop(env, history, userMessage, session.systemPrompt);
```

Delete the `detectToolNeed()` function entirely.

---

### 1.2 — Fix wrangler.toml + .dev.vars for Local Workflow (15 min)

**File:** `wrangler.toml`
```toml
[vars]
UPSTASH_WORKFLOW_URL = "https://YOUR-NGROK-ID.ngrok-free.app"
```

**File:** `.dev.vars` — add this line:
```
UPSTASH_WORKFLOW_URL=https://YOUR-NGROK-ID.ngrok-free.app
SERPER_API_KEY=f5dac1d0ad628071fd8a5827676637605cd3751d
```

> Replace `YOUR-NGROK-ID` with your live ngrok subdomain. Update this every time ngrok restarts (or buy a fixed ngrok domain).

---

### 1.3 — Fix Dynamic Tool Dispatch (1 hr)

**File:** `src/tools/builtins.ts`

`create_tool` stores a tool in Redis but `executeTool()` has no way to run it. Add a dynamic fallback at the bottom of `executeTool()`:

```typescript
// At the bottom of executeTool(), replace the default case:
default: {
  // Try to find a dynamically registered tool in Redis
  const { Redis } = await import("@upstash/redis/cloudflare");
  const { listTools } = await import("../memory");
  const redis = Redis.fromEnv(env);
  const tools = await listTools(redis);
  const dynTool = tools.find(t => t.name === toolName && !t.builtIn);
  if (dynTool) {
    // Let Gemini interpret and execute the handler description
    const { think } = await import("../gemini");
    const result = await think(
      env.GEMINI_API_KEY,
      `Execute this tool:\nName: ${dynTool.name}\nDescription: ${dynTool.description}\nHandler logic: ${dynTool.handlerCode}\nArgs: ${JSON.stringify(args)}\n\nReturn ONLY a JSON object with the result.`,
      "You are a precise tool executor. Return only valid JSON."
    );
    try { return JSON.parse(result); } catch { return { result }; }
  }
  return { error: `Unknown tool: ${toolName}` };
}
```

---

## PHASE 2 — New Power Tools (Wire Up What's Already Installed)

### 2.1 — Upstash Vector: Semantic Memory & RAG (2-3 hrs)

**Why this matters:** Redis memory (`store_memory`) only retrieves by exact key. Vector memory retrieves by *meaning*. Ask "what did we discuss about my project?" and the agent finds every relevant past conversation automatically.

**Create:** `src/tools/vector-memory.ts`

```typescript
import { Index } from "@upstash/vector";

export function getVectorIndex(env: Env) {
  return new Index({
    url: env.UPSTASH_VECTOR_REST_URL,
    token: env.UPSTASH_VECTOR_REST_TOKEN,
    cache: false, // Required for Cloudflare Workers
  });
}

export async function upsertMemory(env: Env, id: string, text: string, metadata: Record<string, unknown>) {
  const index = getVectorIndex(env);
  await index.upsert({ id, data: text, metadata: { ...metadata, text } });
}

export async function queryMemory(env: Env, query: string, topK = 5) {
  const index = getVectorIndex(env);
  const results = await index.query({ data: query, topK, includeMetadata: true });
  return results
    .filter(r => r.score > 0.7) // Only high-confidence matches
    .map(r => ({ text: r.metadata?.text as string, score: r.score }));
}
```

**Add to `worker-configuration.d.ts`:**
```typescript
UPSTASH_VECTOR_REST_URL: string;
UPSTASH_VECTOR_REST_TOKEN: string;
```

**Add to `.dev.vars`:**
```
UPSTASH_VECTOR_REST_URL=https://maximum-alpaca-8377-us1-vector.upstash.io
UPSTASH_VECTOR_REST_TOKEN=ABcFMG1h...
```

**Add 2 tools to `builtins.ts`:**
- `semantic_recall` — query by meaning, returns top-5 relevant memories
- `semantic_store` — embed and store any text as a searchable memory

**Auto-embed after every conversation turn** (in `agent.ts` after `appendHistory`):
```typescript
await upsertMemory(env, `${sessionId}-${Date.now()}`, userMessage, { sessionId, role: "user" });
await upsertMemory(env, `${sessionId}-${Date.now()+1}`, response, { sessionId, role: "model" });
```

---

### 2.2 — E2B: Real Code Execution Sandbox (1-2 hrs)

**Why this matters:** Instead of the agent describing code, it *runs* it and returns real output, plots, and data.

**Add to `builtins.ts`:**

```typescript
// Declaration:
{
  name: "run_code",
  description: "Execute Python code in a secure cloud sandbox. Returns real stdout, stderr, errors, and file outputs. Use for: data analysis, charting, math, web scraping, API calls, file processing.",
  parameters: {
    properties: {
      code: { type: "string", description: "Python code to run" },
      packages: { type: "string", description: "Comma-separated pip packages to install first e.g. 'pandas,matplotlib'" },
    },
    required: ["code"],
  },
}

// Executor:
async function execRunCode(args: ToolArgs, env: Env): Promise<Record<string, unknown>> {
  const { CodeInterpreter } = await import("@e2b/code-interpreter");
  const { code, packages } = args as { code: string; packages?: string };
  const sandbox = await CodeInterpreter.create({ apiKey: env.E2B_API_KEY });
  try {
    if (packages) {
      await sandbox.notebook.execCell(`!pip install ${packages} -q`);
    }
    const exec = await sandbox.notebook.execCell(code);
    return {
      stdout: exec.logs.stdout.join("\n"),
      stderr: exec.logs.stderr.join("\n"),
      error: exec.error?.value ?? null,
      hasOutput: exec.results.length > 0,
    };
  } finally {
    await sandbox.close();
  }
}
```

**Add to `.dev.vars`:** `E2B_API_KEY=your_e2b_api_key`

---

### 2.3 — GitHub Tool (1 hr)

**Why this matters:** The agent can read your repos, search code, create issues, review PRs — enabling real autonomous dev-ops loops.

```typescript
// Declaration:
{
  name: "github",
  description: "Interact with GitHub. Actions: list_repos, get_file, search_code, create_issue, list_issues.",
  parameters: {
    properties: {
      action: { type: "string", enum: ["list_repos", "get_file", "search_code", "create_issue", "list_issues"] },
      owner: { type: "string" },
      repo: { type: "string" },
      path: { type: "string", description: "File path for get_file" },
      query: { type: "string", description: "Search query for search_code" },
      title: { type: "string", description: "Issue title for create_issue" },
      body: { type: "string", description: "Issue body for create_issue" },
    },
    required: ["action"],
  },
}
```

---

### 2.4 — Email + SMS Tools (1 hr)

Install: `npm install resend twilio`

These tools make the agent **actable** — it can notify you of results, send reports, and alert you after long-running workflows complete.

**`send_email` via Resend:**
```typescript
async function execSendEmail(args: ToolArgs, env: Env) {
  const { Resend } = await import("resend");
  const client = new Resend(env.RESEND_API_KEY);
  const { to, subject, body } = args as { to: string; subject: string; body: string };
  const { data, error } = await client.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to, subject,
    html: `<p>${body.replace(/\n/g, "<br>")}</p>`,
  });
  return error ? { success: false, error: String(error) } : { success: true, id: data?.id };
}
```

**`send_sms` via Twilio:**
```typescript
async function execSendSMS(args: ToolArgs, env: Env) {
  const { to, message } = args as { to: string; message: string };
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: message }).toString(),
  });
  const data = await res.json() as Record<string, unknown>;
  return res.ok ? { success: true, sid: data.sid } : { success: false, error: data.message };
}
```

---

## PHASE 3 — Next.js Chat UI

### Structure

```
app/
├── page.tsx              ← Homepage (marketing/landing — see Phase 4)
├── chat/
│   └── page.tsx          ← /chat route — full agent chat UI
├── api/
│   └── chat/
│       └── route.ts      ← Proxy to CF Worker (keeps ngrok URL server-side)
└── globals.css

src/components/ai-elements/
├── conversation.tsx      ← Scrollable message list
├── message.tsx           ← Individual message bubble (markdown, tool badges)
└── prompt-input.tsx      ← Textarea + send button + session controls
```

### API Proxy Route (`app/api/chat/route.ts`)

Keep the ngrok URL on the server side — never expose it to the browser:

```typescript
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
  
  const res = await fetch(`${workerUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  
  const data = await res.json();
  return Response.json(data, { status: res.status });
}
```

Add to `.env.local`:
```
WORKER_URL=https://YOUR-NGROK-ID.ngrok-free.app
```

> This way, when ngrok URL changes, you only update `.env.local` — never client code.

---

## PHASE 4 — Homepage Design Plan

### Concept: "Mission Control"

Vega is a powerful autonomous agent. The homepage should feel like walking into a command center — not a SaaS marketing page.

**Aesthetic Direction:** Dark industrial-technical. Deep charcoal backgrounds, electric teal/amber accent system, monospace + geometric type pairing. Think NASA mission control crossed with a Bloomberg terminal.

### Page Sections (top to bottom)

#### 1. Hero — "The Agent"
- Full-viewport dark section
- Large type: **"VEGA"** in a sharp geometric font
- Subtitle: "Autonomous · Self-scheduling · Always-on"
- One CTA button: `→ Open Chat` (links to `/chat`)
- Background: slow-moving particle grid or animated constellation (canvas, pure CSS)
- Show a live stat from Redis: "Last active: X minutes ago" (fetched via `/health`)

#### 2. Capabilities Grid
- 6 cards, 2×3 grid, monospace labels
- Each card has: icon (SVG), short title, one-line description
- Cards: Web Search · Code Execution · Long-Running Workflows · Semantic Memory · Self-Scheduling · Email & SMS
- Hover: card lifts with teal border glow

#### 3. Architecture Diagram
- Animated SVG or static diagram showing: Next.js → Worker → Redis / Vector / QStash
- Nodes light up in sequence on scroll-into-view
- Shows the technical depth without requiring explanation

#### 4. Live Agent Log (Optional / Impressive)
- Polls `/health` + `agent:last-tick` from Redis (via an API route)
- Shows the last cron self-reflection output
- Styled like a terminal: dark panel, green monospace text
- Makes the agent feel *alive*

#### 5. Footer
- Minimal: "Built on Cloudflare · Upstash · Gemini" with small wordmarks
- Link to GitHub, `/chat`

### Typography Choices
- Display: `Bebas Neue` or `Space Mono` for headings (hard, technical)
- Body: `IBM Plex Mono` or `JetBrains Mono` (terminal feel, readable)
- Load both from Google Fonts

### Color System
```css
--bg-base:     #0a0a0b;   /* near-black */
--bg-card:     #111113;   /* card surface */
--bg-border:   #1e1e22;   /* subtle borders */
--accent-teal: #00e5cc;   /* primary action */
--accent-amber:#f5a623;   /* secondary / warm */
--text-primary:#e8e8ea;
--text-dim:    #6b6b7a;
```

---

## PHASE 5 — Hardening for 10-Hour Autonomous Runs

### 5.1 — Workflow Resilience
The `workflowHandler` in `src/routes/workflow.ts` already uses Upstash Workflow's durable steps. Each `context.run()` block is idempotent and auto-retried. This is correct. But add:
- **Max step timeout:** Pass `{ retries: 3, timeout: "5m" }` to each `context.run()`
- **Dead-letter handling:** If a workflow fails after all retries, update the task status to `"failed"` with the error reason

### 5.2 — Redis TTL Audit
- Sessions: 24h TTL ✅ (current)
- History: 24h TTL ✅ (current)  
- Tasks: 48h TTL ✅ (current)
- Vector embeddings: No TTL (permanent by default — correct for long-term memory)

### 5.3 — Rate Limit Guard
Add a simple per-session rate limiter in `index.ts` using Redis:
```typescript
const calls = await redis.incr(`rate:${sessionId}`);
if (calls === 1) await redis.expire(`rate:${sessionId}`, 60);
if (calls > 30) return c.json({ error: "Rate limit: 30 requests/min" }, 429);
```

### 5.4 — Error Telemetry
After `catch` blocks in `agent.ts`, log structured errors to a Redis list:
```typescript
await redis.lpush("agent:errors", JSON.stringify({ 
  ts: Date.now(), sessionId, error: String(err), message: userMessage 
}));
await redis.ltrim("agent:errors", 0, 99); // keep last 100
```

---

## Build Order Summary

| # | Task | Time | Impact |
|---|---|---|---|
| 1 | Remove `detectToolNeed`, always use agentic loop | 30 min | 🔴 Critical |
| 2 | Fix `UPSTASH_WORKFLOW_URL` in `.dev.vars` + `wrangler.toml` | 15 min | 🔴 Critical |
| 3 | Wire Upstash Vector (semantic memory) | 2-3 hrs | 🟠 High |
| 4 | Add E2B `run_code` tool | 1-2 hrs | 🟠 High |
| 5 | Build Next.js chat UI (`/chat` page + components) | 3-4 hrs | 🟡 Medium |
| 6 | Add GitHub tool | 1 hr | 🟡 Medium |
| 7 | Add email + SMS tools | 1 hr | 🟡 Medium |
| 8 | Fix dynamic tool dispatch | 1 hr | 🟡 Medium |
| 9 | Build homepage | 3-4 hrs | 🟢 Low |
| 10 | Harden for 10-hr runs (rate limits, error logs) | 1-2 hrs | 🟢 Low |

---

*Total estimated build time: ~16-20 hours across all phases.*