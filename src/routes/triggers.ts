/**
 * ============================================================================
 * src/routes/triggers.ts — VEGA Proactive Trigger Engine
 * ============================================================================
 *
 * What it does:
 *   Users (or VEGA itself) register triggers — conditions that, when met,
 *   cause VEGA to proactively initiate a conversation without waiting for
 *   a user message. Every cron/tick evaluates all active triggers.
 *
 * Trigger types:
 *   schedule    → Fire at a specific ISO datetime (one-shot reminder)
 *   recurring   → Fire on a cron schedule (e.g. "every Monday 9am")
 *   price_alert → Fire when market_data price crosses a threshold
 *   keyword     → Fire when an inbound CF email contains a keyword
 *   goal_due    → Fire when a goal's deadline is approaching (<24h)
 *   manual      → Fire immediately (user or VEGA-triggered)
 *
 * Flow:
 *   1. evaluateAllTriggers() runs inside /cron/tick
 *   2. Each trigger's condition is checked
 *   3. If met: runAgent() is called with the trigger's prompt, then
 *      proactive_notify sends the result to the user via Telegram
 *   4. One-shot triggers are deleted. Recurring triggers update last_fired_at.
 *
 * Routes:
 *   POST   /triggers          → create a trigger
 *   GET    /triggers          → list triggers for a user
 *   DELETE /triggers/:id      → delete a trigger
 *   PATCH  /triggers/:id      → enable/disable a trigger
 *
 * Agent Tools (registered in builtins.ts):
 *   create_trigger(type, condition, action_prompt, label?)
 *   list_triggers()
 *   delete_trigger(id)
 *
 * D1 Migration required:
 *   Run: migrations/0006_triggers.sql
 * ============================================================================
 */

import { Hono } from "hono";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TriggerType =
    | "schedule"      // fire once at fire_at datetime
    | "recurring"     // fire on cron schedule
    | "price_alert"   // fire when asset price crosses threshold
    | "keyword"       // fire when inbound email contains keyword
    | "goal_due"      // fire when goal deadline < 24h away
    | "manual";       // fire immediately (agent-triggered)

export type TriggerRow = {
    id: string;
    user_id: string;
    type: TriggerType;
    label: string | null;
    condition_json: string;   // JSON: { symbol, threshold, direction } | { keyword } | { fire_at } etc.
    action_prompt: string;    // The prompt VEGA will run when triggered
    enabled: number;          // 1 = active, 0 = paused
    fire_at: string | null;   // ISO datetime for 'schedule' type
    cron: string | null;      // cron expression for 'recurring' type
    last_fired_at: string | null;
    fire_count: number;
    created_at: string;
};

export type TriggerCondition =
    | { symbol: string; threshold: number; direction: "above" | "below" }   // price_alert
    | { keyword: string; case_sensitive?: boolean }                          // keyword
    | { fire_at: string }                                                    // schedule
    | { cron: string }                                                       // recurring
    | { goal_id?: string }                                                   // goal_due
    | Record<string, unknown>;                                               // manual/custom

// ─── D1 Helpers ───────────────────────────────────────────────────────────────

