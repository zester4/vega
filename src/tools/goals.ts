/**
 * ============================================================================
 * src/tools/goals.ts — VEGA Goal System (Production Rewrite)
 * ============================================================================
 *
 * What changed from the original:
 *   - Full userId scoping: goals:user:{userId}:{goalId} — no shared state
 *   - Deadline field: goals feel real and create urgency
 *   - Progress history: timestamped log of every update — VEGA shows trajectory
 *   - Autonomous advancement: stalled goals with a nextAction → VEGA spawns
 *     a sub-agent to actually do the work, not just suggest it
 *   - lastNotifiedAt: proper spam prevention, separate from updatedAt
 *   - Dependency support: a goal can depend on other goals completing first
 *   - Goal velocity: how fast is progress moving? used in check_all
 *   - Fixed proactive_notify: reads per-user D1 Telegram config, not a
 *     broken global Redis key that never existed
 *   - Fixed getGoalsContext: user-scoped, never leaks cross-user data
 *
 * Redis key schema (all per-user):
 *   goals:user:{userId}:{goalId}  → Goal JSON
 *   goals:user:{userId}:index     → Set of goalIds
 *
 * ============================================================================
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoalMilestone {
  id: string;
  title: string;
  completed: boolean;
  completedAt?: number;
  notes?: string;
  dependsOn?: string[]; // milestone IDs that must complete first
}

export interface ProgressEntry {
  timestamp: number;
  progress: number;
  note?: string;
  triggeredBy: "user" | "agent" | "sub_agent" | "cron";
}

export interface Goal {
  id: string;
  userId: string;              // always set — no cross-user leakage
  title: string;
  description: string;
  category: "business" | "research" | "personal" | "monitoring" | "custom";
  milestones: GoalMilestone[];
  dependsOn?: string[];        // goalIds that must complete before this one starts
  progress: number;            // 0-100
  progressHistory: ProgressEntry[]; // full audit trail
  status: "active" | "completed" | "paused" | "cancelled" | "blocked";
  priority: "low" | "medium" | "high" | "critical";
  deadline?: string;           // ISO date string — e.g. "2025-06-01"
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  nextAction?: string;         // concrete next step — VEGA acts on this autonomously
  autoAdvance: boolean;        // if true, VEGA spawns sub-agent when stalled
  notifyOnProgress: boolean;
  telegramChatId?: string;
  lastNotifiedAt?: number;     // separate from updatedAt — prevents notification spam
  advancingAgentId?: string;   // set when a sub-agent is actively working this goal
}

// ─── Redis Key Helpers ────────────────────────────────────────────────────────

const GOAL_KEY = (userId: string, goalId: string) =>
  `goals:user:${userId}:${goalId}`;

const GOAL_INDEX_KEY = (userId: string) =>
  `goals:user:${userId}:index`;

const GOAL_TTL = 60 * 60 * 24 * 365; // 1 year

// ─── Internal Helpers ─────────────────────────────────────────────────────────

async function loadGoal(
  redis: any,
  userId: string,
  goalId: string
): Promise<Goal | null> {
  try {
    const raw = await redis.get(GOAL_KEY(userId, goalId));
    if (!raw) return null;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as Goal;
  } catch {
    return null;
  }
}

async function saveGoal(redis: any, goal: Goal): Promise<void> {
  goal.updatedAt = Date.now();
  await redis.set(GOAL_KEY(goal.userId, goal.id), JSON.stringify(goal), {
    ex: GOAL_TTL,
  });
  await redis.sadd(GOAL_INDEX_KEY(goal.userId), goal.id);
}

async function loadAllGoals(redis: any, userId: string): Promise<Goal[]> {
  const ids = (await redis.smembers(GOAL_INDEX_KEY(userId))) as string[];
  if (!ids.length) return [];
  const goals = await Promise.all(ids.map((id) => loadGoal(redis, userId, id)));
  return goals.filter((g): g is Goal => g !== null);
}

/**
 * Calculate goal velocity: average progress-per-day over the last 7 days.
 * Returns null if not enough history.
 */
function calculateVelocity(goal: Goal): number | null {
  if (goal.progressHistory.length < 2) return null;
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = goal.progressHistory.filter((e) => e.timestamp > week);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const daysDiff = (last.timestamp - first.timestamp) / (1000 * 60 * 60 * 24);
  if (daysDiff < 0.1) return null;
  return (last.progress - first.progress) / daysDiff;
}

/**
 * Days remaining until deadline. Null if no deadline.
 * Negative = overdue.
 */
function daysUntilDeadline(goal: Goal): number | null {
  if (!goal.deadline) return null;
  const deadline = new Date(goal.deadline).getTime();
  return (deadline - Date.now()) / (1000 * 60 * 60 * 24);
}

/**
 * Deadline urgency label for notifications.
 */
function urgencyLabel(daysLeft: number): string {
  if (daysLeft < 0) return `⛔ OVERDUE by ${Math.abs(Math.round(daysLeft))} days`;
  if (daysLeft < 1) return "🔴 Due TODAY";
  if (daysLeft < 3) return `🟠 Due in ${Math.round(daysLeft)} days`;
  if (daysLeft < 7) return `🟡 Due in ${Math.round(daysLeft)} days`;
  return `🟢 Due in ${Math.round(daysLeft)} days`;
}

