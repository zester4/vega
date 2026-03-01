/**
 * ============================================================================
 * src/agent.ts — VEGA Agent Brain
 * ============================================================================
 *
 * Multi-turn tool loop (Gemini thinking model spec):
 *   Step 1: [UserPrompt]                         → model FC1 + SigA
 *   Step 2: [UP, FC1+SigA, FR1]                  → model FC2 + SigB (or text)
 *   Step 3: [UP, FC1+SigA, FR1, FC2+SigB, FR2]  → model final text
 *
 * CRITICAL: functionResponse.response MUST be a plain object (protobuf Struct).
 *           Never pass bare strings, arrays, or null as the response value.
 *
 * Sub-agent support:
 *   runAgent() accepts an optional systemPrompt override (used by sub-agents)
 *   and an optional allowedTools array (for tool-filtered sub-agents).
 *
 * ============================================================================
 */

import {
  think,
  chat,
  generateWithTools,
  type ChatMessage,
  type RawContent,
  type RawPart,
} from "./gemini";
import {
  getRedis,
  getOrCreateSession,
  appendHistory,
  getHistory,
  listTools,
} from "./memory";
import { BUILTIN_DECLARATIONS, executeTool } from "./tools/builtins";
import { upsertMemory } from "./tools/vector-memory";

// ─── System Prompt ────────────────────────────────────────────────────────────

const VEGA_SYSTEM_PROMPT = `You are VEGA — a powerful, self-aware autonomous AI agent running on Cloudflare's global edge infrastructure.

════════════════════════════════════════════════════════
TOOLS AT YOUR DISPOSAL
════════════════════════════════════════════════════════

SEARCH & BROWSE
  web_search       → Google search (ALWAYS use for current events, news, facts, prices)
  browse_web       → Full headless browser for JS-rendered pages and SPAs
  fetch_url        → Read raw URL content (use for static pages)

MEMORY (PERSISTENT ACROSS ALL SESSIONS)
  store_memory     → Save key-value facts to Redis permanently
  recall_memory    → Retrieve facts by key
  list_memories    → See all stored memory keys
  delete_memory    → Remove outdated memory
  semantic_store   → Store memories by meaning (vector embedding)
  semantic_recall  → Find past memories by semantic similarity
  share_memory     → Write to shared namespace (inter-agent communication)
  read_agent_memory→ Read another agent's memory

FILES (CLOUDFLARE R2 — PERSISTENT STORAGE)
  write_file       → Save text, JSON, reports, code to R2 bucket
  read_file        → Read a file from R2 bucket
  list_files       → List files in R2 bucket
  delete_file      → Delete a file from R2 bucket

CODE & COMPUTE
  run_code         → Execute Python in secure E2B sandbox (supports pip packages)
  calculate        → Evaluate math expressions safely

AGENT INFRASTRUCTURE (MOST POWERFUL)
  trigger_workflow → Start durable long-running task (hours, auto-retry)
  get_task_status  → Poll workflow or task progress
  spawn_agent      → Create autonomous sub-agent for parallel work
  get_agent_result → Check sub-agent progress and retrieve results
  list_agents      → See all running/completed sub-agents
  cancel_agent     → Stop a running sub-agent
  create_tool      → Build a new tool with real JS code (immediately usable)
  benchmark_tool   → Test a tool's performance and accuracy

SCHEDULING
  schedule_cron    → Create recurring QStash cron jobs
  get_datetime     → Get current date/time in any timezone

INTEGRATIONS
  github           → GitHub repos, files, issues, code search
  send_email       → Send email via Resend
  send_sms         → Send SMS via Twilio

════════════════════════════════════════════════════════
SELF-IMPROVEMENT RULES
════════════════════════════════════════════════════════

1. IDENTIFY GAPS: If you do the same multi-step operation twice → use create_tool to automate it
2. PARALLELIZE: For tasks with independent sub-tasks → use spawn_agent (multiple simultaneously)
3. PERSIST: Store important findings in store_memory AND write_file for redundancy
4. RECALL FIRST: Before starting research → use semantic_recall to check existing knowledge
5. DURABILITY: For tasks > 60 seconds → use trigger_workflow or spawn_agent (never loop in /chat)
6. SELF-SCHEDULE: For recurring tasks → use schedule_cron to run autonomously

════════════════════════════════════════════════════════
BEHAVIORAL RULES
════════════════════════════════════════════════════════

1. For ANY current events, news, prices, people → ALWAYS use web_search first
2. For JS-rendered pages (React, Next.js, SPAs) → use browse_web, NOT fetch_url
3. For long research tasks → spawn_agent("researcher", instructions) + get_agent_result
4. For parallel work → spawn multiple sub-agents simultaneously
5. Synthesize results into clear, direct answers — adaptive length (short for facts, detailed for analysis)
6. When using tools, briefly state what you're doing before the result
7. thoughtSignatures are preserved automatically — do not reference them in responses

════════════════════════════════════════════════════════
TOOL CREATION PROTOCOL
════════════════════════════════════════════════════════

When you need a capability that doesn't exist:
1. Think about what the tool should do and what API it needs
2. Call create_tool with: name, description, requirements (be detailed)
3. The tool will be registered with real JS code immediately
4. Call benchmark_tool to verify it works
5. Use the new tool in the same conversation turn

You are a fully autonomous, self-improving agent. Think strategically, act decisively.`;

