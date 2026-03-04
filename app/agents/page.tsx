"use client";

import { useState, useEffect, useCallback } from "react";

interface AgentConfig {
    name: string;
    allowedTools: string[] | null;
    memoryPrefix: string;
    notifyEmail: string | null;
    spawnedAt: string;
    parentAgent: string;
}

interface Agent {
    agentId: string;
    agentName: string;
    spawnedAt: string;
    status: "initializing" | "running" | "done" | "error" | "cancelled" | "scheduled";
    summary?: string;
    completedAt?: string;
    scheduledFor?: string | null;
    scheduledAt?: string;
    originalAgentId?: string;
    agentConfig?: AgentConfig;
    // Live task fields (merged from Redis task:*)
    taskStatus?: string;
    taskSummary?: string;
    progress?: string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
    running: { bg: "bg-blue-500/10", text: "text-blue-400", dot: "bg-blue-400 animate-pulse" },
    initializing: { bg: "bg-yellow-500/10", text: "text-yellow-400", dot: "bg-yellow-400 animate-pulse" },
    done: { bg: "bg-emerald-500/10", text: "text-emerald-400", dot: "bg-emerald-400" },
    error: { bg: "bg-red-500/10", text: "text-red-400", dot: "bg-red-500" },
    cancelled: { bg: "bg-zinc-600/20", text: "text-zinc-400", dot: "bg-zinc-500" },
    scheduled: { bg: "bg-violet-500/10", text: "text-violet-400", dot: "bg-violet-400" },
};

function StatusBadge({ status }: { status: string }) {
    const c = STATUS_COLORS[status] ?? STATUS_COLORS.initializing;
    return (
        <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
            {status}
        </span>
    );
}

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

