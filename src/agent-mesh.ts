/**
 * ============================================================================
 * src/tools/agent-mesh.ts — VEGA Peer-to-Peer Multi-Agent Mesh
 * ============================================================================
 *
 * Feature #7: Agents can now communicate LATERALLY without routing through
 * VEGA core. A researcher agent can send findings directly to a writer agent.
 * Multiple agents can work in parallel, messaging each other as they complete.
 *
 * Transport: Upstash Redis — using LIST as a lightweight message queue.
 *   - Each agent has a mailbox: `agent:mailbox:{agentId}` (Redis LIST)
 *   - Messages are JSON objects: { from, content, type, ts, metadata }
 *   - VEGA core also has a mailbox: `agent:mailbox:vega-core`
 *
 * Tools added:
 *   message_agent      → Send a message to another agent's mailbox
 *   read_agent_messages → Read messages from your own mailbox
 *   wait_for_agents    → Block until all specified agents complete (polls Redis)
 *                        Returns results as soon as all are done, or partial
 *                        results on timeout (agent can call again)
 *   broadcast_to_agents → Send same message to multiple agents at once
 *   get_mesh_topology  → See all agents in the mesh and their relationships
 *
 * wait_for_agents design:
 *   - Polls every 2 seconds for up to 25 seconds (safe within 30s tool timeout)
 *   - Returns { done: true, results: {...} } when all complete
 *   - Returns { done: false, pending: [...], completed: [...] } if timed out
 *   - Agent can call wait_for_agents again on next turn until done=true
 *   - This solves "VEGA should not stop after spawning" — agent loops until done
 *
 * ============================================================================
 */

type ToolArgs = Record<string, unknown>;

interface MeshMessage {
    id: string;
    from: string;        // agentId or "vega-core"
    to: string;          // agentId or "vega-core"
    content: string;
    type: "task" | "result" | "status" | "broadcast" | "query" | "data";
    ts: number;
    metadata?: Record<string, unknown>;
}

// ─── Tool Declarations (add to BUILTIN_DECLARATIONS in builtins.ts) ──────────