async function insertTrigger(db: D1Database, row: TriggerRow): Promise<void> {
    await db.prepare(
        `INSERT INTO triggers
      (id, user_id, type, label, condition_json, action_prompt, enabled,
       fire_at, cron, last_fired_at, fire_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        row.id, row.user_id, row.type, row.label ?? null,
        row.condition_json, row.action_prompt, row.enabled,
        row.fire_at ?? null, row.cron ?? null, row.last_fired_at ?? null,
        row.fire_count, row.created_at
    ).run();
}

async function getActiveTriggers(db: D1Database): Promise<TriggerRow[]> {
    const result = await db
        .prepare("SELECT * FROM triggers WHERE enabled = 1 ORDER BY created_at ASC")
        .all<TriggerRow>();
    return result.results ?? [];
}

async function markFired(db: D1Database, id: string): Promise<void> {
    await db.prepare(
        `UPDATE triggers SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?`
    ).bind(new Date().toISOString(), id).run();
}

async function disableTrigger(db: D1Database, id: string): Promise<void> {
    await db.prepare("UPDATE triggers SET enabled = 0 WHERE id = ?").bind(id).run();
}

// ─── Cron Expression Evaluator ────────────────────────────────────────────────

/**
 * Checks if a cron expression should fire now (within a 5-minute window).
 * Supports standard 5-field cron: min hour dom month dow
 */
function cronShouldFire(cron: string, lastFiredAt: string | null): boolean {
    try {
        const now = new Date();
        const parts = cron.trim().split(/\s+/);
        if (parts.length !== 5) return false;

        const [minPart, hourPart, domPart, monthPart, dowPart] = parts;

        const matchField = (part: string, value: number): boolean => {
            if (part === "*") return true;
            if (part.includes("/")) {
                const [, step] = part.split("/");
                return value % parseInt(step) === 0;
            }
            if (part.includes(",")) return part.split(",").map(Number).includes(value);
            if (part.includes("-")) {
                const [start, end] = part.split("-").map(Number);
                return value >= start && value <= end;
            }
            return parseInt(part) === value;
        };

        const matches =
            matchField(minPart, now.getUTCMinutes()) &&
            matchField(hourPart, now.getUTCHours()) &&
            matchField(domPart, now.getUTCDate()) &&
            matchField(monthPart, now.getUTCMonth() + 1) &&
            matchField(dowPart, now.getUTCDay());

        if (!matches) return false;

        // Prevent double-firing within the same 5-minute window
        if (lastFiredAt) {
            const lastFired = new Date(lastFiredAt).getTime();
            const diffMs = Date.now() - lastFired;
            if (diffMs < 4 * 60 * 1000) return false; // fired < 4 min ago
        }

        return true;
    } catch {
        return false;
    }
}

// ─── Market Price Checker ─────────────────────────────────────────────────────

async function checkPriceCondition(
    condition: { symbol: string; threshold: number; direction: "above" | "below" }
): Promise<{ met: boolean; currentPrice?: number }> {
    try {
        const res = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(condition.symbol)}?interval=1m&range=1d`,
            { headers: { "User-Agent": "VEGA-Agent/1.0" } }
        );
        if (!res.ok) return { met: false };
        const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (!price) return { met: false };

        const met =
            condition.direction === "above"
                ? price >= condition.threshold
                : price <= condition.threshold;

        return { met, currentPrice: price };
    } catch {
        return { met: false };
    }
}

// ─── Core Evaluator (called from /cron/tick) ──────────────────────────────────

/**
 * Evaluate all active triggers for all users.
 * For each trigger that fires: run VEGA agent and send proactive notification.
 * Called from the /cron/tick handler in index.ts.
 */
