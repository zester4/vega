/**
 * ============================================================================
 * src/tools/world-model.ts — VEGA Living World-Model (Knowledge Graph)
 * ============================================================================
 *
 * The most powerful memory system any AI agent has ever had.
 *
 * Every other agent stores flat key-value facts.
 * VEGA stores a LIVING RELATIONSHIP GRAPH of everything the user cares about.
 * Not facts — connections between facts. And it reasons across those connections
 * to surface consequences the user never asked about.
 *
 * Example graph:
 *   Ethereum ──affects──▶ My Portfolio ($12k)
 *        │                       │
 *        └──relates──▶ Tax Threshold ($10k taxable)
 *                              │
 *                     deadline_for──▶ April 15 Deadline
 *                                           │
 *                                    contacts──▶ John the Accountant
 *                                                      │
 *                                             last_contacted──▶ 14 days ago (overdue)
 *
 * When ETH pumps 18%, VEGA traverses this graph and surfaces:
 *   "You may now be above your taxable threshold. Tax deadline in 6 weeks.
 *    You haven't emailed John in 14 days — that's overdue."
 *
 * ─── Storage Layout (Upstash Redis) ──────────────────────────────────────────
 *
 *  wm:node:{userId}:{nodeId}           → GraphNode JSON (string)
 *  wm:nodes:{userId}                   → Set of all nodeIds for user
 *  wm:label:{userId}:{label_lower}     → nodeId (reverse label lookup)
 *  wm:edges:{userId}:{nodeId}          → JSON array of outgoing GraphEdge[]
 *  wm:edgecount:{userId}               → total edge count (incr)
 *
 * ─── Auto-Extraction (hooks into agent.ts after every turn) ──────────────────
 *
 *  After every user message + agent response, Gemini extracts:
 *    - Entities mentioned (people, assets, deadlines, projects, goals, facts)
 *    - Relationships between them ("affects", "deadline_for", "owned_by", etc.)
 *  These are silently upserted into the graph.
 *
 * ─── Tools Exposed to Gemini ─────────────────────────────────────────────────
 *
 *  graph_node     → upsert / get / delete / list / search nodes
 *  graph_connect  → create or update an edge between two nodes
 *  graph_traverse → walk from a node N hops, return full subgraph
 *  graph_insight  → Gemini traverses the graph and surfaces non-obvious
 *                   consequences, stale info, and actions required
 *
 * ─── Integration Points ──────────────────────────────────────────────────────
 *
 *  1. src/tools/builtins.ts    → Add WORLD_MODEL_TOOL_DECLARATIONS to
 *                                BUILTIN_DECLARATIONS and dispatch in
 *                                executeToolInner switch.
 *
 *  2. src/agent.ts             → After the "Life Memory Extraction" block
 *                                (~line 366), add:
 *
 *                                  import { autoExtractWorldModel } from "./tools/world-model";
 *
 *                                  // Inside the try block after life memory:
 *                                  try {
 *                                    const userId = await redis.get(
 *                                      `session:user-map:${sessionId}`
 *                                    ) as string | null;
 *                                    if (userId) {
 *                                      await autoExtractWorldModel(
 *                                        env, userId, userMessage, response
 *                                      );
 *                                    }
 *                                  } catch (we) {
 *                                    console.error("[WorldModel AutoExtract]", we);
 *                                  }
 *
 * ─── Graph Insight System Prompt ─────────────────────────────────────────────
 *
 *  graph_insight injects the subgraph into Gemini and asks it to reason
 *  across ALL nodes and edges simultaneously — like a detective connecting dots.
 *  Returns structured insights: consequences, stale data warnings, actions.
 *
 * ============================================================================
 */

import { Redis } from "@upstash/redis/cloudflare";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NodeType =
    | "asset"       // financial: ETH, AAPL, savings account
    | "person"      // contacts: client, accountant, partner
    | "deadline"    // time-bound: tax deadline, project due date
    | "project"     // ongoing work: VEGA build, Q3 pitch deck
    | "goal"        // aspirations: reach $100k, launch in March
    | "fact"        // arbitrary facts: subscription costs $29/mo
    | "event"       // occurrences: ETH pump, meeting on Tuesday
    | "constraint"  // limits: can't work weekends, budget $500
    | "entity";     // catch-all: companies, tools, locations

