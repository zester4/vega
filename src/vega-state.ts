/**
 * ============================================================================
 * src/vega-state.ts — VEGA Cognitive State Engine
 * ============================================================================
 *
 * This is what separates VEGA from every other AI agent.
 *
 * Most agents are stateless: they answer, forget, answer again.
 * VEGA has a persistent cognitive state that evolves with every interaction:
 *
 *   MOOD          → how VEGA is approaching the current session
 *   CONFIDENCE    → degrades on failures, grows on successes — affects strategy
 *   FOCUS         → what VEGA believes the user's real underlying goal is
 *   PATTERNS      → behavioral observations about this user over time
 *   PENDING       → surface completed background tasks at conversation start
 *   TEMPORAL      → knows what time it is for the user, how long since last chat
 *
 * This state is:
 *   - Persisted in Redis (key: vega:state:{userId})
 *   - Injected into the system prompt as a compact context block each turn
 *   - Updated non-blockingly after every interaction
 *
 * The result: VEGA feels like it has continuity, personality, and memory.
 * It notices when you've been gone 3 days. It gets more careful after failures.
 * It surfaces your background tasks without being asked.
 * It knows your patterns and adapts to them.
 *
 * That's not a chatbot. That's a colleague.
 * ============================================================================
 */

import type { Redis } from "@upstash/redis/cloudflare";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VegaMood =
    | "analytical"   // deep focus, methodical, precise
    | "curious"      // exploring, making connections, discovering
    | "cautious"     // careful after recent failures, double-checking
    | "engaged"      // high energy, user is on a roll, momentum
    | "focused"      // single task, ignoring noise
    | "reflective";  // long gap since last chat, re-orienting

export type VegaState = {
    userId: string;
    mood: VegaMood;
    confidence: number;            // 0-100. Affects tool retry strategy and hedging.
    currentFocus: string | null;   // What VEGA believes the user's real goal is right now.
    consecutiveSuccesses: number;
    consecutiveFailures: number;
    totalInteractions: number;
    firstSeenAt: string;           // ISO — for context ("I've known you for X days")
    lastSeenAt: string;            // ISO — to detect long gaps
    patterns: string[];            // e.g. ["prefers bullet points", "always asks for code", "works late"]
    pendingItems: PendingItem[];   // Background tasks/alerts to surface at conversation start
    timezone: string | null;       // User's timezone if known ("America/New_York")
    updatedAt: string;
};

export type PendingItem = {
    id: string;
    type: "task_complete" | "price_alert" | "goal_milestone" | "trigger_fired" | "agent_error";
    summary: string;
    surfacedAt: string | null;     // null = not yet surfaced to user
    createdAt: string;
};

// ─── Defaults ─────────────────────────────────────────────────────────────────

function defaultState(userId: string): VegaState {
    const now = new Date().toISOString();
    return {
        userId,
        mood: "curious",
        confidence: 80,
        currentFocus: null,
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        totalInteractions: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        patterns: [],
        pendingItems: [],
        timezone: null,
        updatedAt: now,
    };
}

// ─── Redis Key ────────────────────────────────────────────────────────────────

const STATE_KEY = (userId: string) => `vega:state:${userId}`;
const STATE_TTL = 60 * 60 * 24 * 90; // 90 days

// ─── Read / Write ─────────────────────────────────────────────────────────────

export async function getVegaState(redis: Redis, userId: string): Promise<VegaState> {
    try {
        const raw = await redis.get<VegaState>(STATE_KEY(userId));
        if (raw) return raw;
    } catch { /* fallback to default */ }
    return defaultState(userId);
}

export async function saveVegaState(redis: Redis, state: VegaState): Promise<void> {
    try {
        state.updatedAt = new Date().toISOString();
        await redis.set(STATE_KEY(state.userId), state, { ex: STATE_TTL });
    } catch { /* non-fatal */ }
}

// ─── Mood Calculator ──────────────────────────────────────────────────────────

/**
 * Determine VEGA's mood for this session based on state history.
 * This is deterministic — not random. Mood emerges from real conditions.
 */
export function calculateMood(state: VegaState, gapHours: number): VegaMood {
    // Long absence → reflective, re-orienting
    if (gapHours > 72) return "reflective";

    // Recent failure streak → cautious
    if (state.consecutiveFailures >= 2) return "cautious";

    // High confidence + success streak → engaged
    if (state.confidence >= 85 && state.consecutiveSuccesses >= 3) return "engaged";

    // Low confidence → careful analytical mode
    if (state.confidence < 50) return "analytical";

    // Active focused task → focused
    if (state.currentFocus) return "focused";

    // Default: curious
    return "curious";
}

