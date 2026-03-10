/**
 * ============================================================================
 * src/tools/long-running.ts — Tools for 10+ Hour Agent Workflows
 * ============================================================================
 *
 * This file provides tool DECLARATIONS and EXECUTORS for:
 *
 *   wait_for_user_input   — Pause a workflow and ask the user a question.
 *                           Worker exits entirely, zero CPU held.
 *                           User replies on Telegram, workflow resumes.
 *                           Supports up to 7-day wait timeout.
 *
 *   parallel_agents       — Spawn N sub-agents in parallel via QStash.
 *                           All run simultaneously on Cloudflare Workers.
 *                           Results are collected when all complete.
 *
 * INTEGRATION:
 *   In src/tools/builtins.ts, add to BUILTIN_DECLARATIONS:
 *     import { LONG_RUNNING_DECLARATIONS, executeLongRunningTool } from "./long-running"
 *     export const BUILTIN_DECLARATIONS = [...existingTools, ...LONG_RUNNING_DECLARATIONS]
 *
 *   In executeTool(), add case handler:
 *     const longRunningResult = await executeLongRunningTool(name, args, env, sessionId);
 *     if (longRunningResult !== null) return longRunningResult;
 *
 * HOW wait_for_user_input WORKS:
 *   1. Tool generates a unique eventId (UUID-style)
 *   2. Sends the question to user via Telegram (using tg:delivery:{userId} config)
 *   3. Stores Redis key: tg:awaiting-workflow:{chatId} = { eventId, sessionId, taskId }
 *   4. Returns special marker: { _pause_workflow: true, _event_id: "...", _question: "..." }
 *   5. workflow.ts detects this marker and calls context.waitForEvent(eventId)
 *   6. When user replies, telegram.ts processMessage detects tg:awaiting-workflow:{chatId}
 *   7. Calls POST /workflow/notify { eventId, eventData: { text: userReply } }
 *   8. Workflow resumes from the exact iteration — no data lost
 *
 * ============================================================================
 */

import { getRedis } from "./memory";

// ─── Tool Declarations (Gemini function calling schema) ───────────────────────

export const LONG_RUNNING_DECLARATIONS = [
    {
        name: "wait_for_user_input",
        description: `Pause the current workflow and ask the user a question. The agent will suspend entirely (zero CPU consumed) until the user replies on Telegram or the web UI. Use this when:
- You need a decision from the user before proceeding
- You need clarification on an ambiguous instruction
- You want to present findings and ask how to continue
- You're mid-task and need approval to proceed

The user's reply will be injected into the next step automatically.
Supports up to 7-day wait timeout. After timeout, the task gracefully concludes.`,
        parameters: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description: "The question or prompt to send to the user. Be clear and specific. Include context if needed.",
                },
                context: {
                    type: "string",
                    description: "Optional: brief summary of what you've done so far, to give the user context for their reply.",
                },
            },
            required: ["question"],
        },
    },

    {
        name: "parallel_agents",
        description: `Spawn multiple specialized sub-agents that run simultaneously in parallel. Each agent works independently on its own task, and results are stored in shared memory when complete.

Use this when:
- You need to research multiple topics at the same time
- You want to parallelize a large batch of independent tasks
- You're doing competitive analysis across multiple competitors
- You need data from many sources simultaneously

Each agent is given a unique task and memory namespace. They run as separate Cloudflare Worker instances on Upstash QStash.`,
        parameters: {
            type: "object",
            properties: {
                agents: {
                    type: "array",
                    description: "Array of agent task definitions",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Agent name (e.g. 'researcher-1', 'analyst-competitor-a')" },
                            task: { type: "string", description: "What this specific agent should do" },
                            tools: {
                                type: "array",
                                items: { type: "string" },
                                description: "Specific tools this agent can use. Omit to allow all tools.",
                            },
                        },
                        required: ["name", "task"],
                    },
                },
                context: {
                    type: "string",
                    description: "Shared context/instructions for all agents",
                },
                collectResultsKey: {
                    type: "string",
                    description: "Optional: Redis key prefix where agents store their results for collection",
                },
            },
            required: ["agents"],
        },
    },
] as const;