export async function evaluateAllTriggers(env: Env): Promise<{
    evaluated: number;
    fired: number;
    errors: string[];
}> {
    const triggers = await getActiveTriggers(env.DB);
    const fired: string[] = [];
    const errors: string[] = [];
    const now = new Date();

    for (const trigger of triggers) {
        try {
            let shouldFire = false;
            let contextNote = "";
            let condition: TriggerCondition = {};

            try {
                condition = JSON.parse(trigger.condition_json);
            } catch { /* use empty */ }

            switch (trigger.type) {

                case "schedule": {
                    const fireAt = trigger.fire_at ? new Date(trigger.fire_at) : null;
                    if (fireAt && now >= fireAt && !trigger.last_fired_at) {
                        shouldFire = true;
                        contextNote = `Scheduled reminder at ${fireAt.toISOString()}`;
                    }
                    break;
                }

                case "recurring": {
                    if (trigger.cron) {
                        shouldFire = cronShouldFire(trigger.cron, trigger.last_fired_at);
                        contextNote = `Recurring trigger (cron: ${trigger.cron})`;
                    }
                    break;
                }

                case "price_alert": {
                    const pc = condition as { symbol: string; threshold: number; direction: "above" | "below" };
                    if (pc.symbol && pc.threshold && pc.direction) {
                        const { met, currentPrice } = await checkPriceCondition(pc);
                        if (met) {
                            shouldFire = true;
                            contextNote = `${pc.symbol} is ${pc.direction} ${pc.threshold} (current: ${currentPrice})`;
                        }
                    }
                    break;
                }

                case "goal_due": {
                    // Check if any goal for this user has a deadline within 24h
                    try {
                        const goalsRaw = await env.DB.prepare(
                            `SELECT * FROM goals WHERE user_id = ? AND status = 'active' AND deadline IS NOT NULL`
                        ).bind(trigger.user_id).all<{ id: string; title: string; deadline: string }>();

                        for (const goal of goalsRaw.results ?? []) {
                            const deadline = new Date(goal.deadline);
                            const hoursUntil = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);
                            if (hoursUntil > 0 && hoursUntil <= 24) {
                                shouldFire = true;
                                contextNote = `Goal "${goal.title}" is due in ${Math.round(hoursUntil)} hours`;
                                break;
                            }
                        }
                    } catch { /* goals table may not exist */ }
                    break;
                }

                case "manual": {
                    // Manual triggers fire once immediately
                    if (!trigger.last_fired_at) {
                        shouldFire = true;
                        contextNote = "Manual trigger";
                    }
                    break;
                }
            }

            if (!shouldFire) continue;

            // ── Fire the trigger ───────────────────────────────────────────────────
            const sessionId = `trigger-${trigger.user_id}-${trigger.id}-${Date.now()}`;

            // Write session:user-map so tools work correctly
            try {
                const { getRedis } = await import("../memory");
                const redis = getRedis(env);
                await redis.set(`session:user-map:${sessionId}`, trigger.user_id, { ex: 60 * 60 * 2 });
            } catch { /* non-fatal */ }

            // Build the agent prompt with context
            const fullPrompt =
                `[PROACTIVE TRIGGER FIRED]\n` +
                `Trigger: ${trigger.label ?? trigger.type}\n` +
                `Context: ${contextNote}\n\n` +
                `${trigger.action_prompt}\n\n` +
                `After completing your task, use proactive_notify to send your response to the user.`;

            try {
                const { runAgent } = await import("../agent");
                await runAgent(env, sessionId, fullPrompt);
                fired.push(`${trigger.id} (${trigger.type}: ${trigger.label ?? "unlabeled"})`);
            } catch (runErr) {
                errors.push(`Trigger ${trigger.id} agent failed: ${String(runErr)}`);
                continue;
            }

            // ── Post-fire bookkeeping ──────────────────────────────────────────────
            await markFired(env.DB, trigger.id);

            // One-shot triggers: disable after firing
            if (trigger.type === "schedule" || trigger.type === "manual") {
                await disableTrigger(env.DB, trigger.id);
            }

            // Price alerts: disable after firing (user must re-enable to avoid spam)
            if (trigger.type === "price_alert") {
                await disableTrigger(env.DB, trigger.id);
            }

        } catch (err) {
            errors.push(`Trigger ${trigger.id} eval failed: ${String(err)}`);
        }
    }

    return { evaluated: triggers.length, fired: fired.length, errors };
}

// ─── Agent Tool Declarations ──────────────────────────────────────────────────

export const TRIGGER_TOOL_DECLARATIONS = [
    {
        name: "create_trigger",
        description:
            "Create a proactive trigger that causes VEGA to initiate a conversation when a condition is met. " +
            "Types: 'schedule' (one-shot at a datetime), 'recurring' (cron schedule), " +
            "'price_alert' (when asset price crosses a threshold), " +
            "'goal_due' (when a goal deadline is < 24h away), 'manual' (fire immediately). " +
            "When fired, VEGA runs action_prompt autonomously and sends the result to the user via Telegram. " +
            "Example: remind user every Monday morning, alert when BTC drops below 50000, fire when goal deadline is near.",
        parameters: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    enum: ["schedule", "recurring", "price_alert", "goal_due", "manual"],
                    description: "Trigger type",
                },
                label: {
                    type: "string",
                    description: "Human-readable name for this trigger, e.g. 'Weekly BTC check'",
                },
                condition: {
                    type: "object",
                    description:
                        "Condition config based on type. " +
                        "schedule: { fire_at: 'ISO datetime' }. " +
                        "recurring: { cron: '0 9 * * 1' } (5-field UTC cron). " +
                        "price_alert: { symbol: 'BTC-USD', threshold: 50000, direction: 'below' }. " +
                        "goal_due: {} (auto-detects from goals). " +
                        "manual: {}",
                },
                action_prompt: {
                    type: "string",
                    description:
                        "The task VEGA will perform autonomously when this trigger fires. " +
                        "Be specific. Example: 'Check the current BTC price and summarize market sentiment, " +
                        "then notify the user with a brief report.'",
                },
            },
            required: ["type", "condition", "action_prompt"],
        },
    },
    {
        name: "list_triggers",
        description: "List all active proactive triggers for the current user.",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "delete_trigger",
        description: "Delete a proactive trigger by ID.",
        parameters: {
            type: "object",
            properties: {
                id: { type: "string", description: "Trigger ID to delete" },
            },
            required: ["id"],
        },
    },
];

