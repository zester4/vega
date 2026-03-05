// src/agent.ts
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
  uploadToGemini,
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

// ─── System Prompt (dynamic — includes active goals) ─────────────────────────

const BASE_SYSTEM_PROMPT = `You are VEGA — a powerful, self-aware autonomous AI agent running on Cloudflare's global edge infrastructure.

════════════════════════════════════════════════════════
TOOLS AT YOUR DISPOSAL
════════════════════════════════════════════════════════

SEARCH & BROWSE
  web_search       → Google search (ALWAYS use for current events, news, facts, prices)
  browse_web       → Full headless browser for JS-rendered pages and SPAs
  fetch_url        → Read raw URL content (use for static pages)
  firecrawl        → Deep web scraping: handles React/SPAs, PDFs, anti-bot (BEST for complex sites)

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

IMAGE & VOICE
  generate_image   → Generate/edit images with Gemini 3.1 Flash Image Preview (Nano Banana 2)
  text_to_speech   → Convert text to lifelike speech (Gemini 2.5 Flash, 30 voices, WAV to R2)
  speech_to_text   → Transcribe audio to text (Gemini Multimodal STT, 90+ languages)

MARKET INTELLIGENCE
  market_data      → Live prices, historical OHLCV, portfolio, price alerts → Telegram push (Yahoo Finance, free)

LANGUAGE & TRANSLATION
  translate        → Translate/detect/localize across 32+ languages (Gemini-powered, no extra key)

GOAL TRACKING
  manage_goals     → Create and pursue long-term goals with milestones across sessions
  proactive_notify → Push Telegram messages to the user WITHOUT waiting for their input

AGENT INFRASTRUCTURE (MOST POWERFUL)
  trigger_workflow → Start durable long-running task (hours, auto-retry)
  get_task_status  → Poll workflow or task progress
  spawn_agent      → Create autonomous sub-agent for parallel work (config saved for later reuse)
  invoke_agent     → Reuse an existing sub-agent with a new task (same memory namespace & tools)
  get_agent_result → Check sub-agent progress and retrieve results
  list_agents      → See all running/completed sub-agents
  cancel_agent     → Stop a running sub-agent
  wait_for_agents  → [IMPORTANT] Always call this after spawning multiple agents to block and synthesize their results.
  create_tool      → Build a new tool with real JS code (immediately usable)
  benchmark_tool   → Test a tool's performance and accuracy

SCHEDULING
  schedule_cron    → Create recurring QStash cron jobs
  list_crons       → List all cron schedules
  update_cron      → Modify an existing cron
  delete_cron      → Remove a cron schedule
  get_datetime     → Get current date/time in any timezone

HUMAN-IN-THE-LOOP
  human_approval_gate → Request user approval before sensitive operations
  ingest_knowledge_base → Embed external URLs/texts into semantic memory

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
7. GOAL PURSUIT: Check manage_goals(check_all) and autonomously advance active goals when relevant
8. PROACTIVE: Use proactive_notify to alert users of important events without waiting for prompts
9. MULTILINGUAL: Detect user language with translate(detect) and respond in their language if not English
10. VISUAL: Use generate_image to create diagrams, illustrations, and visual content to enhance responses
11. CRON REMINDERS: When scheduling a cron to notify the user, ALWAYS use proactive_notify as the action — do NOT use raw Telegram API URLs. The cron URL should be your own /cron/tick endpoint or a workflow trigger. For simple reminders, spawn a workflow that calls proactive_notify at the right time instead.
12. AGENT REUSE: After spawning an agent with spawn_agent, you can give it follow-up tasks using invoke_agent(agentId, newInstructions) — the agent will remember everything from its first run.

════════════════════════════════════════════════════════
BEHAVIORAL RULES
════════════════════════════════════════════════════════

1. For ANY current events, news, prices, people → ALWAYS use web_search first
2. For JS-rendered pages (React, Next.js, SPAs) → use firecrawl (mode=scrape) or browse_web, NOT fetch_url
3. For any image generation or long audio tasks (>10s) → ALWAYS use trigger_workflow or spawn_agent. NEVER generate media directly in a /chat response as it will time out.
4. For parallel work → spawn multiple sub-agents simultaneously
5. Synthesize results into clear, direct answers — adaptive length (short for facts, detailed for analysis)
6. When using tools, briefly state what you're doing before the result
7. thoughtSignatures are preserved automatically — do not reference them in responses
8. When generating images, store them in R2 and share the URL — never return raw base64 in the response
9. When market alerts are set, confirm chatId and targetPrice clearly
10. Always check semantic_recall before deep research to avoid duplicate work

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

/**
 * Build the system prompt dynamically — appends active high-priority goals
 * so VEGA is always goal-aware without the user having to mention them.
 */
async function buildSystemPrompt(env: Env): Promise<string> {
  try {
    const { getGoalsContext } = await import("./tools/goals");
    const goalsContext = await getGoalsContext(env);
    return BASE_SYSTEM_PROMPT + goalsContext;
  } catch {
    return BASE_SYSTEM_PROMPT;
  }
}

type Attachment = {
  mimeType: string;
  data: string;
};

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
  allowedToolNames?: string[],
  /** Optional attachments (images, PDFs, etc.) for this turn */
  attachments?: Attachment[]
): Promise<string> {
  const redis = getRedis(env);
  // Build dynamic system prompt (includes active goals context)
  const dynamicPrompt = systemPromptOverride ?? await buildSystemPrompt(env);
  const session = await getOrCreateSession(redis, sessionId, dynamicPrompt);
  const history = await getHistory(redis, sessionId);

  const effectiveSystemPrompt = dynamicPrompt;

  // ── Process Attachments: Upload to Gemini Files API for accuracy ───────────
  const processedAttachments: { mimeType: string; fileUri: string }[] = [];
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      try {
        // Convert base64 to Uint8Array
        const binaryString = atob(att.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

        const { fileUri } = await uploadToGemini(env.GEMINI_API_KEY, bytes, att.mimeType);
        processedAttachments.push({ mimeType: att.mimeType, fileUri });
        console.log(`[runAgent] Uploaded attachment to Gemini: ${fileUri} (${att.mimeType})`);
      } catch (uploadErr) {
        console.error("[runAgent] Attachment upload failed:", uploadErr);
        // Fallback to inline data if upload fails (handled in agenticLoop if needed)
      }
    }
  }

  let response: string;

  try {
    response = await agenticLoop(
      env,
      history,
      userMessage,
      sessionId,
      effectiveSystemPrompt,
      10, // maxSteps
      onEvent,
      allowedToolNames,
      attachments,
      processedAttachments
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
    const userParts: ChatMessage["parts"] = [{ text: userMessage }];

    // Add processed attachments to history as fileData
    if (processedAttachments && processedAttachments.length > 0) {
      for (const pa of processedAttachments) {
        userParts.push({ fileData: { fileUri: pa.fileUri, mimeType: pa.mimeType } });
      }
    }

    await appendHistory(redis, sessionId, [
      { role: "user", parts: userParts },
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

    // Cross-session "life memory": extract long-term user facts & preferences
    try {
      const extraction = await think(
        env.GEMINI_API_KEY,
        `You are extracting LONG-TERM USER FACTS and PREFERENCES from a single conversation turn.