// ─── Tool Executors ───────────────────────────────────────────────────────────

/**
 * Execute a long-running tool. Returns null if the tool name is not handled here.
 */
export async function executeLongRunningTool(
    name: string,
    args: Record<string, unknown>,
    env: Env,
    sessionId?: string
): Promise<Record<string, unknown> | null> {
    if (name === "wait_for_user_input") {
        return executeWaitForUserInput(args, env, sessionId);
    }
    if (name === "parallel_agents") {
        return executeParallelAgents(args, env, sessionId);
    }
    return null;
}

// ─── wait_for_user_input ──────────────────────────────────────────────────────

async function executeWaitForUserInput(
    args: Record<string, unknown>,
    env: Env,
    sessionId?: string
): Promise<Record<string, unknown>> {
    const question = String(args.question ?? "");
    const context = args.context ? String(args.context) : null;

    if (!question) {
        return { error: "question is required for wait_for_user_input" };
    }

    const redis = getRedis(env);

    // Generate a unique event ID for this pause
    const eventId = `vega-pause-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Resolve userId from sessionId (format: "tg-{chatId}-{ts}" or "user-{userId}")
    let userId: string | null = null;
    let chatId: number | null = null;

    if (sessionId) {
        // Try user-map first
        userId = await redis.get<string>(`session:user-map:${sessionId}`).catch(() => null);

        // Extract from "user-{userId}" format
        if (!userId && sessionId.startsWith("user-")) {
            userId = sessionId.replace("user-", "");
        }

        // Extract chatId from Telegram session format "tg-{chatId}-{ts}"
        const tgMatch = sessionId.match(/^tg-(\d+)-/);
        if (tgMatch) {
            chatId = parseInt(tgMatch[1], 10);
        }

        // Fallback: look up chatId from Redis
        if (!chatId && userId) {
            const storedChatId = await redis.get<string>(`telegram:chat-id:${userId}`).catch(() => null);
            if (storedChatId) chatId = parseInt(storedChatId, 10);
        }
    }

    // Store the waiting state in Redis so telegram.ts can detect it
    if (chatId) {
        await redis.set(
            `tg:awaiting-workflow:${chatId}`,
            JSON.stringify({ eventId, sessionId, question, pausedAt: new Date().toISOString() }),
            { ex: 60 * 60 * 24 * 7 } // 7 day TTL matching waitForEvent timeout
        ).catch(() => { });
        console.log(`[wait_for_user_input] Stored pause request for chatId ${chatId}, eventId: ${eventId}`);
    }

    // Send the question to the user via Telegram (if we can find their config)
    if (userId) {
        try {
            const db = (env as any).DB as D1Database | undefined;
            if (db) {
                const { getTelegramConfigByUserId } = await import("./db/queries");
                const tgConfig = await getTelegramConfigByUserId(db, userId).catch(() => null);

                if (tgConfig?.token && chatId) {
                    const { TelegramBot, markdownToHtml } = await import("./telegram");
                    const bot = new TelegramBot(tgConfig.token);

                    const messageLines = [
                        `⏸️ <b>VEGA needs your input to continue</b>`,
                        ``,
                    ];

                    if (context) {
                        messageLines.push(`<blockquote>${markdownToHtml(context.slice(0, 400))}</blockquote>`);
                        messageLines.push(``);
                    }

                    messageLines.push(`❓ <b>${markdownToHtml(question)}</b>`);
                    messageLines.push(``);
                    messageLines.push(`<i>Reply here and I'll continue the task. (Waiting up to 7 days)</i>`);

                    await bot.sendMessage(chatId, messageLines.join("\n"), { parse_mode: "HTML" });
                    console.log(`[wait_for_user_input] Sent question to Telegram chatId ${chatId}`);
                }
            }
        } catch (e) {
            console.warn(`[wait_for_user_input] Telegram send failed: ${String(e)}`);
        }
    }

    // Return the special marker that workflow.ts detects to call context.waitForEvent()
    return {
        _pause_workflow: true,
        _event_id: eventId,
        _question: question,
        status: "waiting",
        message: chatId
            ? `Question sent via Telegram (chatId: ${chatId}). Task paused waiting for your reply.`
            : `Task paused. Event ID: ${eventId}. Send your reply to resume.`,
        eventId,
    };
}

