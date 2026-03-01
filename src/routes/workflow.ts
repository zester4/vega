/**
 * ============================================================================
 * src/routes/workflow.ts — VEGA Durable Workflow Engine
 * ============================================================================
 *
 * Powered by Upstash Workflow (QStash-backed durable execution).
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
    // Mark task as errored but don't rethrow (allow QStash retry logic to apply)
    console.error(`[Workflow] ${taskId} fatal error:`, String(err));
    await updateTask(redis, taskId, {
      status: "error",
      result: { error: String(err), failedAt: new Date().toISOString() },
    }).catch(() => { });
    // Re-throw so QStash knows to retry if appropriate
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-AGENT HANDLER
// Runs a full autonomous agenticLoop — has access to ALL tools
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSubAgent(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  instructions: string,
  agentConfig: AgentConfig
): Promise<void> {
  console.log(`[SubAgent] ${taskId} (${agentConfig.name}) starting autonomous loop`);

  const result: string = await context.run("agent-execute", async () => {
    // Import here (inside context.run) to avoid serialization issues
    const { runAgent } = await import("../agent");

    // Build a system prompt specialized for this sub-agent's role
    const subAgentSystemPrompt = buildSubAgentPrompt(agentConfig);

    // Run the full agentic loop — this agent has all tools
    const reply = await runAgent(
      env,
      `subagent-${taskId}`,
      instructions,
      subAgentSystemPrompt,
      // onEvent: sub-agents don't stream events back (fire-and-forget)
      undefined,
      // Tool filter: if allowedTools is set, only pass those declarations
      agentConfig.allowedTools ?? undefined,
      // Attachments are not used for background sub-agents today
      undefined
    );

    return reply;
  });

  // Persist result and notify
  await context.run("agent-finalize", async () => {
    const completedAt = new Date().toISOString();

    await updateTask(redis, taskId, {
      status: "done",
      result: {
        summary: result,
        agent: agentConfig.name,
        memoryPrefix: agentConfig.memoryPrefix,
        completedAt,
      },
    });

    // Write result to shared memory namespace so parent can find it
    try {
      const { Redis } = await import("@upstash/redis/cloudflare");
      const sharedRedis = Redis.fromEnv(env);
      await sharedRedis.set(
        `agent:shared:${agentConfig.memoryPrefix}:result`,
        JSON.stringify({ summary: result, completedAt })
      );
      await sharedRedis.set(
        `agent:shared:${agentConfig.memoryPrefix}:status`,
        "done"
      );
    } catch (e) {
      console.warn(`[SubAgent] Failed to write shared memory: ${String(e)}`);
    }

    // Email notification if requested
    if (agentConfig.notifyEmail) {
      try {
        const { executeTool } = await import("../tools/builtins");
        await executeTool("send_email", {
          to: agentConfig.notifyEmail,
          subject: `✅ VEGA Agent '${agentConfig.name}' completed`,
          body: `**Task ID:** ${taskId}\n**Agent:** ${agentConfig.name}\n**Completed:** ${completedAt}\n\n**Result:**\n\n${result}`,
        }, env);
      } catch (e) {
        console.warn(`[SubAgent] Email notification failed: ${String(e)}`);
      }
    }

    // Notify via webhook if UPSTASH_WORKFLOW_URL is set
    try {
      await fetch(`${env.UPSTASH_WORKFLOW_URL}/webhook/task-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          agentName: agentConfig.name,
          status: "done",
          summary: result.slice(0, 500),
          completedAt,
        }),
      });
    } catch {
      // Non-fatal — webhook is best-effort
    }

    console.log(`[SubAgent] ${taskId} (${agentConfig.name}) completed.`);
    return { done: true };
  });
}

function buildSubAgentPrompt(config: AgentConfig): string {
  const toolRestriction = config.allowedTools
    ? `\nYou have access ONLY to these tools: ${config.allowedTools.join(", ")}.`
    : "\nYou have access to ALL tools.";

  return `You are ${config.name.toUpperCase()}, a specialized autonomous sub-agent created by VEGA.

Your role: ${config.name}
Your memory namespace: ${config.memoryPrefix}
Parent agent: ${config.parentAgent}
${toolRestriction}

Core rules for sub-agents:
1. Focus EXCLUSIVELY on your assigned task — don't go off-topic
2. Store all important findings using store_memory with prefix '${config.memoryPrefix}:'
3. Store complex findings using semantic_store for later retrieval
4. Use share_memory(namespace='${config.memoryPrefix}', ...) to publish results for the parent
5. Write final reports to write_file('reports/${config.memoryPrefix}-result.md')
6. Be thorough — you are running autonomously so produce complete, actionable output
7. Cite sources (URLs) when using web data
8. Structure your final response as a clear, well-organized report

You are running in AUTONOMOUS mode. Complete your task fully before returning.`;
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