export type EdgeRelation =
    | "affects"         // X affects Y (directional consequence)
    | "owned_by"        // X is owned by Y
    | "deadline_for"    // X is a deadline for Y
    | "related_to"      // X is related to Y (bidirectional)
    | "contacts"        // X contacts Y (person → person)
    | "part_of"         // X is part of Y
    | "blocks"          // X blocks Y from happening
    | "depends_on"      // X depends on Y
    | "triggers"        // X triggers Y when condition met
    | "assigned_to"     // X is assigned to Y (task → person)
    | "located_at"      // X is at Y
    | "measures"        // X measures/tracks Y
    | string;           // allow custom relations

export interface GraphNode {
    id: string;               // stable slug: "eth_portfolio", "tax_deadline_2025"
    userId: string;
    label: string;            // human name: "My ETH Holdings"
    type: NodeType;
    value: string;            // current state: "$12,400" or "April 15, 2025"
    confidence: number;       // 0–100: how confident this is still accurate
    freshness: "fresh" | "aging" | "stale";
    createdAt: string;
    updatedAt: string;
    source: "auto" | "manual" | "tool"; // how this node entered the graph
    metadata: Record<string, unknown>;
}

export interface GraphEdge {
    fromId: string;
    toId: string;
    relation: EdgeRelation;
    weight: number;           // 0–1: strength/relevance of relationship
    notes: string;            // optional context: "ETH affects portfolio when price > $3k"
    createdAt: string;
    updatedAt: string;
}

export interface Subgraph {
    rootNodeId: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    depth: number;
    totalNodes: number;
    totalEdges: number;
}

export interface GraphInsight {
    type: "consequence" | "stale_data" | "action_required" | "connection" | "risk" | "opportunity";
    priority: "high" | "medium" | "low";
    title: string;
    detail: string;
    involvedNodes: string[];  // node labels
    suggestedAction?: string;
}

// ─── Redis Key Helpers ────────────────────────────────────────────────────────

const KEY = {
    node: (userId: string, nodeId: string) => `wm:node:${userId}:${nodeId}`,
    nodes: (userId: string) => `wm:nodes:${userId}`,
    label: (userId: string, label: string) => `wm:label:${userId}:${label.toLowerCase().replace(/\s+/g, "_")}`,
    edges: (userId: string, nodeId: string) => `wm:edges:${userId}:${nodeId}`,
    edgeCount: (userId: string) => `wm:edgecount:${userId}`,
};

const NODE_TTL = 60 * 60 * 24 * 180; // 6 months
const EDGE_TTL = 60 * 60 * 24 * 180;
const NODES_SET_TTL = 60 * 60 * 24 * 180;
const MAX_NODES_PER_USER = 500;
const MAX_EDGES_PER_NODE = 50;

// ─── ID / Label Helpers ───────────────────────────────────────────────────────

function slugify(label: string): string {
    return label
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, "")
        .replace(/\s+/g, "_")
        .slice(0, 60);
}

function freshness(updatedAt: string): "fresh" | "aging" | "stale" {
    const ageDays = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 7) return "fresh";
    if (ageDays < 30) return "aging";
    return "stale";
}

// ─── Storage Primitives ───────────────────────────────────────────────────────

async function getRedisHelper(env: Env): Promise<Redis> {
    return Redis.fromEnv(env);
}

export async function upsertNode(
    redis: Redis,
    userId: string,
    input: Omit<GraphNode, "id" | "userId" | "createdAt" | "updatedAt" | "freshness">
): Promise<GraphNode> {
    // Derive a stable ID from the label
    const nodeId = slugify(input.label);
    const now = new Date().toISOString();

    // Load existing to preserve createdAt
    const existingRaw = await redis.get<string>(KEY.node(userId, nodeId)).catch(() => null);
    let existing: GraphNode | null = null;
    if (existingRaw) {
        try {
            existing = typeof existingRaw === "string"
                ? JSON.parse(existingRaw)
                : existingRaw as GraphNode;
        } catch { /* ignore */ }
    }

    const node: GraphNode = {
        id: nodeId,
        userId,
        label: input.label,
        type: input.type,
        value: input.value,
        confidence: input.confidence ?? 80,
        freshness: freshness(now),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        source: input.source ?? "auto",
        metadata: { ...(existing?.metadata ?? {}), ...input.metadata },
    };

    await redis.set(KEY.node(userId, nodeId), JSON.stringify(node), { ex: NODE_TTL });
    await redis.sadd(KEY.nodes(userId), nodeId);
    await redis.expire(KEY.nodes(userId), NODES_SET_TTL);
    await redis.set(KEY.label(userId, input.label), nodeId, { ex: NODE_TTL });

    return node;
}