// ─── Temporal Context ─────────────────────────────────────────────────────────

export type TemporalContext = {
    now: string;              // ISO
    userTimeStr: string;      // "Tuesday 3:45 PM" in user's timezone
    gapHours: number;         // hours since last interaction
    gapDescription: string;   // "2 hours ago", "3 days ago", "just now"
    isFirstEver: boolean;
    isLongAbsence: boolean;   // > 3 days
};

export function buildTemporalContext(state: VegaState): TemporalContext {
    const now = new Date();
    const lastSeen = new Date(state.lastSeenAt);
    const gapMs = now.getTime() - lastSeen.getTime();
    const gapHours = gapMs / (1000 * 60 * 60);
    const gapMins = gapMs / (1000 * 60);

    let gapDescription: string;
    if (gapMins < 2) gapDescription = "moments ago";
    else if (gapMins < 60) gapDescription = `${Math.round(gapMins)} minutes ago`;
    else if (gapHours < 24) gapDescription = `${Math.round(gapHours)} hours ago`;
    else if (gapHours < 48) gapDescription = "yesterday";
    else gapDescription = `${Math.round(gapHours / 24)} days ago`;

    // User-facing time string
    let userTimeStr: string;
    try {
        userTimeStr = now.toLocaleString("en-US", {
            timeZone: state.timezone ?? "UTC",
            weekday: "long",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
        });
    } catch {
        userTimeStr = now.toUTCString();
    }

    return {
        now: now.toISOString(),
        userTimeStr,
        gapHours,
        gapDescription,
        isFirstEver: state.totalInteractions === 0,
        isLongAbsence: gapHours > 72,
    };
}

// ─── Pending Items Manager ────────────────────────────────────────────────────

export function getUnsurfacedItems(state: VegaState): PendingItem[] {
    return state.pendingItems.filter((p) => !p.surfacedAt);
}

export function markItemsSurfaced(state: VegaState): VegaState {
    const now = new Date().toISOString();
    return {
        ...state,
        pendingItems: state.pendingItems
            .map((p) => (p.surfacedAt ? p : { ...p, surfacedAt: now }))
            .filter((p) => {
                const age = Date.now() - new Date(p.createdAt).getTime();
                // Prune items older than 7 days
                return age < 7 * 24 * 60 * 60 * 1000;
            }),
    };
}

/**
 * Add a pending item to a user's state (called from background tasks/triggers).
 * E.g., when a sub-agent completes, add a pending item so VEGA surfaces it
 * at the start of the next conversation.
 */
export async function addPendingItem(
    redis: Redis,
    userId: string,
    item: Omit<PendingItem, "id" | "surfacedAt" | "createdAt">
): Promise<void> {
    const state = await getVegaState(redis, userId);
    state.pendingItems.push({
        ...item,
        id: crypto.randomUUID(),
        surfacedAt: null,
        createdAt: new Date().toISOString(),
    });
    // Keep max 20 pending items
    if (state.pendingItems.length > 20) {
        state.pendingItems = state.pendingItems.slice(-20);
    }
    await saveVegaState(redis, state);
}

// ─── Context Block Builder ────────────────────────────────────────────────────

/**
 * Build the compact context block that gets prepended to the system prompt.
 * This is the "inner state injection" — what makes VEGA feel self-aware.
 *
 * Kept deliberately short (< 300 tokens) to minimise prompt bloat.
 * Rich enough to fundamentally change how VEGA shows up.
 */
export function buildContextBlock(
    state: VegaState,
    temporal: TemporalContext
): string {
    const lines: string[] = [];

    lines.push("═══════════════════════════════════════════════════");
    lines.push("YOUR CURRENT STATE (self-awareness context)");
    lines.push("═══════════════════════════════════════════════════");

    // Temporal
    lines.push(`Time: ${temporal.userTimeStr}`);
    lines.push(`Last interaction: ${temporal.gapDescription}`);

    // Mood and confidence
    lines.push(`Mood: ${state.mood} | Confidence: ${state.confidence}/100`);

    // Current focus
    if (state.currentFocus) {
        lines.push(`Your sense of what the user is working toward: ${state.currentFocus}`);
    }

    // Pending items to surface
    const unsurfaced = getUnsurfacedItems(state);
    if (unsurfaced.length > 0) {
        lines.push(`\nPENDING — surface these naturally at the start of your response:`);
        for (const item of unsurfaced.slice(0, 3)) {
            lines.push(`  • [${item.type}] ${item.summary}`);
        }
    }

    // Known patterns about the user
    if (state.patterns.length > 0) {
        lines.push(`\nUser patterns you've observed: ${state.patterns.slice(0, 3).join("; ")}`);
    }

    // Long absence handling
    if (temporal.isLongAbsence) {
        lines.push(`\nNOTE: ${temporal.gapDescription} since last chat. Re-orient gently. Reference what you were working on if relevant.`);
    }

    // First ever interaction
    if (temporal.isFirstEver) {
        lines.push(`\nNOTE: This is a first interaction. Introduce yourself briefly, ask for their name and role.`);
    }

    // Confidence behavioral guidance
    if (state.confidence < 50) {
        lines.push(`\nCONFIDENCE IS LOW: Be more careful. Verify before asserting. Ask clarifying questions. Explain your reasoning.`);
    } else if (state.confidence >= 90 && state.consecutiveSuccesses >= 4) {
        lines.push(`\nCONFIDENCE IS HIGH: Recent streak of successes. You can be more decisive and bold.`);
    }

    lines.push("═══════════════════════════════════════════════════\n");

    return lines.join("\n");
}

