/**
 * ============================================================================
 * src/tools/goals.ts — Goal Tracking System + Proactive Telegram Push
 * ============================================================================
 *
 * Goal Tracking:
 *   VEGA stores long-term goals in Redis under `goals:*` keys.
 *   Every session start, agent.ts checks goal progress before responding.
 *   Goals have: title, description, milestones, progress (0-100), status.
 *
 * Proactive Telegram Push:
 *   sendProactiveTelegramMessage() is called by:
 *   - Price alert triggers (market.ts)
 *   - Goal milestone completion
 *   - Error spike detection (cron)
 *   - Sub-agent task completion
 *   - Any scheduled notification
 *
 * manage_goals tool actions:
 *   create_goal      → Create a new long-term goal
 *   update_progress  → Update goal progress (0-100) + milestone notes
 *   list_goals       → Show all active goals with progress
 *   complete_goal    → Mark goal as achieved
 *   delete_goal      → Remove a goal
 *   check_all        → Review all goals and suggest autonomous actions
 *
 * proactive_notify tool:
 *   Allows VEGA to push messages to Telegram without user prompting.
 * ============================================================================
 */

// ─── GOAL SYSTEM ─────────────────────────────────────────────────────────────

export interface Goal {
  id: string;
  title: string;
  description: string;
  category: string; // "business" | "research" | "personal" | "monitoring" | "custom"
  milestones: GoalMilestone[];
  progress: number; // 0-100
  status: "active" | "completed" | "paused" | "cancelled";
  priority: "low" | "medium" | "high" | "critical";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  nextAction?: string;  // What VEGA should autonomously do next
  notifyOnProgress?: boolean;
  telegramChatId?: string; // Push updates here
}

export interface GoalMilestone {
  id: string;
  title: string;
  completed: boolean;
  completedAt?: number;
  notes?: string;
}

