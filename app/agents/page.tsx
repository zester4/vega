"use client";

/**
 * app/agents/page.tsx — VEGA Sub-agents Dashboard
 *
 * Displays a list of all autonomous sub-agents spawned by the core agent.
 * Polling allows live status updates.
 */

import { useState, useEffect, useCallback } from "react";
import {
    BotIcon,
    RefreshCwIcon,
    ClockIcon,
    CheckCircle2Icon,
    XCircleIcon,
    PlayCircleIcon,
    ChevronRightIcon,
    SearchIcon,
    AlertCircleIcon,
    Trash2Icon,
    ExternalLinkIcon
} from "lucide-react";
import Link from "next/link";
// ─── Types ────────────────────────────────────────────────────────────────────

interface SubAgent {
    agentId: string;
    agentName: string;
    spawnedAt: string;
    status: "initializing" | "running" | "done" | "error" | "cancelled";
    completedAt?: string;
    summary?: string;
    progress?: string;
}

// ─── API Helper ───────────────────────────────────────────────────────────────

async function fetchAgents(status = "all"): Promise<SubAgent[]> {
    const res = await fetch(`/api/agents?status=${status}`);
    if (!res.ok) throw new Error("Failed to fetch agents");
    const data = await res.json() as { agents: SubAgent[] };
    return data.agents || [];
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AgentsPage() {
    const [agents, setAgents] = useState<SubAgent[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState("all");
    const [search, setSearch] = useState("");

    const loadData = useCallback(async () => {
        try {
            const data = await fetchAgents(filter);
            setAgents(data);
            setError(null);
        } catch (err) {
            setError(String(err));
        } finally {
            setLoading(false);
        }
    }, [filter]);

    // Initial load + Polling
    useEffect(() => {
        loadData();
        const interval = setInterval(loadData, 5000); // Poll every 5s
        return () => clearInterval(interval);
    }, [loadData]);

    const filteredAgents = agents
        .filter(a =>
            search === "" ||
            a.agentName.toLowerCase().includes(search.toLowerCase()) ||
            a.agentId.toLowerCase().includes(search.toLowerCase())
        )
        .sort((a, b) => new Date(b.spawnedAt).getTime() - new Date(a.spawnedAt).getTime());

    return (
        <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-[#e8e8ea] flex items-center gap-2">
                        <BotIcon className="size-6 text-[#00e5cc]" />
                        Sub-agents
                    </h1>
                    <p className="text-sm text-[#6b6b7a] mt-1">
                        Monitor and manage parallel autonomous tasks.
                    </p>
                </div>

                <div className="flex items-center gap-2">
                    <div className="relative">
                        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[#3a3a44]" />
                        <input
                            type="text"
                            placeholder="Search agents..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="bg-[#0a0a0b] border border-[#1e1e22] rounded-lg pl-9 pr-4 py-2 text-sm text-[#e8e8ea] focus:outline-none focus:border-[#00e5cc]/50 w-full md:w-64"
                        />
                    </div>
                    <button
                        onClick={() => { setLoading(true); loadData(); }}
                        className="p-2 rounded-lg border border-[#1e1e22] bg-[#0a0a0b] hover:bg-[#1e1e22] transition-colors group"
                        title="Refresh list"
                    >
                        <RefreshCwIcon className={`size-4 text-[#6b6b7a] group-hover:text-[#e8e8ea] ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center gap-1 border-b border-[#1e1e22]">
                {["all", "running", "done", "error"].map((f) => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 capitalize ${filter === f
                            ? "text-[#00e5cc] border-[#00e5cc]"
                            : "text-[#6b6b7a] border-transparent hover:text-[#e8e8ea]"
                            }`}
                    >
                        {f}
                    </button>
                ))}
            </div>

            {/* Error State */}
            {error && (
                <div className="p-4 rounded-xl bg-red-500/5 border border-red-500/20 flex items-center gap-3 text-red-400">
                    <AlertCircleIcon className="size-5 shrink-0" />
                    <p className="text-sm">{error}</p>
                    <button onClick={loadData} className="ml-auto text-xs underline font-medium">Retry</button>
                </div>
            )}

            {/* Agents Grid */}
            {loading && agents.length === 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="h-48 rounded-xl border border-[#1e1e22] bg-[#0d0d10] animate-pulse" />
                    ))}
                </div>
            ) : filteredAgents.length === 0 ? (
                <div className="py-20 text-center rounded-xl border border-[#1e1e22] border-dashed">
                    <BotIcon className="size-12 text-[#1e1e22] mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-[#e8e8ea]">No sub-agents found</h3>
                    <p className="text-sm text-[#6b6b7a] mt-1">
                        Spawn an agent in chat using "spawn a sub-agent to..."
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredAgents.map((agent) => (
                        <AgentCard key={agent.agentId} agent={agent} />
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Agent Card Component ──────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: SubAgent }) {
    const isRunning = agent.status === "running" || agent.status === "initializing";
    const isDone = agent.status === "done";
    const isError = agent.status === "error";
    const isCancelled = agent.status === "cancelled";

    return (
        <div className="group relative flex flex-col rounded-xl border border-[#1e1e22] bg-[#0d0d10] hover:border-[#3a3a44] transition-all overflow-hidden">
            {/* Top section: Status & Icon */}
            <div className="p-5 flex items-start justify-between">
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${isRunning ? "bg-blue-500/10 text-blue-400" :
                        isDone ? "bg-emerald-500/10 text-emerald-400" :
                            isError ? "bg-red-500/10 text-red-400" :
                                "bg-[#1e1e22] text-[#6b6b7a]"
                        }`}>
                        <BotIcon className="size-5" />
                    </div>
                    <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-[#e8e8ea] truncate">
                            {agent.agentName}
                        </h3>
                        <p className="text-[10px] text-[#4a4a58] font-mono truncate">
                            {agent.agentId}
                        </p>
                    </div>
                </div>

                <StatusBadge status={agent.status} />
            </div>

            {/* Middle section: Info */}
            <div className="px-5 py-2 flex-1 space-y-3">
                <div className="flex items-center gap-1.5 text-xs text-[#6b6b7a]">
                    <ClockIcon className="size-3" />
                    <span>Spawned {formatRelativeTime(agent.spawnedAt)}</span>
                </div>

                {isRunning && agent.progress && (
                    <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                            <span className="text-[10px] font-medium text-[#6b6b7a] uppercase tracking-wider">Progress</span>
                            <span className="text-[10px] font-bold text-[#00e5cc]">{agent.progress}</span>
                        </div>
                        <div className="h-1.5 w-full bg-[#1e1e22] rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-[#00e5cc] to-[#22d3ee] transition-all duration-1000 ease-in-out shadow-[0_0_8px_rgba(0,229,204,0.4)]"
                                style={{ width: agent.progress.includes('%') ? agent.progress : '10%' }}
                            />
                        </div>
                    </div>
                )}

                {agent.summary && (
                    <div className="p-3 rounded-lg bg-[#0a0a0b] border border-[#1e1e22] group-hover:border-[#1e1e22] transition-colors">
                        <p className="text-xs text-[#6b6b7a] line-clamp-3 leading-relaxed italic">
                            "{agent.summary}"
                        </p>
                    </div>
                )}
            </div>

            {/* Bottom section: Actions */}
            <div className="p-4 mt-auto border-t border-[#1e1e22] bg-[#0a0a0b]/50 flex items-center justify-between gap-2">
                <Link
                    href={`/task/${agent.agentId}`}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1e1e22] hover:bg-[#2a2a30] text-xs font-medium text-[#e8e8ea] transition-colors"
                >
                    View Log <ChevronRightIcon className="size-3" />
                </Link>

                {isRunning && (
                    <button className="p-1.5 rounded-md border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-colors" title="Cancel Agent">
                        <XCircleIcon className="size-4" />
                    </button>
                )}
            </div>
        </div>
    );
}

function StatusBadge({ status }: { status: SubAgent["status"] }) {
    const configs: Record<string, { icon: any, color: string, label: string, animate?: boolean }> = {
        initializing: { icon: ClockIcon, color: "text-blue-400 bg-blue-400/10 border-blue-400/20", label: "Initial" },
        running: { icon: RefreshCwIcon, color: "text-blue-400 bg-blue-400/10 border-blue-400/20", label: "Running", animate: true },
        done: { icon: CheckCircle2Icon, color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20", label: "Success" },
        error: { icon: XCircleIcon, color: "text-red-400 bg-red-400/10 border-red-400/20", label: "Failed" },
        cancelled: { icon: PlayCircleIcon, color: "text-[#6b6b7a] bg-[#1e1e22] border-[#2a2a30]", label: "Stopped" },
    };

    const config = configs[status] || configs.initializing;
    const Icon = config.icon;

    return (
        <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${config.color}`}>
            <Icon className={`size-2.5 ${config.animate ? 'animate-spin' : ''}`} />
            {config.label}
        </div>
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(date: string | number | Date): string {
    const d = new Date(date);
    const diff = Date.now() - d.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return `${seconds}s ago`;
}