export async function getNode(
    redis: Redis,
    userId: string,
    nodeIdOrLabel: string
): Promise<GraphNode | null> {
    // Try direct ID lookup first
    let raw = await redis.get<string>(KEY.node(userId, nodeIdOrLabel)).catch(() => null);

    // Fall back to label lookup
    if (!raw) {
        const labelId = await redis.get<string>(KEY.label(userId, nodeIdOrLabel)).catch(() => null);
        if (labelId) {
            raw = await redis.get<string>(KEY.node(userId, String(labelId))).catch(() => null);
        }
    }

    if (!raw) return null;

    try {
        const node: GraphNode = typeof raw === "string" ? JSON.parse(raw) : raw as GraphNode;
        node.freshness = freshness(node.updatedAt);
        return node;
    } catch {
        return null;
    }
}

export async function connectNodes(
    redis: Redis,
    userId: string,
    fromLabel: string,
    toLabel: string,
    relation: EdgeRelation,
    options: { weight?: number; notes?: string } = {}
): Promise<{ edge: GraphEdge; created: boolean }> {
    const now = new Date().toISOString();

    // Resolve or auto-create both nodes
    const fromId = slugify(fromLabel);
    const toId = slugify(toLabel);

    // Ensure both nodes exist (create stubs if needed)
    const fromExists = await redis.get<string>(KEY.node(userId, fromId)).catch(() => null);
    if (!fromExists) {
        await upsertNode(redis, userId, {
            label: fromLabel,
            type: "entity",
            value: "",
            confidence: 60,
            source: "auto",
            metadata: {},
        });
    }

    const toExists = await redis.get<string>(KEY.node(userId, toId)).catch(() => null);
    if (!toExists) {
        await upsertNode(redis, userId, {
            label: toLabel,
            type: "entity",
            value: "",
            confidence: 60,
            source: "auto",
            metadata: {},
        });
    }

    // Load existing edges for this node
    const edgesRaw = await redis.get<string>(KEY.edges(userId, fromId)).catch(() => null);
    let edges: GraphEdge[] = [];
    if (edgesRaw) {
        try {
            edges = typeof edgesRaw === "string" ? JSON.parse(edgesRaw) : (edgesRaw as GraphEdge[]);
        } catch { /* start fresh */ }
    }

    // Check if this exact edge already exists
    const existingIdx = edges.findIndex(
        (e) => e.toId === toId && e.relation === relation
    );

    const edge: GraphEdge = {
        fromId: fromId,
        toId: toId,
        relation,
        weight: options.weight ?? 0.8,
        notes: options.notes ?? "",
        createdAt: existingIdx >= 0 ? edges[existingIdx].createdAt : now,
        updatedAt: now,
    };

    const isNew = existingIdx < 0;

    if (existingIdx >= 0) {
        edges[existingIdx] = edge;
    } else {
        edges.push(edge);
        // Cap at max edges per node
        if (edges.length > MAX_EDGES_PER_NODE) {
            edges = edges.slice(edges.length - MAX_EDGES_PER_NODE);
        }
    }

    await redis.set(KEY.edges(userId, fromId), JSON.stringify(edges), { ex: EDGE_TTL });

    if (isNew) {
        await redis.incr(KEY.edgeCount(userId));
    }

    return { edge, created: isNew };
}

export async function getEdgesFromNode(
    redis: Redis,
    userId: string,
    nodeId: string
): Promise<GraphEdge[]> {
    const raw = await redis.get<string>(KEY.edges(userId, nodeId)).catch(() => null);
    if (!raw) return [];
    try {
        return typeof raw === "string" ? JSON.parse(raw) : (raw as GraphEdge[]);
    } catch {
        return [];
    }
}

export async function deleteNode(
    redis: Redis,
    userId: string,
    nodeIdOrLabel: string
): Promise<boolean> {
    const nodeId = slugify(nodeIdOrLabel);
    const node = await getNode(redis, userId, nodeId);
    if (!node) return false;

    await redis.del(KEY.node(userId, nodeId));
    await redis.del(KEY.edges(userId, nodeId));
    await redis.del(KEY.label(userId, node.label));
    await redis.srem(KEY.nodes(userId), nodeId);

    return true;
}

