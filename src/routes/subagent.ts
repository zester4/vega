/**
 * ============================================================================
 * src/routes/subagent.ts — Direct Sub-Agent Executor
 * ============================================================================
 *
 * This module provides a DIRECT execution path for sub-agents that does NOT
 * depend on QStash/Upstash Workflow callbacks. Instead:
 *
 *   1. Caller fires POST /run-subagent (internal, protected by a secret)
 *   2. Worker creates the task record immediately
 *   3. Uses executionCtx.waitUntil() to run the full agent loop in the background
 *   4. Redis is updated to "done" or "error" when the loop completes
 *   5. Fires the webhook to notify the parent if UPSTASH_WORKFLOW_URL is set
 *
 * This completely replaces the QStash → Upstash Workflow mechanism for
 * sub-agents, making it:
 *   - Reliable in both local dev (wrangler dev + ngrok) and production
 *   - Faster (no QStash round-trip delay)
 *   - Simpler (no Upstash Workflow SDK overhead)
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
            // Record already created by execSpawnAgent — just ensure it’s running
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

        // Notify parent
        await notifyCompletion(env, taskId, agentConfig.name, "error", String(e));
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

    // Notify parent via webhook
    await notifyCompletion(env, taskId, agentConfig.name, "done", result);
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
 * Fire a best-effort webhook to UPSTASH_WORKFLOW_URL/webhook/task-complete.
 */
async function notifyCompletion(
    env: Env,
    taskId: string,
    agentName: string,
    status: string,
    summaryOrError: string
): Promise<void> {
    try {
        const base = (env.UPSTASH_WORKFLOW_URL ?? "").trim().replace(/\/$/, "");
        if (!base) return;

        await fetch(`${base}/webhook/task-complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                taskId,
                agentName,
                status,
                summary: summaryOrError.slice(0, 500),
                completedAt: new Date().toISOString(),
            }),
        });
    } catch {
        // Non-fatal
    }
}
