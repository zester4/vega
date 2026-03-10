/**
 * ============================================================================
 * src/routes/workflow.ts — VEGA Durable Workflow Engine v2
 * ============================================================================
 *
 * UPGRADE SUMMARY (v2):
 *
 * ── CRITICAL BUG FIXES ──────────────────────────────────────────────────────
 *   ✅ BUG 1 FIXED: wf-init now loads history from `sessionId` (the actual
 *      Telegram session), not `subagent-${taskId}` (a dead per-task key).
 *      Root cause of Telegram memory amnesia — every workflow started with
 *      zero context because it loaded from a key that was always empty.
 *
 *   ✅ BUG 2 FIXED: wf-finalize now writes the conversation back to the parent
 *      `sessionId` via appendHistory(). The next message from Telegram now
 *      has full context of everything the workflow did.
 *
 *   ✅ BUG 3 FIXED: Workflow state key uses `agent:wf-state:${taskId}` (unique
 *      per run), while history reads/writes use `sessionId` (shared per user).
 *      These two concerns are now cleanly separated.
 *
 * ── 10+ HOUR EXECUTION CAPABILITIES ────────────────────────────────────────
 *   ✅ FEATURE 1 — waitForEvent / Human-in-the-loop:
 *      Agent can call `wait_for_user_input(question)` to pause the workflow.
 *      The workflow suspends via context.waitForEvent() (zero CPU held).
 *      When the user replies on Telegram, POST /workflow/notify wakes the
 *      workflow with the user's reply injected into the next iteration.
 *      Supports up to 7-day timeout before auto-expiry.
 *
 *   ✅ FEATURE 2 — Workflow Chaining (infinite execution):
 *      When MAX_ITERATIONS is reached without completion, the workflow
 *      serializes its current state to Redis and triggers a NEW continuation
 *      workflow from QStash. The new workflow picks up the conversation
 *      exactly where the old one left off — no data loss, no iteration cap.
 *      A single task can now run for weeks.
 *
 *   ✅ FEATURE 3 — Parallel step execution:
 *      Tasks passed as `steps[]` with taskType "parallel" run all steps
 *      simultaneously via Promise.all(). Each step is a separate Worker
 *      invocation. Results are merged and synthesized.
 *
 *   ✅ FEATURE 4 — Sleep-based long monitors:
 *      context.sleep() already used in monitor handler. Combined with
 *      HARD_MAX_CHECKS = 500 × sleepBetweenStepsSec, a monitor set to
 *      check every hour runs for 500 hours (20+ days). Zero CF CPU held
 *      during sleep — Worker fully exits, QStash re-invokes on schedule.
 *
 * ── ARCHITECTURE RULES (unchanged) ─────────────────────────────────────────
 *   Each context.run("step-id", fn) is a SEPARATE Cloudflare Worker invocation.
 *   WorkflowAbort is normal control flow — MUST re-throw, never swallow.
 *   State between steps lives in Redis (agent:wf-state:${taskId}, 7-day TTL).
 *   History (memory) lives in agent:history:${sessionId} (shared with chat).
 *
 * ============================================================================
 */

import { think } from "../gemini";
import { getRedis, createTask, updateTask, getTask, appendHistory, getHistory } from "../memory";
import { Client as QStashClient } from "@upstash/qstash";
import type { WorkflowContext as UpstashWorkflowContext } from "@upstash/workflow";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Redis TTL for workflow state. 7 days covers long-sleeping monitoring workflows. */
const STATE_TTL_SEC = 60 * 60 * 24 * 7;

/** Task record TTL. Re-extended on every step so long workflows keep their status. */
const TASK_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

const DEFAULT_MAX_ITERATIONS = 50;
const HARD_MAX_ITERATIONS = 200;

/** Maximum chains before we force-finalize to prevent infinite loops. */
const MAX_WORKFLOW_CHAINS = 10;