// ─── Proactive Telegram Notify (FIXED) ───────────────────────────────────────
/**
 * Send a Telegram message to a user by their userId.
 * Uses D1 per-user config — NOT the broken global Redis key.
 */
export async function sendProactiveTelegramMessage(
  env: Env,
  chatId: string | number,
  message: string,
  userId?: string
): Promise<boolean> {
  try {
    let botToken: string | null = null;

    // Primary: per-user D1 config
    if (userId && env.DB) {
      const { getTelegramConfigByUserId } = await import("../telegram");
      const config = await getTelegramConfigByUserId(env, userId);
      if (config?.token) botToken = config.token;
    }

    // Fallback: global Redis token
    if (!botToken) {
      const { getRedis } = await import("../memory");
      const redis = getRedis(env);
      const raw = await redis.get("tg:fallback-token") as string | null;
      if (raw) botToken = raw;
    }

    if (!botToken) {
      console.warn("[proactive_notify] No Telegram bot token found for user:", userId);
      return false;
    }

    // ── Media detection ────────────────────────────────────────────────────
    // Match any URL pointing to /files/<r2-key> with a media extension
    const MEDIA_REGEX = /https?:\/\/[^\s)<>"]+\/files\/([^\s)<>"]+\.(?:png|jpg|jpeg|gif|webp|wav|mp3|ogg|mp4))/gi;
    const AUDIO_EXTS = new Set([".wav", ".mp3", ".ogg"]);
    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4"]);

    const audioKeys: string[] = [];
    const imageKeys: string[] = [];
    const allUrls: string[] = [];

    let match;
    while ((match = MEDIA_REGEX.exec(message)) !== null) {
      const r2Key = decodeURIComponent(match[1]);
      const url = match[0];
      const ext = r2Key.slice(r2Key.lastIndexOf(".")).toLowerCase();

      allUrls.push(url);
      if (AUDIO_EXTS.has(ext)) audioKeys.push(r2Key);
      else if (IMAGE_EXTS.has(ext)) imageKeys.push(r2Key);
    }

    // Strip all media URLs + their markdown containers from the text
    let cleanMessage = message;
    for (const url of allUrls) {
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      cleanMessage = cleanMessage
        .replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, "gi"), "")  // ![alt](url)
        .replace(new RegExp(`\\[[^\\]]*\\]\\(${escaped}\\)`, "gi"), "")   // [text](url)
        .replace(new RegExp(escaped, "gi"), "");                           // bare url
    }
    cleanMessage = cleanMessage.replace(/\n{3,}/g, "\n\n").trim();

    const text = cleanMessage.slice(0, 4096);

    // ── 1. Send text (if anything left after stripping media) ──────────────
    if (text) {
      const textRes = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
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
      const textResult = await textRes.json() as { ok: boolean; description?: string };
      if (!textResult.ok) {
        console.error("[proactive_notify] Text send failed:", textResult.description);
        // Try without HTML parse mode
        const plainRes = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text }),
          }
        );
        const plainResult = await plainRes.json() as { ok: boolean };
        if (!plainResult.ok) return false;
      }
    }

    // ── 2. Send audio files directly from R2 ──────────────────────────────
    for (const r2Key of audioKeys) {
      try {
        const bucket = (env as unknown as { FILES_BUCKET?: R2Bucket }).FILES_BUCKET;
        if (!bucket) {
          console.warn("[proactive_notify] FILES_BUCKET not bound, cannot send audio");
          break;
        }
        const obj = await bucket.get(r2Key);
        if (!obj) {
          console.warn("[proactive_notify] Audio not found in R2:", r2Key);
          continue;
        }

        const audioBytes = new Uint8Array(await obj.arrayBuffer());
        const ext = r2Key.slice(r2Key.lastIndexOf(".") + 1).toLowerCase();
        const mime = ext === "mp3" ? "audio/mpeg"
          : ext === "ogg" ? "audio/ogg"
            : "audio/wav";
        const filename = r2Key.split("/").pop() ?? "voice.wav";

        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("voice", new Blob([audioBytes], { type: mime }), filename);

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
          method: "POST",
          body: form,
        });
        const result = await res.json() as { ok: boolean; description?: string };
        if (!result.ok) {
          console.warn("[proactive_notify] sendVoice failed:", result.description);
        }
      } catch (e) {
        console.error("[proactive_notify] Audio send failed:", r2Key, String(e));
      }
    }

    // ── 3. Send image files directly from R2 ──────────────────────────────
    for (const r2Key of imageKeys) {
      try {
        const bucket = (env as unknown as { FILES_BUCKET?: R2Bucket }).FILES_BUCKET;
        if (!bucket) {
          console.warn("[proactive_notify] FILES_BUCKET not bound, cannot send image");
          break;
        }
        const obj = await bucket.get(r2Key);
        if (!obj) {
          console.warn("[proactive_notify] Image not found in R2:", r2Key);
          continue;
        }

        const imageBytes = new Uint8Array(await obj.arrayBuffer());
        const ext = r2Key.slice(r2Key.lastIndexOf(".") + 1).toLowerCase();
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
          : ext === "gif" ? "image/gif"
            : ext === "webp" ? "image/webp"
              : "image/png";
        const filename = r2Key.split("/").pop() ?? `image.${ext}`;

        // Telegram's sendPhoto has a 10MB limit — use sendDocument for larger files
        const form = new FormData();
        form.append("chat_id", String(chatId));
        const method = imageBytes.length > 10 * 1024 * 1024 ? "sendDocument" : "sendPhoto";
        form.append(method === "sendPhoto" ? "photo" : "document", new Blob([imageBytes], { type: mime }), filename);

        const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
          method: "POST",
          body: form,
        });
        const result = await res.json() as { ok: boolean; description?: string };
        if (!result.ok) {
          console.warn(`[proactive_notify] ${method} failed:`, result.description);
        }
      } catch (e) {
        console.error("[proactive_notify] Image send failed:", r2Key, String(e));
      }
    }

    return true;
  } catch (err) {
    console.error("[sendProactiveTelegramMessage] Failed:", err);
    return false;
  }
}