export default function AgentsPage() {
    const [agents, setAgents] = useState<Agent[]>([]);
    const [filter, setFilter] = useState<string>("all");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [invoking, setInvoking] = useState<string | null>(null);
    const [invokeText, setInvokeText] = useState<Record<string, string>>({});
    const [showInvokeFor, setShowInvokeFor] = useState<string | null>(null);

    const fetchAgents = useCallback(async () => {
        try {
            const res = await fetch(`/api/agents?status=${filter}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as { agents: Agent[]; count: number };
            setAgents(data.agents ?? []);
            setError(null);
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [filter]);

    useEffect(() => { fetchAgents(); }, [fetchAgents]);

    // Auto-refresh every 6 seconds while any agent is running/initializing
    useEffect(() => {
        const hasActive = agents.some(a => a.status === "running" || a.status === "initializing");
        if (!hasActive) return;
        const id = setInterval(fetchAgents, 6000);
        return () => clearInterval(id);
    }, [agents, fetchAgents]);

    const handleInvoke = async (agentId: string) => {
        const instructions = invokeText[agentId];
        if (!instructions?.trim()) return;
        setInvoking(agentId);

        try {
            const res = await fetch(`/api/agents/${agentId}/invoke`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ instructions }),
            });
            const data = await res.json() as { success?: boolean; newTaskId?: string; error?: string };
            if (data.success) {
                setShowInvokeFor(null);
                setInvokeText(prev => ({ ...prev, [agentId]: "" }));
                setTimeout(fetchAgents, 1500);
            } else {
                alert(data.error ?? "Failed to invoke agent");
            }
        } catch (e) {
            alert(String(e));
        } finally {
            setInvoking(null);
        }
    };

    const filtered = filter === "all" ? agents : agents.filter(a => a.status === filter);

    return (
        <div className="min-h-screen bg-[#0a0a0f] text-white px-4 py-8">
            <div className="max-w-5xl mx-auto">

                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div>
                        <h1 className="text-2xl font-bold bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent">
                            Agents
                        </h1>
                        <p className="text-sm text-zinc-500 mt-1">
                            Spawned sub-agents — running, completed, and scheduled
                        </p>
                    </div>
                    <button
                        onClick={() => { setLoading(true); fetchAgents(); }}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Refresh
                    </button>
                </div>

                {/* Filter Tabs */}
                <div className="flex gap-1 mb-6 bg-zinc-900 rounded-lg p-1 w-fit">
                    {["all", "running", "initializing", "done", "error", "scheduled"].map(f => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${filter === f
                                    ? "bg-violet-600 text-white"
                                    : "text-zinc-400 hover:text-white"
                                }`}
                        >
                            {f}
                        </button>
                    ))}
                </div>

                {/* Content */}
                {loading && (
                    <div className="flex items-center justify-center py-24">
                        <div className="flex flex-col items-center gap-3">
                            <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                            <p className="text-zinc-500 text-sm">Loading agents…</p>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-red-400 text-sm">
                        ⚠️ {error}
                    </div>
                )}

                {!loading && !error && filtered.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center mb-4 text-3xl">🤖</div>
                        <p className="text-zinc-400 font-medium">No agents found</p>
                        <p className="text-zinc-600 text-sm mt-1">
                            {filter === "all"
                                ? "Ask VEGA to spawn a sub-agent to see it here."
                                : `No agents with status "${filter}".`}
                        </p>
                    </div>
                )}

                {!loading && filtered.length > 0 && (
                    <div className="space-y-3">
                        {filtered.map(agent => {
                            const color = STATUS_COLORS[agent.status] ?? STATUS_COLORS.initializing;
                            const isInvoking = invoking === agent.agentId;
                            const showInvoke = showInvokeFor === agent.agentId;
                            const canInvoke = agent.status === "done" || agent.status === "error" || agent.status === "cancelled";

                            return (
                                <div
                                    key={agent.agentId}
                                    className={`rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition-colors hover:border-zinc-700 ${agent.status === "running" ? "ring-1 ring-blue-500/20" : ""
                                        }`}
                                >
                                    <div className="flex items-start gap-4">
                                        {/* Icon */}
                                        <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${color.bg}`}>
                                            <span className="text-base">
                                                {agent.status === "done" ? "✅" :
                                                    agent.status === "error" ? "❌" :
                                                        agent.status === "scheduled" ? "⏰" :
                                                            agent.status === "cancelled" ? "🚫" :
                                                                "🤖"}
                                            </span>
                                        </div>

                                        {/* Main content */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-3 flex-wrap">
                                                <span className="font-semibold text-white truncate">{agent.agentName}</span>
                                                <StatusBadge status={agent.status} />
                                                {agent.originalAgentId && (
                                                    <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full">reinvoked</span>
                                                )}
                                                {agent.agentConfig?.allowedTools && (
                                                    <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full">
                                                        🔧 {agent.agentConfig.allowedTools.length} tools
                                                    </span>
                                                )}
                                            </div>

                                            {/* Scheduled */}
                                            {agent.status === "scheduled" && agent.scheduledAt && (
                                                <div className="mt-2 text-xs text-violet-400 bg-violet-500/10 rounded-lg px-3 py-1.5">
                                                    ⏰ Scheduled for: {new Date(agent.scheduledAt).toLocaleString()}
                                                </div>
                                            )}

                                            {/* Progress */}
                                            {(agent.status === "running" || agent.status === "initializing") && agent.progress && (
                                                <div className="mt-2 text-xs text-blue-400">{agent.progress}</div>
                                            )}

                                            {/* Summary */}
                                            {agent.summary && (
                                                <div className="mt-2 text-sm text-zinc-400 bg-zinc-800/50 rounded-lg px-3 py-2 leading-relaxed line-clamp-3">
                                                    {agent.summary}
                                                </div>
                                            )}

                                            {/* Memory namespace */}
                                            {agent.agentConfig?.memoryPrefix && (
                                                <div className="mt-2 font-mono text-xs text-zinc-600">
                                                    namespace: {agent.agentConfig.memoryPrefix}
                                                </div>
                                            )}

                                            {/* Meta */}
                                            <div className="flex items-center gap-3 mt-2">
                                                <span className="text-xs text-zinc-600">
                                                    Spawned {timeAgo(agent.spawnedAt)}
                                                </span>
                                                {agent.completedAt && (
                                                    <span className="text-xs text-zinc-600">
                                                        · Completed {timeAgo(agent.completedAt)}
                                                    </span>
                                                )}
                                                <span className="font-mono text-xs text-zinc-700 truncate max-w-[200px]">
                                                    {agent.agentId}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div className="flex-shrink-0 flex flex-col gap-2">
                                            {canInvoke && (
                                                <button
                                                    onClick={() => setShowInvokeFor(showInvoke ? null : agent.agentId)}
                                                    className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium transition-colors"
                                                >
                                                    ↩ Invoke
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Invoke form */}
                                    {showInvoke && (
                                        <div className="mt-4 border-t border-zinc-800 pt-4">
                                            <p className="text-xs text-zinc-500 mb-2">
                                                Assign a new task to <strong className="text-zinc-300">{agent.agentName}</strong>.
                                                It will resume with the same memory and tool access.
                                            </p>
                                            <div className="flex gap-2">
                                                <input
                                                    type="text"
                                                    value={invokeText[agent.agentId] ?? ""}
                                                    onChange={e => setInvokeText(prev => ({ ...prev, [agent.agentId]: e.target.value }))}
                                                    placeholder="New task instructions..."
                                                    className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                                                    onKeyDown={e => { if (e.key === "Enter") handleInvoke(agent.agentId); }}
                                                />
                                                <button
                                                    onClick={() => handleInvoke(agent.agentId)}
                                                    disabled={isInvoking || !invokeText[agent.agentId]?.trim()}
                                                    className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium transition-colors flex items-center gap-2"
                                                >
                                                    {isInvoking ? (
                                                        <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                                    ) : "Send"}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {!loading && filtered.length > 0 && (
                    <p className="text-center text-zinc-600 text-xs mt-6">
                        Showing {filtered.length} agents{filter !== "all" ? ` with status "${filter}"` : ""}
                    </p>
                )}
            </div>
        </div>
    );
}