export const MESH_TOOL_DECLARATIONS = [
    {
        name: "message_agent",
        description:
            "Send a direct message to another agent's mailbox. The target agent will receive it on its next iteration. " +
            "Use this for lateral agent communication: e.g. a researcher sends its findings to a writer without routing through VEGA core. " +
            "Messages persist in the mailbox until the agent reads them. Use agentId from spawn_agent or 'vega-core' to message the parent.",
        parameters: {
            properties: {
                targetAgentId: { type: "string", description: "Agent ID to send to (from spawn_agent), or 'vega-core' to message the parent" },
                message: { type: "string", description: "Message content — can be JSON, natural language, task instructions, or results" },
                type: {
                    type: "string",
                    enum: ["task", "result", "status", "query", "data"],
                    description: "'result' = sharing findings, 'task' = assigning work, 'status' = progress update, 'query' = asking a question, 'data' = passing structured data"
                },
                fromAgentId: { type: "string", description: "Your agent ID (optional, helps recipient know the sender)" },
                metadata: { type: "object", description: "Optional structured metadata to attach (e.g. { confidence: 0.9, sources: [...] })" },
            },
            required: ["targetAgentId", "message"],
        },
    },

    {
        name: "read_agent_messages",
        description:
            "Read messages from your agent's mailbox. Returns all unread messages or messages since a specific ID. " +
            "Call this at the start of each iteration to check if other agents have sent you data or tasks. " +
            "Messages are NOT auto-deleted — use clear=true to clear after reading.",
        parameters: {
            properties: {
                agentId: { type: "string", description: "Your agent ID to read messages for (or 'vega-core' for the main session)" },
                limit: { type: "number", description: "Max messages to return (default 20)" },
                clear: { type: "boolean", description: "If true, clear the mailbox after reading (default false)" },
            },
            required: ["agentId"],
        },
    },

    {
        name: "wait_for_agents",
        description:
            "Wait until one or more spawned agents complete their tasks and return their results. " +
            "Polls Redis every 2 seconds for up to 25 seconds per call. " +
            "If not all done within 25s, returns partial results with pending list — call again on next turn to continue waiting. " +
            "This is how VEGA should use multiple agents: spawn them, then call wait_for_agents to collect all outputs before continuing. " +
            "Returns { done: true, results: { agentId: summary } } when all complete. " +
            "IMPORTANT: Always call this after spawning multiple agents instead of calling get_agent_result in a loop.",
        parameters: {
            properties: {
                agentIds: {
                    type: "array",
                    description: "List of agent IDs to wait for (from spawn_agent calls)",
                    items: { type: "string" },
                },
                timeoutSeconds: {
                    type: "number",
                    description: "Max seconds to wait per call (default 25, max 25 to stay within tool timeout)",
                },
                collectResults: {
                    type: "boolean",
                    description: "If true, include full agent result summaries in the response (default true)",
                },
            },
            required: ["agentIds"],
        },
    },

    {
        name: "broadcast_to_agents",
        description:
            "Send the same message to multiple agents simultaneously. " +
            "Useful for: distributing a dataset across parallel agents, sending updated instructions to all running agents, " +
            "or signalling all agents to wrap up and report results.",
        parameters: {
            properties: {
                agentIds: {
                    type: "array",
                    description: "List of agent IDs to broadcast to",
                    items: { type: "string" },
                },
                message: { type: "string", description: "Message to send to all agents" },
                type: {
                    type: "string",
                    enum: ["task", "result", "status", "query", "data"],
                    description: "Message type",
                },
                fromAgentId: { type: "string", description: "Sender ID (optional)" },
            },
            required: ["agentIds", "message"],
        },
    },

    {
        name: "get_mesh_topology",
        description:
            "Get an overview of all agents in the current mesh: their status, relationships, and recent message activity. " +
            "Use this to understand the state of your agent network before deciding to spawn more or wait.",
        parameters: {
            properties: {
                includeMessages: {
                    type: "boolean",
                    description: "If true, include recent messages between agents (default false)",
                },
            },
            required: [],
        },
    },
] as const;

// ─── Implementations ──────────────────────────────────────────────────────────

export async function execMessageAgent(
    args: ToolArgs,
    env: Env
): Promise<Record<string, unknown>> {
    const {
        targetAgentId,
        message,
        type = "data",
        fromAgentId = "vega-core",
        metadata = {},
    } = args as {
        targetAgentId: string;
        message: string;
        type?: string;
        fromAgentId?: string;
        metadata?: Record<string, unknown>;
    };

    const { Redis } = await import("@upstash/redis/cloudflare");
    const redis = Redis.fromEnv(env);

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const meshMsg: MeshMessage = {
        id: msgId,
        from: String(fromAgentId),
        to: String(targetAgentId),
        content: String(message),
        type: type as MeshMessage["type"],
        ts: Date.now(),
        metadata: metadata as Record<string, unknown>,
    };

    const mailboxKey = `agent:mailbox:${targetAgentId}`;
    await redis.lpush(mailboxKey, JSON.stringify(meshMsg));
    await redis.ltrim(mailboxKey, 0, 99); // Keep last 100 messages
    await redis.expire(mailboxKey, 60 * 60 * 24); // 24h TTL

    // Also log to mesh activity for topology view
    await redis.lpush("agent:mesh:activity", JSON.stringify({
        ...meshMsg,
        content: meshMsg.content.slice(0, 200),
    }));
    await redis.ltrim("agent:mesh:activity", 0, 199);

    return {
        success: true,
        messageId: msgId,
        to: targetAgentId,
        from: fromAgentId,
        type,
        preview: String(message).slice(0, 100),
        message: `Message delivered to agent '${targetAgentId}' mailbox.`,
    };
}

