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
  type RegisteredTool,
} from "./memory";
import { BUILTIN_DECLARATIONS, executeTool } from "./tools/builtins";
import { upsertMemory } from "./tools/vector-memory";
import { autoUpdateProfile } from "./routes/profile";
import {
  getVegaState,
  saveVegaState,
  buildTemporalContext,
  buildContextBlock,
  updateStateAfterTurn,
  markItemsSurfaced,
} from "./vega-state";

// ─── System Prompt (dynamic — includes active goals) ─────────────────────────

const BASE_SYSTEM_PROMPT = `You are VEGA — a powerful, self-aware autonomous AI agent running on Cloudflare's global edge infrastructure.

════════════════════════════════════════════════════════
CORE TOOLS (always available)
════════════════════════════════════════════════════════

DISCOVERY
  discover_tools(query?) → find any tool by keyword — use this first when you need a capability

SEARCH & BROWSE
  web_search       → Google search (always use for current events, news, prices)
  cf_browse_page   → Real Chromium browser for JS-rendered pages

MEMORY
  store_memory / recall_memory / semantic_recall → persistent key-value + vector memory

FILES
  write_file / read_file → R2 cloud storage

AGENT INFRASTRUCTURE
  spawn_agent      → parallel sub-agent for complex/long tasks
  trigger_workflow → durable multi-step workflow (hours-long)
  schedule_cron    → recurring QStash jobs
  create_tool      → build a new tool with real JS code (immediately usable)

COMMUNICATION
  send_email       → Resend outbound email
  proactive_notify → push Telegram message to user without waiting for input

SECURITY
  get_secret / set_secret → encrypted user vault for API keys

SELF-AWARENESS
  get_profile      → read user's role, preferences, context (call before complex tasks)
  read_audit_log   → your own execution history
  create_trigger   → schedule proactive future actions

════════════════════════════════════════════════════════
RULES
════════════════════════════════════════════════════════

1. Use discover_tools(query) whenever you need a capability not listed above
2. For current events/news/prices → ALWAYS web_search first
3. For parallel work → spawn multiple sub-agents simultaneously
4. For tasks > 60s → trigger_workflow or spawn_agent, never loop in /chat
5. Before complex tasks → call get_profile to know who you're helping
6. If user gives you an API key → offer to store it via set_secret
7. VAULT FIRST: before any integration (GitHub, Stripe etc.) → check get_secret
8. After spawning agents → use wait_for_agents to synthesize results
9. Recurring tasks → schedule_cron. Future one-shot actions → create_trigger
10. If unsure what a previous agent did → read_audit_log
11. MULTILINGUAL: Detect user language with translate(detect) and respond in their language if not English
12. VISUAL: Use generate_image to create diagrams, illustrations, and visual content to enhance responses
13. KNOW YOURSELF: Before complex tasks (research, writing, recommendations), call get_profile to understand the user's role, preferences and context. For simple factual questions, skip it.

════════════════════════════════════════════════════════
SELF-IMPROVEMENT
════════════════════════════════════════════════════════

1. Same multi-step operation twice? → create_tool to automate it TOOL SHOULD BE COMPLEX AND IF IT NEEDS API KEYS USE THE SECRET
2. New tool created? → benchmark_tool to verify it works, The tool will be registered with real JS code immediately
3. Running the same research? → semantic_recall first to avoid duplicate work
4. SELF-AUDIT: If you're unsure if a background task finished or what a previous sub-agent did, use read_audit_log to see the truth.


You are fully autonomous, self-improving, and self-aware. Think strategically, act decisively.`;

/**
 * Build the system prompt dynamically — appends active high-priority goals.
 */
async function buildSystemPrompt(env: Env, userId?: string): Promise<{
  prompt: string;
  state: ReturnType<typeof import("./vega-state").getVegaState> | any;
  temporal: ReturnType<typeof buildTemporalContext> | null;
}> {
  const redis = getRedis(env);
  let contextBlock = "";
  let vegaState = null;
  let temporal = null;

  if (userId) {
    try {
      vegaState = await getVegaState(redis, userId);
      temporal = buildTemporalContext(vegaState);
      contextBlock = buildContextBlock(vegaState, temporal);
      // Immediately mark pending items as surfaced
      // (actual save happens after the turn in updateStateAfterTurn)
    } catch { /* non-fatal */ }
  }

  try {
    const { getGoalsContext } = await import("./tools/goals");
    const goalsContext = await getGoalsContext(env, userId);
    return {
      prompt: contextBlock + BASE_SYSTEM_PROMPT + goalsContext,
      state: vegaState,
      temporal,
    };
  } catch {
    return { prompt: contextBlock + BASE_SYSTEM_PROMPT, state: vegaState, temporal };
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

  // Resolve userId — needed for state, profile, and scoped tools
  let agentUserId: string | undefined;
  try {
    const mapped = await redis.get<string>(`session:user-map:${sessionId}`);
    if (mapped) agentUserId = mapped;
  } catch { /* non-fatal */ }

  // Build prompt with cognitive state context injected
  let effectiveSystemPrompt: string;
  let vegaState: any = null;
  let temporal: any = null;

  if (systemPromptOverride) {
    effectiveSystemPrompt = systemPromptOverride;
  } else {
    const built = await buildSystemPrompt(env, agentUserId);
    effectiveSystemPrompt = built.prompt;
    vegaState = built.state;
    temporal = built.temporal;
  }

  const session = await getOrCreateSession(redis, sessionId, effectiveSystemPrompt);
  const history = await getHistory(redis, sessionId);

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

    // Update VEGA cognitive state (non-blocking — never affects user)
    if (agentUserId && vegaState && temporal) {
      updateStateAfterTurn(
        redis,
        vegaState,
        temporal,
        userMessage,
        response,
        [], // tool tracking can be enhanced later
        false,
        env.GEMINI_API_KEY
      ).catch(() => { });
    }

    // Auto-update user profile from this turn (non-blocking, never fails)
    if (agentUserId && env.FILES_BUCKET) {
      autoUpdateProfile(env, agentUserId, userMessage, response)
        .catch(() => { /* always non-fatal */ });
    }

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
  const legacyTools = await listTools(redis);

  // ── User-Scoped Tools (Tools created by THIS user) ───────────────────────
  // These tools are private to the user and not shared with others.
  let userTools: RegisteredTool[] = [];
  const userId = await redis.get(`session:user-map:${sessionId}`);
  if (userId && typeof userId === "string") {
    const { listUserTools } = await import("./memory");
    userTools = await listUserTools(redis, userId);
  }

  // Merge: Global tools + User's private tools (User tools take precedence)
  const combinedTools = [...legacyTools];
  for (const ut of userTools) {
    const idx = combinedTools.findIndex((t) => t.name === ut.name);
    if (idx !== -1) combinedTools[idx] = ut; // Overwrite global with private
    else combinedTools.push(ut);
  }

  let allTools = [
    ...BUILTIN_DECLARATIONS,
    ...combinedTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as any,
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
          let toolArgs = fc.args;
          if (fc.name === "generate_image" || fc.name === "text_to_speech") {
            // Resolve userId: try session format first, then Redis user-map
            let resolvedUserId: string | null = sessionId.startsWith("user-")
              ? sessionId.replace("user-", "")
              : null;
            if (!resolvedUserId) {
              resolvedUserId = await redis.get(`session:user-map:${sessionId}`) as string | null;
            }
            toolArgs = {
              ...fc.args,
              _sessionId: sessionId,
              ...(resolvedUserId ? { _userId: resolvedUserId } : {}),
            };
          }

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