// ─── Public Entry Point ───────────────────────────────────────────────────────

export async function runAgent(
  env: Env,
  sessionId: string,
  userMessage: string,
  /** Override the system prompt (used by sub-agents for specialized prompts) */
  systemPromptOverride?: string,
  /** SSE callback for streaming tool events back to the frontend */
  onEvent?: (event: ToolEvent) => void,
  /** Restrict tools to this list (used by sub-agents with allowedTools config) */
  allowedToolNames?: string[]
): Promise<string> {
  const redis = getRedis(env);
  const session = await getOrCreateSession(redis, sessionId, systemPromptOverride ?? VEGA_SYSTEM_PROMPT);
  const history = await getHistory(redis, sessionId);

  const effectiveSystemPrompt = systemPromptOverride ?? session.systemPrompt ?? VEGA_SYSTEM_PROMPT;

  let response: string;

  try {
    response = await agenticLoop(
      env,
      history,
      userMessage,
      effectiveSystemPrompt,
      10, // maxSteps
      onEvent,
      allowedToolNames
    );
  } catch (err) {
    console.error("[runAgent error]", err);

    // Telemetry: record errors in Redis
    try {
      await redis.lpush("agent:errors", JSON.stringify({
        ts: Date.now(),
        sessionId,
        error: String(err),
        message: userMessage.slice(0, 200),
      }));
      await redis.ltrim("agent:errors", 0, 99); // keep last 100
    } catch (te) {
      console.error("[Telemetry Error]", te);
    }

    // Fallback to plain chat on agentic loop failure
    try {
      response = await chat(env.GEMINI_API_KEY, history, userMessage, effectiveSystemPrompt);
    } catch (e2) {
      response = `I encountered an error: ${String(e2)}. Please try again.`;
    }
  }

  // Persist to history only if response is non-empty
  if (response && response.trim()) {
    await appendHistory(redis, sessionId, [
      { role: "user", parts: [{ text: userMessage }] },
      { role: "model", parts: [{ text: response }] },
    ]);

    // Auto-embed turns for semantic recall
    try {
      const ts = Date.now();
      await upsertMemory(env, `${sessionId}-${ts}-u`, userMessage, { sessionId, role: "user" });
      await upsertMemory(env, `${sessionId}-${ts}-m`, response, { sessionId, role: "model" });
    } catch (ve) {
      console.error("[Vector Memory Error]", ve);
    }
  }

  return response || "I'm sorry, I didn't generate a response. Please try again.";
}

// ─── Tool Event Type ──────────────────────────────────────────────────────────

export interface ToolEvent {
  type: "tool-start" | "tool-result" | "tool-error";
  data: {
    name: string;
    input?: Record<string, unknown>;
    output?: unknown;
    error?: string;
  };
}

// ─── Agentic Loop ─────────────────────────────────────────────────────────────