// ─── Post-Turn State Updater ──────────────────────────────────────────────────

/**
 * Called after every agent response to update cognitive state.
 * Runs non-blocking. Failures never affect the user.
 *
 * Updates: confidence, mood, currentFocus, patterns, lastSeenAt, totalInteractions.
 */
export async function updateStateAfterTurn(
    redis: Redis,
    state: VegaState,
    temporal: TemporalContext,
    userMessage: string,
    agentResponse: string,
    toolsUsed: string[],
    hadErrors: boolean,
    geminiApiKey: string
): Promise<void> {
    try {
        // Update interaction count and timestamp
        state.totalInteractions += 1;
        state.lastSeenAt = temporal.now;

        // Confidence adjustment
        if (hadErrors) {
            state.consecutiveFailures += 1;
            state.consecutiveSuccesses = 0;
            state.confidence = Math.max(20, state.confidence - 8);
        } else {
            state.consecutiveSuccesses += 1;
            state.consecutiveFailures = 0;
            state.confidence = Math.min(100, state.confidence + 3);
        }

        // Recalculate mood
        state.mood = calculateMood(state, temporal.gapHours);

        // Mark pending items as surfaced
        state = markItemsSurfaced(state);

        // Non-blocking: use Gemini to extract focus + patterns
        // Only run every 3 interactions to save tokens
        if (state.totalInteractions % 3 === 0 || !state.currentFocus) {
            const { think } = await import("./gemini");

            const analysis = await think(
                geminiApiKey,
                `Analyze this conversation turn for an AI agent's self-awareness system.

User message: ${userMessage.slice(0, 300)}
Agent reply: ${agentResponse.slice(0, 300)}
Tools used: ${toolsUsed.join(", ") || "none"}
Current focus: ${state.currentFocus ?? "unknown"}
Existing patterns: ${state.patterns.join("; ") || "none"}

Extract:
1. "focus" — What is the user's real underlying goal right now? 1 sentence. Null if unclear.
2. "new_pattern" — One new behavioral observation about this user (e.g., "prefers concise answers", "always asks for code examples", "works on React projects"). Only include if genuinely new. Null if nothing new.
3. "timezone" — If timezone was mentioned or inferred. Null otherwise.

Return ONLY JSON: { "focus": "...", "new_pattern": "...", "timezone": "..." }`,
                "Return only valid JSON."
            );

            try {
                const { focus, new_pattern, timezone } = JSON.parse(
                    analysis.match(/\{[\s\S]*\}/)?.[0] ?? "{}"
                );

                if (focus && typeof focus === "string") state.currentFocus = focus;
                if (new_pattern && typeof new_pattern === "string") {
                    if (!state.patterns.includes(new_pattern)) {
                        state.patterns.unshift(new_pattern);
                        state.patterns = state.patterns.slice(0, 8); // keep max 8
                    }
                }
                if (timezone && typeof timezone === "string") state.timezone = timezone;
            } catch { /* ignore parse failures */ }
        }

        await saveVegaState(redis, state);
    } catch { /* always non-fatal */ }
}

// ─── Tool Tracking (called from executeTool) ──────────────────────────────────

/**
 * Quick signal: a tool succeeded or failed.
 * Used to update confidence without running the full analysis.
 */
export async function signalToolOutcome(
    redis: Redis,
    userId: string,
    success: boolean
): Promise<void> {
    try {
        const state = await getVegaState(redis, userId);
        if (success) {
            state.confidence = Math.min(100, state.confidence + 1);
        } else {
            state.confidence = Math.max(20, state.confidence - 3);
        }
        await saveVegaState(redis, state);
    } catch { /* non-fatal */ }
}