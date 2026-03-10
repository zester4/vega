/**
 * ============================================================================
 * src/index.ts — VEGA Cloudflare Worker Entry Point (Hono)
 * ============================================================================
 *
 * Routes:
 *   GET  /health              → liveness check
 *   POST /chat                → conversational agent (streaming SSE)
 *   POST /task                → queue a long-running durable workflow
 *   GET  /task/:id            → poll task/agent status
 *   POST /workflow            → Upstash Workflow durable step handler
 *   POST /cron/tick           → QStash periodic heartbeat (self-reflection)
 *   POST /webhook/task-complete → SSE push when a background task finishes
 *   GET  /agents              → list all spawned sub-agents
 *   DELETE /task/:id          → cancel a running task
 *
 * SSE Streaming Contract:
 *   Events emitted during /chat streaming:
 *     { type: "tool-start",  data: { name, input } }
 *     { type: "tool-result", data: { name, output } }
 *     { type: "tool-error",  data: { name, error } }
 *     { type: "message",     data: "<final reply string>" }
 *     { type: "error",       data: { error: "..." } }
 *
 * ============================================================================
 */

import { Hono } from "hono";
import { serve } from "@upstash/workflow/cloudflare";
import { Client as QStashClient, Receiver } from "@upstash/qstash";
import { runAgent, type ToolEvent } from "./agent";
import { BUILTIN_DECLARATIONS } from "./tools/builtins";
import { getRedis, getTask, updateTask, listTasks, listSchedules, listTools, listUserTools, type RegisteredTool } from "./memory";
import { workflowHandler } from "./routes/workflow";
import type { WorkflowPayload } from "./routes/workflow";
import { runSubAgentTask } from "./routes/subagent";
import type { SubAgentPayload } from "./routes/subagent";
import { think } from "./gemini";
import { executeTool } from "./tools/builtins";
import {
  setupTelegramBot,
  disconnectTelegramBot,
  getTelegramConfig,
  getTelegramConfigBySecret,
  getTelegramConfigByUserId,
  handleTelegramUpdate,
  verifyWebhookSecret,
  verifyTelegramInternalSecret,
  TelegramBot
} from "./telegram";
import {
  handleWhatsAppWebhook,
  setupWhatsAppNumber,
  disconnectWhatsAppNumber,
  getWhatsAppConfigForUser,
  verifyWhatsAppSignature,
  type WhatsAppWebhookPayload,
} from "./whatsapp";
import { handleCompletionCallback } from "./routes/completion-callback";
import triggersRouter, { evaluateAllTriggers } from "./routes/triggers";
import { TRIGGER_TOOL_DECLARATIONS, executeTriggerTool } from "./routes/triggers";
import workflowEventsRoute from "./routes/workflow-events";

// ─── NEW IMPORTS FOR 5 FEATURES ───────────────────────────────────────────────
import vaultRoutes from "./routes/vault";
import approvalsRoutes from "./routes/approvals";
import auditRoutes from "./routes/audit";
import cfEmailRoutes from "./routes/cf-email-inbound";
import { handleCfEmailInbound } from "./routes/cf-email-inbound";
import { handleApprovalCallback } from "./routes/approvals";

const app = new Hono<{ Bindings: Env }>();

// ─── CORS middleware ──────────────────────────────────────────────────────────
app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, x-stream, Authorization");
});

