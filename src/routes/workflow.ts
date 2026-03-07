/**
 * ============================================================================
 * src/routes/workflow.ts — VEGA Durable Workflow Engine
 * ============================================================================
 *
 * FIX SUMMARY (2025-03):
 *   ✅ AgentConfig now carries parentSessionId — the spawning session
 *   ✅ wf-finalize fires POST /agents/completion-callback (not just a silent
 *      /webhook/task-complete that nobody consumes)
 *   ✅ completion-callback synthesizes the result, pushes via Telegram
 *      proactive_notify, and stores as a pending message for SSE/polling
 *
 * How durability works:
 *   Each context.run("step-id", fn) is a SEPARATE Cloudflare Worker invocation.
 *   If the Worker crashes mid-step, QStash re-invokes from the last completed step.
 *   This means a workflow can run for HOURS or DAYS — limited only by Upstash plan.
 *   Steps that have already completed are SKIPPED on replay (idempotency).
 *
 * Task Types:
 *   "sub_agent"   → Full agenticLoop with all tools per step (most powerful)
 *   "research"    → Multi-step internet research with source aggregation
 *   "monitor"     → Watch a resource and alert on changes
 *   "batch"       → Process a list of items one by one
 *   "pipeline"    → Linear pipeline with data passed between steps
 *   default       → Plan-then-execute with Gemini think() per step
 *
 * Payload shape: WorkflowPayload (see type export below)
 *
 * ============================================================================
 */

import { think } from "../gemini";
import { getRedis, createTask, updateTask, getTask } from "../memory";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Redis TTL for workflow state. 7 days covers long-sleeping monitoring workflows. */
const STATE_TTL_SEC = 60 * 60 * 24 * 7;

/** Task record TTL. Re-extended on every step so long workflows keep their status. */
const TASK_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

const DEFAULT_MAX_ITERATIONS = 50;
const HARD_MAX_ITERATIONS = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentConfig = {
  name: string;
  allowedTools: string[] | null;  // null = all tools
  memoryPrefix: string;
  notifyEmail: string | null;
  spawnedAt: string;
  parentAgent: string;
  /**
   * The sessionId of the conversation that spawned this agent.
   * Used to push the result back to the user when the agent completes.
   * Format: "user-{userId}" matching the /chat proxy injection.
   */
  parentSessionId: string | null;
  /**
   * Explicit userId extracted from parentSessionId at spawn time.
   * Avoids fragile string parsing inside completion callbacks.
   */
  userId?: string | null;
  /**
   * Max agentic iterations for sub_agent workflows.
   * Default: 50. Hard cap: 200.
   * Each iteration is a separate CF Worker invocation with a fresh 30 s CPU budget.
   * 200 iterations = 200 × 30 s of available CPU time on the free plan.
   */
  maxIterations?: number;
  /**
   * Seconds to sleep between agentic iterations via context.sleep().
   * 0 / undefined = run as fast as possible (default).
   * Example: sleepBetweenStepsSec: 3600 = monitor checks every hour.
   * During sleep ZERO CPU is held — the CF Worker exits and QStash wakes it.
   */
  sleepBetweenStepsSec?: number;
};

export type WorkflowPayload = {
  taskId: string;
  sessionId: string;
  taskType: string;
  instructions: string;
  steps?: string[];
  agentConfig?: AgentConfig | null;
  /** Max iterations forwarded for non-sub_agent handlers. */
  maxIterations?: number;
};

type WorkflowContext = {
  requestPayload: WorkflowPayload;
  env: unknown;
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Pause the workflow for `seconds` seconds.
   * The CF Worker exits entirely during sleep — ZERO CPU held.
   * QStash re-invokes the workflow when the timer expires.
   */
  sleep: (stepId: string, seconds: number) => Promise<void>;
};

