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
import { getRedis, getTask, updateTask, listTasks, listSchedules, listTools } from "./memory";
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

    // Rate limiting: 30 req/min per session
    const redis = getRedis(c.env);
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
      "X-Accel-Buffering": "no",   // Disable nginx/Cloudflare buffering
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
    console.log(`[/agents] Redis URL: ${c.env.UPSTASH_REDIS_REST_URL?.slice(0, 25)}...`);

    const status = c.req.query("status") ?? "all";
    const raw = await redis.lrange("agent:spawned", 0, 99) as string[];
    console.log(`[/agents] Found ${raw.length} agents in agent:spawned`);

    const agents = raw.map((r: string) => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);

    const filtered = status === "all"
      ? agents
      : agents.filter((a: Record<string, unknown>) => a.status === status);

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
    const customTools = await listTools(redis);

    // Merge built-in and custom tools with enhanced metadata
    const registry = [
      ...BUILTIN_DECLARATIONS.map((t: any) => ({
        ...t,
        id: `builtin-${t.name}`,
        source: "system",
        category: "core",
        status: "active"
      })),
      ...customTools.map((t: any) => ({
        ...t,
        id: `custom-${t.name}`,
        source: "user",
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

// ─── Human Approval Registry ───────────────────────────────────────────────────

app.get("/approvals", async (c) => {
  try {
    const redis = getRedis(c.env);
    const statusFilter = c.req.query("status") ?? "all";
    const raw = await redis.lrange("agent:approvals", 0, 99) as string[];
    const approvals = raw
      .map((r: string) => {
        try {
          return JSON.parse(r) as {
            id: string;
            operation: string;
            channel: string;
            metadata?: unknown;
            status: string;
            createdAt: string;
            decidedAt?: string;
            approved?: boolean;
            reason?: string;
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Record<string, unknown>[];

    const filtered =
      statusFilter === "all"
        ? approvals
        : approvals.filter((a) => a.status === statusFilter);

    return c.json({ approvals: filtered, count: filtered.length });
  } catch (err) {
    console.error("[/approvals error]", err);
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/approvals/:id/decision", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{
      approved: boolean;
      reason?: string;
    }>();

    const redis = getRedis(c.env);
    const key = `agent:approval:${id}`;
    const existingRaw = await redis.get<string>(key);
    if (!existingRaw) {
      return c.json({ error: "Approval request not found" }, 404);
    }

    let record: any;
    try {
      record = JSON.parse(existingRaw);
    } catch {
      record = { id };
    }

    record.status = body.approved ? "approved" : "rejected";
    record.approved = body.approved;
    record.reason = body.reason ?? record.reason ?? null;
    record.decidedAt = new Date().toISOString();

    await redis.set(key, JSON.stringify(record), { ex: 60 * 60 * 24 });

    // Also update the rolling approvals list
    const listRaw = await redis.lrange("agent:approvals", 0, 199) as string[];
    for (let i = 0; i < listRaw.length; i++) {
      try {
        const item = JSON.parse(listRaw[i]);
        if (item.id === id) {
          await redis.lset("agent:approvals", i, JSON.stringify(record));
          break;
        }
      } catch {
        // ignore parse errors
      }
    }

    return c.json({ success: true, approval: record });
  } catch (err) {
    console.error("[/approvals/:id/decision error]", err);
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
  if (!config) {
    const legacy = await getTelegramConfig(c.env);
    if (!legacy) {
      return c.json({ error: "Not configured" }, 400);
    }
    const ok = secretHeader ? verifyWebhookSecret(secretHeader, legacy.secret) : false;
    if (!ok) return c.json({ error: "Unauthorized" }, 401);
    try {
      const update = await c.req.json();
      c.executionCtx.waitUntil(handleTelegramUpdate(update, c.env, legacy));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
  }
  if (!verifyWebhookSecret(secretHeader ?? null, config.secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  try {
    const update = await c.req.json();
    c.executionCtx.waitUntil(handleTelegramUpdate(update, c.env, config));
    return c.json({ ok: true });
  } catch (err) {
    console.error("[Telegram Webhook] Error parsing JSON:", err);
    return c.json({ error: "Invalid JSON" }, 400);
  }
});

// ─── Upstash Workflow Handler ─────────────────────────────────────────────────
app.post("/workflow", async (c) => {
  const handler = serve<WorkflowPayload>(workflowHandler, {
    qstashClient: new QStashClient({
      token: c.env.QSTASH_TOKEN,
      baseUrl: c.env.QSTASH_URL,
    }),
    receiver: new Receiver({
      currentSigningKey: c.env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: c.env.QSTASH_NEXT_SIGNING_KEY,
    }),
    baseUrl: c.env.UPSTASH_WORKFLOW_URL,
    env: {
      QSTASH_URL: c.env.QSTASH_URL,
      QSTASH_TOKEN: c.env.QSTASH_TOKEN,
      UPSTASH_REDIS_REST_URL: c.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: c.env.UPSTASH_REDIS_REST_TOKEN,
      GEMINI_API_KEY: c.env.GEMINI_API_KEY,
      UPSTASH_WORKFLOW_URL: c.env.UPSTASH_WORKFLOW_URL,
    },
  });
  return handler.fetch(c.req.raw, c.env as unknown as Record<string, string | undefined>);
});

// ─── Direct Sub-Agent Executor ─────────────────────────────────────────────
// Does NOT use QStash/Upstash Workflow — runs agent in background via waitUntil.
// Protected by TELEGRAM_INTERNAL_SECRET to prevent abuse.
app.post("/run-subagent", async (c) => {
  const secret = c.req.header("X-Internal-Secret");
  if (!c.env.TELEGRAM_INTERNAL_SECRET || secret !== c.env.TELEGRAM_INTERNAL_SECRET) {
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

// ─── QStash Cron Heartbeat ────────────────────────────────────────────────────
// QStash calls this endpoint on schedule. We verify the signature before acting.
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

    // Agent self-reflection
    const reflection = await think(
      c.env.GEMINI_API_KEY,
      `You are VEGA running a periodic self-check. Time: ${new Date().toISOString()}.

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
      iso: new Date().toISOString(),
    }), { ex: 60 * 60 * 25 }); // 25 hours TTL

    // Self-evolving tool ecosystem: analyze usage and create composite tools when helpful
    try {
      await analyzeToolUsageAndEvolve(c.env);
    } catch (e) {
      console.error("[ToolEvolution error]", e);
    }

    return c.json({ success: true, reflection });
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

export default app;