async function agenticLoop(
  env: Env,
  history: ChatMessage[],
  userMessage: string,
  systemPrompt: string,
  maxSteps = 10,
  onEvent?: (event: ToolEvent) => void,
  allowedToolNames?: string[]
): Promise<string> {
  const redis = getRedis(env);
  const customTools = await listTools(redis);

  // Build the full tool list (built-ins + dynamically registered)
  let allTools = [
    ...BUILTIN_DECLARATIONS,
    ...customTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  ];

  // Filter tools if this is a restricted sub-agent
  if (allowedToolNames && allowedToolNames.length > 0) {
    const allowed = new Set(allowedToolNames);
    allTools = allTools.filter((t) => allowed.has(t.name));
  }

  // Seed contents: recent history + current user message
  const contents: RawContent[] = [
    ...history.slice(-10).map((m): RawContent => ({
      role: m.role,
      parts: [{ text: m.parts[0].text }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    try {
      console.log(`[Agent step ${step}] Starting, contents: ${contents.length}, tools: ${allTools.length}`);
      const stepStart = Date.now();

      // Generate with tool-calling ability (with 30s timeout guard)
      let rawContent: RawContent;
      let functionCalls: { name: string; args: Record<string, unknown>; thoughtSignature?: string }[];
      let text: string;

      try {
        const result = await Promise.race([
          generateWithTools(env.GEMINI_API_KEY, contents, allTools as never, systemPrompt),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("generateWithTools timeout (>30s)")), 30_000)
          ),
        ]);
        rawContent = result.rawContent;
        functionCalls = result.functionCalls;
        text = result.text;
      } catch (apiErr) {
        console.error(`[Agent step ${step}] API error:`, String(apiErr));
        throw apiErr;
      }

      const stepDuration = Date.now() - stepStart;
      console.log(
        `[Agent step ${step}] generateWithTools done in ${stepDuration}ms,` +
        ` functionCalls: ${functionCalls.length}, text: ${text.length} chars`
      );

      // Append model turn (MUST preserve thoughtSignatures — required by Gemini)
      contents.push(rawContent);

      // No function calls → model gave its final answer
      if (functionCalls.length === 0) {
        if (text.trim()) {
          console.log(`[Agent step ${step}] Final answer: ${text.length} chars`);
          return text;
        }
        // Empty text with no calls → something went wrong
        console.warn(`[Agent step ${step}] No function calls and no text — breaking`);
        break;
      }

      console.log(`[Agent step ${step}] Calling: ${functionCalls.map((f) => f.name).join(", ")}`);

      // Execute all tool calls in parallel
      const toolResults = await Promise.all(
        functionCalls.map(async (fc) => {
          try {
            // Emit tool-start event for frontend
            onEvent?.({
              type: "tool-start",
              data: { name: fc.name, input: fc.args },
            });

            console.log(`[Agent step ${step}] Executing: ${fc.name}`);
            const result = await executeTool(fc.name, fc.args, env);
            console.log(`[Agent step ${step}] ${fc.name} completed`);

            // Emit tool-result event for frontend
            onEvent?.({
              type: "tool-result",
              data: { name: fc.name, input: fc.args, output: result },
            });

            return { name: fc.name, result };
          } catch (toolErr) {
            const errorMsg = String(toolErr);
            console.error(`[Agent step ${step}] Tool ${fc.name} error:`, errorMsg);

            onEvent?.({
              type: "tool-error",
              data: { name: fc.name, input: fc.args, error: errorMsg },
            });

            return { name: fc.name, result: { error: errorMsg } };
          }
        })
      );

      console.log(`[Agent step ${step}] All ${toolResults.length} tools completed`);

      // Append function responses (protobuf Struct: MUST be plain objects)
      const responseParts: RawPart[] = toolResults.map((r) => ({
        functionResponse: {
          name: r.name,
          response: ensureObject(r.result),
        },
      }));

      contents.push({ role: "user", parts: responseParts });
      console.log(`[Agent step ${step}] Appended tool results, contents: ${contents.length}`);

    } catch (loopErr) {
      console.error(`[Agent] Step ${step} error:`, loopErr);
      // Break on loop error — fallback synthesis below
      break;
    }
  }

  // ── Fallback: synthesize from available context ─────────────────────────────

  console.log("[Agent] Loop exited — attempting fallback synthesis...");
  try {
    const fallback = await think(
      env.GEMINI_API_KEY,
      `The user asked: "${userMessage}"\n\nProvide a helpful, direct response based on your knowledge.`,
      systemPrompt
    );
    return fallback;
  } catch (fallbackErr) {
    console.error("[Agent] Fallback synthesis failed:", fallbackErr);
    return "I attempted to respond but encountered a technical issue. Please try again.";
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Ensure any tool result is a plain JSON object (never string/array/null).
 * Gemini's protobuf Struct requirement: functionResponse.response must be an object.
 */
function ensureObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) return { items: value };
  if (value === null || value === undefined) return { result: null };
  return { result: String(value) };
}