export async function listNodesForUser(
    redis: Redis,
    userId: string,
    limit = 50
): Promise<GraphNode[]> {
    const allIds = await redis.smembers(KEY.nodes(userId)).catch(() => [] as string[]);
    if (!allIds || allIds.length === 0) return [];

    const ids = (allIds as string[]).slice(0, limit);
    const raws = await Promise.all(
        ids.map((id) => redis.get<string>(KEY.node(userId, id)).catch(() => null))
    );

    const nodes: GraphNode[] = [];
    for (const raw of raws) {
        if (!raw) continue;
        try {
            const n: GraphNode = typeof raw === "string" ? JSON.parse(raw) : raw as GraphNode;
            n.freshness = freshness(n.updatedAt);
            nodes.push(n);
        } catch { /* skip malformed */ }
    }

    // Sort by most recently updated
    nodes.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return nodes;
}

// ─── Graph Traversal (BFS) ────────────────────────────────────────────────────

export async function traverseGraph(
    redis: Redis,
    userId: string,
    startNodeIdOrLabel: string,
    maxDepth = 2
): Promise<Subgraph> {
    const startId = slugify(startNodeIdOrLabel);
    const visitedNodes = new Map<string, GraphNode>();
    const allEdges: GraphEdge[] = [];
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startId, depth: 0 }];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const item = queue.shift()!;
        if (visited.has(item.nodeId) || item.depth > maxDepth) continue;
        visited.add(item.nodeId);

        // Load the node
        const node = await getNode(redis, userId, item.nodeId);
        if (!node) continue;
        visitedNodes.set(item.nodeId, node);

        // Load edges and queue neighbors
        if (item.depth < maxDepth) {
            const edges = await getEdgesFromNode(redis, userId, item.nodeId);
            for (const edge of edges) {
                allEdges.push(edge);
                if (!visited.has(edge.toId)) {
                    queue.push({ nodeId: edge.toId, depth: item.depth + 1 });
                }
            }
        }
    }

    return {
        rootNodeId: startId,
        nodes: Array.from(visitedNodes.values()),
        edges: allEdges,
        depth: maxDepth,
        totalNodes: visitedNodes.size,
        totalEdges: allEdges.length,
    };
}

// ─── Graph Insight Engine ─────────────────────────────────────────────────────