// ─── Agent Tool Executor ──────────────────────────────────────────────────────

export async function executeTriggerTool(
    toolName: string,
    args: Record<string, unknown>,
    env: Env,
    userId: string | undefined
): Promise<unknown> {
    if (!userId) return { error: "Triggers require authentication." };

    switch (toolName) {
        case "create_trigger": {
            const { type, label, condition, action_prompt } = args as {
                type: TriggerType;
                label?: string;
                condition: TriggerCondition;
                action_prompt: string;
            };

            const conditionObj = condition ?? {};
            const row: TriggerRow = {
                id: crypto.randomUUID(),
                user_id: userId,
                type,
                label: label ?? null,
                condition_json: JSON.stringify(conditionObj),
                action_prompt: String(action_prompt),
                enabled: 1,
                fire_at: (conditionObj as { fire_at?: string }).fire_at ?? null,
                cron: (conditionObj as { cron?: string }).cron ?? null,
                last_fired_at: null,
                fire_count: 0,
                created_at: new Date().toISOString(),
            };

            await insertTrigger(env.DB, row);

            return {
                ok: true,
                id: row.id,
                type,
                label: label ?? null,
                message: `✅ Trigger "${label ?? type}" created. VEGA will act proactively when the condition is met.`,
            };
        }

        case "list_triggers": {
            const result = await env.DB.prepare(
                "SELECT id, type, label, condition_json, enabled, fire_at, cron, last_fired_at, fire_count, created_at FROM triggers WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
            ).bind(userId).all<Partial<TriggerRow>>();
            return { triggers: result.results ?? [], count: result.results?.length ?? 0 };
        }

        case "delete_trigger": {
            const { id } = args as { id: string };
            const result = await env.DB.prepare(
                "DELETE FROM triggers WHERE id = ? AND user_id = ?"
            ).bind(id, userId).run();
            const deleted = (result.meta?.changes ?? 0) > 0;
            return deleted
                ? { ok: true, message: `Trigger ${id} deleted.` }
                : { ok: false, error: "Trigger not found or doesn't belong to you." };
        }

        default:
            return { error: `Unknown trigger tool: ${toolName}` };
    }
}

// ─── Hono Routes ──────────────────────────────────────────────────────────────

const triggersRouter = new Hono<{ Bindings: Env }>();

triggersRouter.use("*", async (c, next) => {
    const userId = c.req.header("X-User-Id")?.trim();
    if (!userId) return c.json({ error: "X-User-Id required" }, 401);
    await next();
});

triggersRouter.post("/", async (c) => {
    const userId = c.req.header("X-User-Id")!;
    const body = await c.req.json<{
        type: TriggerType;
        label?: string;
        condition: TriggerCondition;
        action_prompt: string;
    }>();

    if (!body.type || !body.action_prompt) {
        return c.json({ error: "type and action_prompt are required" }, 400);
    }

    const result = await executeTriggerTool("create_trigger", body as Record<string, unknown>, c.env, userId);
    return c.json(result);
});

triggersRouter.get("/", async (c) => {
    const userId = c.req.header("X-User-Id")!;
    const result = await executeTriggerTool("list_triggers", {}, c.env, userId);
    return c.json(result);
});

triggersRouter.delete("/:id", async (c) => {
    const userId = c.req.header("X-User-Id")!;
    const result = await executeTriggerTool("delete_trigger", { id: c.req.param("id") }, c.env, userId);
    return c.json(result);
});

triggersRouter.patch("/:id", async (c) => {
    const userId = c.req.header("X-User-Id")!;
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    await c.env.DB.prepare(
        "UPDATE triggers SET enabled = ? WHERE id = ? AND user_id = ?"
    ).bind(enabled ? 1 : 0, c.req.param("id"), userId).run();
    return c.json({ ok: true });
});

export default triggersRouter;