export async function execManageGoals(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const action = String(args.action ?? "list_goals") as
    | "create_goal"
    | "update_progress"
    | "list_goals"
    | "get_goal"
    | "complete_goal"
    | "delete_goal"
    | "add_milestone"
    | "complete_milestone"
    | "check_all";

  const { getRedis } = await import("../memory");
  const redis = getRedis(env);

  try {
    switch (action) {
      // ── CREATE GOAL ───────────────────────────────────────────────────────────
      case "create_goal": {
        const title = String(args.title ?? "");
        if (!title) return { error: "title is required" };

        const goalId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const milestoneList = (args.milestones as string[] | undefined) ?? [];

        const goal: Goal = {
          id: goalId,
          title,
          description: String(args.description ?? ""),
          category: String(args.category ?? "custom"),
          milestones: milestoneList.map((m, i) => ({
            id: `m-${i}`,
            title: m,
            completed: false,
          })),
          progress: 0,
          status: "active",
          priority: (args.priority as Goal["priority"]) ?? "medium",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          nextAction: args.nextAction as string | undefined,
          notifyOnProgress: Boolean(args.notifyOnProgress ?? false),
          telegramChatId: args.telegramChatId as string | undefined,
        };

        await redis.set(`goals:${goalId}`, JSON.stringify(goal));
        await redis.sadd("goals:index", goalId);

        return {
          success: true,
          goalId,
          goal,
          message: `Goal created: "${title}" (${goal.priority} priority)`,
        };
      }

      // ── UPDATE PROGRESS ───────────────────────────────────────────────────────
      case "update_progress": {
        const goalId = String(args.goalId ?? "");
        const progress = Math.min(100, Math.max(0, Number(args.progress ?? 0)));
        const notes = args.notes as string | undefined;

        const raw = await redis.get(`goals:${goalId}`) as string | null;
        if (!raw) return { error: `Goal not found: ${goalId}` };

        const goal = JSON.parse(raw) as Goal;
        const prevProgress = goal.progress;
        goal.progress = progress;
        goal.updatedAt = Date.now();
        if (notes) goal.nextAction = notes;
        if (progress >= 100) {
          goal.status = "completed";
          goal.completedAt = Date.now();
        }

        await redis.set(`goals:${goalId}`, JSON.stringify(goal));

        // Send proactive Telegram notification if progress hit milestone
        const milestoneThresholds = [25, 50, 75, 100];
        const hitMilestone = milestoneThresholds.find(
          (t) => prevProgress < t && progress >= t
        );

        if (hitMilestone && goal.telegramChatId && goal.notifyOnProgress) {
          const emoji = hitMilestone === 100 ? "🎉" : "🎯";
          await sendProactiveTelegramMessage(
            env,
            goal.telegramChatId,
            `${emoji} <b>Goal Progress Update</b>\n\n` +
            `<b>${goal.title}</b>\n` +
            `Progress: ${progress}% ${hitMilestone === 100 ? "(COMPLETED! 🏆)" : ""}\n\n` +
            (notes ? `📝 ${notes}` : "")
          );
        }

        return {
          success: true,
          goalId,
          progress,
          previousProgress: prevProgress,
          status: goal.status,
          milestoneHit: hitMilestone ?? null,
        };
      }

      // ── LIST GOALS ────────────────────────────────────────────────────────────
      case "list_goals": {
        const status = args.status as string | undefined;
        const goalIds = await redis.smembers("goals:index") as string[];

        if (!goalIds.length) {
          return { goals: [], count: 0, message: "No goals set. Use create_goal to start tracking." };
        }

        const goals = await Promise.all(
          goalIds.map(async (id) => {
            try {
              const raw = await redis.get(`goals:${id}`) as string | null;
              return raw ? (JSON.parse(raw) as Goal) : null;
            } catch { return null; }
          })
        );

        let filtered = goals.filter((g): g is Goal => g !== null);
        if (status) filtered = filtered.filter((g) => g.status === status);

        // Sort by priority then progress
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        filtered.sort((a, b) =>
          (priorityOrder[a.priority] - priorityOrder[b.priority]) ||
          (b.progress - a.progress)
        );

        return {
          goals: filtered.map((g) => ({
            id: g.id,
            title: g.title,
            category: g.category,
            priority: g.priority,
            progress: g.progress,
            status: g.status,
            milestonesTotal: g.milestones.length,
            milestonesCompleted: g.milestones.filter((m) => m.completed).length,
            nextAction: g.nextAction,
            updatedAt: new Date(g.updatedAt).toISOString(),
          })),
          count: filtered.length,
          activeCount: filtered.filter((g) => g.status === "active").length,
          completedCount: filtered.filter((g) => g.status === "completed").length,
        };
      }

      // ── GET SINGLE GOAL ───────────────────────────────────────────────────────
      case "get_goal": {
        const goalId = String(args.goalId ?? "");
        const raw = await redis.get(`goals:${goalId}`) as string | null;
        if (!raw) return { error: `Goal not found: ${goalId}` };
        return { goal: JSON.parse(raw) as Goal };
      }

      // ── COMPLETE MILESTONE ────────────────────────────────────────────────────
      case "complete_milestone": {
        const goalId = String(args.goalId ?? "");
        const milestoneId = String(args.milestoneId ?? "");
        const notes = args.notes as string | undefined;

        const raw = await redis.get(`goals:${goalId}`) as string | null;
        if (!raw) return { error: `Goal not found: ${goalId}` };

        const goal = JSON.parse(raw) as Goal;
        const milestone = goal.milestones.find((m) => m.id === milestoneId);
        if (!milestone) return { error: `Milestone not found: ${milestoneId}` };

        milestone.completed = true;
        milestone.completedAt = Date.now();
        if (notes) milestone.notes = notes;

        // Auto-calculate progress from milestone completion
        const completedCount = goal.milestones.filter((m) => m.completed).length;
        if (goal.milestones.length > 0) {
          goal.progress = Math.round((completedCount / goal.milestones.length) * 100);
        }
        goal.updatedAt = Date.now();

        await redis.set(`goals:${goalId}`, JSON.stringify(goal));

        return {
          success: true,
          milestoneTitle: milestone.title,
          goalProgress: goal.progress,
          milestonesCompleted: completedCount,
          milestonesTotal: goal.milestones.length,
        };
      }

      // ── COMPLETE GOAL ─────────────────────────────────────────────────────────
      case "complete_goal": {
        const goalId = String(args.goalId ?? "");
        const raw = await redis.get(`goals:${goalId}`) as string | null;
        if (!raw) return { error: `Goal not found: ${goalId}` };

        const goal = JSON.parse(raw) as Goal;
        goal.status = "completed";
        goal.progress = 100;
        goal.completedAt = Date.now();
        goal.updatedAt = Date.now();

        await redis.set(`goals:${goalId}`, JSON.stringify(goal));

        if (goal.telegramChatId) {
          await sendProactiveTelegramMessage(
            env,
            goal.telegramChatId,
            `🏆 <b>Goal Completed!</b>\n\n` +
            `<b>${goal.title}</b> is done!\n\n` +
            `Completed in ${Math.round((goal.completedAt - goal.createdAt) / (1000 * 60 * 60 * 24))} days.`
          );
        }

        return { success: true, goalId, title: goal.title, status: "completed" };
      }

      // ── DELETE GOAL ───────────────────────────────────────────────────────────
      case "delete_goal": {
        const goalId = String(args.goalId ?? "");
        await redis.del(`goals:${goalId}`);
        await redis.srem("goals:index", goalId);
        return { success: true, deleted: goalId };
      }

      // ── CHECK ALL — review goals & suggest actions ────────────────────────────
      case "check_all": {
        const goalIds = await redis.smembers("goals:index") as string[];
        const goals = await Promise.all(
          goalIds.map(async (id) => {
            const raw = await redis.get(`goals:${id}`) as string | null;
            return raw ? (JSON.parse(raw) as Goal) : null;
          })
        );

        const active = goals.filter((g): g is Goal => g?.status === "active");
        const stalled = active.filter(
          (g) => Date.now() - g.updatedAt > 7 * 24 * 60 * 60 * 1000 // 7 days no update
        );
        const critical = active.filter((g) => g.priority === "critical");
        const nearComplete = active.filter((g) => g.progress >= 75 && g.progress < 100);

        return {
          summary: {
            total: goals.filter(Boolean).length,
            active: active.length,
            stalled: stalled.length,
            critical: critical.length,
            nearComplete: nearComplete.length,
          },
          stalledGoals: stalled.map((g) => ({
            id: g.id,
            title: g.title,
            progress: g.progress,
            daysSinceUpdate: Math.round((Date.now() - g.updatedAt) / (1000 * 60 * 60 * 24)),
            nextAction: g.nextAction,
          })),
          criticalGoals: critical.map((g) => ({
            id: g.id,
            title: g.title,
            progress: g.progress,
            nextAction: g.nextAction,
          })),
          nearCompleteGoals: nearComplete.map((g) => ({
            id: g.id,
            title: g.title,
            progress: g.progress,
          })),
          recommendation: stalled.length > 0
            ? `${stalled.length} goal(s) are stalled. Consider spawning sub-agents to make autonomous progress.`
            : critical.length > 0
            ? `${critical.length} critical goal(s) need attention. Prioritize these now.`
            : "Goals are progressing well! Consider updating progress for near-complete goals.",
        };
      }

      default:
        return { error: `Unknown goal action: ${action}` };
    }
  } catch (err) {
    return { error: `Goal management failed: ${String(err)}` };
  }
}

