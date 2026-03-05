/**
 * ============================================================================
 * src/routes/subagent.ts — Direct Sub-Agent Executor
 * ============================================================================
 *
 * FIX SUMMARY (2025-03):
 *   ✅ notifyCompletion now calls /agents/completion-callback (WORKER_URL self-call)
 *      instead of just storing to Redis. This pushes the result back to the user
 *      via Telegram proactive_notify automatically.
 *   ✅ Full result (not truncated) is sent in the callback payload
 *   ✅ Retry logic on notification failure (3 attempts, exponential backoff)
 *
 * This module provides a DIRECT execution path for sub-agents that does NOT
 * depend on QStash/Upstash Workflow callbacks. Instead:
 *
 *   1. Caller fires POST /run-subagent (internal, protected by a secret)
 *   2. Worker creates the task record immediately
 *   3. Uses executionCtx.waitUntil() to run the full agent loop in the background
 *   4. Redis is updated to "done" or "error" when the loop completes
 *   5. Fires the completion callback to notify the parent
 *
 * For long-running tasks (research, batch, pipeline), Upstash Workflow is
 * still used via the /workflow endpoint.
 * ============================================================================
 */

import { getRedis, createTask, updateTask, getTask } from "../memory";
import type { AgentConfig } from "./workflow";

export type SubAgentPayload = {
    taskId: string;
    sessionId: string;
    instructions: string;
    agentConfig: AgentConfig;
};

/**
 * Build the specialized system prompt for a sub-agent.
 */
export function buildSubAgentPrompt(config: AgentConfig): string {
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

/**
 * Execute a sub-agent task in the background using waitUntil.
 * Called from the /run-subagent HTTP handler.
 */
export async function runSubAgentTask(env: Env, payload: SubAgentPayload): Promise<void> {
    const { taskId, sessionId, instructions, agentConfig } = payload;
    const redis = getRedis(env);

    // Ensure task record exists and is marked running.
    // execSpawnAgent pre-creates the task record eagerly, so we use
    // getTask + upsert logic to avoid overwriting an already-running record.
    try {
        const existing = await getTask(redis, taskId);
        if (!existing) {
            await createTask(redis, {
                id: taskId,
                type: "sub_agent",
                payload: { instructions, agentConfig },
                status: "running",
            });
        } else {
            // Record already created by execSpawnAgent — just ensure it's running
            await updateTask(redis, taskId, { status: "running" });
        }
    } catch (e) {
        console.error(`[SubAgent] ${taskId} failed to init task record:`, e);
        try {
            await updateTask(redis, taskId, {
                status: "error",
                result: { error: `Task init failed: ${String(e)}`, failedAt: new Date().toISOString() },
            });
        } catch { /* ignore */ }
        return;
    }

    console.log(`[SubAgent] ${taskId} (${agentConfig.name}) starting...`);

    let result: string;
    try {
        const { runAgent } = await import("../agent");
        const systemPrompt = buildSubAgentPrompt(agentConfig);

        result = await runAgent(
            env,
            sessionId,
            instructions,
            systemPrompt,
            undefined, // no SSE streaming for background agents
            agentConfig.allowedTools ?? undefined,
            undefined  // no attachments
        );
    } catch (e) {
        console.error(`[SubAgent] ${taskId} agent loop failed:`, e);
        const completedAt = new Date().toISOString();

        await updateTask(redis, taskId, {
            status: "error",
            result: { error: String(e), failedAt: completedAt },
        }).catch(() => { });

        // Update the agent record in agent:spawned list
        await updateSpawnedStatus(redis, taskId, "error", undefined, undefined);

        // Notify parent — even errors get pushed back
        await notifyCompletion(env, taskId, agentConfig, "error", String(e));
        return;
    }

    const completedAt = new Date().toISOString();

    // Persist final result
    await updateTask(redis, taskId, {
        status: "done",
        result: {
            summary: result,
            agent: agentConfig.name,
            memoryPrefix: agentConfig.memoryPrefix,
            completedAt,
        },
    }).catch((e) => console.error("[SubAgent] Failed to update task:", e));

    // Write result to shared memory namespace so parent can find it
    try {
        const { Redis } = await import("@upstash/redis/cloudflare");
        const sharedRedis = Redis.fromEnv(env);
        await sharedRedis.set(
            `agent:shared:${agentConfig.memoryPrefix}:result`,
            JSON.stringify({ summary: result, completedAt })
        );
        await sharedRedis.set(`agent:shared:${agentConfig.memoryPrefix}:status`, "done");
    } catch (e) {
        console.warn(`[SubAgent] Failed to write shared memory: ${String(e)}`);
    }

    // Update agent:spawned list entry with final status + summary
    await updateSpawnedStatus(redis, taskId, "done", result, completedAt);

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

    // Notify parent via completion callback (pushes result to user)
    await notifyCompletion(env, taskId, agentConfig, "done", result);
    console.log(`[SubAgent] ${taskId} (${agentConfig.name}) DONE.`);
}

/**
 * Update the status of a spawned agent record in the agent:spawned Redis list.
 */
async function updateSpawnedStatus(
    redis: ReturnType<typeof getRedis>,
    taskId: string,
    status: string,
    summary: string | undefined,
    completedAt: string | undefined
): Promise<void> {
    try {
        const agentListRaw = await redis.lrange("agent:spawned", 0, 199) as string[];
        for (let i = 0; i < agentListRaw.length; i++) {
            try {
                const agent = JSON.parse(agentListRaw[i]);
                if (agent.agentId === taskId) {
                    agent.status = status;
                    if (completedAt) agent.completedAt = completedAt;
                    if (summary) agent.summary = summary.slice(0, 500);
                    await redis.lset("agent:spawned", i, JSON.stringify(agent));
                    break;
                }
            } catch { /* skip bad entries */ }
        }
    } catch (e) {
        console.warn("[SubAgent] updateSpawnedStatus failed:", String(e));
    }
}

/**
 * Fire the completion callback to the Worker's /agents/completion-callback endpoint.
 * This replaces the old "store to Redis and pray someone reads it" pattern.
 * The callback handler will:
 *   1. Synthesize a user-friendly version of the result
 *   2. Push it to the user via Telegram proactive_notify
 *   3. Store it as a pending message for the next chat session
 *
 * Retries 3 times with exponential backoff — result is already in Redis as fallback.
 */
async function notifyCompletion(
    env: Env,
    taskId: string,
    agentConfig: AgentConfig,
    status: string,
    result: string
): Promise<void> {
    const { fireCompletionCallback } = await import("./workflow");

    try {
        await fireCompletionCallback(env, {
            taskId,
            agentName: agentConfig.name,
            parentSessionId: agentConfig.parentSessionId ?? null,
            memoryPrefix: agentConfig.memoryPrefix,
            status,
            result,
            completedAt: new Date().toISOString(),
        });
    } catch (e) {
        console.warn(`[SubAgent] notifyCompletion failed: ${String(e)}`);
        // Non-fatal — result is in Redis, user can poll with get_agent_result
    }
}