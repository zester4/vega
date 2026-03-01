//app/tasks/page.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ActivityIcon,
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  ClockIcon,
  RefreshCwIcon,
  XCircleIcon,
  CalendarClockIcon,
  ListOrderedIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface AgentTask {
  id: string;
  type: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled" | "error";
  createdAt: number;
  result?: unknown;
  error?: string;
}

interface AgentSchedule {
  scheduleId: string;
  cron: string;
  description: string;
  url?: string;
  body?: string;
  createdAt?: string;
}

interface ApprovalRecord {
  id: string;
  operation: string;
  channel: string;
  status: "pending" | "approved" | "rejected";
  metadata?: unknown;
  createdAt: string;
  decidedAt?: string;
  approved?: boolean;
  reason?: string;
}

export default function TasksDashboardPage() {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AgentTask["status"]>("all");
  const [approvalsFilter, setApprovalsFilter] = useState<
    "all" | "pending" | "approved" | "rejected"
  >("pending");
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tasksRes, schedulesRes, approvalsRes] = await Promise.all([
        fetch(`/api/tasks?status=all`),
        fetch(`/api/schedules`),
        fetch(`/api/approvals?status=all`),
      ]);

      let allFailed = true;

      if (tasksRes.ok) {
        const tasksJson = (await tasksRes.json()) as { tasks: AgentTask[] };
        setTasks(tasksJson.tasks ?? []);
        allFailed = false;
      } else {
        console.error("Failed to load tasks:", tasksRes.status, tasksRes.statusText);
      }

      if (schedulesRes.ok) {
        const schedulesJson = (await schedulesRes.json()) as {
          schedules: AgentSchedule[];
        };
        setSchedules(schedulesJson.schedules ?? []);
        allFailed = false;
      } else {
        console.error("Failed to load schedules:", schedulesRes.status, schedulesRes.statusText);
      }

      if (approvalsRes.ok) {
        const approvalsJson = (await approvalsRes.json()) as {
          approvals: ApprovalRecord[];
        };
        setApprovals(approvalsJson.approvals ?? []);
        allFailed = false;
      } else {
        console.error("Failed to load approvals:", approvalsRes.status, approvalsRes.statusText);
      }

      if (allFailed) {
        throw new Error("Failed to load mission control data from the worker");
      }
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error ? err.message : "Failed to load mission control data"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 8000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleApprovalDecision = async (
    id: string,
    approved: boolean,
    reason?: string
  ) => {
    setDecidingId(id);
    try {
      const res = await fetch(`/api/approvals/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, reason }),
      });
      if (!res.ok) throw new Error("Failed to record approval decision");
      const data = (await res.json()) as { approval: ApprovalRecord };
      setApprovals((prev) =>
        prev.map((a) => (a.id === id ? data.approval : a))
      );
    } catch (err) {
      console.error(err);
      alert(
        err instanceof Error
          ? err.message
          : "Failed to record approval decision"
      );
    } finally {
      setDecidingId(null);
    }
  };

  const filteredTasks =
    filter === "all"
      ? tasks
      : tasks.filter((t) => t.status === filter).slice().sort((a, b) => b.createdAt - a.createdAt);

  const filteredApprovals =
    approvalsFilter === "all"
      ? approvals
      : approvals.filter((a) => a.status === approvalsFilter);

  const pendingApprovals = approvals.filter((a) => a.status === "pending")
    .length;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin bg-[#0a0a0b]">
      <div className="max-w-6xl mx-auto px-4 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-[#e8e8ea] flex items-center gap-2">
              <ActivityIcon className="size-5 sm:size-6 text-[#00e5cc]" />
              Mission Control
            </h1>
            <p className="text-xs sm:text-sm text-[#6b6b7a] mt-1">
              Live view of workflows, sub-agents, cron jobs, and human approvals.
            </p>
          </div>
          <button
            onClick={loadData}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[#111113] border border-[#1e1e22] text-[#e8e8ea] hover:bg-[#1a1a1f] hover:border-[#3a3a44] transition-all disabled:opacity-50 text-sm shadow-sm"
          >
            <RefreshCwIcon
              className={`size-4 ${
                loading ? "animate-spin text-[#00e5cc]" : "text-[#6b6b7a]"
              }`}
            />
            Refresh
          </button>
        </motion.div>

        {error && (
          <div className="p-4 rounded-xl bg-red-500/5 border border-red-500/20 flex items-center gap-3 text-red-400">
            <AlertTriangleIcon className="size-5 shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* Top summary cards */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4"
        >
          <SummaryCard
            icon={<ListOrderedIcon className="size-4" />}
            label="Total Tasks"
            value={tasks.length}
            tone="neutral"
          />
          <SummaryCard
            icon={<ClockIcon className="size-4" />}
            label="Running"
            value={tasks.filter((t) => t.status === "running").length}
            tone="info"
          />
          <SummaryCard
            icon={<CalendarClockIcon className="size-4" />}
            label="Cron Jobs"
            value={schedules.length}
            tone="neutral"
          />
          <SummaryCard
            icon={<ShieldCheckIcon className="size-4" />}
            label="Pending Approvals"
            value={pendingApprovals}
            tone={pendingApprovals > 0 ? "warn" : "success"}
          />
        </motion.div>

        {/* Main grid: tasks + schedules + approvals */}
        <div className="grid grid-cols-1 lg:grid-cols-[2fr,1.2fr] gap-6 sm:gap-8">
          {/* Tasks panel */}
          <motion.section
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <BotIcon className="size-4 text-[#00e5cc]" />
                <h2 className="text-sm sm:text-base font-semibold text-[#e8e8ea]">
                  Long-running Tasks
                </h2>
              </div>
              <div className="flex items-center gap-1 border border-[#1e1e22] rounded-full bg-[#111113]/80 px-1">
                {["all", "running", "done", "failed"].map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f as any)}
                    className={`px-3 py-1 text-[11px] rounded-full transition-colors ${
                      filter === f
                        ? "bg-[#00e5cc] text-[#0a0a0b] font-semibold"
                        : "text-[#6b6b7a] hover:text-[#e8e8ea]"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-md min-h-[220px]">
              {loading && filteredTasks.length === 0 ? (
                <div className="flex items-center justify-center h-[220px]">
                  <RefreshCwIcon className="size-5 text-[#00e5cc] animate-spin" />
                </div>
              ) : filteredTasks.length === 0 ? (
                <div className="p-6 text-center text-xs text-[#6b6b7a]">
                  No tasks found for this filter.
                </div>
              ) : (
                <div className="divide-y divide-[#1e1e22]/80">
                  <AnimatePresence>
                    {filteredTasks
                      .slice()
                      .sort((a, b) => b.createdAt - a.createdAt)
                      .map((task) => (
                        <TaskRow key={task.id} task={task} />
                      ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          </motion.section>

          {/* Right column: schedules + approvals */}
          <div className="space-y-6">
            {/* Cron schedules */}
            <motion.section
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-3"
            >
              <div className="flex items-center gap-2">
                <CalendarClockIcon className="size-4 text-[#00e5cc]" />
                <h2 className="text-sm sm:text-base font-semibold text-[#e8e8ea]">
                  Cron Jobs
                </h2>
              </div>
              <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-md min-h-[120px]">
                {schedules.length === 0 ? (
                  <div className="p-6 text-xs text-[#6b6b7a]">
                    No cron jobs registered yet. Use{" "}
                    <code className="font-mono text-[#00e5cc]">
                      schedule_cron
                    </code>{" "}
                    or the agent to create one.
                  </div>
                ) : (
                  <div className="divide-y divide-[#1e1e22]/80 text-xs">
                    {schedules.map((s) => (
                      <div
                        key={s.scheduleId}
                        className="px-4 py-3 flex items-start justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-[11px] text-[#6b6b7a]">
                            {s.cron}
                          </p>
                          <p className="text-[#e8e8ea] text-xs mt-0.5 line-clamp-2">
                            {s.description}
                          </p>
                          {s.url && (
                            <p className="text-[10px] text-[#4a4a58] mt-0.5 truncate">
                              {s.url}
                            </p>
                          )}
                        </div>
                        <span className="text-[10px] text-[#3a3a44] font-mono">
                          {shortId(s.scheduleId)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.section>

            {/* Approvals */}
            <motion.section
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ShieldCheckIcon className="size-4 text-[#00e5cc]" />
                  <h2 className="text-sm sm:text-base font-semibold text-[#e8e8ea]">
                    Human Approvals
                  </h2>
                </div>
                <div className="flex items-center gap-1 border border-[#1e1e22] rounded-full bg-[#111113]/80 px-1">
                  {["pending", "approved", "rejected", "all"].map((f) => (
                    <button
                      key={f}
                      onClick={() => setApprovalsFilter(f as any)}
                      className={`px-2.5 py-0.5 text-[10px] rounded-full transition-colors ${
                        approvalsFilter === f
                          ? "bg-[#00e5cc] text-[#0a0a0b] font-semibold"
                          : "text-[#6b6b7a] hover:text-[#e8e8ea]"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-md min-h-[140px]">
                {filteredApprovals.length === 0 ? (
                  <div className="p-6 text-xs text-[#6b6b7a]">
                    No approval requests yet.
                  </div>
                ) : (
                  <div className="divide-y divide-[#1e1e22]/80 text-xs">
                    {filteredApprovals.map((a) => (
                      <div
                        key={a.id}
                        className="px-4 py-3 space-y-1.5 border-l-2 border-l-transparent"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] text-[#6b6b7a]">
                            {shortId(a.id)}
                          </span>
                          <StatusBadge status={a.status} small />
                        </div>
                        <p className="text-[#e8e8ea] text-xs line-clamp-3 whitespace-pre-wrap">
                          {a.operation}
                        </p>
                        <div className="flex items-center justify-between gap-2 mt-1.5">
                          <span className="text-[10px] text-[#4a4a58]">
                            {a.channel.toUpperCase()} •{" "}
                            {formatRelativeTime(a.createdAt)}
                          </span>
                          {a.status === "pending" && (
                            <div className="flex items-center gap-1.5">
                              <button
                                disabled={decidingId === a.id}
                                onClick={() =>
                                  handleApprovalDecision(a.id, false)
                                }
                                className="px-2 py-1 rounded-md border border-red-500/30 text-[10px] text-red-400 hover:bg-red-500/10 transition-colors"
                              >
                                {decidingId === a.id ? "..." : "Reject"}
                              </button>
                              <button
                                disabled={decidingId === a.id}
                                onClick={() =>
                                  handleApprovalDecision(a.id, true)
                                }
                                className="px-2 py-1 rounded-md border border-emerald-500/30 text-[10px] text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                              >
                                {decidingId === a.id ? "..." : "Approve"}
                              </button>
                            </div>
                          )}
                          {a.status !== "pending" && a.reason && (
                            <span className="text-[10px] text-[#8b8b9a] italic">
                              {a.reason}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.section>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "neutral" | "info" | "warn" | "success";
}) {
  const toneClasses =
    tone === "info"
      ? "border-blue-500/30 bg-blue-500/5"
      : tone === "warn"
      ? "border-amber-500/30 bg-amber-500/5"
      : tone === "success"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : "border-[#1e1e22] bg-[#111113]/80";

  return (
    <div
      className={`rounded-xl border ${toneClasses} px-4 py-3 flex items-center justify-between gap-3`}
    >
      <div className="flex items-center gap-2 text-[#6b6b7a] text-[11px]">
        {icon}
        <span>{label}</span>
      </div>
      <span className="text-lg font-bold text-[#e8e8ea]">{value}</span>
    </div>
  );
}

function TaskRow({ task }: { task: AgentTask }) {
  const created = new Date(task.createdAt);
  const status = task.status;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      className="px-4 py-3 flex items-start justify-between gap-3 hover:bg-[#0d0d10] transition-colors"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-[#e8e8ea]">
            {task.type}
          </span>
          <StatusBadge status={status} />
        </div>
        <p className="font-mono text-[11px] text-[#6b6b7a]">
          {shortId(task.id)}
        </p>
        {task.error && (
          <p className="text-[11px] text-red-400 mt-1 line-clamp-2">
            {task.error}
          </p>
        )}
      </div>
      <div className="text-right text-[10px] text-[#4a4a58] font-mono">
        <div>{created.toLocaleDateString()}</div>
        <div>{created.toLocaleTimeString()}</div>
      </div>
    </motion.div>
  );
}

function StatusBadge({
  status,
  small,
}: {
  status: AgentTask["status"] | "pending" | "approved" | "rejected";
  small?: boolean;
}) {
  const map: Record<
    string,
    { label: string; color: string; icon: React.ComponentType<any> }
  > = {
    pending: {
      label: "Pending",
      color: "text-amber-400 bg-amber-500/10 border-amber-500/30",
      icon: ClockIcon,
    },
    running: {
      label: "Running",
      color: "text-blue-400 bg-blue-500/10 border-blue-500/30",
      icon: RefreshCwIcon,
    },
    done: {
      label: "Done",
      color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
      icon: CheckCircle2Icon,
    },
    failed: {
      label: "Failed",
      color: "text-red-400 bg-red-500/10 border-red-500/30",
      icon: XCircleIcon,
    },
    error: {
      label: "Error",
      color: "text-red-400 bg-red-500/10 border-red-500/30",
      icon: XCircleIcon,
    },
    cancelled: {
      label: "Cancelled",
      color: "text-[#6b6b7a] bg-[#1e1e22] border-[#2a2a30]",
      icon: XCircleIcon,
    },
    approved: {
      label: "Approved",
      color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
      icon: CheckCircle2Icon,
    },
    rejected: {
      label: "Rejected",
      color: "text-red-400 bg-red-500/10 border-red-500/30",
      icon: XCircleIcon,
    },
  };

  const cfg = map[status] ?? map.pending;
  const Icon = cfg.icon;

  return (
    <span
      className={`inline-flex items-center gap-1 border rounded-full ${
        small ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-[10px]"
      } font-semibold uppercase tracking-wide ${cfg.color}`}
    >
      <Icon className={`size-3 ${status === "running" ? "animate-spin" : ""}`} />
      {cfg.label}
    </span>
  );
}

function shortId(id: string): string {
  if (!id) return "";
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

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

