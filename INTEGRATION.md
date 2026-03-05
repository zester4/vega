# VEGA Integration Guide
## WhatsApp Business + Agent Mesh (No. 7) + Agent Completion Feedback

---

## What You're Getting

| Feature | Files |
|---------|-------|
| **WhatsApp per-user** | `src/whatsapp.ts`, `src/db/schema.ts`, `src/db/queries.ts`, D1 migration |
| **Next.js proxy** | `app/api/whatsapp/[...path]/route.ts` |
| **Settings UI** | `app/settings/page.tsx` (full replacement) |
| **Agent Mesh (No.7)** | `src/tools/agent-mesh.ts` — 5 new tools |
| **Agent completion push** | `src/routes/completion-callback.ts` — the missing bridge |

---

## STEP 1 — Run the D1 Migration

```bash
wrangler d1 execute vega-d1 --remote --file=./migrations/0001_whatsapp_configs.sql
```

---

## STEP 2 — Set Worker Secrets

```bash
wrangler secret put WHATSAPP_APP_SECRET
# → Paste your Meta App Secret (from Meta App Dashboard → Settings → Basic)

wrangler secret put WHATSAPP_WEBHOOK_VERIFY_TOKEN
# → Paste any random string (e.g. output of: openssl rand -hex 16)
# → You will set this SAME string in Meta Console webhook config
```

---

## STEP 3 — Copy New Files

Copy all files from this bundle into your project:

```
migrations/0001_whatsapp_configs.sql      → vega/migrations/
src/whatsapp.ts                           → vega/src/
src/db/schema.ts                          → REPLACE vega/src/db/schema.ts
src/db/queries.ts                         → REPLACE vega/src/db/queries.ts
src/tools/agent-mesh.ts                   → vega/src/tools/
src/routes/completion-callback.ts         → vega/src/routes/
worker-configuration.d.ts                 → REPLACE vega/worker-configuration.d.ts
app/api/whatsapp/[...path]/route.ts       → vega/app/api/whatsapp/[...path]/route.ts
app/settings/page.tsx                     → REPLACE vega/app/settings/page.tsx
```

