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

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentConfig = {
  name: string;
  allowedTools: string[] | null;  // null = all tools
  memoryPrefix: string;
  notifyEmail: string | null;
  spawnedAt: string;
  parentAgent: string;
  /**
   * NEW: The sessionId of the conversation that spawned this agent.
   * Used to push the result back to the user when the agent completes.
   * Format: "user-{userId}" matching the /chat proxy injection.
   */
  parentSessionId: string | null;
};

export type WorkflowPayload = {
  taskId: string;
  sessionId: string;
  taskType: string;
  instructions: string;
  steps?: string[];
  agentConfig?: AgentConfig | null;
};

type WorkflowContext = {
  requestPayload: WorkflowPayload;
  env: unknown;
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
};

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function workflowHandler(context: WorkflowContext): Promise<void> {
  const { taskId, taskType, instructions, steps = [], agentConfig } = context.requestPayload;
  const env = context.env as Env;
  const redis = getRedis(env);

  // ── Step 0: Initialize task record ───────────────────────────────────────────
  await context.run("init", async () => {
    await createTask(redis, {
      id: taskId,
      type: taskType,
      payload: { instructions, agentConfig },
      status: "running",
    });
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
      await handleMonitor(context, env, redis, taskId, instructions);
    } else if (taskType === "batch") {
      await handleBatch(context, env, redis, taskId, instructions, steps);
    } else {
      // Default: plan-and-execute
      await handlePlanExecute(context, env, redis, taskId, taskType, instructions, steps);
    }
  } catch (err) {
    // WorkflowAbort is thrown by Upstash after every completed step — it is
    // NORMAL control flow, not an error. Re-throw immediately so QStash can
    // orchestrate the next step. Never mark the task as failed for this.
    if (
      err instanceof Error &&
      (err.message?.includes("WorkflowAbort") ||
        err.constructor?.name === "WorkflowAbort" ||
        err.message?.includes("Aborting workflow after executing step"))
    ) {
      throw err;
    }

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
};

async function handleSubAgent(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  instructions: string,
  agentConfig: AgentConfig
): Promise<void> {
  console.log(`[SubAgent WF] ${taskId} (${agentConfig.name}) starting multi-step execution`);

  const MAX_ITERATIONS = 12;
  const stateKey = `agent:wf-state:${taskId}`;

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

    const state: WfState = { contents, systemPrompt, done: false, finalText: null };
    await redis.set(stateKey, JSON.stringify(state), { ex: 7200 }); // 2h TTL
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
        await redis.set(stateKey, JSON.stringify(state), { ex: 7200 });
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
            return { name: fc.name, result: { error: String(e) } };
          }
        })
      );

      // Append function responses (protobuf Struct: MUST be plain objects)
      const responseParts = toolResults.map((r) => ({
        functionResponse: {
          name: r.name,
          response: ensureObject(r.result),
        },
      }));
      state.contents.push({ role: "user", parts: responseParts });

      // Persist updated state for next step
      await redis.set(stateKey, JSON.stringify(state), { ex: 7200 });

      return {
        done: false,
        text: "",
        toolsCalled: functionCalls.map((f: { name: string }) => f.name),
      };
    });

    // Update progress visible to get_agent_result
    await updateTask(redis, taskId, {
      result: {
        completedSteps: i + 1,
        totalSteps: MAX_ITERATIONS,
        latestResult: stepResult.toolsCalled?.length
          ? `Called: ${stepResult.toolsCalled.join(", ")}`
          : (stepResult.text?.slice(0, 300) ?? "Working..."),
      },
    }).catch(() => { });

    if (stepResult.done) {
      finalText = stepResult.text ?? "";
      break;
    }
  }

  // ── Finalise: write results, push back to parent user ──────────────────────
  await context.run("wf-finalize", async () => {
    let result = finalText;

    // If no text emerged (loop exhausted without clean termination), synthesise
    if (!result) {
      const { think } = await import("../gemini");
      const stateRaw = await redis.get<WfState | string>(stateKey);
      const parsedState = stateRaw
        ? (typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw) as WfState
        : null;
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
        completedAt,
      },
    });

    // Write to shared memory namespace so parent agent can find results
    try {
      const { Redis } = await import("@upstash/redis/cloudflare");
      const sharedRedis = Redis.fromEnv(env);
      await sharedRedis.set(
        `agent:shared:${agentConfig.memoryPrefix}:result`,
        JSON.stringify({ summary: result, completedAt })
      );
      await sharedRedis.set(`agent:shared:${agentConfig.memoryPrefix}:status`, "done");
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
// Watch a resource for changes and alert
// ═══════════════════════════════════════════════════════════════════════════════

async function handleMonitor(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  instructions: string
): Promise<void> {
  await context.run("monitor-execute", async () => {
    const { runAgent } = await import("../agent");

    const monitorPrompt = `You are a monitoring agent. Execute this monitoring task ONCE and report findings.

Monitoring task: ${instructions}

Steps to follow:
1. Fetch/search the target resource
2. Compare with any previously stored state (use recall_memory)
3. If something changed or matches the alert condition, document it clearly
4. Store the new state using store_memory so you can compare next time
5. Return a clear monitoring report

Be specific about: what you found, whether it changed, and what action (if any) should be taken.`;

    const report = await runAgent(env, `monitor-${taskId}`, monitorPrompt);

    await updateTask(redis, taskId, {
      status: "done",
      result: {
        report,
        checkedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });

    console.log(`[Monitor] ${taskId} check complete.`);
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

  console.log(`[Workflow] ${taskId} (${taskType}): ${plan.length} steps`);

  // Execute steps
  const results: string[] = [];

  for (let i = 0; i < plan.length; i++) {
    const stepResult: string = await context.run(`execute-step-${i + 1}`, async () => {
      return think(
        env.GEMINI_API_KEY,
        `You are executing step ${i + 1} of ${plan.length} for task: "${taskType}".

Previous results:
${results.length > 0 ? results.join("\n") : "None yet."}

Current step:
${plan[i]}

Execute this step thoroughly and return your complete result.`,
        "You are a precise task executor. Be thorough and accurate.",
        true // use thinking for deeper reasoning
      );
    });

    results.push(`Step ${i + 1} [${plan[i]}]: ${stepResult}`);

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