// ─── PROACTIVE TELEGRAM PUSH ──────────────────────────────────────────────────

/**
 * Send a message to a Telegram chat WITHOUT a user prompt.
 * Called by cron jobs, price alerts, goal milestones, error spikes, etc.
 * VEGA initiates the conversation.
 */
export async function sendProactiveTelegramMessage(
  env: Env,
  chatId: string | number,
  message: string
): Promise<boolean> {
  try {
    const { getRedis } = await import("../memory");
    const redis = getRedis(env);
    const configRaw = await redis.get("tg:config") as string | null;
    if (!configRaw) return false;

    const config = JSON.parse(configRaw) as { token: string };
    if (!config.token) return false;

    // Truncate message to Telegram limit
    const text = message.slice(0, 4096);

    const res = await fetch(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );

    const result = await res.json() as { ok: boolean };
    return result.ok;
  } catch (err) {
    console.error("[sendProactiveTelegramMessage] Failed:", err);
    return false;
  }
}

// ── Tool executor wrapper ─────────────────────────────────────────────────────
export async function execProactiveNotify(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const chatId = String(args.chatId ?? "");
  const message = String(args.message ?? "");

  if (!chatId || !message) {
    return { error: "chatId and message are required" };
  }

  const success = await sendProactiveTelegramMessage(env, chatId, message);
  return {
    success,
    chatId,
    messageLength: message.length,
    note: success
      ? "Message sent successfully to Telegram."
      : "Failed to send. Check that Telegram bot is configured (POST /telegram/setup).",
  };
}