export async function execReadAgentMessages(
    args: ToolArgs,
    env: Env
): Promise<Record<string, unknown>> {
    const { agentId, limit = 20, clear = false } = args as {
        agentId: string;
        limit?: number;
        clear?: boolean;
    };

    const { Redis } = await import("@upstash/redis/cloudflare");
    const redis = Redis.fromEnv(env);

    const mailboxKey = `agent:mailbox:${agentId}`;
    const raw = await redis.lrange(mailboxKey, 0, Math.min(Number(limit), 100) - 1) as string[];

    const messages: MeshMessage[] = raw.map((r: string) => {
        try { return JSON.parse(r) as MeshMessage; } catch { return null; }
    }).filter(Boolean) as MeshMessage[];

    // Sort oldest first (they were stored newest-first via lpush)
    messages.sort((a, b) => a.ts - b.ts);

    if (clear && messages.length > 0) {
        await redis.del(mailboxKey);
    }

    return {
        agentId,
        count: messages.length,
        messages: messages.map((m) => ({
            id: m.id,
            from: m.from,
            type: m.type,
            content: m.content,
            ts: m.ts,
            metadata: m.metadata,
            age: `${Math.round((Date.now() - m.ts) / 1000)}s ago`,
        })),
        cleared: clear && messages.length > 0,
        mailboxKey,
    };
}

export async function execWaitForAgents(
    args: ToolArgs,
    env: Env
): Promise<Record<string, unknown>> {
    const {
        agentIds,
        timeoutSeconds = 25,
        collectResults = true,
    } = args as {
        agentIds: string[];
        timeoutSeconds?: number;
        collectResults?: boolean;
    };

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
        return { error: "agentIds must be a non-empty array" };
    }

    const { getRedis, getTask } = await import("./memory");
    const redis = getRedis(env);

    // Cap at 25s to stay safely within the 30s generateWithTools timeout guard
    const maxWaitMs = Math.min(Number(timeoutSeconds) || 25, 25) * 1000;
    const pollIntervalMs = 2000;
    const deadline = Date.now() + maxWaitMs;

    const completed: Record<string, unknown> = {};
    const pending: string[] = [...agentIds];

    // ── Poll until all done or timeout ───────────────────────────────────────
    while (pending.length > 0 && Date.now() < deadline) {
        for (const agentId of [...pending]) {
            const task = await getTask(redis, agentId);
            if (!task) continue; // Still initializing

            if (task.status === "done" || task.status === "error" || task.status === "cancelled") {
                const result = task.result as Record<string, unknown> ?? {};
                completed[agentId] = {
                    status: task.status,
                    summary: collectResults ? (result.summary ?? result.error ?? "Completed") : "[not collected]",
                    completedAt: result.completedAt ?? new Date().toISOString(),
                    agent: result.agent ?? agentId,
                };
                pending.splice(pending.indexOf(agentId), 1);
            }
        }

        if (pending.length > 0 && Date.now() < deadline) {
            // Wait before next poll
            await new Promise((res) => setTimeout(res, pollIntervalMs));
        }
    }

    const allDone = pending.length === 0;

    if (allDone) {
        // Collect summaries for synthesis
        const summaries = Object.entries(completed).map(([id, r]) => {
            const result = r as Record<string, unknown>;
            return `Agent ${id} (${result.agent ?? id}) — ${result.status}:\n${String(result.summary ?? "").slice(0, 500)}`;
        });

        return {
            done: true,
            totalAgents: agentIds.length,
            completed: agentIds.length,
            results: completed,
            summaries,
            message: `All ${agentIds.length} agent(s) completed. Results collected — synthesize them now.`,
        };
    }

    // Partial completion — agent should call wait_for_agents again next turn
    return {
        done: false,
        totalAgents: agentIds.length,
        completedCount: Object.keys(completed).length,
        pendingCount: pending.length,
        pending,
        completed,
        message: `${Object.keys(completed).length}/${agentIds.length} agents done. Call wait_for_agents again on next turn to continue waiting.`,
        tip: "Tip: Call wait_for_agents(['agent-id-1', ...]) again in your next message to resume waiting for the remaining agents.",
    };
}