app.options("*", (c) => new Response(null, { status: 204 }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({
    status: "ok",
    agent: "VEGA",
    version: "2.0",
    timestamp: Date.now(),
    features: [
      "sub_agents",
      "self_building_tools",
      "r2_file_storage",
      "headless_browser",
      "semantic_memory",
      "durable_workflows",
      "keys_vault",
      "approval_gates",
      "audit_log",
      "cf_browser_rendering",
      "cf_email_inbound",
    ],
  })
);

// ─── File Serving (R2) ────────────────────────────────────────────────────────
// Serves images, audio, and documents stored in the vega_agent_files bucket.
app.get("/files/:path{.+$}", async (c) => {
  const path = c.req.param("path");
  if (!c.env.FILES_BUCKET) {
    return c.json({ error: "FILES_BUCKET not bound" }, 500);
  }

  const object = await c.env.FILES_BUCKET.get(path);
  if (!object) {
    return c.json({ error: "File not found" }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/octet-stream");
  }

  // Handle Range Requests for Audio/Video
  const rangeHeader = c.req.header("range");
  if (rangeHeader && object.size > 0) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : object.size - 1;

    if (start >= object.size || end >= object.size || start > end) {
      headers.set("Content-Range", `bytes */${object.size}`);
      return new Response(null, { status: 416, headers });
    }

    const chunk = object.body?.slice
      ? object.body.slice(start, end + 1) // some environments support slice
      : object.body; // Fallback, we'll try to rely on stream slice or let CF handle it if possible. 
    // Actually, R2 API requires passing range inside the get() call for proper partial download.
    // Let's re-fetch with range.

    const partialObject = await c.env.FILES_BUCKET.get(path, {
      range: { offset: start, length: end - start + 1 }
    });

    if (partialObject) {
      headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
      headers.set("Content-Length", (end - start + 1).toString());
      return new Response(partialObject.body, { status: 206, headers });
    }
  }

  // Fallback to full object
  headers.set("Content-Length", object.size.toString());
  return new Response(object.body, { headers });
});


// ─── Chat ─────────────────────────────────────────────────────────────────────
// Primary conversational endpoint. Always streams via SSE (x-stream: true is default).
// Tool events are emitted in real-time as the agent executes tools.
app.post("/chat", async (c) => {
  try {
    const body = await c.req.json<{
      message: string;
      sessionId?: string;
      attachments?: { mimeType: string; data: string }[];
    }>();

    if (!body.message?.trim()) {
      return c.json({ error: "message is required" }, 400);
    }

    const sessionId = body.sessionId ?? `session-${Date.now()}`;
    const userId = c.req.header("X-User-Id")?.trim();

    // ── Session ↔ User Mapping (Production-Grade Isolation) ──────────────
    // Maps the frontend-generated sessionId to the authenticated userId.
    // This allows background sub-agents to route results back to the user's
    // Telegram without forcing all sessions to share a single history key.
    const redis = getRedis(c.env);
    if (userId && sessionId) {
      await redis.set(`session:user-map:${sessionId}`, userId, {
        ex: 60 * 60 * 24 * 7 // 7 day TTL
      }).catch(() => { });
    }

    // Rate limiting: 30 req/min per session
    const calls = await redis.incr(`rate:${sessionId}`);
    if (calls === 1) await redis.expire(`rate:${sessionId}`, 60);
    if (calls > 30) {
      return c.json({ error: "Rate limit exceeded: 30 requests/minute per session" }, 429);
    }

    const shouldStream = c.req.header("x-stream") !== "false"; // stream by default

    if (shouldStream) {
      return streamingResponse(c.env, sessionId, body.message, body.attachments);
    } else {
      // Non-streaming fallback (for debugging/testing)
      const reply = await runAgent(c.env, sessionId, body.message, undefined, undefined, undefined, body.attachments);
      return c.json({ reply, sessionId });
    }
  } catch (err) {
    console.error("[/chat error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Streaming Response Builder ───────────────────────────────────────────────

function streamingResponse(
  env: Env,
  sessionId: string,
  message: string,
  attachments?: { mimeType: string; data: string }[]
): Response {
  const encoder = new TextEncoder();

  function emit(controller: ReadableStreamDefaultController<Uint8Array>, payload: object): void {
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    } catch {
      // Controller may already be closed — ignore
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Heartbeat to prevent proxy timeouts
      const heartbeat = setInterval(() => {
        emit(controller, { type: "tool-running", data: { timestamp: Date.now() } });
      }, 15000);

      try {
        console.log(`[SSE] Session ${sessionId} starting agent...`);
        const startTime = Date.now();

        const reply = await runAgent(
          env,
          sessionId,
          message,
          undefined,
          (event) => {
            if (event.type === "tool-start") {
              emit(controller, {
                type: "tool-start",
                data: {
                  name: event.data.name,
                  input: event.data.input ?? {},
                },
              });
            } else if (event.type === "tool-result") {
              // Sanitize output — ensure it's serializable
              let output: unknown = event.data.output;
              if (typeof output === "undefined") output = null;
              emit(controller, {
                type: "tool-result",
                data: { name: event.data.name, output },
              });
            } else if (event.type === "tool-error") {
              emit(controller, {
                type: "tool-error",
                data: {
                  name: event.data.name,
                  error: event.data.error ?? "Unknown error",
                },
              });
            }
          },
          undefined,
          attachments
        );

        clearInterval(heartbeat);

        const duration = Date.now() - startTime;
        console.log(`[SSE] Agent completed in ${duration}ms, reply: ${reply.length} chars`);

        // Final message — always emit as a plain string in data field
        emit(controller, {
          type: "message",
          data: typeof reply === "string" ? reply : String(reply),
        });

        controller.close();
      } catch (err) {
        clearInterval(heartbeat);
        console.error("[SSE] Error:", err);
        emit(controller, {
          type: "error",
          data: { error: String(err) },
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── Queue Long-Running Task ──────────────────────────────────────────────────
app.post("/task", async (c) => {
  try {
    const body = await c.req.json<{
      taskType: string;
      instructions: string;
      sessionId?: string;
      steps?: string[];
    }>();

    if (!body.taskType || !body.instructions) {
      return c.json({ error: "taskType and instructions are required" }, 400);
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionId = body.sessionId ?? `session-${Date.now()}`;

    const qstash = new QStashClient({
      token: c.env.QSTASH_TOKEN,
      baseUrl: c.env.QSTASH_URL,
    });
    const workflowBase = (c.env.UPSTASH_WORKFLOW_URL ?? "").trim().replace(/\/$/, "");
    if (!workflowBase) throw new Error("UPSTASH_WORKFLOW_URL must be set");
    await qstash.publishJSON({
      url: `${workflowBase}/workflow`,
      body: {
        taskId,
        sessionId,
        taskType: body.taskType,
        instructions: body.instructions,
        steps: body.steps ?? [],
        agentConfig: null,
      } satisfies WorkflowPayload,
    });

    return c.json({
      success: true,
      taskId,
      message: `Task queued. Poll GET /task/${taskId} for status.`,
      statusEndpoint: `/task/${taskId}`,
    });
  } catch (err) {
    console.error("[/task error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Task Status ──────────────────────────────────────────────────────────────
app.get("/task/:id", async (c) => {
  try {
    const redis = getRedis(c.env);
    const task = await getTask(redis, c.req.param("id"));
    if (!task) return c.json({ error: "Task not found", id: c.req.param("id") }, 404);
    return c.json(task);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Cancel Task ──────────────────────────────────────────────────────────────
app.delete("/task/:id", async (c) => {
  try {
    const taskId = c.req.param("id");
    const redis = getRedis(c.env);
    const task = await getTask(redis, taskId);

    if (!task) return c.json({ error: "Task not found" }, 404);
    if (task.status === "done") return c.json({ error: "Task already completed" }, 400);

    await updateTask(redis, taskId, {
      status: "cancelled",
      result: { cancelledAt: new Date().toISOString(), reason: "Cancelled via API" },
    });

    return c.json({ success: true, taskId, status: "cancelled" });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── List Agents ──────────────────────────────────────────────────────────────
app.get("/agents", async (c) => {
  try {
    const redis = getRedis(c.env);
    const status = c.req.query("status") ?? "all";
    const sessionId = c.req.query("sessionId");

    const raw = await redis.lrange("agent:spawned", 0, 199) as string[];
    const agents = raw.map((r: string) => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);

    let filtered = agents;

    // Filter by status if requested
    if (status !== "all") {
      filtered = filtered.filter((a: any) => a.status === status);
    }

    // Filter by sessionId if provided (Multi-tenant)
    if (sessionId) {
      filtered = filtered.filter((a: any) => a.parentSessionId === sessionId);
    }

    return c.json({ agents: filtered, count: filtered.length });
  } catch (err) {
    console.error("[/agents error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Get specific agent detail ────────────────────────────────────────────────
app.get("/agents/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const redis = getRedis(c.env);

    let agentRecord = null;
    const raw = await redis.lrange("agent:spawned", 0, 199) as string[];
    for (const r of raw) {
      try {
        const parsed = JSON.parse(r);
        if (parsed.agentId === id) {
          agentRecord = parsed;
          break;
        }
      } catch { /* skip */ }
    }

    if (!agentRecord) {
      return c.json({ error: "Agent not found" }, 404);
    }

    const task = await getTask(redis, id);
    if (task) {
      agentRecord.taskStatus = task.status;
      agentRecord.taskSummary = (task.result as { summary?: string })?.summary;
    }

    return c.json(agentRecord);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Invoke existing agent directly from API ──────────────────────────────────
app.post("/agents/:id/invoke", async (c) => {
  try {
    const agentId = c.req.param("id");
    const body = await c.req.json<{ instructions: string }>();

    if (!body.instructions) {
      return c.json({ error: "instructions required" }, 400);
    }

    const { execInvokeAgent } = await import("./tools/builtins");
    const result = await execInvokeAgent({ agentId, instructions: body.instructions }, c.env);

    return c.json(result);
  } catch (err) {
    console.error("[/agents/:id/invoke error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Spawn Sub-agent (for playground/multi-tenant UI) ─────────────────────────

app.post("/agents/spawn", async (c) => {
  try {
    const body = await c.req.json<{
      agentName: string;
      instructions: string;
      allowedTools?: string[];
      memoryPrefix?: string;
      notifyEmail?: string;
      priority?: "normal" | "high";
    }>();

    if (!body.agentName || !body.instructions) {
      return c.json(
        { error: "agentName and instructions are required" },
        400
      );
    }

    const result = await executeTool(
      "spawn_agent",
      {
        agentName: body.agentName,
        instructions: body.instructions,
        allowedTools: body.allowedTools?.join(","),
        memoryPrefix: body.memoryPrefix,
        notifyEmail: body.notifyEmail,
        priority: body.priority ?? "normal",
      },
      c.env
    );

    return c.json(result);
  } catch (err) {
    console.error("[/agents/spawn error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Task-Complete Webhook ────────────────────────────────────────────────────
// Called by workflowHandler when a sub-agent or long task finishes.
// The frontend can subscribe to this via EventSource if it's polling.
// This also stores the completion notification in Redis for the frontend to poll.
app.post("/webhook/task-complete", async (c) => {
  try {
    const body = await c.req.json<{
      taskId: string;
      agentName?: string;
      status: string;
      summary?: string;
      completedAt: string;
    }>();

    const redis = getRedis(c.env);

    // Store the notification so the frontend can pick it up on next poll
    await redis.lpush("agent:notifications", JSON.stringify({
      ...body,
      receivedAt: new Date().toISOString(),
    }));
    await redis.ltrim("agent:notifications", 0, 49); // keep last 50

    // Update the spawned agents list status
    const agentListRaw = await redis.lrange("agent:spawned", 0, 199) as string[];
    for (let i = 0; i < agentListRaw.length; i++) {
      try {
        const agent = JSON.parse(agentListRaw[i]);
        if (agent.agentId === body.taskId) {
          agent.status = body.status;
          agent.completedAt = body.completedAt;
          await redis.lset("agent:spawned", i, JSON.stringify(agent));
          break;
        }
      } catch { /* ignore parse errors */ }
    }

    console.log(`[Webhook] Task ${body.taskId} (${body.agentName}) ${body.status}`);
    return c.json({ success: true, taskId: body.taskId });
  } catch (err) {
    console.error("[/webhook/task-complete error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /agents/pending-pushes — frontend polls this to get agent completion notifications
app.get("/agents/pending-pushes", async (c) => {
  const sessionId = c.req.query("session") ?? "";
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");

  // Internal auth check
  if (token !== c.env.TELEGRAM_INTERNAL_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const userId = c.req.header("X-User-Id")?.trim();
  const redis = getRedis(c.env);

  // Collect from both keys: the direct session key AND the user-scoped key
  const keys = [`session:pending-push:${sessionId}`];
  if (userId) keys.push(`session:pending-push:user-${userId}`);

  const allPushes: unknown[] = [];
  for (const key of keys) {
    const raw = await redis.lrange(key, 0, 19) as string[];
    if (raw.length > 0) {
      await redis.del(key); // consume
      allPushes.push(
        ...raw.map((r: string) => {
          try { return JSON.parse(r); } catch { return null; }
        }).filter(Boolean)
      );
    }
  }

  return c.json({ pushes: allPushes });
});

// ─── Agent Completion Callback ─────────────────────────────────────────────
// Called by sub-agents (workflow.ts + subagent.ts) when they complete.
app.post("/agents/completion-callback", async (c) => {
  const secret = c.req.header("x-internal-secret");
  const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
  if (internalSecret && secret !== internalSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const payload = await c.req.json();
  c.executionCtx.waitUntil(handleCompletionCallback(payload as any, c.env));
  return c.json({ received: true });
});



// ─── Pending Notifications ────────────────────────────────────────────────────
// Frontend polls this to check for background task completions
app.get("/notifications", async (c) => {
  try {
    const redis = getRedis(c.env);
    const raw = await redis.lrange("agent:notifications", 0, 9) as string[];
    const notifications = raw.map((r: string) => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);

    return c.json({ notifications, count: notifications.length });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Tools & Capabilities Registry ───────────────────────────────────────────

app.get("/tools/v1/registry", async (c) => {
  try {
    const redis = getRedis(c.env);

    // ── Resolve userId (Optional for browsing vs filtered view) ──────────────
    let userId = c.req.header("X-User-Id")?.trim();
    if (!userId) {
      userId = c.req.query("userId")?.trim();
    }

    const legacyTools = await listTools(redis);

    let userTools: RegisteredTool[] = [];
    if (userId) {
      const { listUserTools } = await import("./memory");
      userTools = await listUserTools(redis, userId);
    }

    // Merge: Built-ins + Global Custom + User Private
    const registry = [
      ...BUILTIN_DECLARATIONS.map((t: any) => ({
        ...t,
        id: `builtin-${t.name}`,
        source: "system",
        category: "core",
        status: "active"
      })),
      ...legacyTools.map((t: any) => ({
        ...t,
        id: `custom-${t.name}`,
        source: "user",
        category: "extension",
        status: "active"
      })),
      ...userTools.map((t: any) => ({
        ...t,
        id: `private-${t.name}`,
        source: "user-private",
        category: "extension",
        status: "active"
      }))
    ];

    return c.json({
      success: true,
      count: registry.length,
      tools: registry,
      version: "1.0.0",
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error("[Registry Error]", err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.get("/tasks", async (c) => {
  try {
    const redis = getRedis(c.env);
    const statusFilter = c.req.query("status") ?? "all";
    const tasks = await listTasks(redis);
    const filtered = statusFilter === "all"
      ? tasks
      : tasks.filter((t) => t.status === statusFilter);
    return c.json({ tasks: filtered, count: filtered.length });
  } catch (err) {
    console.error("[/tasks error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/schedules", async (c) => {
  try {
    const redis = getRedis(c.env);
    const schedules = await listSchedules(redis);
    return c.json({ schedules, count: schedules.length });
  } catch (err) {
    console.error("[/schedules error]", err);
    return c.json({ error: String(err) }, 500);
  }
});


// ─── Telegram API ─────────────────────────────────────────────────────────────
// When X-User-Id + Authorization (internal secret) are present, use D1 per-user config.
// Otherwise fall back to legacy Redis/env single-tenant.

function getTelegramUserId(c: { req: { header: (n: string) => string | undefined }; env: Env }): string | null {
  const secret = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!secret || !verifyTelegramInternalSecret(c.env, secret)) return null;
  return c.req.header("X-User-Id")?.trim() ?? null;
}

app.get("/telegram/status", async (c) => {
  try {
    const userId = getTelegramUserId(c);
    const config = userId
      ? await getTelegramConfigByUserId(c.env, userId)
      : await getTelegramConfig(c.env);
    if (!config) return c.json({ connected: false });

    const bot = new TelegramBot(config.token);
    const webhookInfo = await bot.getWebhookInfo();
    const redis = getRedis(c.env);
    const activityKey = config.userId ? `tg:activity:${config.userId}` : "tg:activity";
    const activityCount = await redis.llen(activityKey);

    return c.json({
      connected: true,
      bot: {
        id: config.botId,
        username: config.username,
        firstName: config.firstName,
      },
      webhookUrl: config.webhookUrl,
      connectedAt: config.connectedAt,
      pendingUpdates: webhookInfo.pending_update_count,
      lastError: webhookInfo.last_error_message || null,
      activityCount,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/telegram/setup", async (c) => {
  try {
    const body = await c.req.json<{ botToken: string; userId?: string }>();
    const { botToken, userId } = body;
    if (!botToken) return c.json({ error: "botToken is required" }, 400);

    const rawWorker = c.env.WORKER_URL || c.env.UPSTASH_WORKFLOW_URL;
    const workerUrl = rawWorker?.trim().replace(/\/$/, "");
    if (!workerUrl || !workerUrl.startsWith("https://")) {
      return c.json({ error: "UPSTASH_WORKFLOW_URL must be a valid HTTPS URL" }, 400);
    }

    const authenticatedUserId = getTelegramUserId(c);
    const effectiveUserId = (authenticatedUserId && userId === authenticatedUserId) ? userId : undefined;

    const config = await setupTelegramBot(botToken, workerUrl, c.env, effectiveUserId ?? undefined);

    return c.json({
      success: true,
      bot: { username: config.username, firstName: config.firstName },
      message: "Telegram bot connected successfully!",
    });
  } catch (err) {
    console.error("[Telegram Setup Error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

app.delete("/telegram/disconnect", async (c) => {
  try {
    const userId = getTelegramUserId(c);
    await disconnectTelegramBot(c.env, userId ?? undefined);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/telegram/activity", async (c) => {
  try {
    const redis = getRedis(c.env);
    const userId = getTelegramUserId(c);
    const activityKey = userId ? `tg:activity:${userId}` : "tg:activity";
    const raw = await redis.lrange(activityKey, 0, 49) as string[];
    const activity = raw.map((r: string) => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);
    return c.json({ activity });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/telegram/webhook", async (c) => {
  const secretHeader = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  const config = secretHeader
    ? await getTelegramConfigBySecret(c.env, secretHeader)
    : null;

  // Get the Telegram update first
  let update: unknown;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Check for callback_query (approval button taps) FIRST
  if (update && typeof update === "object" && "callback_query" in update) {
    const callbackData = (update as { callback_query: { data?: string } }).callback_query?.data;
    if (callbackData && (callbackData.startsWith("approve:") || callbackData.startsWith("deny:"))) {
      // Handle approval callback BEFORE regular message handling
      const handled = await handleApprovalCallback(
        c.env.DB,
        c.env,
        (update as { callback_query: unknown }).callback_query as Parameters<typeof handleApprovalCallback>[2]
      );
      if (handled) return c.json({ ok: true });
    }
  }

  // Continue with normal Telegram message handling
  if (!config) {
    const legacy = await getTelegramConfig(c.env);
    if (!legacy) {
      return c.json({ error: "Not configured" }, 400);
    }
    const ok = secretHeader ? verifyWebhookSecret(secretHeader, legacy.secret) : false;
    if (!ok) return c.json({ error: "Unauthorized" }, 401);
    try {
      c.executionCtx.waitUntil(handleTelegramUpdate(update as Parameters<typeof handleTelegramUpdate>[0], c.env, legacy));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
  }
  if (!verifyWebhookSecret(secretHeader ?? null, config.secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  try {
    c.executionCtx.waitUntil(handleTelegramUpdate(update as Parameters<typeof handleTelegramUpdate>[0], c.env, config));
    return c.json({ ok: true });
  } catch (err) {
    console.error("[Telegram Webhook] Error parsing JSON:", err);
    return c.json({ error: "Invalid JSON" }, 400);
  }
});

// ─── WhatsApp Business Cloud API ──────────────────────────────────────────────

// GET /whatsapp/webhook — Meta webhook verification challenge
// Called once when you configure the webhook in Meta Developer Console
app.get("/whatsapp/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  const expectedToken = (c.env as { WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string }).WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token === expectedToken && challenge) {
    console.log("[WhatsApp Webhook] Verification successful");
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  console.warn("[WhatsApp Webhook] Verification failed — token mismatch or missing challenge");
  return c.json({ error: "Forbidden" }, 403);
});

// POST /whatsapp/webhook — Incoming message events from Meta
app.post("/whatsapp/webhook", async (c) => {
  const rawBody = await c.req.text();

  // Verify HMAC signature (app-level, not per-user)
  const appSecret = (c.env as { WHATSAPP_APP_SECRET?: string }).WHATSAPP_APP_SECRET;
  if (appSecret) {
    const sig = c.req.header("X-Hub-Signature-256") ?? "";
    const valid = await verifyWhatsAppSignature(rawBody, sig, appSecret);
    if (!valid) {
      console.warn("[WhatsApp Webhook] Invalid signature");
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Return 200 immediately — Meta requires < 5s response or retries
  // Process asynchronously in background
  c.executionCtx.waitUntil(
    handleWhatsAppWebhook(payload, c.env).catch((e) =>
      console.error("[WhatsApp Webhook] Handler error:", e)
    )
  );

  return c.json({ status: "ok" });
});

// POST /whatsapp/setup — Connect a phone number (called from Next.js settings page)
app.post("/whatsapp/setup", async (c) => {
  try {
    const body = await c.req.json<{
      phoneNumberId: string;
      accessToken: string;
      wabaId?: string;
      userId?: string;
    }>();

    if (!body.phoneNumberId || !body.accessToken) {
      return c.json({ error: "phoneNumberId and accessToken are required" }, 400);
    }

    // Auth: requires X-User-Id + internal secret (same pattern as Telegram)
    const secret = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
    const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
    if (internalSecret && secret !== internalSecret) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const userId = c.req.header("X-User-Id")?.trim() ?? body.userId;
    if (!userId) {
      return c.json({ error: "X-User-Id header required" }, 400);
    }

    const config = await setupWhatsAppNumber(
      body.phoneNumberId,
      body.accessToken,
      c.env,
      userId,
      body.wabaId
    );

    return c.json({
      success: true,
      phoneNumber: config.phoneNumber,
      displayName: config.displayName,
      webhookUrl: config.webhookUrl,
      message: `WhatsApp number ${config.phoneNumber} (${config.displayName}) connected!`,
      nextStep: `Configure your Meta App webhook:\n  URL: ${config.webhookUrl}\n  Verify token: (your WHATSAPP_WEBHOOK_VERIFY_TOKEN secret)\n  Fields: messages`,
    });
  } catch (err) {
    console.error("[/whatsapp/setup error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /whatsapp/status — Get current user's WhatsApp connection status
app.get("/whatsapp/status", async (c) => {
  try {
    const secret = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
    const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
    const userId = (internalSecret && secret === internalSecret)
      ? c.req.header("X-User-Id")?.trim()
      : null;

    if (!userId) return c.json({ connected: false });

    const config = await getWhatsAppConfigForUser(c.env, userId);
    if (!config) return c.json({ connected: false });

    const { getRedis } = await import("./memory");
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
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// DELETE /whatsapp/disconnect — Remove user's WhatsApp config
app.delete("/whatsapp/disconnect", async (c) => {
  try {
    const secret = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
    const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
    const userId = (internalSecret && secret === internalSecret)
      ? c.req.header("X-User-Id")?.trim()
      : null;

    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    await disconnectWhatsAppNumber(c.env, userId);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /whatsapp/activity — Recent message activity for the user's number
app.get("/whatsapp/activity", async (c) => {
  try {
    const secret = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
    const internalSecret = (c.env as { TELEGRAM_INTERNAL_SECRET?: string }).TELEGRAM_INTERNAL_SECRET;
    const userId = (internalSecret && secret === internalSecret)
      ? c.req.header("X-User-Id")?.trim()
      : null;

    if (!userId) return c.json({ activity: [] });

    const { getRedis } = await import("./memory");
    const redis = getRedis(c.env);
    const raw = await redis.lrange(`wa:activity:${userId}`, 0, 49) as string[];
    const activity = raw.map((r: string) => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);

    return c.json({ activity });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Upstash Workflow Handler ─────────────────────────────────────────────────
//
// ROOT CAUSE FIX (was failing every time):
//
//   1. `env` option was a partial subset — only 6 vars passed.
//      `context.env` inside workflowHandler is built from this object, so any step
//      that touched WORKER_URL, TELEGRAM_INTERNAL_SECRET, signing keys, or optional
//      API keys (Serper, Firecrawl, E2B, GitHub…) got `undefined` and silently died.
//      Fix: pass ALL string-typed env vars.
//
//   2. `new Receiver({...})` was always constructed even when signing keys are unset.
//      An instantiated Receiver with undefined keys rejects EVERY QStash callback
//      (step 2, 3, 4…), so workflows could never progress past the first step.
//      Fix: only create Receiver when both keys are present.
//
app.post("/workflow", async (c) => {
  // Only verify QStash signatures when both signing keys are configured.
  // During initial setup / local dev these may be absent — skip verification
  // rather than rejecting every re-invocation and silently killing all steps.
  const receiver = (c.env.QSTASH_CURRENT_SIGNING_KEY && c.env.QSTASH_NEXT_SIGNING_KEY)
    ? new Receiver({
      currentSigningKey: c.env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: c.env.QSTASH_NEXT_SIGNING_KEY,
    })
    : undefined;

  const env = c.env as unknown as Record<string, string | undefined>;

  const handler = serve<WorkflowPayload>(workflowHandler, {
    qstashClient: new QStashClient({
      token: c.env.QSTASH_TOKEN,
      baseUrl: c.env.QSTASH_URL,
    }),
    ...(receiver ? { receiver } : {}),
    // Strip trailing slash — Upstash appends the path automatically
    baseUrl: (c.env.UPSTASH_WORKFLOW_URL ?? c.env.WORKER_URL ?? "").replace(/\/$/, ""),
    // ⚠️  CRITICAL: pass ALL string-type env vars so context.env in every workflow
    // step has the full set.  D1/R2 bindings are NOT included here (they cannot be
    // JSON-serialised through QStash) but Cloudflare re-injects them automatically
    // on every Worker invocation via handler.fetch(…, c.env) below.
    env: {
      // Core infra
      GEMINI_API_KEY: c.env.GEMINI_API_KEY,
      UPSTASH_REDIS_REST_URL: c.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: c.env.UPSTASH_REDIS_REST_TOKEN,
      QSTASH_TOKEN: c.env.QSTASH_TOKEN,
      QSTASH_URL: c.env.QSTASH_URL,
      QSTASH_CURRENT_SIGNING_KEY: c.env.QSTASH_CURRENT_SIGNING_KEY ?? "",
      QSTASH_NEXT_SIGNING_KEY: c.env.QSTASH_NEXT_SIGNING_KEY ?? "",
      UPSTASH_WORKFLOW_URL: c.env.UPSTASH_WORKFLOW_URL,
      WORKER_URL: c.env.WORKER_URL,
      TELEGRAM_INTERNAL_SECRET: c.env.TELEGRAM_INTERNAL_SECRET ?? "",
      BRIDGE_URL: (env.BRIDGE_URL ?? ""),
      UPSTASH_VECTOR_REST_URL: (env.UPSTASH_VECTOR_REST_URL ?? ""),
      UPSTASH_VECTOR_REST_TOKEN: (env.UPSTASH_VECTOR_REST_TOKEN ?? ""),
      SERPER_API_KEY: (env.SERPER_API_KEY ?? ""),
      FIRECRAWL_API_KEY: (env.FIRECRAWL_API_KEY ?? ""),
      E2B_API_KEY: (env.E2B_API_KEY ?? ""),
      GITHUB_TOKEN: (env.GITHUB_TOKEN ?? ""),
      RESEND_API_KEY: (env.RESEND_API_KEY ?? ""),
      RESEND_FROM_EMAIL: (env.RESEND_FROM_EMAIL ?? ""),
      TWILIO_ACCOUNT_SID: (env.TWILIO_ACCOUNT_SID ?? ""),
      TWILIO_AUTH_TOKEN: (env.TWILIO_AUTH_TOKEN ?? ""),
      TWILIO_FROM_NUMBER: (env.TWILIO_FROM_NUMBER ?? ""),
      BROWSERLESS_TOKEN: (env.BROWSERLESS_TOKEN ?? ""),
      WHATSAPP_APP_SECRET: (env.WHATSAPP_APP_SECRET ?? ""),
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: (env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? ""),
      CAPSOLVER_API_KEY: (env.CAPSOLVER_API_KEY ?? ""),
      TWOCAPTCHA_API_KEY: (env.TWOCAPTCHA_API_KEY ?? ""),
      VAULT_ENCRYPTION_SECRET: (env.VAULT_ENCRYPTION_SECRET ?? ""),
      CF_API_TOKEN: (env.CF_API_TOKEN ?? ""),
      CF_ACCOUNT_ID: (env.CF_ACCOUNT_ID ?? ""),
      CF_EMAIL_SENDER: (env.CF_EMAIL_SENDER ?? ""),
    },
  });

  // Pass the full c.env so Cloudflare re-injects D1/R2/KV bindings on each step
  return handler.fetch(c.req.raw, c.env as unknown as Record<string, string | undefined>);
});

// ─── Direct Sub-Agent Executor ─────────────────────────────────────────────
// Does NOT use QStash/Upstash Workflow — runs agent in background via waitUntil.
// Protected by TELEGRAM_INTERNAL_SECRET to prevent abuse.
app.post("/run-subagent", async (c) => {
  const secret = c.req.header("X-Internal-Secret");
  // If TELEGRAM_INTERNAL_SECRET is not configured, allow all internal calls (dev mode).
  // If it IS configured, enforce the secret to prevent abuse.
  const configuredSecret = c.env.TELEGRAM_INTERNAL_SECRET;
  if (configuredSecret && secret !== configuredSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let payload: SubAgentPayload;
  try {
    payload = await c.req.json<SubAgentPayload>();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  if (!payload.taskId || !payload.agentConfig) {
    return c.json({ error: "taskId and agentConfig are required" }, 400);
  }

  // Fire-and-forget in background — responds 202 immediately
  c.executionCtx.waitUntil(runSubAgentTask(c.env, payload));

  return c.json({
    success: true,
    taskId: payload.taskId,
    agentName: payload.agentConfig.name,
    message: "Sub-agent queued for background execution.",
  }, 202);
});

// ─── Async Media Generation (Image + Audio) ──────────────────────────────────
//
// WHY THIS EXISTS:
//   Gemini image generation and TTS take 20-90 s. Running them synchronously
//   inside /chat hits two hard limits simultaneously:
//     • Vercel reverse-proxy: 30 s request timeout → kills the SSE stream
//     • CF Worker CPU time: 30 s on Standard plan
//
// FLOW:
//   1. generate_image / text_to_speech tools detect _sessionId in args
//      (injected by agenticLoop in agent.ts) and publish HERE via QStash.
//   2. This handler ACKs QStash immediately (no retry triggered).
//   3. The Gemini call runs inside waitUntil() — execution continues for
//      up to 30 s AFTER the response, past any proxy timeout.
//   4. On completion, handleCompletionCallback() pushes the result to the
//      user's session (Redis pending-push), Telegram, and WhatsApp.
//
// Auth: QStash-signed (upstash-signature) OR TELEGRAM_INTERNAL_SECRET header.
//
app.post("/run-media", async (c) => {
  const internalSecret = c.env.TELEGRAM_INTERNAL_SECRET;
  const clientSecret = c.req.header("x-internal-secret");
  const hasQStashSig = !!c.req.header("upstash-signature");

  if (!hasQStashSig && internalSecret && clientSecret !== internalSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: {
    type: "image" | "audio";
    taskId: string;
    parentSessionId: string | null;
    userId: string | null;
    args: Record<string, unknown>;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { taskId, type: mediaType, parentSessionId, userId, args } = body;
  if (!taskId || !mediaType || !args) {
    return c.json({ error: "taskId, type and args are required" }, 400);
  }

  // ACK immediately — actual generation runs in background
  c.executionCtx.waitUntil((async () => {
    const redis = getRedis(c.env);
    try {
      await updateTask(redis, taskId, { status: "running" }).catch(() => { });

      let result: Record<string, unknown>;
      if (mediaType === "image") {
        const { execGenerateImage } = await import("./tools/generate-image");
        result = await execGenerateImage(args, c.env);
      } else {
        const { execTextToSpeech } = await import("./tools/voice");
        result = await execTextToSpeech(args, c.env);
      }

      const isError = !!result.error;
      const agentName = mediaType === "image" ? "Image Generator" : "Audio Generator";

      let resultStr: string;
      if (isError) {
        resultStr = `❌ ${agentName} failed: ${result.error}`;
      } else if (mediaType === "image") {
        resultStr = [
          `✅ Image ready!`,
          `📎 **URL**: ${result.imageUrl}`,
          result.description ? `📝 ${String(result.description).slice(0, 300)}` : "",
          `🖼️ Resolution: ${result.resolution} | Aspect: ${result.aspectRatio}`,
        ].filter(Boolean).join("\n");
      } else {
        resultStr = [
          `✅ Audio ready!`,
          `🔊 **URL**: ${result.audioUrl}`,
          `📏 Size: ${result.audioSizeKB ?? "?"}KB | Voice: ${result.voiceName ?? "Puck"}`,
        ].join("\n");
      }

      await updateTask(redis, taskId, {
        status: isError ? "error" : "done",
        result: { ...result, completedAt: new Date().toISOString() },
      }).catch(() => { });

      await handleCompletionCallback({
        taskId,
        agentName,
        parentSessionId,
        userId: userId ?? undefined,
        memoryPrefix: taskId,
        status: isError ? "error" : "done",
        result: resultStr,
        completedAt: new Date().toISOString(),
      }, c.env);

    } catch (err) {
      console.error(`[/run-media] ${taskId} fatal:`, String(err));
      await updateTask(redis, taskId, {
        status: "error",
        result: { error: String(err), failedAt: new Date().toISOString() },
      }).catch(() => { });
    }
  })());

  return c.json({ received: true, taskId });
});

// ─── QStash Cron Heartbeat + Self-Healing ─────────────────────────────────────
app.post("/cron/tick", async (c) => {
  try {
    const receiver = new Receiver({
      currentSigningKey: c.env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: c.env.QSTASH_NEXT_SIGNING_KEY,
    });

    const signature = c.req.header("upstash-signature") ?? "";
    const body = await c.req.text();
    const isValid = await receiver.verify({ signature, body });

    if (!isValid) {
      return c.json({ error: "Unauthorized — invalid QStash signature" }, 401);
    }

    const redis = getRedis(c.env);
    const healingReport: string[] = [];

    // ── Self-healing: detect and recover stuck agents ─────────────────────────
    try {
      const STUCK_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
      const now = Date.now();

      const agentListRaw = await redis.lrange("agent:spawned", 0, 99) as string[];

      for (let i = 0; i < agentListRaw.length; i++) {
        try {
          const agent = JSON.parse(agentListRaw[i]);
          if (agent.status !== "running") continue;

          const age = now - new Date(agent.spawnedAt).getTime();

          // ── Respect per-agent sleep interval ────────────────────────────────
          // Monitor workflows sleep between checks — don't declare them stuck
          // just because they've been "running" longer than 15 minutes.
          // A monitor sleeping hourly needs 90-minute threshold (1.5× sleep).
          const sleepSec = agent.agentConfig?.sleepBetweenStepsSec ?? 0;
          const stuckThresholdMs = sleepSec > 0
            ? Math.max(sleepSec * 1.5 * 1000, 15 * 60 * 1000)   // 1.5× sleep interval, min 15m
            : 30 * 60 * 1000;                                     // 30m for non-sleeping agents

          if (age < stuckThresholdMs) continue;

          // Double-check the task record in Redis
          const task = await getTask(redis, agent.agentId);
          if (!task || task.status !== "running") continue;

          // Check if we already tried to respawn this run (avoid infinite respawn loops)
          const respawnKey = `agent:respawned:${agent.agentId}`;
          const alreadyRespawned = await redis.get(respawnKey).catch(() => null);

          if (!alreadyRespawned) {
            // ── RESPAWN: re-publish workflow payload to QStash ─────────────────
            // The workflow will pick up its state from Redis (stateKey = agent:wf-state:{taskId})
            // which is still there with 7-day TTL. It resumes from the last saved iteration.
            try {
              const { Client: QStashClient } = await import("@upstash/qstash");
              const qstash = new QStashClient({ token: c.env.QSTASH_TOKEN });
              const workerBase = (c.env.UPSTASH_WORKFLOW_URL ?? c.env.WORKER_URL ?? "").replace(/\/$/, "");

              await qstash.publishJSON({
                url: `${workerBase}/workflow`,
                body: {
                  taskId: agent.agentId,
                  sessionId: agent.agentConfig?.parentSessionId ?? agent.agentId,
                  taskType: "sub_agent",
                  instructions: agent.agentConfig?.instructions ?? "Resume previous task.",
                  agentConfig: {
                    ...(agent.agentConfig ?? {}),
                    name: agent.agentName,
                    chainGeneration: (agent.agentConfig?.chainGeneration ?? 0) + 1,
                  },
                },
              });

              // Mark as respawned so we don't loop on the next tick
              await redis.set(respawnKey, "1", { ex: 60 * 60 * 2 }).catch(() => { }); // 2h TTL

              // Update spawned list entry
              agent.status = "respawned";
              agent.respawnedAt = new Date().toISOString();
              await redis.lset("agent:spawned", i, JSON.stringify(agent));

              healingReport.push(`Respawned stuck agent '${agent.agentName}' (${agent.agentId}) after ${Math.round(age / 60000)}m`);
              console.log(`[cron/tick] Respawned ${agent.agentId} — age: ${Math.round(age / 60000)}m, threshold: ${Math.round(stuckThresholdMs / 60000)}m`);
            } catch (respawnErr) {
              console.warn(`[cron/tick] Respawn failed for ${agent.agentId}:`, String(respawnErr));
              // Fall through to mark as error if respawn itself fails
              await updateTask(redis, agent.agentId, {
                status: "error",
                result: { error: `Respawn failed: ${String(respawnErr)}`, failedAt: new Date().toISOString() },
              }).catch(() => { });
              agent.status = "error";
              await redis.lset("agent:spawned", i, JSON.stringify(agent));
              healingReport.push(`Respawn failed for '${agent.agentName}' (${agent.agentId}) — marked error`);
            }
          } else {
            // Already tried once — mark as truly dead and notify user
            const errorMsg = `Agent '${agent.agentName}' ran for ${Math.round(age / 60000)} minutes and could not be auto-recovered.`;
            await updateTask(redis, agent.agentId, {
              status: "error",
              result: { error: errorMsg, failedAt: new Date().toISOString(), selfHealed: true },
            }).catch(() => { });
            agent.status = "error";
            agent.error = errorMsg;
            agent.healedAt = new Date().toISOString();
            await redis.lset("agent:spawned", i, JSON.stringify(agent));
            healingReport.push(`Permanently failed: '${agent.agentName}' (${agent.agentId})`);

            if (agent.parentSessionId) {
              const { fireCompletionCallback } = await import("./routes/workflow");
              await fireCompletionCallback(c.env, {
                taskId: agent.agentId,
                agentName: agent.agentName,
                parentSessionId: agent.parentSessionId,
                memoryPrefix: agent.agentConfig?.memoryPrefix ?? agent.agentId,
                status: "error",
                result: `⚠️ ${errorMsg} You can try spawning it again.`,
                completedAt: new Date().toISOString(),
              }).catch(() => { });
            }
          }
        } catch (agentErr) {
          console.warn("[cron/tick] Agent healing check failed:", String(agentErr));
        }
      }

      if (healingReport.length > 0) {
        console.log(`[cron/tick] Self-healing: ${healingReport.join("; ")}`);
      }
    } catch (healErr) {
      console.error("[cron/tick] Self-healing scan failed:", String(healErr));
    }

    // ── Agent self-reflection ─────────────────────────────────────────────────
    const reflection = await think(
      c.env.GEMINI_API_KEY,
      `You are VEGA running a periodic self-check. Time: ${new Date().toISOString()}.
Self-healing report: ${healingReport.length > 0 ? healingReport.join("; ") : "All agents healthy."}

Review your current state and suggest ONE concrete action:
- Check if any sub-agents need attention
- Identify any scheduled tasks that need follow-up
- Note any capability gaps you've encountered recently
- Suggest one tool you could create to improve your capabilities

Max 80 words. Be specific and actionable.`,
      "You are VEGA — a self-aware autonomous agent. Be brief and actionable."
    );

    console.log("[CRON TICK]", reflection);

    await redis.set("agent:last-tick", JSON.stringify({
      timestamp: Date.now(),
      reflection,
      healingReport,
      iso: new Date().toISOString(),
    }), { ex: 60 * 60 * 25 }); // 25 hours TTL

    // ── Proactive Heartbeat — daily Telegram briefing ──────────────────────────
    // Sent once per day between 7–9 AM UTC. Each user gets one message per day max.
    // The message surfaces the reflection so VEGA feels alive and self-aware.
    try {
      const nowHour = new Date().getUTCHours();
      // Only send in the morning window (adjust to your timezone as needed)
      if (nowHour >= 7 && nowHour <= 9) {
        const usersResult = await c.env.DB.prepare(
          "SELECT user_id, token FROM telegram_configs LIMIT 100"
        ).all<{ user_id: string; token: string }>();

        for (const user of usersResult.results ?? []) {
          const todayKey = `tg:heartbeat-sent:${user.user_id}:${new Date().toISOString().slice(0, 10)}`;
          const alreadySent = await redis.get(todayKey).catch(() => null);
          if (alreadySent) continue;

          const chatId = await redis.get<string>(`telegram:chat-id:${user.user_id}`).catch(() => null);
          if (!chatId || !user.token) continue;

          const healthLine = healingReport.length > 0
            ? `\n\n⚠️ *Actions taken:*\n${healingReport.map(r => `• ${r}`).join("\n")}`
            : "\n\n✅ All systems healthy.";

          const briefingText =
            `🤖 *VEGA Daily Briefing*\n\n` +
            `${reflection}` +
            `${healthLine}\n\n` +
            `_${new Date().toUTCString()}_`;

          await fetch(`https://api.telegram.org/bot${user.token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: briefingText,
              parse_mode: "Markdown",
            }),
          }).catch(() => { }); // non-fatal — user may have blocked the bot

          // Mark sent for today — 25h TTL to handle clock drift
          await redis.set(todayKey, "1", { ex: 60 * 60 * 25 }).catch(() => { });
          console.log(`[cron/tick] Heartbeat sent to user ${user.user_id}`);
        }
      }
    } catch (heartbeatErr) {
      console.warn("[cron/tick] Proactive heartbeat failed:", String(heartbeatErr));
    }

    // Self-evolving tool ecosystem
    try {
      await analyzeToolUsageAndEvolve(c.env);
    } catch (e) {
      console.error("[ToolEvolution error]", e);
    }

    // ── Proactive Trigger Evaluation ───────────────────────────────────────────
    try {
      const triggerResult = await evaluateAllTriggers(c.env);
      console.log(
        `[cron/tick] Triggers: evaluated=${triggerResult.evaluated}, fired=${triggerResult.fired}`,
        triggerResult.errors.length > 0 ? `errors=${triggerResult.errors.join("; ")}` : ""
      );
    } catch (triggerErr) {
      console.error("[cron/tick] Trigger evaluation failed:", String(triggerErr));
    }

    // Auto-resume any failed workflow runs from the DLQ
    c.executionCtx.waitUntil(
      fetch(`${c.env.WORKER_URL}/workflow/resume-dlq`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": c.env.TELEGRAM_INTERNAL_SECRET ?? "",
        },
      }).catch((e) => console.warn("[Cron] DLQ resume failed:", String(e)))
    );

    return c.json({
      success: true,
      reflection,
      selfHealing: {
        agentsFixed: healingReport.length,
        actions: healingReport,
      },
    });
  } catch (err) {
    console.error("[/cron/tick error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Self-evolving tool ecosystem helper ───────────────────────────────────────

async function analyzeToolUsageAndEvolve(env: Env): Promise<void> {
  const redis = getRedis(env);

  const usageKeys = await redis.keys("agent:tool-usage:*") as string[];
  if (!usageKeys || usageKeys.length === 0) return;

  const usageCounts: Record<string, number> = {};
  for (const key of usageKeys) {
    const raw = await redis.get(key);
    const count = Number(raw ?? 0);
    const name = key.replace("agent:tool-usage:", "");
    usageCounts[name] = count;
  }

  // Example heuristic: if web_search is heavily used and we don't yet have
  // a composite "web_research_and_summarize" tool, create it automatically.
  const webSearchCount = usageCounts["web_search"] ?? 0;
  if (webSearchCount < 25) return; // require some real usage before evolving

  const tools = await listTools(redis);
  const alreadyExists = tools.some((t) => t.name === "web_research_and_summarize");
  const alreadyFlagged = await redis.get("agent:self-tool:web_research_and_summarize");

  if (alreadyExists || alreadyFlagged) {
    return;
  }

  const description =
    "Perform end-to-end web research and summarization for a query: " +
    "1) search the web, 2) fetch the most relevant pages, 3) synthesize a concise, well-structured summary with sources.";

  const requirements =
    "Use web_search to find relevant pages, then fetch_url to read them, " +
    "then synthesize a markdown report that includes an executive summary, key findings, and a sources list. " +
    "Return a JSON object with { summary, sources } where sources is an array of { title, url }.";

  const parameters = JSON.stringify({
    properties: {
      query: {
        type: "string",
        description: "The research query to investigate using the web.",
      },
      maxSources: {
        type: "number",
        description: "Maximum number of pages to fetch and consider (default 5).",
      },
    },
    required: ["query"],
  });

  try {
    const result = await executeTool(
      "create_tool",
      {
        name: "web_research_and_summarize",
        description,
        requirements,
        parameters,
      },
      env
    );

    console.log("[ToolEvolution] Created composite tool:", result);
    await redis.set("agent:self-tool:web_research_and_summarize", "1", {
      ex: 60 * 60 * 24 * 7,
    });
  } catch (e) {
    console.error("[ToolEvolution create_tool failed]", e);
  }
}

// ─── Memory API (for frontend Memory page) ────────────────────────────────────
app.get("/memory", async (c) => {
  try {
    const redis = getRedis(c.env);
    const prefix = c.req.query("prefix") ?? "";
    const keys = await redis.keys(`agent:memory:${prefix}*`) as string[];

    const memories = await Promise.all(
      keys.slice(0, 100).map(async (key: string) => {
        const value = await redis.get(key);
        return {
          id: key.replace("agent:memory:", ""),
          key: key.replace("agent:memory:", ""),
          value: value ? String(value) : null,
          createdAt: new Date().toISOString()
        };
      })
    );

    return c.json({ memories, count: memories.length });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.delete("/memory", async (c) => {
  try {
    const redis = getRedis(c.env);
    const keys = await redis.keys("agent:memory:*") as string[];
    if (keys.length > 0) {
      // Delete in batches of 100 to avoid Upstash arg limits
      for (let i = 0; i < keys.length; i += 100) {
        await redis.del(...keys.slice(i, i + 100));
      }
    }
    return c.json({ success: true, deleted: keys.length });
  } catch (err) {
    console.error("[Memory Delete Error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

app.delete("/memory/:key", async (c) => {
  try {
    const key = c.req.param("key");
    const redis = getRedis(c.env);
    await redis.del(`agent:memory:${key}`);
    return c.json({ success: true, deleted: 1 });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Tools Registry API (for frontend Tools page) ─────────────────────────────
app.get("/tools", async (c) => {
  try {
    const redis = getRedis(c.env);
    const { listTools } = await import("./memory");
    const tools = await listTools(redis);
    const custom = tools.filter((t) => !t.builtIn);

    return c.json({
      custom,
      customCount: custom.length,
      builtInCount: 25, // from BUILTIN_DECLARATIONS
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Delete Custom Tool ───────────────────────────────────────────────────────
app.delete("/tools/:name", async (c) => {
  try {
    const name = c.req.param("name");
    const redis = getRedis(c.env);
    await redis.del(`tool:${name}`);
    return c.json({ success: true, deleted: name });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── NEW ROUTE REGISTRATIONS ─────────────────────────────────────────────────
app.route("/vault", vaultRoutes);
app.route("/approvals", approvalsRoutes);
app.route("/audit", auditRoutes);
app.route("/cf-email", cfEmailRoutes);
app.route("/triggers", triggersRouter);

// Workflow event bus — notify waiting workflows, DLQ resume
app.route("/workflow", workflowEventsRoute);

app.post("/webhook/inbound/:webhookId", async (c) => {
  const webhookId = c.req.param("webhookId");
  const redis = getRedis(c.env);

  // Look up the registration
  const regRaw = await redis.get(`webhook:registry:${webhookId}`).catch(() => null);
  if (!regRaw) {
    return c.json({ error: "Webhook not registered or expired" }, 404);
  }

  let reg: { eventId: string; name: string; userId?: string; sessionId?: string; createdAt: string };
  try {
    reg = typeof regRaw === "string" ? JSON.parse(regRaw) : (regRaw as typeof reg);
  } catch {
    return c.json({ error: "Invalid webhook registration data" }, 500);
  }

  // Parse the inbound payload
  let payload: unknown = {};
  try { payload = await c.req.json(); } catch { /* body may be empty */ }

  // Wake the waiting workflow
  try {
    const { Client: WorkflowClient } = await import("@upstash/workflow");
    const client = new WorkflowClient({ token: c.env.QSTASH_TOKEN });

    const result = await client.notify({
      eventId: reg.eventId,
      eventData: {
        webhookId,
        webhookName: reg.name,
        receivedAt: new Date().toISOString(),
        payload,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      },
    });

    const woken = (result as any)?.waiters?.length ?? 0;
    console.log(`[Webhook Inbound] ${webhookId} (${reg.name}) — woke ${woken} workflows`);

    // Log to Redis for debugging
    await redis.set(
      `webhook:last-call:${webhookId}`,
      JSON.stringify({ receivedAt: new Date().toISOString(), woken, payloadPreview: JSON.stringify(payload).slice(0, 200) }),
      { ex: 60 * 60 * 24 * 7 }
    ).catch(() => { });

    return c.json({ ok: true, webhookId, woken });
  } catch (e) {
    console.error(`[Webhook Inbound] notify failed for ${webhookId}:`, String(e));
    return c.json({ error: String(e) }, 500);
  }
});

// ─── Telegram Webhook: Handle Approval Callbacks ──────────────────────────────
// This is integrated into the existing Telegram webhook handler below.
// See the handleTelegramUpdate call in the Telegram webhook section.

// ─── Default Export with Email Handler ────────────────────────────────────────
interface SendEmail {
  send(message: unknown): Promise<void>;
}

export default {
  // Hono handles all HTTP fetch() calls
  fetch: app.fetch.bind(app),

  // CF Email Routing: fires for every inbound email to vega@yourdomain.com
  // Wire up in Cloudflare Dashboard: Email > Email Routing > Email Workers
  email: handleCfEmailInbound,

  // CF Cron Triggers: fires every 5 minutes (configured in wrangler.toml)
  scheduled: async (_event: any, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduledTick(env));
  },
};

async function runScheduledTick(env: Env): Promise<void> {
  const redis = getRedis(env);
  const healingReport: string[] = [];

  // ── 1. Self-healing ──────────────────────────────────────────────────────────
  try {
    const STUCK_THRESHOLD_MS = 15 * 60 * 1000;
    const now = Date.now();
    const agentListRaw = await redis.lrange("agent:spawned", 0, 99) as string[];

    for (let i = 0; i < agentListRaw.length; i++) {
      try {
        const agent = JSON.parse(agentListRaw[i]);
        if (agent.status !== "running") continue;

        const age = now - new Date(agent.spawnedAt).getTime();
        if (age < STUCK_THRESHOLD_MS) continue;

        const task = await getTask(redis, agent.agentId);
        if (!task || task.status !== "running") continue;

        const errorMsg = `Agent timed out after ${Math.round(age / 60000)} minutes.`;
        await updateTask(redis, agent.agentId, {
          status: "error",
          result: { error: errorMsg, failedAt: new Date().toISOString(), selfHealed: true },
        });

        agent.status = "error";
        agent.healedAt = new Date().toISOString();
        await redis.lset("agent:spawned", i, JSON.stringify(agent));
        healingReport.push(`Healed stuck agent '${agent.agentName}' (${agent.agentId})`);

        if (agent.parentSessionId) {
          const { fireCompletionCallback } = await import("./routes/workflow");
          await fireCompletionCallback(env, {
            taskId: agent.agentId,
            agentName: agent.agentName,
            parentSessionId: agent.parentSessionId,
            memoryPrefix: agent.agentConfig?.memoryPrefix ?? agent.agentId,
            status: "error",
            result: `Agent '${agent.agentName}' timed out after ${Math.round(age / 60000)} minutes.`,
            completedAt: new Date().toISOString(),
          }).catch(() => { });
        }
      } catch { /* skip malformed entry */ }
    }
  } catch (e) {
    console.error("[scheduled] Self-healing failed:", e);
  }

  // ── 2. Trigger evaluation ────────────────────────────────────────────────────
  try {
    const { evaluateAllTriggers } = await import("./routes/triggers");
    const result = await evaluateAllTriggers(env);
    console.log(`[scheduled] Triggers: evaluated=${result.evaluated} fired=${result.fired}`);
  } catch (e) {
    console.error("[scheduled] Trigger evaluation failed:", e);
  }

  // ── 2.5 Goal Monitoring ─────────────────────────────────────────────────────
  try {
    const { checkGoalsAtCron } = await import("./tools/goals");
    await checkGoalsAtCron(env);
  } catch (e) {
    console.error("[scheduled] Goal monitoring failed:", e);
  }

  // ── 3. Self-reflection (now actually stored and readable) ────────────────────
  try {
    const { think } = await import("./gemini");
    const reflection = await think(
      env.GEMINI_API_KEY,
      `You are VEGA. Time: ${new Date().toISOString()}.
Self-healing this tick: ${healingReport.length > 0 ? healingReport.join("; ") : "all agents healthy"}.
In one sentence, what is the most useful thing you could do proactively right now?`,
      "Be brief and specific."
    );

    await redis.set("agent:last-tick", JSON.stringify({
      timestamp: Date.now(),
      reflection,
      healingReport,
      iso: new Date().toISOString(),
    }), { ex: 60 * 60 * 25 });

    console.log("[scheduled] Reflection:", reflection);
  } catch (e) {
    console.error("[scheduled] Reflection failed:", e);
  }
}
