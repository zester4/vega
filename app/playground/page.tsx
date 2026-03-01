//app/playground/page.tsx
"use client";

import { useState } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  RocketIcon,
  Settings2Icon,
  ZapIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { motion } from "motion/react";

interface SpawnResponse {
  success?: boolean;
  agentId?: string;
  agentName?: string;
  message?: string;
  error?: string;
}

export default function AgentPlaygroundPage() {
  const [agentName, setAgentName] = useState("researcher");
  const [instructions, setInstructions] = useState(
    "Act as a senior research agent. Deeply investigate the user's topic using web_search, browse_web, and semantic memory, then produce a structured report."
  );
  const [allowedTools, setAllowedTools] = useState(
    "web_search,browse_web,fetch_url,semantic_store,semantic_recall,write_file"
  );
  const [memoryPrefix, setMemoryPrefix] = useState("playground-researcher");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [priority, setPriority] = useState<"normal" | "high">("normal");
  const [topic, setTopic] = useState("");

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SpawnResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSpawn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const payload = {
        agentName: agentName.trim(),
        instructions:
          topic.trim().length > 0
            ? `${instructions.trim()}\n\nUser topic: ${topic.trim()}`
            : instructions.trim(),
        allowedTools: allowedTools
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        memoryPrefix: memoryPrefix.trim() || undefined,
        notifyEmail: notifyEmail.trim() || undefined,
        priority,
      };

      const res = await fetch("/api/agents/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as SpawnResponse;
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResult(data);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to spawn agent");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin bg-[#0a0a0b]">
      <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-2"
        >
          <div className="flex items-center gap-2">
            <RocketIcon className="size-5 sm:size-6 text-[#00e5cc]" />
            <h1 className="text-xl sm:text-2xl font-bold text-[#e8e8ea]">
              Agent Playground
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-[#6b6b7a] max-w-xl">
            Spin up isolated sub-agents with their own memory namespace and
            tool permissions, then monitor them in the{" "}
            <span className="font-semibold text-[#e8e8ea]">Sub-agents</span>{" "}
            and{" "}
            <span className="font-semibold text-[#e8e8ea]">
              Mission Control
            </span>{" "}
            dashboards.
          </p>
        </motion.div>

        {/* Form */}
        <motion.form
          onSubmit={handleSpawn}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-5 rounded-xl border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-md p-5 sm:p-6 shadow-sm"
        >
          {/* Basic configuration */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-[#6b6b7a]">
              <Settings2Icon className="size-4" />
              <span className="font-semibold uppercase tracking-wide">
                Agent Configuration
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-[#e8e8ea]">
                  Agent name
                </label>
                <input
                  type="text"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-[#0d0d10] border border-[#1e1e22] text-[12px] text-[#e8e8ea] placeholder-[#3a3a44] focus:outline-none focus:border-[#00e5cc]/50"
                />
                <p className="text-[10px] text-[#6b6b7a]">
                  Used in prompts and dashboards (e.g. researcher, coder).
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-[#e8e8ea]">
                  Memory namespace
                </label>
                <input
                  type="text"
                  value={memoryPrefix}
                  onChange={(e) => setMemoryPrefix(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-[#0d0d10] border border-[#1e1e22] text-[12px] text-[#e8e8ea] placeholder-[#3a3a44] focus:outline-none focus:border-[#00e5cc]/50"
                  placeholder="playground-researcher"
                />
                <p className="text-[10px] text-[#6b6b7a]">
                  Prefix used for this agent&apos;s long-term memories.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-[#e8e8ea]">
                Core instructions
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 rounded-lg bg-[#0d0d10] border border-[#1e1e22] text-[12px] text-[#e8e8ea] placeholder-[#3a3a44] focus:outline-none focus:border-[#00e5cc]/50 resize-none"
              />
              <p className="text-[10px] text-[#6b6b7a]">
                Describe what this agent should do autonomously and what
                outputs it should produce.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-[#e8e8ea]">
                Optional topic / task
              </label>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder='e.g. "State of autonomous agents in 2026"'
                className="w-full px-3 py-1.5 rounded-lg bg-[#0d0d10] border border-[#1e1e22] text-[12px] text-[#e8e8ea] placeholder-[#3a3a44] focus:outline-none focus:border-[#00e5cc]/50"
              />
              <p className="text-[10px] text-[#6b6b7a]">
                This is appended to the instructions so you can quickly spawn
                new runs for different topics.
              </p>
            </div>
          </div>

          {/* Tools & notifications */}
          <div className="space-y-3 pt-2 border-t border-[#1e1e22]">
            <div className="flex items-center gap-2 text-xs text-[#6b6b7a]">
              <ZapIcon className="size-4" />
              <span className="font-semibold uppercase tracking-wide">
                Tools & Notifications
              </span>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-[#e8e8ea]">
                Allowed tools (comma-separated)
              </label>
              <input
                type="text"
                value={allowedTools}
                onChange={(e) => setAllowedTools(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg bg-[#0d0d10] border border-[#1e1e22] text-[12px] text-[#e8e8ea] placeholder-[#3a3a44] focus:outline-none focus:border-[#00e5cc]/50 font-mono"
              />
              <p className="text-[10px] text-[#6b6b7a]">
                Leave as-is for a focused research agent, or broaden it with
                tools like <code>run_code</code>, <code>github</code>, etc.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-[#e8e8ea]">
                  Notify email (optional)
                </label>
                <input
                  type="email"
                  value={notifyEmail}
                  onChange={(e) => setNotifyEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-1.5 rounded-lg bg-[#0d0d10] border border-[#1e1e22] text-[12px] text-[#e8e8ea] placeholder-[#3a3a44] focus:outline-none focus:border-[#00e5cc]/50"
                />
                <p className="text-[10px] text-[#6b6b7a]">
                  If set, the agent emails you when it finishes.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-[#e8e8ea]">
                  Priority
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPriority("normal")}
                    className={`flex-1 px-3 py-1.5 rounded-lg border text-[11px] ${
                      priority === "normal"
                        ? "border-[#00e5cc] text-[#00e5cc]"
                        : "border-[#1e1e22] text-[#6b6b7a]"
                    }`}
                  >
                    Normal
                  </button>
                  <button
                    type="button"
                    onClick={() => setPriority("high")}
                    className={`flex-1 px-3 py-1.5 rounded-lg border text-[11px] ${
                      priority === "high"
                        ? "border-amber-400 text-amber-300"
                        : "border-[#1e1e22] text-[#6b6b7a]"
                    }`}
                  >
                    High
                  </button>
                </div>
                <p className="text-[10px] text-[#6b6b7a]">
                  High priority agents are scheduled with minimal delay.
                </p>
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="flex items-center justify-between pt-3">
            <div className="flex items-center gap-2 text-[10px] text-[#4a4a58]">
              <AlertTriangleIcon className="size-3.5" />
              <span>
                Agents run autonomously via Upstash Workflow. Monitor them in{" "}
                <span className="font-semibold text-[#e8e8ea]">/agents</span>{" "}
                and{" "}
                <span className="font-semibold text-[#e8e8ea]">/tasks</span>.
              </span>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#00e5cc] hover:bg-[#00cbb5] text-[#0a0a0b] text-xs font-semibold tracking-wide uppercase shadow-sm disabled:opacity-50"
            >
              <BotIcon className="size-3.5" />
              {busy ? "Spawning…" : "Spawn Agent"}
              <ChevronRightIcon className="size-3" />
            </button>
          </div>

          {error && (
            <div className="mt-3 text-[11px] text-red-400 flex items-center gap-1.5">
              <AlertTriangleIcon className="size-3" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="mt-3 text-[11px] text-[#e8e8ea] bg-[#0d0d10] border border-[#1e1e22] rounded-lg px-3 py-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BotIcon className="size-3.5 text-[#00e5cc]" />
                <div>
                  <p className="font-semibold">
                    Spawned agent{" "}
                    <span className="text-[#00e5cc]">
                      {result.agentName ?? agentName}
                    </span>
                  </p>
                  {result.agentId && (
                    <p className="text-[10px] text-[#6b6b7a]">
                      ID:{" "}
                      <span className="font-mono">
                        {result.agentId}
                      </span>
                    </p>
                  )}
                </div>
              </div>
              <a
                href="/agents"
                className="inline-flex items-center gap-1 text-[10px] text-[#00e5cc] hover:text-[#7ce7db] transition-colors"
              >
                View in dashboard
                <ChevronRightIcon className="size-3" />
              </a>
            </div>
          )}
        </motion.form>
      </div>
    </div>
  );
}