async function generateInsights(
    geminiApiKey: string,
    subgraph: Subgraph,
    userQuestion?: string
): Promise<GraphInsight[]> {
    const { think } = await import("../gemini");

    if (subgraph.nodes.length === 0) {
        return [];
    }

    // Build a human-readable description of the subgraph
    const nodeLines = subgraph.nodes.map((n) =>
        `  NODE [${n.type.toUpperCase()}] "${n.label}" = "${n.value}" (confidence: ${n.confidence}%, freshness: ${n.freshness})`
    );

    const edgeLines = subgraph.edges.map((e) => {
        const from = subgraph.nodes.find((n) => n.id === e.fromId)?.label ?? e.fromId;
        const to = subgraph.nodes.find((n) => n.id === e.toId)?.label ?? e.toId;
        return `  EDGE "${from}" --[${e.relation}]--> "${to}"${e.notes ? ` (${e.notes})` : ""}`;
    });

    const graphText = [
        "=== KNOWLEDGE GRAPH SUBGRAPH ===",
        ...nodeLines,
        "",
        "=== RELATIONSHIPS ===",
        ...edgeLines,
    ].join("\n");

    const prompt = `You are an expert analyst examining a user's personal knowledge graph.
Your job is to reason like a detective — traverse the connections, spot non-obvious consequences, stale information, needed actions, and hidden risks or opportunities.

${graphText}

${userQuestion ? `USER'S CURRENT QUESTION OR FOCUS: ${userQuestion}\n` : ""}

Analyze this graph and return a JSON array of insights. Each insight must have this exact shape:
{
  "type": "consequence" | "stale_data" | "action_required" | "connection" | "risk" | "opportunity",
  "priority": "high" | "medium" | "low",
  "title": "Short headline (max 10 words)",
  "detail": "Full explanation of the insight and why it matters (2-4 sentences)",
  "involvedNodes": ["Node Label 1", "Node Label 2"],
  "suggestedAction": "Concrete next step (optional, 1 sentence)"
}

Rules:
- Surface ONLY non-obvious insights. Don't just restate facts the user already knows.
- Prioritize insights that cross multiple nodes (the graph's value is in connections).
- Flag stale data (freshness: "aging" or "stale") only when it directly affects other nodes.
- Return 3-7 insights maximum. Quality over quantity.
- Return ONLY valid JSON array — no preamble, no markdown, no commentary.

If you cannot find meaningful insights, return [].`;

    const raw = await think(geminiApiKey, prompt, "You are a precise analytical system. Return only valid JSON arrays.");

    try {
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) return [];
        return JSON.parse(match[0]) as GraphInsight[];
    } catch {
        return [];
    }
}

// ─── Auto-Extraction (Called After Every Agent Turn) ─────────────────────────

/**
 * After every conversation turn, Gemini silently extracts entities and
 * relationships and upserts them into the user's world model graph.
 * This is called from src/agent.ts after the life-memory extraction.
 *
 * Designed to be fire-and-forget — failures never affect the user turn.
 */
export async function autoExtractWorldModel(
    env: Env,
    userId: string,
    userMessage: string,
    agentResponse: string
): Promise<void> {
    if (!env.GEMINI_API_KEY) return;

    const { think } = await import("../gemini");
    const redis = await getRedisHelper(env);

    // Check if graph is at capacity
    const existingNodes = await redis.smembers(KEY.nodes(userId)).catch(() => [] as string[]);
    if (existingNodes && existingNodes.length >= MAX_NODES_PER_USER) {
        console.log("[WorldModel] Node cap reached for user, skipping extraction");
        return;
    }

    const prompt = `You are extracting a knowledge graph from a conversation turn.
Identify entities (things, people, assets, projects, deadlines, facts, goals) and relationships between them.

User message: "${userMessage.slice(0, 400)}"
Agent response: "${agentResponse.slice(0, 600)}"

Return a JSON object with this EXACT shape:
{
  "entities": [
    {
      "label": "Human-readable name (e.g. 'My ETH Holdings', 'Tax Deadline 2025', 'Client Marcus')",
      "type": "asset" | "person" | "deadline" | "project" | "goal" | "fact" | "event" | "constraint" | "entity",
      "value": "Current state or value (e.g. '$12,000', 'April 15 2025', 'Needs follow-up')",
      "confidence": 60-95
    }
  ],
  "relations": [
    {
      "from": "Entity label exactly as written above",
      "to": "Entity label exactly as written above",
      "relation": "affects" | "owned_by" | "deadline_for" | "related_to" | "contacts" | "part_of" | "blocks" | "depends_on" | "triggers" | "assigned_to" | "measures",
      "notes": "Brief context for this connection (optional, 1 sentence)"
    }
  ]
}

Rules:
- Only extract entities that are SPECIFIC and MEANINGFUL (not generic words like "question" or "answer")
- Only extract relations that represent REAL dependencies or connections
- Minimum confidence: 60 (only include things you're fairly sure about)
- Maximum 8 entities and 10 relations per extraction
- If there's nothing meaningful to extract, return {"entities": [], "relations": []}
- Return ONLY valid JSON — no preamble, no markdown code fences`;

    let parsed: {
        entities: Array<{ label: string; type: NodeType; value: string; confidence: number }>;
        relations: Array<{ from: string; to: string; relation: EdgeRelation; notes?: string }>;
    };

    try {
        const raw = await think(
            env.GEMINI_API_KEY,
            prompt,
            "Return only valid JSON. No markdown. No commentary."
        );

        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return;
        parsed = JSON.parse(match[0]);
    } catch (e) {
        console.warn("[WorldModel AutoExtract] Parse failed:", String(e));
        return;
    }

    if (!Array.isArray(parsed.entities) || parsed.entities.length === 0) return;

    // Upsert nodes
    for (const entity of parsed.entities) {
        if (!entity.label || !entity.type) continue;
        try {
            await upsertNode(redis, userId, {
                label: entity.label,
                type: entity.type,
                value: entity.value ?? "",
                confidence: entity.confidence ?? 70,
                source: "auto",
                metadata: { extractedAt: new Date().toISOString() },
            });
        } catch (e) {
            console.warn("[WorldModel] Node upsert failed:", entity.label, String(e));
        }
    }

    // Create edges
    if (Array.isArray(parsed.relations)) {
        for (const rel of parsed.relations) {
            if (!rel.from || !rel.to || !rel.relation) continue;
            try {
                await connectNodes(redis, userId, rel.from, rel.to, rel.relation, {
                    weight: 0.75,
                    notes: rel.notes ?? "",
                });
            } catch (e) {
                console.warn("[WorldModel] Edge connect failed:", rel.from, "->", rel.to, String(e));
            }
        }
    }

    console.log(
        `[WorldModel] AutoExtract: ${parsed.entities.length} entities, ` +
        `${parsed.relations?.length ?? 0} relations for user ${userId}`
    );
}

// ─── Tool Executor ────────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

export async function execWorldModelTool(
    toolName: string,
    args: ToolArgs,
    env: Env,
    callerSessionId?: string
): Promise<Record<string, unknown>> {
    // Resolve userId from session
    let userId: string | null = null;
    if (callerSessionId) {
        const { getRedis } = await import("../memory");
        const redis = getRedis(env);
        userId = await redis.get<string>(`session:user-map:${callerSessionId}`).catch(() => null);
    }

    if (!userId) {
        return {
            error: "World model requires an authenticated session. No userId found.",
            hint: "This tool requires the user to be logged in via the web chat.",
        };
    }

    const redis = await getRedisHelper(env);

    switch (toolName) {

        // ── graph_node ─────────────────────────────────────────────────────────────
        case "graph_node": {
            const { action, label, type, value, confidence, metadata } = args as {
                action: "upsert" | "get" | "delete" | "list" | "search";
                label?: string;
                type?: NodeType;
                value?: string;
                confidence?: number;
                metadata?: Record<string, unknown>;
            };

            switch (action) {
                case "upsert": {
                    if (!label) return { error: "label is required for upsert" };
                    const node = await upsertNode(redis, userId, {
                        label,
                        type: type ?? "entity",
                        value: value ?? "",
                        confidence: confidence ?? 80,
                        source: "manual",
                        metadata: metadata ?? {},
                    });
                    return {
                        success: true,
                        node,
                        message: `Node "${label}" saved to your world model.`,
                    };
                }

                case "get": {
                    if (!label) return { error: "label is required for get" };
                    const node = await getNode(redis, userId, label);
                    if (!node) return { error: `No node found with label or ID "${label}"` };
                    return { node };
                }

                case "delete": {
                    if (!label) return { error: "label is required for delete" };
                    const deleted = await deleteNode(redis, userId, label);
                    return {
                        success: deleted,
                        message: deleted ? `Deleted "${label}" from world model.` : `Node "${label}" not found.`,
                    };
                }

                case "list": {
                    const nodes = await listNodesForUser(redis, userId, 100);
                    return {
                        nodes,
                        count: nodes.length,
                        breakdown: {
                            fresh: nodes.filter((n) => n.freshness === "fresh").length,
                            aging: nodes.filter((n) => n.freshness === "aging").length,
                            stale: nodes.filter((n) => n.freshness === "stale").length,
                            byType: nodes.reduce((acc, n) => {
                                acc[n.type] = (acc[n.type] ?? 0) + 1;
                                return acc;
                            }, {} as Record<string, number>),
                        },
                    };
                }

                case "search": {
                    if (!label) return { error: "label (search query) is required" };
                    const allNodes = await listNodesForUser(redis, userId, 200);
                    const q = label.toLowerCase();
                    const matches = allNodes.filter(
                        (n) =>
                            n.label.toLowerCase().includes(q) ||
                            n.value.toLowerCase().includes(q) ||
                            n.type.toLowerCase().includes(q)
                    );
                    return {
                        results: matches.slice(0, 20),
                        count: matches.length,
                        query: label,
                    };
                }

                default:
                    return { error: `Unknown action "${action}". Use: upsert, get, delete, list, search` };
            }
        }

        // ── graph_connect ──────────────────────────────────────────────────────────
        case "graph_connect": {
            const { from, to, relation, weight, notes } = args as {
                from: string;
                to: string;
                relation: EdgeRelation;
                weight?: number;
                notes?: string;
            };

            if (!from || !to || !relation) {
                return { error: "from, to, and relation are required" };
            }

            const { edge, created } = await connectNodes(redis, userId, from, to, relation, {
                weight: weight ?? 0.8,
                notes: notes ?? "",
            });

            return {
                success: true,
                edge,
                created,
                message: created
                    ? `Connected "${from}" --[${relation}]--> "${to}"`
                    : `Updated edge "${from}" --[${relation}]--> "${to}"`,
            };
        }

        // ── graph_traverse ─────────────────────────────────────────────────────────
        case "graph_traverse": {
            const { start, depth = 2 } = args as { start: string; depth?: number };

            if (!start) return { error: "start node label or ID is required" };

            const safeDepth = Math.min(Math.max(Number(depth) || 2, 1), 4);
            const subgraph = await traverseGraph(redis, userId, start, safeDepth);

            if (subgraph.nodes.length === 0) {
                return {
                    error: `Node "${start}" not found in world model`,
                    hint: "Use graph_node action=list to see all stored nodes",
                    isEmpty: true,
                };
            }

            // Format for readability
            const nodesSummary = subgraph.nodes.map((n) => ({
                label: n.label,
                type: n.type,
                value: n.value,
                freshness: n.freshness,
                confidence: n.confidence,
            }));

            const edgesSummary = subgraph.edges.map((e) => {
                const fromLabel = subgraph.nodes.find((n) => n.id === e.fromId)?.label ?? e.fromId;
                const toLabel = subgraph.nodes.find((n) => n.id === e.toId)?.label ?? e.toId;
                return { from: fromLabel, to: toLabel, relation: e.relation, notes: e.notes };
            });

            return {
                rootNode: subgraph.nodes[0]?.label ?? start,
                totalNodes: subgraph.totalNodes,
                totalEdges: subgraph.totalEdges,
                depth: safeDepth,
                nodes: nodesSummary,
                edges: edgesSummary,
            };
        }

        // ── graph_insight ──────────────────────────────────────────────────────────
        case "graph_insight": {
            const { start, question, depth = 3 } = args as {
                start?: string;
                question?: string;
                depth?: number;
            };

            if (!env.GEMINI_API_KEY) {
                return { error: "GEMINI_API_KEY not configured" };
            }

            let subgraph: Subgraph;

            if (start) {
                // Traverse from a specific node
                const safeDepth = Math.min(Math.max(Number(depth) || 3, 1), 4);
                subgraph = await traverseGraph(redis, userId, start, safeDepth);
            } else {
                // Use the full world model (up to 30 most-recently-updated nodes)
                const topNodes = await listNodesForUser(redis, userId, 30);
                if (topNodes.length === 0) {
                    return {
                        insights: [],
                        message: "Your world model is empty. Start chatting and I'll build it automatically.",
                    };
                }

                // For a full-graph insight, collect all edges across top nodes
                const allEdges: GraphEdge[] = [];
                for (const node of topNodes.slice(0, 15)) {
                    const edges = await getEdgesFromNode(redis, userId, node.id);
                    allEdges.push(...edges);
                }

                subgraph = {
                    rootNodeId: topNodes[0].id,
                    nodes: topNodes,
                    edges: allEdges,
                    depth: 2,
                    totalNodes: topNodes.length,
                    totalEdges: allEdges.length,
                };
            }

            if (subgraph.nodes.length === 0) {
                return {
                    insights: [],
                    message: start
                        ? `Node "${start}" not found. Use graph_node action=list to see stored nodes.`
                        : "World model is empty. I'll build it automatically as we talk.",
                };
            }

            const insights = await generateInsights(env.GEMINI_API_KEY, subgraph, question);

            return {
                insights,
                count: insights.length,
                nodesScanned: subgraph.totalNodes,
                edgesScanned: subgraph.totalEdges,
                focus: start ?? "full world model",
                message: insights.length > 0
                    ? `Found ${insights.length} insight${insights.length !== 1 ? "s" : ""} by traversing ${subgraph.totalNodes} connected nodes.`
                    : "No significant insights found in the current graph. Add more context and try again.",
            };
        }

        default:
            return { error: `Unknown world model tool: ${toolName}` };
    }
}

// ─── Tool Declarations (add to BUILTIN_DECLARATIONS in builtins.ts) ───────────

export const WORLD_MODEL_TOOL_DECLARATIONS = [
    {
        name: "graph_node",
        description: `Manage nodes in VEGA's Living World Model — a persistent knowledge graph of everything the user cares about.
Nodes are entities: people, assets, deadlines, projects, goals, facts, events, constraints.
Each node has a label, type, current value, confidence score, and freshness (auto-decays over time).
Actions:
  • "upsert" — create or update a node. Use whenever you learn something important about the user's world.
  • "get" — retrieve a specific node by label.
  • "list" — show all nodes with freshness/type breakdown.
  • "search" — find nodes by keyword.
  • "delete" — remove a node.
This is different from store_memory: graph_node stores entities with types and confidence, and can be traversed as a graph.`,
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["upsert", "get", "delete", "list", "search"],
                    description: "Operation to perform",
                },
                label: {
                    type: "string",
                    description: "Node name (e.g. 'My ETH Holdings', 'Tax Deadline 2025', 'Client Marcus'). Also used as search query for action=search.",
                },
                type: {
                    type: "string",
                    enum: ["asset", "person", "deadline", "project", "goal", "fact", "event", "constraint", "entity"],
                    description: "Entity type (required for upsert)",
                },
                value: {
                    type: "string",
                    description: "Current state/value of this node (e.g. '$12,400', 'April 15 2025', 'Awaiting response')",
                },
                confidence: {
                    type: "number",
                    description: "0-100: how confident you are this value is accurate and current. Default 80.",
                },
                metadata: {
                    type: "object",
                    description: "Optional extra data to attach to this node",
                },
            },
            required: ["action"],
        },
    },

    {
        name: "graph_connect",
        description: `Create or update a DIRECTIONAL relationship (edge) between two entities in the Living World Model.
This is what gives VEGA its power — not just storing facts, but connecting them so consequences can be traced.
Example connections:
  "My ETH Holdings" --[affects]--> "Tax Liability 2025"
  "Tax Liability 2025" --[deadline_for]--> "April 15 Deadline"
  "April 15 Deadline" --[contacts]--> "John the Accountant"
Once connected, graph_insight can traverse these chains and surface non-obvious consequences.
If either node doesn't exist yet, it will be auto-created as a stub.`,
        parameters: {
            type: "object",
            properties: {
                from: {
                    type: "string",
                    description: "Source node label (e.g. 'My ETH Holdings')",
                },
                to: {
                    type: "string",
                    description: "Target node label (e.g. 'Tax Liability 2025')",
                },
                relation: {
                    type: "string",
                    description: "Relationship type. Common: 'affects', 'owned_by', 'deadline_for', 'related_to', 'contacts', 'part_of', 'blocks', 'depends_on', 'triggers', 'assigned_to', 'measures'. Or any custom verb phrase.",
                },
                weight: {
                    type: "number",
                    description: "Strength of relationship 0-1. Default 0.8. Use lower values for weak/speculative connections.",
                },
                notes: {
                    type: "string",
                    description: "Optional context: e.g. 'ETH affects tax when portfolio value > $10k threshold'",
                },
            },
            required: ["from", "to", "relation"],
        },
    },

    {
        name: "graph_traverse",
        description: `Walk the Living World Model graph from a starting node outward by N hops (depth).
Returns all reachable nodes and edges, formatted as a human-readable subgraph.
Use this to understand everything connected to a topic before answering or making decisions.
Example: graph_traverse(start="My ETH Holdings", depth=2) returns ETH → portfolio → tax → deadline → accountant.
Depth 1 = immediate connections, Depth 2 = connections of connections (recommended), Depth 3-4 = deep chains.`,
        parameters: {
            type: "object",
            properties: {
                start: {
                    type: "string",
                    description: "Starting node label or ID to traverse from",
                },
                depth: {
                    type: "number",
                    description: "How many hops to traverse (1-4). Default 2. Depth 2 is usually ideal.",
                },
            },
            required: ["start"],
        },
    },

    {
        name: "graph_insight",
        description: `VEGA's most powerful intelligence tool — traverses the Living World Model and generates non-obvious insights by reasoning across ALL connected nodes simultaneously.
This is NOT a search. This is a detective analysis.
It traverses the knowledge graph, loads the full subgraph context, and asks:
  - What are the cascading consequences of current node states?
  - What data has gone stale and might be causing errors downstream?
  - What actions are implied but haven't been taken?
  - What hidden risks or opportunities does this graph reveal?
  - What connections exist that the user hasn't explicitly noticed?
Example output: "ETH is up 18% → portfolio likely above taxable threshold → tax deadline in 6 weeks → John (accountant) hasn't been contacted in 14 days → action required."
Use this whenever you want to proactively surface context the user hasn't asked about. Or when the user asks "what should I be aware of?" or "anything I'm missing?".
If 'start' is omitted, analyzes the entire world model.`,
        parameters: {
            type: "object",
            properties: {
                start: {
                    type: "string",
                    description: "Optional: start from a specific node and traverse outward. Omit to analyze the full world model.",
                },
                question: {
                    type: "string",
                    description: "Optional: a specific question or focus area to guide the insight analysis.",
                },
                depth: {
                    type: "number",
                    description: "Traversal depth for the insight analysis (1-4). Default 3.",
                },
            },
            required: [],
        },
    },
];