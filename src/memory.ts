/**
 * memory.ts — Upstash Redis state manager
 * Handles: conversation history, agent session state, tool registry, task queue.
 */
import { Redis } from "@upstash/redis/cloudflare";
import type { ChatMessage } from "./gemini";

// ─── Keys ─────────────────────────────────────────────────────────────────────
const KEY = {
  session: (id: string) => `agent:session:${id}`,
  history: (id: string) => `agent:history:${id}`,
  tool: (name: string) => `agent:tool:${name}`,
  tools: () => `agent:tools`,
  task: (id: string) => `agent:task:${id}`,
  tasks: () => `agent:tasks`,
  schedule: (id: string) => `agent:schedule:${id}`,
};

export type AgentSession = {
  id: string;
  created: number;
  lastActive: number;
  systemPrompt: string;
  metadata: Record<string, unknown>;
};

export type AgentTask = {
  id: string;
  type: string;
  payload: unknown;
  status: "pending" | "running" | "done" | "failed" | "cancelled" | "error";
  createdAt: number;
  result?: unknown;
  error?: string;
};

// ─── Redis factory ────────────────────────────────────────────────────────────
export function getRedis(env: Env): Redis {
  return Redis.fromEnv(env);
}

// ─── Session ──────────────────────────────────────────────────────────────────
export async function getOrCreateSession(
  redis: Redis,
  sessionId: string,
  systemPrompt = "You are a highly capable, self-aware autonomous AI agent."
): Promise<AgentSession> {
  const existing = await redis.get<AgentSession>(KEY.session(sessionId));
  if (existing) {
    existing.lastActive = Date.now();
    await redis.set(KEY.session(sessionId), existing, { ex: 60 * 60 * 24 }); // 24h TTL
    return existing;
  }
  const session: AgentSession = {
    id: sessionId,
    created: Date.now(),
    lastActive: Date.now(),
    systemPrompt,
    metadata: {},
  };
  await redis.set(KEY.session(sessionId), session, { ex: 60 * 60 * 24 });
  return session;
}

export async function updateSessionMeta(
  redis: Redis,
  sessionId: string,
  meta: Record<string, unknown>
): Promise<void> {
  const session = await redis.get<AgentSession>(KEY.session(sessionId));
  if (!session) return;
  session.metadata = { ...session.metadata, ...meta };
  session.lastActive = Date.now();
  await redis.set(KEY.session(sessionId), session, { ex: 60 * 60 * 24 });
}

// ─── Chat history ──────────────────────────────────────────────────────────────
const MAX_HISTORY = 40; // keep last 40 messages (20 turns)

export async function appendHistory(
  redis: Redis,
  sessionId: string,
  messages: ChatMessage[]
): Promise<void> {
  const key = KEY.history(sessionId);
  for (const msg of messages) {
    await redis.rpush(key, JSON.stringify(msg));
  }
  // Trim to MAX_HISTORY
  const len = await redis.llen(key);
  if (len > MAX_HISTORY) await redis.ltrim(key, len - MAX_HISTORY, -1);
  await redis.expire(key, 60 * 60 * 24);
}

export async function getHistory(
  redis: Redis,
  sessionId: string
): Promise<ChatMessage[]> {
  const raw = await redis.lrange(KEY.history(sessionId), 0, -1);
  return raw.map((r) => (typeof r === "string" ? JSON.parse(r) : r) as ChatMessage);
}

// ─── Tool registry ────────────────────────────────────────────────────────────
export type RegisteredTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handlerCode: string; // serialized handler logic (for self-created tools)
  builtIn: boolean;
};

export async function registerTool(redis: Redis, tool: RegisteredTool): Promise<void> {
  await redis.set(KEY.tool(tool.name), tool);
  await redis.sadd(KEY.tools(), tool.name);
}

export async function listTools(redis: Redis): Promise<RegisteredTool[]> {
  const names = await redis.smembers(KEY.tools());
  if (!names.length) return [];
  const tools = await Promise.all(
    names.map((n) => redis.get<RegisteredTool>(KEY.tool(n)))
  );
  return tools.filter(Boolean) as RegisteredTool[];
}

// ─── Tasks ────────────────────────────────────────────────────────────────────
export async function createTask(redis: Redis, task: Omit<AgentTask, "createdAt">): Promise<void> {
  const full: AgentTask = { ...task, createdAt: Date.now() };
  await redis.set(KEY.task(task.id), full, { ex: 60 * 60 * 48 });
  await redis.sadd(KEY.tasks(), task.id);
}

export async function updateTask(
  redis: Redis,
  taskId: string,
  update: Partial<AgentTask>
): Promise<void> {
  const task = await redis.get<AgentTask>(KEY.task(taskId));
  if (!task) return;
  await redis.set(KEY.task(taskId), { ...task, ...update }, { ex: 60 * 60 * 48 });
}

export async function getTask(redis: Redis, taskId: string): Promise<AgentTask | null> {
  return redis.get<AgentTask>(KEY.task(taskId));
}

// ─── Schedules registry ───────────────────────────────────────────────────────

export type AgentSchedule = {
  scheduleId: string;
  cron: string;
  description: string;
  url?: string;
  body?: string;
  createdAt?: string;
};

export async function saveSchedule(
  redis: Redis,
  id: string,
  info: { scheduleId: string; cron: string; description: string; url?: string; body?: string }
): Promise<void> {
  const record: AgentSchedule = {
    scheduleId: info.scheduleId,
    cron: info.cron,
    description: info.description,
    url: info.url,
    body: info.body,
    createdAt: new Date().toISOString(),
  };
  await redis.set(KEY.schedule(id), record, { ex: 60 * 60 * 24 * 30 });
}

export async function listTasks(redis: Redis): Promise<AgentTask[]> {
  const ids = await redis.smembers(KEY.tasks());
  if (!ids || ids.length === 0) return [];
  const tasks = await Promise.all(
    ids.map((id) => redis.get<AgentTask>(KEY.task(id)))
  );
  return tasks.filter(Boolean) as AgentTask[];
}

export async function listSchedules(redis: Redis): Promise<AgentSchedule[]> {
  const keys = await redis.keys("agent:schedule:*") as string[];
  if (!keys || keys.length === 0) return [];
  const records = await Promise.all(
    keys.map((key) => redis.get<AgentSchedule>(key))
  );
  return records.filter(Boolean) as AgentSchedule[];
}
