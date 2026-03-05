# VEGA Agent Spawning: Production-Grade Fix
## Root Cause Analysis + Full Implementation Guide

---

## 🔬 Root Cause Diagnosis

The agent spawning system had **4 compounding bugs** that together meant:
> "VEGA spawns a sub-agent, it runs, finishes, and the result disappears into Redis forever."

### Bug 1: No parentSessionId — The Missing Link
`execSpawnAgent` built `agentConfig` without any reference to which conversation
session spawned it. When the agent finished, there was no way to know WHERE to
send the result back.

### Bug 2: Dead-end Notification Chain
When a sub-agent finished:
- `subagent.ts` fired to `UPSTASH_WORKFLOW_URL/webhook/task-complete`
- `workflow.ts` also fired to `/webhook/task-complete`
- `/webhook/task-complete` stored a notification in `agent:notifications` Redis list
- **Nobody ever read that list and sent it to the user**

The notification was a fire-and-forget into a void.

### Bug 3: No Retry on Workflow Dispatch
If the initial `wfClient.trigger()` to launch the workflow failed (wrong QStash URL,
network blip, rate limit), the agent was silently created in "running" state forever.
No retry, no error propagation, no user notification.

### Bug 4: No Self-Healing
Agents stuck in "running" state (due to workflow crashes, Redis TTL expiry, etc.)
were never detected or cleaned up. Users would see perpetually "running" agents
with no recourse.

---

## ✅ The Fix Architecture

```
User: "Research X for me"
        ↓
VEGA: spawn_agent("researcher", instructions)
        ↓ (with callerSessionId = "user-abc123" threaded through)
execSpawnAgent → agentConfig.parentSessionId = "user-abc123"
        ↓
Upstash Workflow dispatched (with 3-attempt retry)
        ↓
[Sub-agent runs autonomously — web_search, analyze, write_file...]
        ↓
wf-finalize / notifyCompletion
        ↓ (NEW)
POST /agents/completion-callback
  ├── Gemini synthesizes user-friendly result
  ├── Stored in Redis: agent:pending:user-abc123
  └── Pushed via Telegram proactive_notify ← USER GETS IT INSTANTLY

Next time user opens /chat:
frontend polls GET /agents/pending/user-abc123
→ Result injected as chat message ← USER SEES IT IN CHAT
```

---

## 🖥️ Frontend Change Required

In the chat page component, add a `useEffect` that polls for pending messages:

```typescript
// In app/chat/page.tsx (or wherever your chat UI lives)
useEffect(() => {
  const checkPending = async () => {
    const res = await fetch(`/api/agents/pending`); // proxy through Next.js
    const { messages } = await res.json();
    if (messages?.length > 0) {
      // Inject these as assistant messages in the chat
      for (const msg of messages) {
        appendMessage({ role: "assistant", content: msg.synthesis });
      }
    }
  };

  // Check on load + every 30s
  checkPending();
  const interval = setInterval(checkPending, 30_000);
  return () => clearInterval(interval);
}, [sessionId]);
```

Add a corresponding proxy route in Next.js:

```typescript
// app/api/agents/pending/route.ts
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return NextResponse.json({ messages: [] });

  const sessionId = `user-${session.user.id}`;
  const res = await fetch(`${process.env.WORKER_URL}/agents/pending/${sessionId}`);
  const data = await res.json();
  return NextResponse.json(data);
}
```

## 🚀 Deploy Checklist

After applying all changes:

```bash
# 1. Ensure WORKER_URL is set in wrangler secrets (used by fireCompletionCallback)
npx wrangler secret put WORKER_URL
# → enter your worker URL: https://vega.workers.dev

# 2. Deploy the Worker
npm run deploy

# 3. Test the callback flow end-to-end
# Open chat, ask VEGA to "research something and tell me when done"
# VEGA should spawn an agent, you should receive a Telegram notification
# when it completes (even if you've closed the chat tab)

# 4. Set up the cron for self-healing (if not already done)
# Use schedule_cron tool in chat: "schedule a cron every 10 minutes"
# Or manually via Upstash dashboard
```

---

## 🔑 Key Principle

The fix follows a simple philosophy:
> **Fire and REPORT BACK, not fire and forget.**

Sub-agents are not launched into the void — they carry the parent's address,
and when they finish (success or error), they dial home. The parent synthesizes
the result and delivers it to the user, whether they're still in the browser
tab or already on their phone checking Telegram.