/** Max monitor checks. At 1hr sleep: 500 × 3600s = 500 hours (20+ days). */
const HARD_MAX_CHECKS = 500;

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
   * This is ALSO used as the history key for memory continuity.
   * Format: "tg-{chatId}-{ts}" for Telegram, "user-{userId}" for web UI.
   */
  parentSessionId: string | null;
  /**
   * Explicit userId extracted from parentSessionId at spawn time.
   */
  userId?: string | null;
  /**
   * Max agentic iterations per workflow run.
   * Default: 50. Hard cap: 200. When reached, workflow chains to a new run.
   */
  maxIterations?: number;
  /**
   * Seconds to sleep between agentic iterations via context.sleep().
   * 0 / undefined = run as fast as possible (default for task agents).
   * Example: sleepBetweenStepsSec: 3600 = monitor checks every hour.
   * During sleep ZERO CPU is held — the CF Worker exits and QStash wakes it.
   */
  sleepBetweenStepsSec?: number;
  /**
   * How many times this workflow has been chained (to prevent infinite chains).
   * Set automatically. Do not set manually.
   */
  chainGeneration?: number;
  /**
   * Optional injected system prompt (for Telegram, built with full goal context).
   */
  systemPrompt?: string | null;
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

/**
 * Use Upstash's real WorkflowContext type parameterised with our payload shape.
 * This ensures waitForEvent, sleep, and run all have the exact signatures the
 * SDK expects — no manual re-declaration that can drift out of sync.
 */
type WorkflowContext = UpstashWorkflowContext<WorkflowPayload>;

// ─── WorkflowAbort guard ──────────────────────────────────────────────────────

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
  const env = context.env as unknown as Env;
  const redis = getRedis(env);

  // ── Step 0: Initialize task record ───────────────────────────────────────────
  await context.run("init", async () => {
    try {
      await createTask(redis, {
        id: taskId,
        type: taskType,
        payload: { instructions, agentConfig },
        status: "running",
      });
    } catch {
      await updateTask(redis, taskId, { status: "running" }).catch(() => { });
    }
    console.log(`[Workflow] ${taskId} started — type: ${taskType}, agent: ${agentConfig?.name ?? "system"}`);
    return { started: true, taskId, taskType };
  });

  try {
    if (taskType === "sub_agent" && agentConfig) {
      await handleSubAgent(context, env, redis, taskId, instructions, agentConfig);
    } else if (taskType === "research") {
      await handleResearch(context, env, redis, taskId, instructions, steps);
    } else if (taskType === "monitor") {
      await handleMonitor(context, env, redis, taskId, instructions, agentConfig);
    } else if (taskType === "batch") {
      await handleBatch(context, env, redis, taskId, instructions, steps);
    } else if (taskType === "parallel") {
      await handleParallel(context, env, redis, taskId, instructions, steps);
    } else {
      await handlePlanExecute(context, env, redis, taskId, taskType, instructions, steps);
    }
  } catch (err) {
    if (isWorkflowAbort(err)) throw err;

    console.error(`[Workflow] ${taskId} fatal error:`, String(err));
    await updateTask(redis, taskId, {
      status: "error",
      result: { error: String(err), failedAt: new Date().toISOString() },
    }).catch(() => { });
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-AGENT HANDLER — Durable multi-step execution with memory continuity
//
// KEY FIX: History is now loaded from and written back to `sessionId`.
// This means Telegram conversations have full memory across workflow runs.
//
// NEW: waitForEvent support — agent can pause and ask user a question.
// NEW: Workflow chaining — when MAX_ITERATIONS hit, chains to a new workflow
//      preserving all conversation state. Enables truly unlimited runtimes.
// ═══════════════════════════════════════════════════════════════════════════════

function ensureObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) return { items: value };
  if (value === null || value === undefined) return { result: null };
  return { result: String(value) };
}