// ─── Autonomous Advancement ───────────────────────────────────────────────────
/**
 * Spawn a sub-agent to autonomously advance a stalled goal.
 * Only fires when:
 *   - goal.autoAdvance = true
 *   - goal has a nextAction defined
 *   - no agent is already working this goal (advancingAgentId not set or errored)
 *   - goal has been stalled for the threshold period
 */
async function advanceGoalAutonomously(
  env: Env,
  goal: Goal,
  sessionId: string
): Promise<string | null> {
  if (!goal.autoAdvance || !goal.nextAction) return null;

  // Don't spawn if an agent is already running for this goal
  if (goal.advancingAgentId) {
    const { getRedis, getTask } = await import("../memory");
    const redis = getRedis(env);
    const task = await getTask(redis, goal.advancingAgentId);
    if (task && task.status === "running") {
      return goal.advancingAgentId; // already being worked
    }
    // Previous agent finished or errored — allow new one
  }

  const daysLeft = daysUntilDeadline(goal);
  const deadlineContext = daysLeft !== null
    ? ` Deadline: ${urgencyLabel(daysLeft)}.`
    : "";

  const instructions =
    `You are working on a goal autonomously on behalf of the user.\n\n` +
    `GOAL: "${goal.title}"\n` +
    `Description: ${goal.description}\n` +
    `Current progress: ${goal.progress}%\n` +
    `Priority: ${goal.priority}\n` +
    `Your specific task: ${goal.nextAction}${deadlineContext}\n\n` +
    `Complete this task using whatever tools you need. ` +
    `When done, use update_progress to log your results and advance the goal percentage. ` +
    `Use proactive_notify to inform the user of what you accomplished.`;

  try {
    const { executeTool } = await import("./builtins");
    const result = await executeTool(
      "spawn_agent",
      {
        agentName: `goal-${goal.id}-advance`,
        instructions,
        priority: goal.priority === "critical" ? "high" : "medium",
        memoryPrefix: `goal:${goal.id}`,
        parentSessionId: sessionId,
      },
      env,
      sessionId
    );

    const agentId = (result as any).agentId as string | undefined;
    if (agentId) {
      goal.advancingAgentId = agentId;
      const { getRedis } = await import("../memory");
      await saveGoal(getRedis(env), goal);
      return agentId;
    }
  } catch (e) {
    console.error("[goal advance] Sub-agent spawn failed:", e);
  }
  return null;
}

// ─── Main Goal Tool Executor ──────────────────────────────────────────────────