// ── Check all goals at cron tick ──────────────────────────────────────────────
export async function checkGoalsAtCron(env: Env): Promise<void> {
  const { getRedis } = await import("../memory");
  const redis = getRedis(env);

  const goalIds = await redis.smembers("goals:index") as string[];
  for (const goalId of goalIds) {
    try {
      const raw = await redis.get(`goals:${goalId}`) as string | null;
      if (!raw) continue;

      const goal = JSON.parse(raw) as Goal;
      if (goal.status !== "active") continue;

      // Check for stalled high-priority goals (no update in 3 days for critical)
      const stalledThresholdMs =
        goal.priority === "critical"
          ? 3 * 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;

      const isStalled = Date.now() - goal.updatedAt > stalledThresholdMs;

      if (isStalled && goal.telegramChatId && goal.priority !== "low") {
        await sendProactiveTelegramMessage(
          env,
          goal.telegramChatId,
          `⚠️ <b>Stalled Goal Alert</b>\n\n` +
          `Your ${goal.priority} priority goal has not progressed:\n` +
          `<b>"${goal.title}"</b>\n` +
          `Progress: ${goal.progress}%\n\n` +
          (goal.nextAction ? `📋 Next action: ${goal.nextAction}` : "No next action defined.")
        );

        // Update so we don't spam — mark last notified
        goal.updatedAt = Date.now() - stalledThresholdMs + (24 * 60 * 60 * 1000);
        await redis.set(`goals:${goalId}`, JSON.stringify(goal));
      }
    } catch (e) {
      console.error(`[checkGoalsAtCron] Error for ${goalId}:`, e);
    }
  }
}

// ─── Goal-aware session starter ───────────────────────────────────────────────
/**
 * Called at the beginning of every runAgent() call.
 * Returns a brief goals context summary to prepend to the system prompt.
 * This makes VEGA goal-aware in every session automatically.
 */
export async function getGoalsContext(env: Env): Promise<string> {
  try {
    const { getRedis } = await import("../memory");
    const redis = getRedis(env);
    const goalIds = await redis.smembers("goals:index") as string[];
    if (!goalIds.length) return "";

    const goals = await Promise.all(
      goalIds.map(async (id) => {
        const raw = await redis.get(`goals:${id}`) as string | null;
        return raw ? (JSON.parse(raw) as Goal) : null;
      })
    );

    const active = goals.filter((g): g is Goal => g?.status === "active");
    if (!active.length) return "";

    const criticalOrHigh = active
      .filter((g) => g.priority === "critical" || g.priority === "high")
      .slice(0, 3);

    if (!criticalOrHigh.length) return "";

    const lines = criticalOrHigh.map(
      (g) => `• "${g.title}" — ${g.progress}% complete${g.nextAction ? ` | Next: ${g.nextAction}` : ""}`
    );

    return `\n\n━━ ACTIVE HIGH-PRIORITY GOALS ━━\n${lines.join("\n")}\n(Autonomously advance these goals when relevant. Use update_progress to log milestones.)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  } catch {
    return "";
  }
}