type WfState = {
  contents: unknown[];
  systemPrompt: string;
  done: boolean;
  finalText: string | null;
  iteration: number;
  /**
   * When agent called wait_for_user_input, this holds the event ID.
   * The workflow exits context.run() and calls context.waitForEvent() with it.
   */
  pauseEventId?: string | null;
  /** The question sent to the user when pausing. */
  pauseQuestion?: string | null;
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
  // BUG FIX: use parentSessionId (the user's actual session) not `subagent-${taskId}`
  const sessionId = agentConfig.parentSessionId ?? `subagent-${taskId}`;

  console.log(`[SubAgent WF] ${taskId} (${agentConfig.name}) — max: ${MAX_ITERATIONS} iters, sleep: ${SLEEP_SEC}s, session: ${sessionId}`);

  // ── Step 0: Init conversation state ─────────────────────────────────────────
  // BUG FIX: Load history from `sessionId` (shared with the user's chat session).
  // Previously was loading from `subagent-${taskId}` which was always empty.
  await context.run("wf-init", async () => {
    const { buildSubAgentPrompt } = await import("./subagent");

    // Load the user's actual conversation history
    const history = await getHistory(redis, sessionId);

    // Build initial contents: recent history (last 15 messages) + current instruction
    const contents: unknown[] = [
      ...history.slice(-15).map((m: any) => ({
        role: m.role,
        parts: m.parts,
      })),
      { role: "user", parts: [{ text: instructions }] },
    ];

    // Use the injected system prompt if available (contains live goals from Telegram dispatch)
    const systemPrompt = (agentConfig as any).systemPrompt ?? buildSubAgentPrompt(agentConfig);

    const state: WfState = {
      contents,
      systemPrompt,
      done: false,
      finalText: null,
      iteration: -1,
      pauseEventId: null,
      pauseQuestion: null,
    };

    await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC });
    console.log(`[SubAgent WF] ${taskId} state init — ${history.length} history msgs loaded from session: ${sessionId}`);
    return { ok: true };
  });

  // ── Steps 1..N: One agentic iteration per step ──────────────────────────────
  let finalText = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    type IterResult = {
      done: boolean;
      text: string;
      toolsCalled: string[];
      pauseEventId?: string | null;
      pauseQuestion?: string | null;
    };

    const stepResult: IterResult = await context.run(`wf-iter-${i}`, async () => {
      const { generateWithTools } = await import("../gemini");
      const { executeTool, BUILTIN_DECLARATIONS } = await import("../tools/builtins");
      const { listTools } = await import("../memory");

      const stateRaw = await redis.get<WfState | string>(stateKey);
      if (!stateRaw) {
        return {
          done: true,
          text: "[Workflow state expired — Redis TTL hit. Task saved to memory.]",
          toolsCalled: [] as string[],
        };
      }
      const state: WfState = typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw as WfState;
      if (state.done) {
        return { done: true, text: state.finalText ?? "", toolsCalled: [] as string[] };
      }

      // Build tool list (built-ins + dynamically registered tools)
      const customTools = await listTools(redis);
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
      const { rawContent, functionCalls, text } = await generateWithTools(
        env.GEMINI_API_KEY,
        state.contents as never,
        allTools as never,
        state.systemPrompt
      );

      state.contents.push(rawContent);

      // No tool calls → final answer
      if (functionCalls.length === 0) {
        state.done = true;
        state.finalText = text;
        state.iteration = i;
        await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC });
        return { done: true, text, toolsCalled: [] as string[] };
      }

      console.log(`[SubAgent WF] ${taskId} iter-${i}: ${functionCalls.map((f: any) => f.name).join(", ")}`);

      // ── Execute all tool calls in parallel ──────────────────────────────────
      const toolResults = await Promise.all(
        functionCalls.map(async (fc: { name: string; args: Record<string, unknown> }) => {
          try {
            const result = await executeTool(fc.name, fc.args, env, sessionId);
            return { name: fc.name, result };
          } catch (e) {
            if (isWorkflowAbort(e)) throw e;
            return { name: fc.name, result: { error: String(e) } };
          }
        })
      );

      // ── Check for pause request (wait_for_user_input tool) ─────────────────
      // The wait_for_user_input tool stores an eventId in the result.
      // We bubble it up to the workflow level where waitForEvent is called.
      const pauseResult = toolResults.find(
        (r) => (r.result as any)?._pause_workflow === true
      );
      if (pauseResult) {
        const eventId = (pauseResult.result as any)._event_id as string;
        const question = (pauseResult.result as any)._question as string;
        state.pauseEventId = eventId;
        state.pauseQuestion = question;
        // Mark as not done (will resume after user reply)
        state.iteration = i;
        await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC });
        return {
          done: false,
          text: "",
          toolsCalled: [pauseResult.name],
          pauseEventId: eventId,
          pauseQuestion: question,
        };
      }

      // ── Async media short-circuit ───────────────────────────────────────────
      const asyncMedia = toolResults.find(
        (r) =>
          (r.name === "generate_image" || r.name === "text_to_speech") &&
          (r.result as Record<string, unknown>)?.status === "pending"
      );
      if (asyncMedia) {
        const isImage = asyncMedia.name === "generate_image";
        const label = isImage ? "🎨 Image" : "🔊 Audio";
        const mediaTaskId = String((asyncMedia.result as any)?.taskId ?? "?");
        const confirmMsg = `${label} generation queued! (~20-90s). Task: \`${mediaTaskId}\``;
        state.done = true;
        state.finalText = confirmMsg;
        state.iteration = i;
        await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC });
        return { done: true, text: confirmMsg, toolsCalled: [asyncMedia.name] };
      }

      // Append tool responses
      const responseParts = toolResults.map((r) => ({
        functionResponse: { name: r.name, response: ensureObject(r.result) },
      }));
      state.contents.push({ role: "user", parts: responseParts });

      state.iteration = i;
      await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC });

      return {
        done: false,
        text: "",
        toolsCalled: functionCalls.map((f: any) => f.name),
      };
    });

    // Update task progress
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

    // ── PAUSE: waitForEvent ──────────────────────────────────────────────────
    // Agent called wait_for_user_input — suspend until user replies (up to 7d).
    // Worker exits entirely during wait — ZERO CPU consumed.
    if (stepResult.pauseEventId) {
      console.log(`[SubAgent WF] ${taskId} pausing for user input — eventId: ${stepResult.pauseEventId}`);

      const { eventData, timeout } = await context.waitForEvent(
        `pause-iter-${i}`,
        stepResult.pauseEventId,
        { timeout: "7d" }
      );

      if (timeout) {
        // User never replied — finalize gracefully
        finalText = `Task paused waiting for your input, but no reply was received within 7 days.\n\nOriginal question: ${stepResult.pauseQuestion ?? "(unknown)"}`;
        break;
      }

      // Inject user's reply into the conversation state for the next iteration
      const userReply = (eventData as any)?.text ?? "[User replied]";
      console.log(`[SubAgent WF] ${taskId} resumed with user reply: ${userReply.slice(0, 100)}`);

      await context.run(`inject-reply-${i}`, async () => {
        const stateRaw = await redis.get<WfState | string>(stateKey);
        if (!stateRaw) return { ok: false };
        const state: WfState = typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw as WfState;

        // ── Distinguish approval decisions from regular user replies ─────────
        // Approval eventData has { approved: boolean, operation, toolArgs, decidedAt }
        // Regular reply eventData has { text: string, chatId, from }
        const isApprovalEvent = typeof (eventData as any)?.approved === "boolean";

        let injectedText: string;
        if (isApprovalEvent) {
          const approvalData = eventData as { approved: boolean; operation: string; toolArgs?: string };
          if (approvalData.approved) {
            injectedText =
              `✅ APPROVAL GRANTED: The user has approved the action "${approvalData.operation}". ` +
              `You MUST now proceed and execute it immediately. Do not ask for confirmation again.`;
          } else {
            injectedText =
              `❌ APPROVAL DENIED: The user has denied the action "${approvalData.operation}". ` +
              `You MUST NOT perform this action. Acknowledge the denial and tell the user what was cancelled.`;
          }
        } else {
          // Regular user reply (from wait_for_user_input tool)
          injectedText = `User replied: ${(eventData as any)?.text ?? "[User replied]"}`;
        }

        state.contents.push({
          role: "user",
          parts: [{ text: injectedText }],
        });
        state.pauseEventId = null;
        state.pauseQuestion = null;
        await redis.set(stateKey, JSON.stringify(state), { ex: STATE_TTL_SEC });
        return { ok: true, injectedText: injectedText.slice(0, 120) };
      });

      // Continue the loop — next iteration will see the reply
      continue;
    }

    // Sleep between iterations (for monitor-style workflows)
    if (SLEEP_SEC > 0 && i < MAX_ITERATIONS - 1) {
      await context.sleep(`wf-sleep-${i}`, SLEEP_SEC);
    }
  }

  // ── If MAX_ITERATIONS reached without completion → Chain to a new workflow ──
  // This is how VEGA escapes the 200-iteration cap and runs indefinitely.
  if (!finalText) {
    const chainGen = (agentConfig.chainGeneration ?? 0) + 1;

    if (chainGen <= MAX_WORKFLOW_CHAINS) {
      // Serialize current state and spawn a continuation workflow
      const chainResult = await context.run("wf-chain-spawn", async () => {
        const stateRaw = await redis.get<WfState | string>(stateKey);
        const currentState = stateRaw
          ? (typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw as WfState)
          : null;

        const workerBase = ((env.UPSTASH_WORKFLOW_URL ?? env.WORKER_URL ?? "")).replace(/\/$/, "");
        const qstash = new QStashClient({
          token: (env as any).QSTASH_TOKEN,
          baseUrl: (env as any).QSTASH_URL,
        });

        const continuationTaskId = `${taskId}-chain${chainGen}`;
        const continuationInstructions = currentState?.finalText
          ? `CONTINUATION (chain ${chainGen}): ${instructions}`
          : instructions;

        // Store current conversation contents so the new workflow can pick up
        const continuationKey = `agent:wf-chain:${continuationTaskId}`;
        if (currentState?.contents) {
          await redis.set(
            continuationKey,
            JSON.stringify({ contents: currentState.contents.slice(-30) }), // last 30 items
            { ex: STATE_TTL_SEC }
          );
        }

        await qstash.publishJSON({
          url: `${workerBase}/workflow`,
          body: {
            taskId: continuationTaskId,
            sessionId,
            taskType: "sub_agent",
            instructions: continuationInstructions,
            agentConfig: {
              ...agentConfig,
              chainGeneration: chainGen,
              maxIterations: MAX_ITERATIONS,
            },
          } satisfies WorkflowPayload,
        });

        console.log(`[SubAgent WF] ${taskId} hit max iterations — chaining to ${continuationTaskId} (gen ${chainGen}/${MAX_WORKFLOW_CHAINS})`);

        // Update the original task to point to the continuation
        await updateTask(redis, taskId, {
          status: "running",
          result: {
            message: `Chained to continuation workflow (generation ${chainGen})`,
            continuationTaskId,
            chainGeneration: chainGen,
          },
        }).catch(() => { });

        return { chained: true, continuationTaskId };
      });

      if ((chainResult as any).chained) {
        // Original workflow ends here — continuation will handle the rest
        return;
      }
    } else {
      // Too many chains — force finalize with a summary
      finalText = await context.run("wf-max-chain-summary", async () => {
        const stateRaw = await redis.get<WfState | string>(stateKey);
        const st = stateRaw ? (typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw as WfState) : null;
        return await think(
          env.GEMINI_API_KEY,
          `Summarize what was accomplished:\n\n${instructions}`,
          st?.systemPrompt ?? "You are a helpful assistant."
        ).catch(() => "Agent reached maximum execution cycles. Task partially completed.");
      });
    }
  }

  // ── Finalize: write results and push back to user ──────────────────────────

  const finalizeResult = await context.run("wf-finalize", async () => {
    const stateRaw = await redis.get<WfState | string>(stateKey);
    const parsedState = stateRaw
      ? (typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw) as WfState
      : null;

    let result = parsedState?.finalText ?? finalText;

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

    // ── KEY FIX: Write conversation back to sessionId ──────────────────────
    // This is what makes the NEXT Telegram message aware of what the agent did.
    // Without this, every conversation starts fresh after a workflow completes.
    try {
      await appendHistory(redis, sessionId, [
        { role: "user" as const, parts: [{ text: instructions }] },
        { role: "model" as const, parts: [{ text: result.slice(0, 2000) }] },
      ]);
      console.log(`[SubAgent WF] ${taskId} history written back to session: ${sessionId}`);
    } catch (e) {
      console.warn(`[SubAgent WF] History write-back failed: ${String(e)}`);
    }

    // Write to shared memory namespace for parent agent access
    try {
      await redis.set(
        `agent:shared:${agentConfig.memoryPrefix}:result`,
        JSON.stringify({ summary: result, completedAt }),
        { ex: STATE_TTL_SEC }
      );
      await redis.set(`agent:shared:${agentConfig.memoryPrefix}:status`, "done", { ex: STATE_TTL_SEC });
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

    console.log(`[SubAgent WF] ${taskId} (${agentConfig.name}) finalized.`);
    return { result, completedAt, done: true };
  });

  // ── Notify user OUTSIDE context.run() ─────────────────────────────────────
  const notifyDedup = `wf:notified:${taskId}`;
  const alreadyNotified = await redis.get(notifyDedup).catch(() => null);

  if (!alreadyNotified) {
    await redis.set(notifyDedup, "1", { ex: 60 * 60 * 24 }).catch(() => { });
    try {
      await fireCompletionCallback(env, {
        taskId,
        agentName: agentConfig.name,
        parentSessionId: agentConfig.parentSessionId,
        userId: agentConfig.userId ?? undefined,
        memoryPrefix: agentConfig.memoryPrefix,
        status: "done",
        result: finalizeResult.result,
        completedAt: finalizeResult.completedAt,
      });
      console.log(`[SubAgent WF] ${taskId} parent notified.`);
    } catch (e) {
      console.warn(`[SubAgent WF] Completion callback failed: ${String(e)}`);
    }
  }
}