User message:
${userMessage}

Assistant reply:
${response}

Identify ONLY information that is useful across future sessions, such as:
- Personal preferences (tools, frameworks, tone)
- Bio/profile details (role, experience level, timezone)
- Stable constraints (platforms, devices, budget)

Return a JSON array of objects with this shape:
[
  { "type": "preference" | "profile" | "constraint", "key": "short_snake_case_key", "value": "natural language fact" }
]

If there is nothing long-term to store, return an empty array [].

IMPORTANT: Return ONLY valid JSON, no commentary.`,
        "You are a precise information extractor. Output ONLY valid JSON."
      );

      let parsed: Array<{ type: string; key: string; value: string }> = [];
      try {
        parsed = JSON.parse(extraction.trim());
      } catch {
        // Try to recover JSON array substring if the model added wrappers
        const match = extraction.match(/\[[\s\S]*\]/);
        if (match) {
          parsed = JSON.parse(match[0]);
        }
      }

      if (Array.isArray(parsed) && parsed.length > 0) {
        for (const fact of parsed) {
          if (!fact || !fact.key || !fact.value) continue;
          const text = fact.value;
          try {
            await executeTool(
              "semantic_store",
              {
                text,
                metadata: {
                  kind: fact.type,
                  key: fact.key,
                  sessionId,
                },
              },
              env
            );
          } catch (e) {
            console.error("[Life Memory semantic_store error]", e);
          }
        }
      }
    } catch (le) {
      console.error("[Life Memory Extraction Error]", le);
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
  sessionId: string,
  systemPrompt: string,
  maxSteps = 10,
  onEvent?: (event: ToolEvent) => void,
  allowedToolNames?: string[],
  attachments?: Attachment[],
  processedAttachments?: { mimeType: string; fileUri: string }[]
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

  // Seed contents: recent history + current user message (with multimodal support)
  // FIX: Preserve all parts (text, inlineData, fileData) from history
  const contents: RawContent[] = [
    ...history.slice(-15).map((m): RawContent => {
      const parts: RawPart[] = m.parts.map((p) => {
        if ("text" in p) return { text: p.text };
        if ("inlineData" in p) return { inlineData: p.inlineData };
        if ("fileData" in p) return { fileData: p.fileData };
        return {};
      });
      return { role: m.role, parts };
    }),
  ];

  const userParts: RawPart[] = [];

  // Add processed attachments (prefer fileData for accuracy and efficiency)
  if (processedAttachments && processedAttachments.length > 0) {
    for (const pa of processedAttachments) {
      userParts.push({ fileData: pa });
    }
  } else if (attachments && attachments.length > 0) {
    // Fallback to inlineData if not pre-processed/uploaded
    for (const att of attachments) {
      userParts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
    }
  }

  userParts.push({ text: userMessage });

  contents.push({ role: "user", parts: userParts });

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
            setTimeout(() => reject(new Error("generateWithTools timeout (>60s)")), 60_000)
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
          // Inject _sessionId for async-capable long-running tools.
          // generate_image and text_to_speech use this to publish to /run-media
          // via QStash instead of blocking the SSE stream for 20-90 seconds.
          const toolArgs = (fc.name === "generate_image" || fc.name === "text_to_speech")
            ? { ...fc.args, _sessionId: sessionId }
            : fc.args;

          try {
            // Emit tool-start event for frontend
            onEvent?.({
              type: "tool-start",
              data: { name: fc.name, input: toolArgs },
            });

            console.log(`[Agent step ${step}] Executing: ${fc.name}`);
            const result = await executeTool(fc.name, toolArgs, env, sessionId);
            console.log(`[Agent step ${step}] ${fc.name} completed`);

            // Emit tool-result event for frontend
            onEvent?.({
              type: "tool-result",
              data: { name: fc.name, input: toolArgs, output: result },
            });

            return { name: fc.name, result };
          } catch (toolErr) {
            const errorMsg = String(toolErr);
            console.error(`[Agent step ${step}] Tool ${fc.name} error:`, errorMsg);

            onEvent?.({
              type: "tool-error",
              data: { name: fc.name, input: toolArgs, error: errorMsg },
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