// ─── parallel_agents ─────────────────────────────────────────────────────────

async function executeParallelAgents(
    args: Record<string, unknown>,
    env: Env,
    sessionId?: string
): Promise<Record<string, unknown>> {
    const agents = args.agents as Array<{
        name: string;
        task: string;
        tools?: string[];
    }>;
    const context = args.context ? String(args.context) : "";
    const collectResultsKey = args.collectResultsKey ? String(args.collectResultsKey) : null;

    if (!agents?.length) {
        return { error: "agents array is required" };
    }

    const redis = getRedis(env);
    const workerBase = ((env as any).UPSTASH_WORKFLOW_URL ?? (env as any).WORKER_URL ?? "").replace(/\/$/, "");
    const qstash = new (await import("@upstash/qstash").then(m => m.Client))({
        token: (env as any).QSTASH_TOKEN,
        baseUrl: (env as any).QSTASH_URL,
    });

    const spawnedAgents: Array<{ name: string; taskId: string; memoryPrefix: string }> = [];

    // Spawn all agents simultaneously
    for (const agent of agents) {
        const taskId = `parallel-${Date.now()}-${agent.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
        const memoryPrefix = collectResultsKey
            ? `${collectResultsKey}:${agent.name}`
            : `parallel-${taskId}`;

        try {
            await qstash.publishJSON({
                url: `${workerBase}/workflow`,
                body: {
                    taskId,
                    sessionId: sessionId ?? `parallel-${taskId}`,
                    taskType: "sub_agent",
                    instructions: context ? `${context}\n\nYour specific task: ${agent.task}` : agent.task,
                    agentConfig: {
                        name: agent.name,
                        allowedTools: agent.tools ?? null,
                        memoryPrefix,
                        notifyEmail: null,
                        spawnedAt: new Date().toISOString(),
                        parentAgent: "parallel_agents-tool",
                        parentSessionId: sessionId ?? null,
                        userId: sessionId?.startsWith("user-") ? sessionId.replace("user-", "") : null,
                        maxIterations: 50,
                    },
                },
            });

            // Track in Redis
            await redis.lpush("agent:spawned", JSON.stringify({
                agentId: taskId,
                agentName: agent.name,
                status: "running",
                spawnedAt: new Date().toISOString(),
                memoryPrefix,
            })).catch(() => { });
            await redis.ltrim("agent:spawned", 0, 99).catch(() => { });

            spawnedAgents.push({ name: agent.name, taskId, memoryPrefix });
            console.log(`[parallel_agents] Spawned: ${agent.name} (${taskId})`);
        } catch (e) {
            console.error(`[parallel_agents] Failed to spawn ${agent.name}: ${String(e)}`);
            spawnedAgents.push({ name: agent.name, taskId: `FAILED-${agent.name}`, memoryPrefix });
        }
    }

    return {
        status: "spawned",
        agents: spawnedAgents,
        count: spawnedAgents.length,
        message: `${spawnedAgents.length} parallel agents spawned. Results will be stored in their memory namespaces and you'll be notified when complete.`,
        collectResultsUsing: collectResultsKey ?? `Use read_agent_memory(namespace="{memoryPrefix}") to check each agent's results.`,
        checkStatusUsing: "Use get_task_status(taskId) to check individual agent status.",
    };
}