// ─── WorkflowAbort guard ──────────────────────────────────────────────────────
/**
 * Returns true when `err` is the Upstash WorkflowAbort signal.
 * This is NORMAL control flow — Upstash throws it after every completed step
 * to stop the current CF invocation and let QStash orchestrate the next one.
 * It MUST be re-thrown immediately — never swallowed by any catch block.
 */
function isWorkflowAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message?.includes("WorkflowAbort") ||
    err.constructor?.name === "WorkflowAbort" ||
    err.message?.includes("Aborting workflow after executing step")
  );
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function workflowHandler(context: WorkflowContext): Promise<void> {
  const { taskId, taskType, instructions, steps = [], agentConfig } = context.requestPayload;
  const env = context.env as Env;
  const redis = getRedis(env);

  // ── Step 0: Initialize task record ───────────────────────────────────────────
  // Upstash caches completed step results — this runs exactly once even on replay.
  await context.run("init", async () => {
    try {
      await createTask(redis, {
        id: taskId,
        type: taskType,
        payload: { instructions, agentConfig },
        status: "running",
      });
    } catch {
      // Task may already exist (created by spawn_agent before workflow queued) — just mark running
      await updateTask(redis, taskId, { status: "running" }).catch(() => { });
    }
    console.log(`[Workflow] ${taskId} started — type: ${taskType}, agent: ${agentConfig?.name ?? "system"}`);
    return { started: true, taskId, taskType };
  });

  // ── Route to appropriate handler ─────────────────────────────────────────────

  try {
    if (taskType === "sub_agent" && agentConfig) {
      await handleSubAgent(context, env, redis, taskId, instructions, agentConfig);
    } else if (taskType === "research") {
      await handleResearch(context, env, redis, taskId, instructions, steps);
    } else if (taskType === "monitor") {
      await handleMonitor(context, env, redis, taskId, instructions, agentConfig);
    } else if (taskType === "batch") {
      await handleBatch(context, env, redis, taskId, instructions, steps);
    } else {
      // Default: plan-and-execute
      await handlePlanExecute(context, env, redis, taskId, taskType, instructions, steps);
    }
  } catch (err) {
    // WorkflowAbort is NORMAL Upstash control flow — thrown after every completed step.
    // Re-throw immediately so QStash can orchestrate the next step.
    // NEVER mark the task as failed for this.
    if (isWorkflowAbort(err)) throw err;

    // Genuine fatal error — mark task and re-throw for QStash retry
    console.error(`[Workflow] ${taskId} fatal error:`, String(err));
    await updateTask(redis, taskId, {
      status: "error",
      result: { error: String(err), failedAt: new Date().toISOString() },
    }).catch(() => { });
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-AGENT HANDLER — Multi-step durable execution
//
// Architecture:
//   Each agentic iteration (one Gemini call + tool execution) runs as its OWN
//   context.run() step. This means:
//   - Each Worker invocation only runs ONE step (~10-30 seconds)
//   - QStash orchestrates the hand-off between steps automatically
//   - A 10-step agent can run for minutes/hours with zero timeout risk
//   - State (contents array) is persisted in Redis between steps
//
// Flow: wf-init → wf-iter-0 → wf-iter-1 → ... → wf-iter-N → wf-finalize
//       (each step = one QStash-managed Worker invocation)
// ═══════════════════════════════════════════════════════════════════════════════

/** Ensure any tool result is a plain JSON object (Gemini protobuf Struct requirement). */
function ensureObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) return { items: value };
  if (value === null || value === undefined) return { result: null };
  return { result: String(value) };
}

type WfState = {
  contents: unknown[];      // RawContent[] — serialized to Redis between steps
  systemPrompt: string;
  done: boolean;
  finalText: string | null;
  /** Last completed iteration index — persisted so wf-finalize can read it on replay. */
  iteration: number;
};