export async function execManageGoals(
  args: Record<string, unknown>,
  env: Env,
  userId?: string
): Promise<Record<string, unknown>> {
  if (!userId) {
    return { error: "Goals require authentication. userId not found in session." };
  }

  const action = String(args.action ?? "list_goals");
  const { getRedis } = await import("../memory");
  const redis = getRedis(env);

  try {
    switch (action) {

      // ── CREATE GOAL ──────────────────────────────────────────────────────────
      case "create_goal": {
        const title = String(args.title ?? "").trim();
        if (!title) return { error: "title is required" };

        const goalId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const milestoneList = (args.milestones as string[] | undefined) ?? [];

        // Validate deadline
        let deadline: string | undefined;
        if (args.deadline) {
          const d = new Date(String(args.deadline));
          if (isNaN(d.getTime())) return { error: "Invalid deadline format. Use ISO date: 2025-06-01" };
          deadline = d.toISOString().split("T")[0]; // normalize to YYYY-MM-DD
        }

        // Validate dependencies
        const dependsOn = (args.dependsOn as string[] | undefined) ?? [];
        if (dependsOn.length > 0) {
          for (const depId of dependsOn) {
            const dep = await loadGoal(redis, userId, depId);
            if (!dep) return { error: `Dependency goal not found: ${depId}` };
          }
        }

        const now = Date.now();
        const goal: Goal = {
          id: goalId,
          userId,
          title,
          description: String(args.description ?? ""),
          category: (args.category as Goal["category"]) ?? "custom",
          milestones: milestoneList.map((m, i) => ({
            id: `m-${i}-${Date.now()}`,
            title: m,
            completed: false,
          })),
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          progress: 0,
          progressHistory: [{
            timestamp: now,
            progress: 0,
            note: "Goal created",
            triggeredBy: "user",
          }],
          status: dependsOn.length > 0 ? "blocked" : "active",
          priority: (args.priority as Goal["priority"]) ?? "medium",
          deadline,
          createdAt: now,
          updatedAt: now,
          nextAction: args.nextAction as string | undefined,
          autoAdvance: Boolean(args.autoAdvance ?? false),
          notifyOnProgress: Boolean(args.notifyOnProgress ?? true),
          telegramChatId: args.telegramChatId as string | undefined,
        };

        await saveGoal(redis, goal);

        const daysLeft = daysUntilDeadline(goal);

        return {
          success: true,
          goalId,
          title,
          priority: goal.priority,
          deadline: deadline ?? null,
          daysUntilDeadline: daysLeft !== null ? Math.round(daysLeft) : null,
          status: goal.status,
          autoAdvance: goal.autoAdvance,
          message: `✅ Goal created: "${title}"${deadline ? ` | Due: ${deadline}` : ""}${goal.status === "blocked" ? " | Status: blocked (waiting on dependencies)" : ""}`,
        };
      }

      // ── UPDATE PROGRESS ──────────────────────────────────────────────────────
      case "update_progress": {
        const goalId = String(args.goalId ?? "");
        const newProgress = Math.min(100, Math.max(0, Number(args.progress ?? 0)));
        const note = args.notes as string | undefined;

        const goal = await loadGoal(redis, userId, goalId);
        if (!goal) return { error: `Goal not found: ${goalId}` };
        if (goal.status === "cancelled") return { error: "Cannot update a cancelled goal." };

        const prevProgress = goal.progress;
        goal.progress = newProgress;
        if (note) goal.nextAction = note;

        // Append to progress history
        goal.progressHistory.push({
          timestamp: Date.now(),
          progress: newProgress,
          note,
          triggeredBy: (args._triggeredBy as ProgressEntry["triggeredBy"]) ?? "agent",
        });

        // Keep history to last 100 entries
        if (goal.progressHistory.length > 100) {
          goal.progressHistory = goal.progressHistory.slice(-100);
        }

        // Auto-complete when 100%
        if (newProgress >= 100 && goal.status === "active") {
          goal.status = "completed";
          goal.completedAt = Date.now();
          goal.advancingAgentId = undefined;

          // Unblock any goals that depended on this one
          const allGoals = await loadAllGoals(redis, userId);
          for (const g of allGoals) {
            if (g.status === "blocked" && g.dependsOn?.includes(goalId)) {
              const allDepsComplete = (g.dependsOn ?? []).every(async (depId) => {
                const dep = await loadGoal(redis, userId, depId);
                return dep?.status === "completed";
              });
              // async check resolved below
              const depsStatus = await Promise.all(
                (g.dependsOn ?? []).map(async (depId) => {
                  const dep = await loadGoal(redis, userId, depId);
                  return dep?.status === "completed";
                })
              );
              if (depsStatus.every(Boolean)) {
                g.status = "active";
                await saveGoal(redis, g);
              }
            }
          }
        }

        await saveGoal(redis, goal);

        // Milestone notifications (25/50/75/100)
        const milestoneThresholds = [25, 50, 75, 100];
        const hitMilestone = milestoneThresholds.find(
          (t) => prevProgress < t && newProgress >= t
        );

        const daysLeft = daysUntilDeadline(goal);
        const velocity = calculateVelocity(goal);

        if (hitMilestone && goal.telegramChatId && goal.notifyOnProgress) {
          const emoji = hitMilestone === 100 ? "🎉" : "🎯";
          const velocityLine = velocity !== null
            ? `\n📈 Velocity: +${velocity.toFixed(1)}% per day`
            : "";
          const deadlineLine = daysLeft !== null
            ? `\n${urgencyLabel(daysLeft)}`
            : "";

          await sendProactiveTelegramMessage(
            env,
            goal.telegramChatId,
            `${emoji} <b>Goal Milestone Hit</b>\n\n` +
            `<b>${goal.title}</b>\n` +
            `Progress: <b>${newProgress}%</b>${hitMilestone === 100 ? " — COMPLETE! 🏆" : ""}` +
            (note ? `\n📝 ${note}` : "") +
            velocityLine +
            deadlineLine,
            userId
          );
          goal.lastNotifiedAt = Date.now();
          await saveGoal(redis, goal);
        }

        return {
          success: true,
          goalId,
          progress: newProgress,
          previousProgress: prevProgress,
          delta: newProgress - prevProgress,
          status: goal.status,
          milestoneHit: hitMilestone ?? null,
          velocity: velocity !== null ? `${velocity.toFixed(1)}%/day` : null,
          daysUntilDeadline: daysLeft !== null ? Math.round(daysLeft) : null,
          message: newProgress >= 100
            ? `🎉 Goal "${goal.title}" completed!`
            : `Progress updated: ${prevProgress}% → ${newProgress}%`,
        };
      }

      // ── LIST GOALS ───────────────────────────────────────────────────────────
      case "list_goals": {
        const statusFilter = args.status as string | undefined;
        let goals = await loadAllGoals(redis, userId);

        if (statusFilter) goals = goals.filter((g) => g.status === statusFilter);

        // Sort: critical first, then by deadline urgency, then progress
        goals.sort((a, b) => {
          const pOrder = { critical: 0, high: 1, medium: 2, low: 3 };
          const pDiff = pOrder[a.priority] - pOrder[b.priority];
          if (pDiff !== 0) return pDiff;
          const aDays = daysUntilDeadline(a) ?? 9999;
          const bDays = daysUntilDeadline(b) ?? 9999;
          return aDays - bDays;
        });

        return {
          goals: goals.map((g) => {
            const daysLeft = daysUntilDeadline(g);
            const velocity = calculateVelocity(g);
            const completedMilestones = g.milestones.filter((m) => m.completed).length;
            return {
              id: g.id,
              title: g.title,
              category: g.category,
              priority: g.priority,
              progress: g.progress,
              status: g.status,
              deadline: g.deadline ?? null,
              daysUntilDeadline: daysLeft !== null ? Math.round(daysLeft) : null,
              urgency: daysLeft !== null ? urgencyLabel(daysLeft) : null,
              velocity: velocity !== null ? `${velocity.toFixed(1)}%/day` : null,
              milestones: `${completedMilestones}/${g.milestones.length}`,
              nextAction: g.nextAction ?? null,
              autoAdvance: g.autoAdvance,
              advancingAgentId: g.advancingAgentId ?? null,
              updatedAt: new Date(g.updatedAt).toISOString(),
            };
          }),
          count: goals.length,
          activeCount: goals.filter((g) => g.status === "active").length,
          completedCount: goals.filter((g) => g.status === "completed").length,
          blockedCount: goals.filter((g) => g.status === "blocked").length,
          overdueCount: goals.filter((g) => {
            const d = daysUntilDeadline(g);
            return d !== null && d < 0 && g.status === "active";
          }).length,
        };
      }

      // ── GET GOAL ─────────────────────────────────────────────────────────────
      case "get_goal": {
        const goalId = String(args.goalId ?? "");
        const goal = await loadGoal(redis, userId, goalId);
        if (!goal) return { error: `Goal not found: ${goalId}` };

        const daysLeft = daysUntilDeadline(goal);
        const velocity = calculateVelocity(goal);

        // Projected completion date based on velocity
        let projectedCompletion: string | null = null;
        if (velocity && velocity > 0 && goal.progress < 100) {
          const daysToComplete = (100 - goal.progress) / velocity;
          const projected = new Date(Date.now() + daysToComplete * 24 * 60 * 60 * 1000);
          projectedCompletion = projected.toISOString().split("T")[0];
        }

        return {
          goal: {
            ...goal,
            daysUntilDeadline: daysLeft !== null ? Math.round(daysLeft) : null,
            urgency: daysLeft !== null ? urgencyLabel(daysLeft) : null,
            velocity: velocity !== null ? `${velocity.toFixed(1)}%/day` : null,
            projectedCompletion,
            recentHistory: goal.progressHistory.slice(-10),
          },
        };
      }

      // ── ADD MILESTONE ────────────────────────────────────────────────────────
      case "add_milestone": {
        const goalId = String(args.goalId ?? "");
        const milestoneTitle = String(args.title ?? "").trim();
        if (!milestoneTitle) return { error: "Milestone title is required" };

        const goal = await loadGoal(redis, userId, goalId);
        if (!goal) return { error: `Goal not found: ${goalId}` };

        const milestone: GoalMilestone = {
          id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          title: milestoneTitle,
          completed: false,
          dependsOn: (args.dependsOn as string[] | undefined),
        };

        goal.milestones.push(milestone);
        await saveGoal(redis, goal);

        return { success: true, goalId, milestone };
      }

      // ── COMPLETE MILESTONE ───────────────────────────────────────────────────
      case "complete_milestone": {
        const goalId = String(args.goalId ?? "");
        const milestoneId = String(args.milestoneId ?? "");
        const notes = args.notes as string | undefined;

        const goal = await loadGoal(redis, userId, goalId);
        if (!goal) return { error: `Goal not found: ${goalId}` };

        const milestone = goal.milestones.find((m) => m.id === milestoneId);
        if (!milestone) return { error: `Milestone not found: ${milestoneId}` };

        // Check milestone dependencies
        if (milestone.dependsOn?.length) {
          const blockers = milestone.dependsOn.filter(
            (depId) => !goal.milestones.find((m) => m.id === depId)?.completed
          );
          if (blockers.length > 0) {
            const blockerNames = blockers.map(
              (id) => goal.milestones.find((m) => m.id === id)?.title ?? id
            );
            return { error: `Complete these milestones first: ${blockerNames.join(", ")}` };
          }
        }

        milestone.completed = true;
        milestone.completedAt = Date.now();
        if (notes) milestone.notes = notes;

        // Auto-calculate progress from milestone completion ratio
        const totalMilestones = goal.milestones.length;
        if (totalMilestones > 0) {
          const completedCount = goal.milestones.filter((m) => m.completed).length;
          const milestoneProgress = Math.round((completedCount / totalMilestones) * 100);
          if (milestoneProgress > goal.progress) {
            goal.progress = milestoneProgress;
            goal.progressHistory.push({
              timestamp: Date.now(),
              progress: milestoneProgress,
              note: `Milestone completed: ${milestone.title}`,
              triggeredBy: "agent",
            });
          }
        }

        await saveGoal(redis, goal);

        return {
          success: true,
          milestoneId,
          milestoneTitle: milestone.title,
          goalProgress: goal.progress,
          milestonesCompleted: goal.milestones.filter((m) => m.completed).length,
          milestonesTotal: goal.milestones.length,
        };
      }

      // ── COMPLETE GOAL ────────────────────────────────────────────────────────
      case "complete_goal": {
        const goalId = String(args.goalId ?? "");
        const goal = await loadGoal(redis, userId, goalId);
        if (!goal) return { error: `Goal not found: ${goalId}` };

        goal.status = "completed";
        goal.progress = 100;
        goal.completedAt = Date.now();
        goal.advancingAgentId = undefined;
        goal.progressHistory.push({
          timestamp: Date.now(),
          progress: 100,
          note: args.notes as string | undefined ?? "Goal marked complete",
          triggeredBy: "user",
        });

        await saveGoal(redis, goal);

        const totalDays = Math.round((Date.now() - goal.createdAt) / (1000 * 60 * 60 * 24));

        if (goal.telegramChatId && goal.notifyOnProgress) {
          await sendProactiveTelegramMessage(
            env,
            goal.telegramChatId,
            `🏆 <b>Goal Achieved!</b>\n\n<b>${goal.title}</b>\n\nCompleted in ${totalDays} days. Well done!`,
            userId
          );
        }

        return {
          success: true,
          goalId,
          title: goal.title,
          completedInDays: totalDays,
          message: `🏆 Goal "${goal.title}" completed in ${totalDays} days.`,
        };
      }

      // ── PAUSE / RESUME GOAL ──────────────────────────────────────────────────
      case "pause_goal": {
        const goalId = String(args.goalId ?? "");
        const goal = await loadGoal(redis, userId, goalId);
        if (!goal) return { error: `Goal not found: ${goalId}` };
        goal.status = "paused";
        await saveGoal(redis, goal);
        return { success: true, goalId, status: "paused" };
      }

      case "resume_goal": {
        const goalId = String(args.goalId ?? "");
        const goal = await loadGoal(redis, userId, goalId);
        if (!goal) return { error: `Goal not found: ${goalId}` };
        if (goal.status !== "paused") return { error: "Goal is not paused." };
        goal.status = "active";
        await saveGoal(redis, goal);
        return { success: true, goalId, status: "active" };
      }

      // ── DELETE GOAL ──────────────────────────────────────────────────────────
      case "delete_goal": {
        const goalId = String(args.goalId ?? "");
        await redis.del(GOAL_KEY(userId, goalId));
        await redis.srem(GOAL_INDEX_KEY(userId), goalId);
        return { success: true, deleted: goalId };
      }

      // ── CHECK ALL — the intelligence layer ───────────────────────────────────
      case "check_all": {
        const goals = await loadAllGoals(redis, userId);
        const active = goals.filter((g) => g.status === "active");
        const now = Date.now();

        // Categorize
        const stalled = active.filter((g) => {
          const threshold =
            g.priority === "critical"
              ? 2 * 24 * 60 * 60 * 1000  // 2 days
              : g.priority === "high"
                ? 4 * 24 * 60 * 60 * 1000  // 4 days
                : 7 * 24 * 60 * 60 * 1000; // 7 days
          return now - g.updatedAt > threshold;
        });

        const overdue = active.filter((g) => {
          const d = daysUntilDeadline(g);
          return d !== null && d < 0;
        });

        const dueSoon = active.filter((g) => {
          const d = daysUntilDeadline(g);
          return d !== null && d >= 0 && d <= 3;
        });

        const critical = active.filter((g) => g.priority === "critical");
        const nearComplete = active.filter((g) => g.progress >= 75 && g.progress < 100);

        // Autonomous advancement: for stalled goals with autoAdvance + nextAction
        // Use a synthetic session ID for cron-initiated actions
        const cronSessionId = `cron-goals-${userId}-${Date.now()}`;
        const { getRedis: gr } = await import("../memory");
        const r = gr(env);
        await r.set(`session:user-map:${cronSessionId}`, userId, { ex: 60 * 60 * 2 });

        const autoAdvanced: string[] = [];
        for (const g of stalled) {
          if (g.autoAdvance && g.nextAction && !g.advancingAgentId) {
            const agentId = await advanceGoalAutonomously(env, g, cronSessionId);
            if (agentId) autoAdvanced.push(`"${g.title}" → agent ${agentId}`);
          }
        }

        return {
          summary: {
            total: goals.length,
            active: active.length,
            stalled: stalled.length,
            overdue: overdue.length,
            dueSoon: dueSoon.length,
            critical: critical.length,
            nearComplete: nearComplete.length,
            blocked: goals.filter((g) => g.status === "blocked").length,
            completed: goals.filter((g) => g.status === "completed").length,
          },
          overdueGoals: overdue.map((g) => ({
            id: g.id,
            title: g.title,
            progress: g.progress,
            deadline: g.deadline,
            daysOverdue: Math.abs(Math.round(daysUntilDeadline(g)!)),
            nextAction: g.nextAction,
          })),
          dueSoonGoals: dueSoon.map((g) => ({
            id: g.id,
            title: g.title,
            progress: g.progress,
            deadline: g.deadline,
            daysLeft: Math.round(daysUntilDeadline(g)!),
            velocity: calculateVelocity(g),
          })),
          stalledGoals: stalled.map((g) => ({
            id: g.id,
            title: g.title,
            progress: g.progress,
            daysSinceUpdate: Math.round((now - g.updatedAt) / (1000 * 60 * 60 * 24)),
            nextAction: g.nextAction,
            autoAdvance: g.autoAdvance,
            advancingAgentId: g.advancingAgentId ?? null,
          })),
          criticalGoals: critical.map((g) => ({
            id: g.id,
            title: g.title,
            progress: g.progress,
            deadline: g.deadline,
            nextAction: g.nextAction,
          })),
          autoAdvanced: autoAdvanced.length > 0 ? autoAdvanced : undefined,
          recommendation:
            overdue.length > 0
              ? `🚨 ${overdue.length} goal(s) are OVERDUE. Prioritize immediately.`
              : dueSoon.length > 0
                ? `⏰ ${dueSoon.length} goal(s) due within 3 days. Focus now.`
                : stalled.length > 0
                  ? `⚠️ ${stalled.length} goal(s) stalled.${autoAdvanced.length > 0 ? ` Auto-advanced ${autoAdvanced.length}.` : " Consider spawning agents."}`
                  : nearComplete.length > 0
                    ? `💪 ${nearComplete.length} goal(s) near completion. Push to finish.`
                    : "✅ All goals progressing well.",
        };
      }

      // ── GOAL PROGRESS HISTORY ─────────────────────────────────────────────────
      case "get_history": {
        const goalId = String(args.goalId ?? "");
        const goal = await loadGoal(redis, userId, goalId);
        if (!goal) return { error: `Goal not found: ${goalId}` };

        const velocity = calculateVelocity(goal);
        const daysLeft = daysUntilDeadline(goal);
        const daysRunning = Math.round((Date.now() - goal.createdAt) / (1000 * 60 * 60 * 24));

        // Project completion
        let projectedCompletion: string | null = null;
        let onTrack: boolean | null = null;
        if (velocity !== null && velocity > 0 && goal.progress < 100) {
          const daysToFinish = (100 - goal.progress) / velocity;
          const projected = new Date(Date.now() + daysToFinish * 24 * 60 * 60 * 1000);
          projectedCompletion = projected.toISOString().split("T")[0];
          if (daysLeft !== null) {
            onTrack = daysToFinish <= daysLeft;
          }
        }

        return {
          goalId,
          title: goal.title,
          currentProgress: goal.progress,
          daysRunning,
          velocity: velocity !== null ? `${velocity.toFixed(1)}%/day` : "not enough data",
          projectedCompletion,
          onTrack,
          deadline: goal.deadline ?? null,
          history: goal.progressHistory,
          historyCount: goal.progressHistory.length,
        };
      }

      default:
        return { error: `Unknown goal action: ${action}` };
    }
  } catch (err) {
    return { error: `Goal management failed: ${String(err)}` };
  }
}