> **Move WhatsAppSection.tsx** out of `app/api/whatsapp/` and into `app/settings/`:
> ```
> app/api/whatsapp/WhatsAppSection.tsx → app/settings/WhatsAppSection.tsx
> ```
> (It's a settings UI component, not an API route)

---

## STEP 4 — Update src/index.ts

### 4a. Add imports at the top (near the Telegram imports)

```typescript
import {
  handleWhatsAppWebhook,
  setupWhatsAppNumber,
  disconnectWhatsAppNumber,
  getWhatsAppConfigForUser,
  verifyWhatsAppSignature,
  type WhatsAppWebhookPayload,
} from "./whatsapp";
import { handleCompletionCallback } from "./routes/completion-callback";
```

### 4b. Add these routes (paste BEFORE the Upstash Workflow handler)

```typescript
// ─── WhatsApp Business Cloud API ─────────────────────────────────────────────

// GET /whatsapp/webhook — Meta webhook verification challenge (runs once during setup)
app.get("/whatsapp/webhook", (c) => {
  const mode      = c.req.query("hub.mode");
  const token     = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const expected  = (c.env as { WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string }).WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (mode === "subscribe" && token === expected && challenge) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return c.json({ error: "Forbidden" }, 403);
});

// POST /whatsapp/webhook — Incoming messages from Meta (all users share this endpoint)
app.post("/whatsapp/webhook", async (c) => {
  const rawBody = await c.req.text();
  const appSecret = (c.env as { WHATSAPP_APP_SECRET?: string }).WHATSAPP_APP_SECRET;
  if (appSecret) {
    const valid = await verifyWhatsAppSignature(rawBody, c.req.header("X-Hub-Signature-256") ?? "", appSecret);
    if (!valid) return c.json({ error: "Invalid signature" }, 401);
  }
  let payload: WhatsAppWebhookPayload;
  try { payload = JSON.parse(rawBody) as WhatsAppWebhookPayload; }
  catch { return c.json({ error: "Invalid JSON" }, 400); }
  c.executionCtx.waitUntil(
    handleWhatsAppWebhook(payload, c.env).catch((e) => console.error("[WA Webhook]", e))
  );
  return c.json({ status: "ok" });
});

// POST /whatsapp/setup
app.post("/whatsapp/setup", async (c) => {
  try {
    const body = await c.req.json<{ phoneNumberId: string; accessToken: string; wabaId?: string; userId?: string }>();
    if (!body.phoneNumberId || !body.accessToken) return c.json({ error: "phoneNumberId and accessToken required" }, 400);
    const secret = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
    const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
    if (internalSecret && secret !== internalSecret) return c.json({ error: "Unauthorized" }, 401);
    const userId = c.req.header("X-User-Id")?.trim() ?? body.userId;
    if (!userId) return c.json({ error: "X-User-Id required" }, 400);
    const config = await setupWhatsAppNumber(body.phoneNumberId, body.accessToken, c.env, userId, body.wabaId);
    return c.json({
      success: true,
      phoneNumber: config.phoneNumber,
      displayName: config.displayName,
      webhookUrl: config.webhookUrl,
      message: `Connected: ${config.displayName} (${config.phoneNumber})`,
      nextStep: `Set webhook URL in Meta Console:\n  URL: ${config.webhookUrl}\n  Verify token: your WHATSAPP_WEBHOOK_VERIFY_TOKEN\n  Subscribe field: messages`,
    });
  } catch (err) { return c.json({ error: String(err) }, 500); }
});

// GET /whatsapp/status
app.get("/whatsapp/status", async (c) => {
  const secret = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
  const userId = (internalSecret && secret === internalSecret) ? c.req.header("X-User-Id")?.trim() : null;
  if (!userId) return c.json({ connected: false });
  const config = await getWhatsAppConfigForUser(c.env, userId);
  if (!config) return c.json({ connected: false });
  const redis = getRedis(c.env);
  const activityCount = await redis.llen(`wa:activity:${userId}`).catch(() => 0);
  return c.json({
    connected: true,
    phoneNumber: config.phoneNumber,
    displayName: config.displayName,
    phoneNumberId: config.phoneNumberId,
    webhookUrl: config.webhookUrl,
    connectedAt: config.connectedAt,
    activityCount,
  });
});

// DELETE /whatsapp/disconnect
app.delete("/whatsapp/disconnect", async (c) => {
  const secret = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
  const userId = (internalSecret && secret === internalSecret) ? c.req.header("X-User-Id")?.trim() : null;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  await disconnectWhatsAppNumber(c.env, userId);
  return c.json({ success: true });
});

// GET /whatsapp/activity
app.get("/whatsapp/activity", async (c) => {
  const secret = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
  const userId = (internalSecret && secret === internalSecret) ? c.req.header("X-User-Id")?.trim() : null;
  if (!userId) return c.json({ activity: [] });
  const redis = getRedis(c.env);
  const raw = await redis.lrange(`wa:activity:${userId}`, 0, 49) as string[];
  return c.json({ activity: raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean) });
});

// ─── Agent Completion Callback ────────────────────────────────────────────────
// Called by workflow.ts and subagent.ts when any background agent finishes.
// Pushes results to user via Telegram + WhatsApp and injects into session history.
app.post("/agents/completion-callback", async (c) => {
  const secret = c.req.header("x-internal-secret");
  const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
  if (internalSecret && secret !== internalSecret) return c.json({ error: "Unauthorized" }, 401);
  const payload = await c.req.json();
  c.executionCtx.waitUntil(
    handleCompletionCallback(payload, c.env).catch((e) => console.error("[CompletionCallback]", e))
  );
  return c.json({ received: true });
});
```

### 4c. Add a route so the chat SSE can flush pending pushes to the UI

Find your existing SSE handler (the one at `/chat` or `/sse`).
Add this endpoint so the frontend can poll for agent completion notifications:

```typescript
// GET /agents/pending-pushes?session=xxx — frontend polls this to get agent results
app.get("/agents/pending-pushes", async (c) => {
  const sessionId = c.req.query("session");
  if (!sessionId) return c.json({ pushes: [] });
  const redis = getRedis(c.env);
  const key = `session:pending-push:${sessionId}`;
  const raw = await redis.lrange(key, 0, 19) as string[];
  await redis.del(key); // consume them
  return c.json({
    pushes: raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean)
  });
});
```

---

## STEP 5 — Update src/tools/builtins.ts

### 5a. Add import at the top

```typescript
import { MESH_TOOL_DECLARATIONS, execMeshTool } from "./agent-mesh";
```

### 5b. Spread mesh tools into BUILTIN_DECLARATIONS

Find your existing array and add one line:

```typescript
export const BUILTIN_DECLARATIONS = [
  // ... all your existing tools ...
  ...MESH_TOOL_DECLARATIONS,   // ← ADD THIS LINE
] as const;
```

### 5c. Add cases to the executeTool switch statement

```typescript
case "message_agent":
case "read_agent_messages":
case "wait_for_agents":
case "broadcast_to_agents":
case "get_mesh_topology":
  return await execMeshTool(toolName, args, env);
```

---

## STEP 6 — Update the spawn_agent tool to pass parentSessionId

In your existing `spawn_agent` tool implementation in `builtins.ts`, find where you build the `AgentConfig` and make sure `parentSessionId` is being set from the current session:

```typescript
// In execSpawnAgent or wherever AgentConfig is built:
const agentConfig: AgentConfig = {
  name: agentName,
  allowedTools: allowedTools ?? null,
  memoryPrefix: memoryPrefix,
  notifyEmail: notifyEmail ?? null,
  spawnedAt: new Date().toISOString(),
  parentAgent: "vega-core",
  parentSessionId: sessionId,  // ← THIS IS THE KEY — pass the current session
};
```

> ⚠️ The `sessionId` format MUST be `"user-{userId}"` for the completion callback to extract userId.
> Check how your `/chat` route constructs sessionId. If it's already `"user-{userId}"` you're good.
> If not, update the chat proxy to format it: `sessionId = \`user-\${userId}\``.

---

## STEP 7 — Update wrangler.toml secrets comment

Add at the bottom of the secrets comment block:

```toml
# WhatsApp Business Cloud API (optional)
# WHATSAPP_APP_SECRET           → Meta App Dashboard → Settings → Basic → App Secret
# WHATSAPP_WEBHOOK_VERIFY_TOKEN → Any random string (set same value in Meta Console)
```

---

## STEP 8 — Configure Meta Console (do this AFTER deploying)

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
2. Select your app → WhatsApp → Configuration → Webhook
3. Set:
   - **Webhook URL**: `https://autonomous-ai-agent.adesrnd.workers.dev/whatsapp/webhook`
   - **Verify token**: value of your `WHATSAPP_WEBHOOK_VERIFY_TOKEN` secret
4. Click Verify — Meta will call GET on your webhook to verify
5. Subscribe to field: **messages**

---

## How Agent Mesh (No. 7) Works

VEGA now has 5 new tools:

| Tool | What it does |
|------|-------------|
| `wait_for_agents` | **THE KEY ONE** — VEGA spawns agents then calls this instead of returning. Polls until all done. |
| `message_agent` | Send a message to any agent's mailbox (lateral P2P comms) |
| `read_agent_messages` | Read messages from your mailbox |
| `broadcast_to_agents` | Send same message to multiple agents at once |
| `get_mesh_topology` | See all agents, their status, and message activity |

### The feedback loop that was broken — now fixed:

**Before:**
```
VEGA → spawn_agent → [returns immediately] → VEGA responds "I've started the task"
                           ↓
                    [agent runs in background]
                           ↓
                    [agent finishes — result in Redis]
                           ↓
                    [nobody pushes result back to user]
```

**After:**
```
VEGA → spawn_agent → wait_for_agents → [polls every 2s]
                                              ↓
                                    [agent finishes]
                                              ↓
                                    completion-callback fires
                                              ↓
                              ┌──── Telegram push to user ────┐
                              │                               │
                              └─── WhatsApp push to user ─────┘
                                              ↓
                                    result injected into session history
                                              ↓
                                    VEGA synthesizes results → responds
```

### Example VEGA conversation:

> User: "Research the top 5 AI chip manufacturers and write a competitive analysis"
>
> VEGA: *(internally)*
> 1. Calls `spawn_agent` × 5 (one per company: NVIDIA, AMD, Intel, Qualcomm, Apple)
> 2. Calls `broadcast_to_agents(agentIds, "Focus on: chip architecture, market share, pricing")`
> 3. Calls `wait_for_agents([id1, id2, id3, id4, id5])` — VEGA BLOCKS HERE
> 4. All 5 agents complete and call `message_agent("vega-core", findings)`
> 5. `wait_for_agents` returns `{ done: true, results: {...} }`
> 6. VEGA synthesizes all findings into a report
> 7. Result pushed to user via Telegram/WhatsApp AND shown in chat

---

## File Map

```
vega/
├── migrations/
│   ├── 0000_telegram_configs.sql    (existing)
│   └── 0001_whatsapp_configs.sql    ← NEW
├── src/
│   ├── db/
│   │   ├── schema.ts                ← UPDATED (added WhatsApp table)
│   │   └── queries.ts               ← UPDATED (added WhatsApp queries)
│   ├── tools/
│   │   ├── builtins.ts              ← UPDATE (import + spread mesh tools)
│   │   └── agent-mesh.ts            ← NEW (5 P2P agent tools)
│   ├── routes/
│   │   ├── workflow.ts              (existing — already calls fireCompletionCallback)
│   │   ├── subagent.ts              (existing — already calls fireCompletionCallback)
│   │   └── completion-callback.ts   ← NEW (the handler that was missing!)
│   ├── index.ts                     ← UPDATE (add routes from STEP 4)
│   └── whatsapp.ts                  ← NEW
├── app/
│   ├── api/
│   │   ├── telegram/[...path]/route.ts  (existing)
│   │   └── whatsapp/[...path]/route.ts  ← NEW
│   └── settings/
│       └── page.tsx                 ← REPLACE (Telegram + WhatsApp sections)
└── worker-configuration.d.ts        ← REPLACE (added WA env vars)
```