async function handleSubAgent(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  instructions: string,
  agentConfig: AgentConfig
): Promise<void> {
  const MAX_ITERATIONS = Math.min(
    agentConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    HARD_MAX_ITERATIONS
  );
  const SLEEP_SEC = Math.max(0, agentConfig.sleepBetweenStepsSec ?? 0);
  const stateKey = `agent:wf-state:${taskId}`;

  console.log(`[SubAgent WF] ${taskId} (${agentConfig.name}) — max: ${MAX_ITERATIONS} iters, sleep: ${SLEEP_SEC}s between steps`);

  // ── Step 0: Initialise conversation state in Redis ──────────────────────────
  await context.run("wf-init", async () => {
    const { getHistory } = await import("../memory");
    const { buildSubAgentPrompt } = await import("./subagent");

    const history = await getHistory(redis, `subagent-${taskId}`);
    const systemPrompt = buildSubAgentPrompt(agentConfig);

    // Build initial contents: recent history + the current instruction
    const contents: unknown[] = [
      ...history.slice(-10).map((m: any) => ({
        role: m.role,
        parts: m.parts,
      })),
      { role: "user", parts: [{ text: instructions }] },
    ];

    const state: WfState = { contents, systemPrompt, done: false, finalText: null, iteration: -1 };
    await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC }); // 7-day TTL — covers long-sleeping workflows
    console.log(`[SubAgent WF] ${taskId} state initialised — ${contents.length} content items`);
    return { ok: true };
  });

  // ── Steps 1..N: One agentic iteration per step ──────────────────────────────
  // Each context.run() is a SEPARATE Worker invocation — no cumulative timeout.
  let finalText = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    type IterResult = { done: boolean; text: string; toolsCalled: string[] };

    const stepResult: IterResult = await context.run(`wf-iter-${i}`, async () => {
      const { generateWithTools } = await import("../gemini");
      const { executeTool, BUILTIN_DECLARATIONS } = await import("../tools/builtins");
      const { listTools } = await import("../memory");

      // Load persisted state
      // NOTE: Upstash Redis auto-deserializes JSON, so stateRaw may already be
      // a WfState object (not a string). JSON.parse(String(object)) → "[object Object]"
      // which crashes. Handle both cases safely.
      const stateRaw = await redis.get<WfState | string>(stateKey);
      if (!stateRaw) {
        return { done: true, text: "[Workflow state expired — Redis TTL hit]", toolsCalled: [] as string[] };
      }
      const state: WfState = typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw as WfState;
      if (state.done) {
        return { done: true, text: state.finalText ?? "", toolsCalled: [] as string[] };
      }

      // Build tool list (built-ins + any dynamically registered tools)
      const customTools = await listTools(redis);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let allTools: any[] = [
        ...BUILTIN_DECLARATIONS,
        ...customTools.map((t: { name: string; description: string; parameters: unknown }) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      ];
      if (agentConfig.allowedTools?.length) {
        const allowed = new Set(agentConfig.allowedTools);
        allTools = allTools.filter((t) => allowed.has(t.name));
      }

      // ── ONE Gemini call ─────────────────────────────────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { rawContent, functionCalls, text } = await generateWithTools(
        env.GEMINI_API_KEY,
        state.contents as never,
        allTools as never,
        state.systemPrompt
      );

      // MUST append rawContent with thoughtSignatures intact (Gemini spec)
      state.contents.push(rawContent);

      // No tool calls → final answer
      if (functionCalls.length === 0) {
        state.done = true;
        state.finalText = text;
        state.iteration = i;
        await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC });
        return { done: true, text, toolsCalled: [] as string[] };
      }

      console.log(`[SubAgent WF] ${taskId} iter-${i} calling: ${functionCalls.map((f: { name: string }) => f.name).join(", ")}`);

      // ── Execute all tool calls in parallel ──────────────────────────────────
      const toolResults = await Promise.all(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        functionCalls.map(async (fc: { name: string; args: Record<string, unknown> }) => {
          try {
            // Pass sub-agent's own sessionId so nested spawn_agent calls can be tracked
            const result = await executeTool(fc.name, fc.args, env, `agent-${taskId}`);
            return { name: fc.name, result };
          } catch (e) {
            // WorkflowAbort MUST propagate — never swallow it
            if (isWorkflowAbort(e)) throw e;
            return { name: fc.name, result: { error: String(e) } };
          }
        })
      );

      // ── ASYNC MEDIA SHORT-CIRCUIT ─────────────────────────────────────────────
      // If generate_image or text_to_speech queued to /run-media, stop here.
      // The /run-media handler will fire completion-callback when done.
      // Do NOT let Gemini burn iterations on get_task_status / wait_for_agents.
      const asyncMedia = toolResults.find(
        (r) =>
          (r.name === "generate_image" || r.name === "text_to_speech") &&
          (r.result as Record<string, unknown>)?.status === "pending"
      );
      if (asyncMedia) {
        const isImage = asyncMedia.name === "generate_image";
        const label = isImage ? "🎨 Image" : "🔊 Audio";
        const mediaTaskId = String((asyncMedia.result as Record<string, unknown>)?.taskId ?? "?");
        const confirmMsg = `${label} generation queued! (~20-90s) — you'll be notified automatically. Task: \`${mediaTaskId}\``;
        state.done = true;
        state.finalText = confirmMsg;
        state.iteration = i;
        await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC });
        return { done: true, text: confirmMsg, toolsCalled: [asyncMedia.name] };
      }

      // Append function responses (protobuf Struct: MUST be plain objects)
      const responseParts = toolResults.map((r) => ({
        functionResponse: {
          name: r.name,
          response: ensureObject(r.result),
        },
      }));
      state.contents.push({ role: "user", parts: responseParts });

      // Persist updated state for next step — refresh TTL so long workflows stay alive
      state.iteration = i;
      await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC });

      return {
        done: false,
        text: "",
        toolsCalled: functionCalls.map((f: { name: string }) => f.name),
      };
    });

    // Update progress + re-extend task TTL on every iteration
    await updateTask(redis, taskId, {
      status: "running",
      result: {
        completedIterations: i + 1,
        maxIterations: MAX_ITERATIONS,
        latestAction: stepResult.toolsCalled?.length
          ? `Called: ${stepResult.toolsCalled.join(", ")}`
          : (stepResult.text?.slice(0, 300) ?? "Working..."),
        ...(SLEEP_SEC > 0 ? { sleepBetweenStepsSec: SLEEP_SEC } : {}),
      },
    })
      .then(() => redis.expire(`agent:task:${taskId}`, TASK_TTL_SEC))
      .catch(() => { });

    if (stepResult.done) {
      finalText = stepResult.text ?? "";
      break;
    }

    // Sleep between iterations — CF Worker exits entirely, ZERO CPU held during wait
    if (SLEEP_SEC > 0 && i < MAX_ITERATIONS - 1) {
      await context.sleep(`wf-sleep-${i}`, SLEEP_SEC);
    }
  }

  // ── Finalise: write results, push back to parent user ──────────────────────
  await context.run("wf-finalize", async () => {
    // BUG FIX: read finalText from Redis state, NOT the local variable.
    // On QStash replay, local variables reset to "" — only Redis state survives.
    const stateRaw = await redis.get<WfState | string>(stateKey);
    const parsedState = stateRaw
      ? (typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw) as WfState
      : null;

    let result = parsedState?.finalText ?? finalText;

    // If loop exhausted without clean termination, synthesise a summary
    if (!result) {
      const { think } = await import("../gemini");
      const sysPrompt = parsedState?.systemPrompt ?? "You are a helpful assistant.";
      result = await think(
        env.GEMINI_API_KEY,
        `Summarise what was accomplished for this task:\n\n${instructions}`,
        sysPrompt
      ).catch(() => "Agent completed the task.");
    }

    const completedAt = new Date().toISOString();

    // Mark task done in Redis
    await updateTask(redis, taskId, {
      status: "done",
      result: {
        summary: result,
        agent: agentConfig.name,
        memoryPrefix: agentConfig.memoryPrefix,
        iterationsUsed: parsedState?.iteration ?? "?",
        completedAt,
      },
    });

    // Write to shared memory namespace so parent agent can find results
    try {
      const { Redis } = await import("@upstash/redis/cloudflare");
      const sharedRedis = Redis.fromEnv(env);
      await sharedRedis.set(
        `agent:shared:${agentConfig.memoryPrefix}:result`,
        JSON.stringify({ summary: result, completedAt }),
        { ex: STATE_TTL_SEC }
      );
      await sharedRedis.set(`agent:shared:${agentConfig.memoryPrefix}:status`, "done", { ex: STATE_TTL_SEC });
    } catch (e) {
      console.warn(`[SubAgent WF] Shared memory write failed: ${String(e)}`);
    }

    // Clean up workflow state from Redis
    await redis.del(stateKey).catch(() => { });

    // Email notification if configured
    if (agentConfig.notifyEmail) {
      try {
        const { executeTool } = await import("../tools/builtins");
        await executeTool("send_email", {
          to: agentConfig.notifyEmail,
          subject: `✅ VEGA Agent '${agentConfig.name}' completed`,
          body: `**Task ID:** ${taskId}\n**Agent:** ${agentConfig.name}\n**Completed:** ${completedAt}\n\n**Result:**\n\n${result}`,
        }, env);
      } catch (e) {
        console.warn(`[SubAgent WF] Email failed: ${String(e)}`);
      }
    }

    // ── CRITICAL FIX: Fire completion callback to push result back to user ──
    // This replaces the old /webhook/task-complete that just stored to Redis
    // and nobody consumed. Now we actively push the result to the parent session.
    await fireCompletionCallback(env, {
      taskId,
      agentName: agentConfig.name,
      parentSessionId: agentConfig.parentSessionId,
      userId: agentConfig.userId ?? null,
      memoryPrefix: agentConfig.memoryPrefix,
      status: "done",
      result,
      completedAt,
    });

    console.log(`[SubAgent WF] ${taskId} (${agentConfig.name}) DONE. Parent notified.`);
    return { done: true, completedAt };
  });
}