export async function execBroadcastToAgents(
    args: ToolArgs,
    env: Env
): Promise<Record<string, unknown>> {
    const {
        agentIds,
        message,
        type = "data",
        fromAgentId = "vega-core",
    } = args as {
        agentIds: string[];
        message: string;
        type?: string;
        fromAgentId?: string;
    };

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
        return { error: "agentIds must be a non-empty array" };
    }

    const { Redis } = await import("@upstash/redis/cloudflare");
    const redis = Redis.fromEnv(env);

    const results: Record<string, string> = {};
    const broadcastId = `bcast-${Date.now()}`;

    await Promise.all(
        agentIds.map(async (targetId) => {
            const msgId = `${broadcastId}-${targetId}`;
            const meshMsg: MeshMessage = {
                id: msgId,
                from: String(fromAgentId),
                to: String(targetId),
                content: String(message),
                type: type as MeshMessage["type"],
                ts: Date.now(),
                metadata: { broadcast: true, broadcastId },
            };
            const mailboxKey = `agent:mailbox:${targetId}`;
            await redis.lpush(mailboxKey, JSON.stringify(meshMsg));
            await redis.expire(mailboxKey, 60 * 60 * 24);
            results[targetId] = "delivered";
        })
    );

    return {
        success: true,
        broadcastId,
        recipients: agentIds.length,
        results,
        type,
        preview: String(message).slice(0, 150),
        message: `Broadcast delivered to ${agentIds.length} agents.`,
    };
}

export async function execGetMeshTopology(
    args: ToolArgs,
    env: Env
): Promise<Record<string, unknown>> {
    const { includeMessages = false } = args as { includeMessages?: boolean };

    const { Redis } = await import("@upstash/redis/cloudflare");
    const { getRedis, getTask } = await import("./memory");
    const redis = getRedis(env);
    const r = Redis.fromEnv(env);

    // Get all spawned agents
    const raw = await redis.lrange("agent:spawned", 0, 99) as string[];
    const agents = raw.map((s: string) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

    // Build topology nodes
    const nodes = await Promise.all(
        agents.map(async (a: Record<string, unknown>) => {
            const task = await getTask(redis, String(a.agentId)).catch(() => null);
            const mailboxLen = await r.llen(`agent:mailbox:${a.agentId}`).catch(() => 0);

            return {
                agentId: a.agentId,
                name: a.agentName,
                status: task?.status ?? a.status,
                parent: (a.agentConfig as Record<string, unknown> | undefined)?.parentSessionId ?? "vega-core",
                mailboxMessages: mailboxLen,
                spawnedAt: a.spawnedAt,
                memoryPrefix: (a.agentConfig as Record<string, unknown> | undefined)?.memoryPrefix,
            };
        })
    );

    // Get recent mesh activity
    let recentMessages: unknown[] = [];
    if (includeMessages) {
        const activityRaw = await r.lrange("agent:mesh:activity", 0, 19) as string[];
        recentMessages = activityRaw.map((s: string) => {
            try { return JSON.parse(s); } catch { return null; }
        }).filter(Boolean);
    }

    // Summary
    const running = nodes.filter((n) => n.status === "running").length;
    const done = nodes.filter((n) => n.status === "done").length;
    const errored = nodes.filter((n) => n.status === "error").length;

    return {
        topology: {
            totalAgents: nodes.length,
            running,
            done,
            errored,
        },
        agents: nodes,
        ...(includeMessages ? { recentMessages } : {}),
        tip: running > 0
            ? `${running} agent(s) still running. Use wait_for_agents([...]) to collect results.`
            : "All agents completed. Use read_agent_memory to retrieve their stored results.",
    };
}

// ─── Dispatcher (called from executeTool in builtins.ts) ─────────────────────

export async function execMeshTool(
    toolName: string,
    args: ToolArgs,
    env: Env
): Promise<Record<string, unknown>> {
    switch (toolName) {
        case "message_agent": return execMessageAgent(args, env);
        case "read_agent_messages": return execReadAgentMessages(args, env);
        case "wait_for_agents": return execWaitForAgents(args, env);
        case "broadcast_to_agents": return execBroadcastToAgents(args, env);
        case "get_mesh_topology": return execGetMeshTopology(args, env);
        default: return { error: `Unknown mesh tool: ${toolName}` };
    }
}