// ─── Proactive Notify Tool Wrapper ────────────────────────────────────────────

export async function execProactiveNotify(
  args: Record<string, unknown>,
  env: Env,
  userId?: string
): Promise<Record<string, unknown>> {
  const chatId = String(args.chatId ?? "");
  const message = String(args.message ?? "");

  if (!chatId || !message) {
    return { error: "chatId and message are required" };
  }

  const success = await sendProactiveTelegramMessage(env, chatId, message, userId);
  return {
    success,
    chatId,
    messageLength: message.length,
    note: success
      ? "Message delivered to Telegram."
      : "Failed to send. Check that Telegram bot is configured for this user.",
  };
}

// ─── Cron Check (runs every tick) ────────────────────────────────────────────
/**
 * Called from the scheduled() cron handler.
 * Checks ALL users' goals. Per-user scoped.
 * Sends deadline warnings and surfaces stalled goals.
 * Never spams — respects lastNotifiedAt with per-priority cooldowns.
 */
export async function checkGoalsAtCron(env: Env): Promise<void> {
  if (!env.DB) return;

  try {
    // Get all users who have a Telegram config (they are the ones who can receive proactive msgs)
    const rows = await env.DB.prepare(
      "SELECT user_id FROM telegram_configs LIMIT 200"
    ).all<{ user_id: string }>();

    const userIds = (rows.results ?? []).map((r) => r.user_id);
    if (!userIds.length) return;

    const { getRedis } = await import("../memory");
    const redis = getRedis(env);

    for (const userId of userIds) {
      try {
        const goals = await loadAllGoals(redis, userId);
        const active = goals.filter((g) => g.status === "active");
        if (!active.length) continue;

        // Get this user's telegram chatId
        const { getTelegramConfigByUserId } = await import("../telegram");
        const tgConfig = await getTelegramConfigByUserId(env, userId);
        if (!tgConfig) continue;

        // Look up chatId from Redis (set when user first messages the bot)
        const chatIdRaw = await redis.get(`telegram:chat-id:${userId}`) as string | null;
        if (!chatIdRaw) continue;
        const chatId = chatIdRaw;

        const now = Date.now();

        for (const goal of active) {
          if (!goal.notifyOnProgress && !goal.telegramChatId) continue;

          const effectiveChatId = goal.telegramChatId ?? chatId;

          // Cooldown per priority to prevent spam
          const cooldownMs =
            goal.priority === "critical" ? 4 * 60 * 60 * 1000   // 4h
              : goal.priority === "high" ? 12 * 60 * 60 * 1000  // 12h
                : goal.priority === "medium" ? 24 * 60 * 60 * 1000  // 24h
                  : 48 * 60 * 60 * 1000;  // 48h

          const lastNotified = goal.lastNotifiedAt ?? 0;
          if (now - lastNotified < cooldownMs) continue;

          const daysLeft = daysUntilDeadline(goal);
          const velocity = calculateVelocity(goal);
          const stalledMs = now - goal.updatedAt;
          const stalledDays = stalledMs / (1000 * 60 * 60 * 24);

          const stalledThreshold =
            goal.priority === "critical" ? 2 : goal.priority === "high" ? 4 : 7;

          let shouldNotify = false;
          let message = "";

          // OVERDUE
          if (daysLeft !== null && daysLeft < 0 && goal.progress < 100) {
            shouldNotify = true;
            message =
              `⛔ <b>Overdue Goal</b>\n\n` +
              `<b>${goal.title}</b>\n` +
              `Progress: ${goal.progress}% | Deadline was: ${goal.deadline}\n` +
              `Overdue by ${Math.abs(Math.round(daysLeft))} days.\n` +
              (goal.nextAction ? `\n📋 Next action: ${goal.nextAction}` : "");
          }
          // DUE SOON (< 48h)
          else if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 2 && goal.progress < 100) {
            shouldNotify = true;
            const projectedOk = velocity !== null && velocity > 0
              ? (100 - goal.progress) / velocity <= daysLeft
              : null;
            message =
              `⏰ <b>Deadline Approaching</b>\n\n` +
              `<b>${goal.title}</b>\n` +
              `Progress: ${goal.progress}% | ${urgencyLabel(daysLeft)}\n` +
              (velocity !== null ? `📈 Velocity: ${velocity.toFixed(1)}%/day\n` : "") +
              (projectedOk !== null
                ? projectedOk
                  ? "✅ On track to complete on time."
                  : "⚠️ At current pace, you will miss the deadline."
                : "") +
              (goal.nextAction ? `\n📋 ${goal.nextAction}` : "");
          }
          // STALLED
          else if (stalledDays >= stalledThreshold && goal.progress < 100) {
            shouldNotify = true;
            message =
              `⚠️ <b>Stalled Goal</b>\n\n` +
              `<b>${goal.title}</b> (${goal.priority} priority)\n` +
              `Progress: ${goal.progress}% | No update for ${Math.round(stalledDays)} days.\n` +
              (goal.nextAction ? `\n📋 Next action: ${goal.nextAction}` : "\nNo next action defined — update the goal to get back on track.") +
              (goal.autoAdvance ? "\n🤖 Auto-advance is ON — spawning agent to help." : "");
          }

          if (shouldNotify) {
            const sent = await sendProactiveTelegramMessage(
              env, effectiveChatId, message, userId
            );
            if (sent) {
              goal.lastNotifiedAt = now;
              await saveGoal(redis, goal);
            }
          }
        }
      } catch (userErr) {
        console.error(`[checkGoalsAtCron] Error for user ${userId}:`, userErr);
      }
    }
  } catch (err) {
    console.error("[checkGoalsAtCron] Fatal error:", err);
  }
}