// ─── Completion Callback Helper ───────────────────────────────────────────────
// Fires POST /agents/completion-callback on the Worker itself (self-call).
// The handler synthesizes the result and pushes it to the user.

export async function fireCompletionCallback(
  env: Env,
  payload: {
    taskId: string;
    agentName: string;
    parentSessionId: string | null;
    userId?: string | null;
    memoryPrefix: string;
    status: string;
    result: string;
    completedAt: string;
  }
): Promise<void> {
  // WORKER_URL and UPSTASH_WORKFLOW_URL both point to the same Worker.
  // Use whichever is available — they're identical in wrangler.toml.
  const workerBase = (
    (env.WORKER_URL ?? "").trim() ||
    (env.UPSTASH_WORKFLOW_URL ?? "").trim()
  ).replace(/\/$/, "");

  if (!workerBase) {
    console.warn("[fireCompletionCallback] Neither WORKER_URL nor UPSTASH_WORKFLOW_URL set. Result is in Redis: task:" + payload.taskId);
    return;
  }

  try {
    const res = await fetch(`${workerBase}/agents/completion-callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Internal auth — same secret used for Telegram proxy
        "x-internal-secret": env.TELEGRAM_INTERNAL_SECRET ?? "",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[fireCompletionCallback] Non-OK response: ${res.status} — ${body}`);
    }
  } catch (e) {
    // Non-fatal — result is already in Redis, worst case user polls for it
    console.warn(`[fireCompletionCallback] fetch failed: ${String(e)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESEARCH HANDLER
// Deep multi-source research with tool access per step
// ═══════════════════════════════════════════════════════════════════════════════

async function handleResearch(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  instructions: string,
  customSteps: string[]
): Promise<void> {
  // Step 1: Plan the research
  const plan: string[] = await context.run("plan-research", async () => {
    if (customSteps.length > 0) return customSteps;

    const planText = await think(
      env.GEMINI_API_KEY,
      `You are planning a research task. Break this into 4-7 concrete research steps.
Each step should be a specific action (search, read, analyze, summarize).
Return ONLY a valid JSON array of step strings, no commentary.

Research goal: ${instructions}`,
      "You are a research director. Return only a JSON array of step strings."
    );

    try {
      const match = planText.match(/\[[\s\S]*?\]/);
      return match ? JSON.parse(match[0]) as string[] : [instructions];
    } catch {
      return [instructions];
    }
  });

  console.log(`[Research] ${taskId}: ${plan.length} steps planned`);

  // Steps 2..N: Execute each step with full tool access
  const findings: string[] = [];

  for (let i = 0; i < plan.length; i++) {
    const stepResult: string = await context.run(`research-step-${i + 1}`, async () => {
      const { runAgent } = await import("../agent");

      const stepPrompt = `You are executing research step ${i + 1} of ${plan.length}.

Overall research goal: ${instructions}

Previous findings:
${findings.length > 0 ? findings.map((f, idx) => `Step ${idx + 1}: ${f.slice(0, 300)}`).join("\n") : "None yet."}

Your current step:
${plan[i]}

Use available tools (web_search, browse_web, fetch_url) to execute this step.
Return a detailed summary of what you found — include sources/URLs.`;

      return runAgent(env, `research-${taskId}-step${i}`, stepPrompt);
    });

    findings.push(`Step ${i + 1} [${plan[i].slice(0, 60)}...]: ${stepResult}`);

    // Progress update
    await context.run(`progress-${i + 1}`, async () => {
      await updateTask(redis, taskId, {
        result: {
          completedSteps: i + 1,
          totalSteps: plan.length,
          latestResult: stepResult.slice(0, 500),
        },
      });
      return true;
    });
  }

  // Final synthesis
  await context.run("research-synthesize", async () => {
    const summary = await think(
      env.GEMINI_API_KEY,
      `Synthesize these research findings into a comprehensive, well-structured report.
Include: executive summary, key findings, important data points, sources, and recommendations.

Research goal: ${instructions}

All findings:
${findings.join("\n\n")}`,
      "You are a research analyst. Write clear, factual, well-structured reports."
    );

    // Save report to R2
    if (env.FILES_BUCKET) {
      const filename = `reports/research-${taskId}-${Date.now()}.md`;
      await env.FILES_BUCKET.put(filename, summary, {
        httpMetadata: { contentType: "text/markdown" },
        customMetadata: { taskId, type: "research", completedAt: new Date().toISOString() },
      });
    }

    await updateTask(redis, taskId, {
      status: "done",
      result: {
        summary,
        steps: findings,
        completedAt: new Date().toISOString(),
        reportFile: env.FILES_BUCKET ? `reports/research-${taskId}-${Date.now()}.md` : null,
      },
    });

    console.log(`[Research] ${taskId} complete.`);
    return { done: true };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONITOR HANDLER
// Watch a resource for changes and alert — supports multi-check loops with sleep
//
// With agentConfig.sleepBetweenStepsSec set (e.g. 3600 for hourly checks), this
// workflow runs for days / weeks on the FREE Cloudflare plan. Zero CPU is held
// during each context.sleep() — the CF Worker exits and QStash wakes it later.
//
// The monitor runs agentConfig.maxIterations checks total (default 50).
// Example: maxIterations: 72, sleepBetweenStepsSec: 3600 = monitors for 3 days.
// ═══════════════════════════════════════════════════════════════════════════════

async function handleMonitor(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  instructions: string,
  agentConfig?: AgentConfig | null
): Promise<void> {
  const MAX_CHECKS = Math.min(agentConfig?.maxIterations ?? DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS);
  const SLEEP_SEC = Math.max(0, agentConfig?.sleepBetweenStepsSec ?? 0);

  console.log(`[Monitor] ${taskId} — ${MAX_CHECKS} checks, ${SLEEP_SEC}s between checks`);

  for (let i = 0; i < MAX_CHECKS; i++) {
    const checkResult: string = await context.run(`monitor-check-${i}`, async () => {
      const { runAgent } = await import("../agent");

      const monitorPrompt = `You are a monitoring agent. This is check #${i + 1} of ${MAX_CHECKS}.

Monitoring task: ${instructions}

Steps to follow:
1. Fetch/search the target resource
2. Compare with any previously stored state (use recall_memory key: "monitor-${taskId}-state")
3. If something changed or matches the alert condition, document it clearly
4. Store the new state using store_memory (key: "monitor-${taskId}-state") so you can compare next time
5. Return a clear monitoring report

Be specific about: what you found, whether it changed, and what action (if any) should be taken.`;

      return runAgent(env, `monitor-${taskId}-check${i}`, monitorPrompt);
    }).catch((e) => {
      if (isWorkflowAbort(e)) throw e;
      return `Check ${i + 1} failed: ${String(e)}`;
    });

    // Update progress + re-extend task TTL
    await updateTask(redis, taskId, {
      status: "running",
      result: {
        completedChecks: i + 1,
        maxChecks: MAX_CHECKS,
        latestCheck: checkResult.slice(0, 500),
        checkedAt: new Date().toISOString(),
        ...(SLEEP_SEC > 0 ? { nextCheckInSec: SLEEP_SEC } : {}),
      },
    })
      .then(() => redis.expire(`agent:task:${taskId}`, TASK_TTL_SEC))
      .catch(() => { });

    // Proactively alert parent if agent found something significant
    const needsAlert = /alert|changed|detected|found|triggered/i.test(checkResult);
    if (needsAlert && agentConfig?.parentSessionId) {
      await fireCompletionCallback(env, {
        taskId: `${taskId}-alert-${i}`,
        agentName: agentConfig.name,
        parentSessionId: agentConfig.parentSessionId,
        userId: agentConfig.userId ?? null,
        memoryPrefix: agentConfig.memoryPrefix,
        status: "done",
        result: `🔔 Monitor Alert (check ${i + 1}/${MAX_CHECKS}):

${checkResult}`,
        completedAt: new Date().toISOString(),
      }).catch(() => { });
    }

    // Sleep between checks — CF Worker exits entirely, ZERO CPU held during wait
    if (SLEEP_SEC > 0 && i < MAX_CHECKS - 1) {
      await context.sleep(`monitor-sleep-${i}`, SLEEP_SEC);
    }
  }

  // Finalize
  await context.run("monitor-finalize", async () => {
    const durationLabel = SLEEP_SEC > 0
      ? `${Math.round(MAX_CHECKS * SLEEP_SEC / 3600 * 10) / 10} hours`
      : "continuous execution";

    const summary = `Monitoring completed: ${MAX_CHECKS} checks over ${durationLabel}.
Task: ${instructions}`;

    await updateTask(redis, taskId, {
      status: "done",
      result: {
        summary,
        totalChecks: MAX_CHECKS,
        completedAt: new Date().toISOString(),
      },
    }).catch(() => { });

    // Final notification to parent
    if (agentConfig?.parentSessionId) {
      await fireCompletionCallback(env, {
        taskId,
        agentName: agentConfig.name,
        parentSessionId: agentConfig.parentSessionId,
        userId: agentConfig.userId ?? null,
        memoryPrefix: agentConfig.memoryPrefix,
        status: "done",
        result: summary,
        completedAt: new Date().toISOString(),
      }).catch(() => { });
    }

    console.log(`[Monitor] ${taskId} all checks complete.`);
    return { done: true };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH HANDLER
// Process a list of items one by one
// ═══════════════════════════════════════════════════════════════════════════════

async function handleBatch(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  instructions: string,
  items: string[]
): Promise<void> {
  const results: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const itemResult: string = await context.run(`batch-item-${i}`, async () => {
      const { runAgent } = await import("../agent");

      return runAgent(
        env,
        `batch-${taskId}-${i}`,
        `Process this item (${i + 1} of ${items.length}):\n\n${items[i]}\n\nContext: ${instructions}`
      );
    });

    results.push(`Item ${i + 1}: ${itemResult}`);

    await context.run(`batch-progress-${i}`, async () => {
      await updateTask(redis, taskId, {
        result: {
          completedSteps: i + 1,
          totalSteps: items.length,
          latestResult: itemResult.slice(0, 300),
        },
      });
      return true;
    });
  }

  await context.run("batch-finalize", async () => {
    await updateTask(redis, taskId, {
      status: "done",
      result: {
        results,
        count: results.length,
        completedAt: new Date().toISOString(),
      },
    });
    return { done: true };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT PLAN-EXECUTE HANDLER
// Classic plan-then-execute with Gemini think() per step
// ═══════════════════════════════════════════════════════════════════════════════

async function handlePlanExecute(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  taskType: string,
  instructions: string,
  customSteps: string[]
): Promise<void> {
  // Plan
  const plan: string[] = await context.run("plan", async () => {
    if (customSteps.length > 0) return customSteps;

    const planText = await think(
      env.GEMINI_API_KEY,
      `Break this task into 3–6 clear sequential steps.
Return ONLY a valid JSON array of strings, no commentary.

Task: ${instructions}`,
      "You are a precise task planner. Output only a JSON array."
    );

    try {
      const match = planText.match(/\[[\s\S]*?\]/);
      return match ? JSON.parse(match[0]) as string[] : [instructions];
    } catch {
      return [instructions];
    }
  });

  const MAX_STEPS = Math.min(
    Number(context.requestPayload?.maxIterations ?? DEFAULT_MAX_ITERATIONS),
    HARD_MAX_ITERATIONS
  );
  const effectivePlan = plan.slice(0, MAX_STEPS);
  console.log(`[Workflow] ${taskId} (${taskType}): ${effectivePlan.length} steps (cap: ${MAX_STEPS})`);

  // Execute steps
  const results: string[] = [];

  for (let i = 0; i < effectivePlan.length; i++) {
    const stepResult: string = await context.run(`execute-step-${i + 1}`, async () => {
      return think(
        env.GEMINI_API_KEY,
        `You are executing step ${i + 1} of ${effectivePlan.length} for task: "${taskType}".

Previous results:
${results.length > 0 ? results.join("\n") : "None yet."}

Current step:
${effectivePlan[i]}

Execute this step thoroughly and return your complete result.`,
        "You are a precise task executor. Be thorough and accurate.",
        true // use thinking for deeper reasoning
      );
    });

    results.push(`Step ${i + 1} [${effectivePlan[i]}]: ${stepResult}`);

    await context.run(`persist-progress-${i + 1}`, async () => {
      await updateTask(redis, taskId, {
        result: {
          completedSteps: i + 1,
          totalSteps: plan.length,
          latestResult: stepResult.slice(0, 500),
        },
      });
      return true;
    });
  }

  // Finalize
  await context.run("finalize", async () => {
    const summary = await think(
      env.GEMINI_API_KEY,
      `Summarize the outcome of this completed task for the user.

Task: ${instructions}

Step results:
${results.join("\n\n")}

Write a clear 2-4 sentence summary, then list key findings or outputs.`,
      undefined,
      false
    );

    await updateTask(redis, taskId, {
      status: "done",
      result: {
        summary,
        steps: results,
        completedAt: new Date().toISOString(),
      },
    });

    console.log(`[Workflow] ${taskId} (${taskType}) complete.`);
    return { done: true };
  });
}