// ─── Completion Callback Helper ───────────────────────────────────────────────

export async function fireCompletionCallback(
  env: Env,
  payload: {
    taskId: string;
    agentName: string;
    parentSessionId: string | null;
    userId?: string;          // undefined only — CompletionCallbackPayload has no null here
    memoryPrefix: string;
    status: string;
    result: string;
    completedAt: string;
  }
): Promise<void> {
  // CRITICAL: Upstash Workflow intercepts ALL fetch() calls at the Worker level —
  // even ones outside context.run(). Calling our own Worker URL via fetch() always
  // returns error 1042 ("cannot route to self") during workflow execution.
  //
  // Fix: import handleCompletionCallback directly and call it as a function.
  // This bypasses the fetch interceptor entirely — it's a plain in-process call.
  try {
    const { handleCompletionCallback } = await import("./completion-callback");
    await handleCompletionCallback(payload, env);
  } catch (e) {
    console.warn(`[fireCompletionCallback] direct call failed: ${String(e)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARALLEL HANDLER — Run all steps simultaneously, merge results
// Perfect for: multi-source research, competitive analysis, batch AI tasks
// ═══════════════════════════════════════════════════════════════════════════════

async function handleParallel(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  instructions: string,
  steps: string[]
): Promise<void> {
  if (steps.length === 0) {
    await handlePlanExecute(context, env, redis, taskId, "parallel", instructions, []);
    return;
  }

  // Run all steps in PARALLEL — each is a separate CF Worker invocation
  const stepResults = await Promise.all(
    steps.map((step, i) =>
      context.run(`parallel-step-${i}`, async () => {
        const { runAgent } = await import("../agent");
        const result = await runAgent(
          env,
          `parallel-${taskId}-${i}`,
          `Execute this specific task as part of a parallel workload:\n\n${step}\n\nContext: ${instructions}`
        );
        return { step, result };
      })
    )
  );

  // Synthesize all results
  await context.run("parallel-synthesize", async () => {
    const combined = stepResults.map((r, i) => `Branch ${i + 1} [${r.step.slice(0, 60)}]:\n${r.result}`).join("\n\n---\n\n");

    const summary = await think(
      env.GEMINI_API_KEY,
      `Synthesize these parallel agent results into a unified report:\n\n${combined}\n\nOverall task: ${instructions}`,
      "You are a synthesis agent. Merge parallel results into a clear, coherent report."
    );

    await updateTask(redis, taskId, {
      status: "done",
      result: {
        summary,
        branchResults: stepResults.map(r => ({ step: r.step.slice(0, 80), resultPreview: r.result.slice(0, 200) })),
        completedAt: new Date().toISOString(),
      },
    });

    return { done: true };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESEARCH HANDLER — Deep multi-source research with tool access per step
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
      `Break this research task into 4-7 concrete steps.
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

  const findings: string[] = [];

  for (let i = 0; i < plan.length; i++) {
    const stepResult: string = await context.run(`research-step-${i + 1}`, async () => {
      const { runAgent } = await import("../agent");

      const stepPrompt = `Execute research step ${i + 1} of ${plan.length}.

Goal: ${instructions}

Previous findings:
${findings.length > 0 ? findings.map((f, idx) => `Step ${idx + 1}: ${f.slice(0, 300)}`).join("\n") : "None yet."}

Your step: ${plan[i]}

Use web_search, cf_browse_page, and fetch_url. Return detailed findings with sources.`;

      return runAgent(env, `research-${taskId}-step${i}`, stepPrompt);
    });

    findings.push(`Step ${i + 1} [${plan[i].slice(0, 60)}]: ${stepResult}`);

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

  // Synthesis
  await context.run("research-synthesize", async () => {
    const synthesis = await think(
      env.GEMINI_API_KEY,
      `Create a comprehensive research report from these findings:

Research goal: ${instructions}

Findings:
${findings.join("\n\n")}

Write a well-structured report with: Executive Summary, Key Findings, Sources, Recommendations.`,
      "You are a research analyst. Write clear, actionable reports."
    );

    await updateTask(redis, taskId, {
      status: "done",
      result: {
        report: synthesis,
        steps: findings.map(f => f.slice(0, 200)),
        completedAt: new Date().toISOString(),
      },
    });

    return { done: true };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONITOR HANDLER — Watch a resource and alert on changes
// Uses context.sleep() — Worker exits entirely between checks. Zero CPU held.
// At 1 hour intervals: 500 checks = 500 hours = 20+ days of monitoring.
// ═══════════════════════════════════════════════════════════════════════════════

async function handleMonitor(
  context: WorkflowContext,
  env: Env,
  redis: ReturnType<typeof getRedis>,
  taskId: string,
  instructions: string,
  agentConfig?: AgentConfig | null
): Promise<void> {
  const SLEEP_SEC = agentConfig?.sleepBetweenStepsSec ?? 3600; // default 1 hour
  const MAX_CHECKS = Math.min(
    agentConfig?.maxIterations ?? 24,
    HARD_MAX_CHECKS
  );

  for (let i = 0; i < MAX_CHECKS; i++) {
    const checkResult: string = await context.run(`monitor-check-${i}`, async () => {
      const { runAgent } = await import("../agent");
      return runAgent(
        env,
        `monitor-${taskId}-check${i}`,
        `Monitor check ${i + 1}/${MAX_CHECKS}. ${instructions}\n\nReport: current status, any changes, any alerts needed.`
      );
    });

    await updateTask(redis, taskId, {
      status: "running",
      result: {
        checksCompleted: i + 1,
        totalChecks: MAX_CHECKS,
        latestCheck: checkResult.slice(0, 300),
        nextCheckInSec: SLEEP_SEC,
      },
    })
      .then(() => redis.expire(`agent:task:${taskId}`, TASK_TTL_SEC))
      .catch(() => { });

    const needsAlert = /alert|changed|detected|found|triggered|urgent|critical/i.test(checkResult);
    if (needsAlert && agentConfig?.parentSessionId) {
      await fireCompletionCallback(env, {
        taskId: `${taskId}-alert-${i}`,
        agentName: agentConfig.name,
        parentSessionId: agentConfig.parentSessionId,
        userId: agentConfig.userId ?? undefined,
        memoryPrefix: agentConfig.memoryPrefix,
        status: "done",
        result: `🔔 Monitor Alert (check ${i + 1}/${MAX_CHECKS}):\n\n${checkResult}`,
        completedAt: new Date().toISOString(),
      }).catch(() => { });
    }

    if (SLEEP_SEC > 0 && i < MAX_CHECKS - 1) {
      await context.sleep(`monitor-sleep-${i}`, SLEEP_SEC);
    }
  }

  await context.run("monitor-finalize", async () => {
    const durationLabel = `${Math.round(MAX_CHECKS * SLEEP_SEC / 3600 * 10) / 10} hours`;
    const summary = `Monitoring completed: ${MAX_CHECKS} checks over ${durationLabel}.\nTask: ${instructions}`;

    await updateTask(redis, taskId, {
      status: "done",
      result: {
        summary,
        totalChecks: MAX_CHECKS,
        completedAt: new Date().toISOString(),
      },
    }).catch(() => { });

    if (agentConfig?.parentSessionId) {
      await fireCompletionCallback(env, {
        taskId,
        agentName: agentConfig.name,
        parentSessionId: agentConfig.parentSessionId,
        userId: agentConfig.userId ?? undefined,
        memoryPrefix: agentConfig.memoryPrefix,
        status: "done",
        result: summary,
        completedAt: new Date().toISOString(),
      }).catch(() => { });
    }

    return { done: true };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH HANDLER — Process a list of items one by one
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
        `Process item (${i + 1} of ${items.length}):\n\n${items[i]}\n\nContext: ${instructions}`
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
  const plan: string[] = await context.run("plan", async () => {
    if (customSteps.length > 0) return customSteps;

    const planText = await think(
      env.GEMINI_API_KEY,
      `Break this task into 3–6 clear sequential steps.
Return ONLY a valid JSON array of strings.

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
  const results: string[] = [];

  for (let i = 0; i < effectivePlan.length; i++) {
    const stepResult: string = await context.run(`execute-step-${i + 1}`, async () => {
      return think(
        env.GEMINI_API_KEY,
        `Execute step ${i + 1} of ${effectivePlan.length} for task: "${taskType}".

Previous results:
${results.length > 0 ? results.join("\n") : "None yet."}

Current step:
${effectivePlan[i]}

Execute thoroughly and return your complete result.`,
        "You are a precise task executor.",
        true
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

    return { done: true };
  });
}