// ─── Goals Context for System Prompt (user-scoped) ───────────────────────────
/**
 * Returns a brief goals context block for the system prompt.
 * ONLY loads goals for the specific user of this session.
 * Never leaks cross-user data.
 */
export async function getGoalsContext(env: Env, userId?: string): Promise<string> {
  if (!userId) return "";

  try {
    const { getRedis } = await import("../memory");
    const redis = getRedis(env);
    const goals = await loadAllGoals(redis, userId);

    const active = goals
      .filter((g) => g.status === "active")
      .sort((a, b) => {
        const pOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return pOrder[a.priority] - pOrder[b.priority];
      })
      .slice(0, 5); // max 5 in prompt to avoid bloat

    if (!active.length) return "";

    const lines = active.map((g) => {
      const daysLeft = daysUntilDeadline(g);
      const deadlinePart = daysLeft !== null
        ? ` | ${daysLeft < 0 ? "OVERDUE" : `${Math.round(daysLeft)}d left`}`
        : "";
      return `• [${g.priority.toUpperCase()}] "${g.title}" — ${g.progress}%${deadlinePart}${g.nextAction ? ` | Next: ${g.nextAction}` : ""}`;
    });

    return (
      `\n\n━━ YOUR ACTIVE GOALS ━━\n` +
      lines.join("\n") +
      `\n(Autonomously advance these when relevant. Use update_progress to log work.)\n━━━━━━━━━━━━━━━━━━━━━━━━`
    );
  } catch {
    return "";
  }
}

// ── Tool executor wrappers (called from builtins.ts) ──────────────────────────
export async function execManageGoalsTool(
  args: Record<string, unknown>,
  env: Env,
  userId?: string
): Promise<Record<string, unknown>> {
  return execManageGoals(args, env, userId);
}

export async function execProactiveNotifyTool(
  args: Record<string, unknown>,
  env: Env,
  userId?: string
): Promise<Record<string, unknown>> {
  return execProactiveNotify(args, env, userId);
}