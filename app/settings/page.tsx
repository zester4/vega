//src/app/settings/page.tsx
"use client";

/**
 * app/settings/page.tsx — VEGA Settings
 *
 * Sections:
 *   1. Telegram Integration — paste bot token → connect → live status + activity feed
 *   2. Agent Configuration  — system prompt, model settings (future)
 *   3. Danger Zone          — reset all memory, clear history
 *
 * Telegram Connect Flow:
 *   1. User creates a bot via @BotFather, copies the token
 *   2. Pastes token here → clicks Connect
 *   3. Frontend POSTs to /api/telegram/setup (Next.js proxy → Worker)
 *   4. Worker validates token, calls setWebhook, stores config in Redis
 *   5. Status card shows bot username, webhook URL, message count
 *   6. Activity feed polls /api/telegram/activity every 10s
 */

import { useState, useEffect, useCallback } from "react";
import {
  BotIcon,
  SendIcon,
  CheckCircleIcon,
  XCircleIcon,
  RefreshCwIcon,
  Trash2Icon,
  AlertTriangleIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  ZapIcon,
  MessageSquareIcon,
  ClockIcon,
  WifiIcon,
  WifiOffIcon,
  CopyIcon,
  CheckIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// ─── API helper ───────────────────────────────────────────────────────────────

async function api<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TelegramStatus {
  connected: boolean;
  bot?: {
    id: number;
    username: string;
    firstName: string;
  };
  webhookUrl?: string;
  connectedAt?: string;
  pendingUpdates?: number;
  lastError?: string | null;
  activityCount?: number;
}

interface ActivityItem {
  chatId: number;
  username: string;
  firstName?: string;
  messagePreview: string;
  replyPreview: string;
  ts: number;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await api<TelegramStatus>("GET", "/telegram/status");
      setTelegramStatus(status);
    } catch {
      setTelegramStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchActivity = useCallback(async () => {
    try {
      const data = await api<{ activity: ActivityItem[] }>("GET", "/telegram/activity");
      setActivity(data.activity ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchActivity();

    // Poll for live updates
    const statusInterval = setInterval(fetchStatus, 15_000);
    const activityInterval = setInterval(fetchActivity, 10_000);
    return () => {
      clearInterval(statusInterval);
      clearInterval(activityInterval);
    };
  }, [fetchStatus, fetchActivity]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <RefreshCwIcon className="size-6 text-[#00e5cc] animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-2xl mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-6 sm:space-y-8">

        {/* Page header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <h1 className="text-xl sm:text-2xl font-bold text-[#e8e8ea]">Settings</h1>
          <p className="text-xs sm:text-sm text-[#6b6b7a] mt-1">
            Connect integrations and configure VEGA.
          </p>
        </motion.div>

        {/* ── Telegram Integration ─────────────────────────────────────────────── */}
        <TelegramSection
          status={telegramStatus}
          activity={activity}
          onRefresh={fetchStatus}
          onActivityRefresh={fetchActivity}
        />

        {/* ── Danger Zone ──────────────────────────────────────────────────────── */}
        <DangerZone />

        {/* ── Debug: Force Disconnect ──────────────────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="space-y-3 mt-8 pt-8 border-t border-[#1e1e22]"
        >
          <p className="text-xs text-[#4a4a58]">Debug: Force clear Telegram config</p>
          <button
            onClick={async () => {
              if (!confirm("Force clear ALL Telegram configuration from Redis? This will disconnect any active bot.")) return;
              try {
                await api("DELETE", "/telegram/disconnect");
                alert("✓ Configuration cleared. The bot should now be disconnected.");
                window.location.reload();
              } catch (e) {
                alert(`✗ Error: ${String(e)}\n\n(If proxy failed, check your WORKER_URL env var)`);
              }
            }}
            className="px-3 py-1.5 rounded-lg bg-red-600/10 border border-red-600/30 text-red-500 text-xs font-medium hover:bg-red-600/20 transition-all active:scale-95"
          >
            Clear Configuration & Disconnect
          </button>
        </motion.section>

      </div>
    </div>
  );
}

// ─── Telegram Section ─────────────────────────────────────────────────────────

function TelegramSection({
  status,
  activity,
  onRefresh,
  onActivityRefresh,
}: {
  status: TelegramStatus | null;
  activity: ActivityItem[];
  onRefresh: () => void;
  onActivityRefresh: () => void;
}) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleConnect = async () => {
    if (!token.trim()) { setError("Paste your bot token first."); return; }
    setConnecting(true);
    setError(null);
    setSuccess(null);

    try {
      const data = await api<{ success: boolean; bot: { username: string }; message: string }>(
        "POST", "/telegram/setup", { botToken: token.trim() }
      );
      setSuccess(data.message);
      setToken("");
      onRefresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect the Telegram bot? You can reconnect anytime.")) return;
    setDisconnecting(true);
    setError(null);
    try {
      await api("DELETE", "/telegram/disconnect");
      setSuccess("Bot disconnected successfully.");
      setToken(""); // Clear token input if it was filled
      onRefresh();
    } catch (e) {
      setError(`Failed to disconnect: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setDisconnecting(false);
    }
  };

  const copyWebhook = async () => {
    if (!status?.webhookUrl) return;
    await navigator.clipboard.writeText(status.webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isConnected = status?.connected && status.bot;

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="space-y-4"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Telegram logo SVG */}
          <div className="flex size-8 sm:size-9 items-center justify-center rounded-lg bg-[#229ED9]/10 border border-[#229ED9]/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
            <svg className="size-4 sm:size-5" viewBox="0 0 24 24" fill="#229ED9">
              <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-[#e8e8ea]">Telegram</h2>
            <p className="text-[10px] sm:text-xs text-[#6b6b7a]">Chat with VEGA directly in Telegram</p>
          </div>
        </div>

        {/* Connection badge */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] sm:text-xs font-bold uppercase tracking-wider ${isConnected
          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.1)]"
          : "bg-[#1e1e22] text-[#6b6b7a] border border-[#2a2a30]"
          }`}>
          {isConnected
            ? <><WifiIcon className="size-3" /> Connected</>
            : <><WifiOffIcon className="size-3" /> Not connected</>
          }
        </div>
      </div>

      {/* Card */}
      <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-md overflow-hidden shadow-sm">

        {/* ── Connected state ─────────────────────────────────────────────── */}
        {isConnected && status?.bot ? (
          <div className="divide-y divide-[#1e1e22]">

            {/* Bot info */}
            <div className="p-5 flex items-center gap-4">
              <div className="flex size-12 items-center justify-center rounded-full bg-[#229ED9]/10 border border-[#229ED9]/20 text-xl shrink-0">
                🤖
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#e8e8ea]">
                  {status.bot.firstName}
                </p>
                <p className="text-xs text-[#229ED9]">@{status.bot.username}</p>
                <p className="text-xs text-[#6b6b7a] mt-0.5">
                  Connected {status.connectedAt ? formatRelTime(new Date(status.connectedAt).getTime()) : ""}
                </p>
              </div>
              <a
                href={`https://t.me/${status.bot.username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#229ED9] hover:bg-[#1a8ec7] text-white text-xs font-medium transition-colors"
              >
                Open Bot <ExternalLinkIcon className="size-3" />
              </a>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 divide-x divide-[#1e1e22]">
              <StatCell
                icon={<MessageSquareIcon className="size-3.5" />}
                label="Total messages"
                value={String(status.activityCount ?? 0)}
              />
              <StatCell
                icon={<ClockIcon className="size-3.5" />}
                label="Pending updates"
                value={String(status.pendingUpdates ?? 0)}
              />
              <StatCell
                icon={<ZapIcon className="size-3.5" />}
                label="Status"
                value={status.lastError ? "Error" : "Active"}
                valueClass={status.lastError ? "text-red-400" : "text-emerald-400"}
              />
            </div>

            {/* Webhook URL */}
            <div className="p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-[#6b6b7a] mb-0.5">Webhook URL</p>
                <p className="text-xs text-[#e8e8ea] font-mono truncate">
                  {status.webhookUrl}
                </p>
              </div>
              <button
                onClick={copyWebhook}
                className="shrink-0 p-2 rounded-lg hover:bg-[#1e1e22] transition-colors text-[#6b6b7a] hover:text-[#e8e8ea]"
                title="Copy webhook URL"
              >
                {copied ? <CheckIcon className="size-4 text-emerald-400" /> : <CopyIcon className="size-4" />}
              </button>
            </div>

            {/* Last error (if any) */}
            {status.lastError && (
              <div className="px-4 py-3 flex items-start gap-2 bg-red-500/5">
                <AlertTriangleIcon className="size-4 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-medium text-red-400">Webhook Error</p>
                  <p className="text-xs text-red-400/70 mt-0.5">{status.lastError}</p>
                </div>
              </div>
            )}

            {/* Disconnect */}
            <div className="p-4 flex justify-end">
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 text-xs transition-colors disabled:opacity-50"
              >
                {disconnecting
                  ? <RefreshCwIcon className="size-3.5 animate-spin" />
                  : <XCircleIcon className="size-3.5" />
                }
                Disconnect
              </button>
            </div>
          </div>

        ) : (
          /* ── Disconnected state ─────────────────────────────────────────── */
          <div className="p-6 space-y-6">

            {/* Step-by-step guide */}
            <div className="space-y-4">
              <SetupStep n={1} title="Create a bot with BotFather">
                <span>Open Telegram → search </span>
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#229ED9] hover:underline"
                >
                  @BotFather
                </a>
                <span> → send </span>
                <code className="px-1.5 py-0.5 rounded bg-[#1e1e22] text-[#00e5cc] text-xs font-mono">/newbot</code>
                <span> → follow the prompts</span>
              </SetupStep>

              <SetupStep n={2} title="Copy the bot token">
                BotFather will reply with a token like{" "}
                <code className="px-1.5 py-0.5 rounded bg-[#1e1e22] text-[#00e5cc] text-xs font-mono">
                  1234567890:ABCdefGHIjklMNOpqrSTUVwxyz
                </code>
                . Copy it.
              </SetupStep>

              <SetupStep n={3} title="Paste it here and connect">
                That's it — VEGA registers the webhook automatically.
              </SetupStep>
            </div>

            {/* Token input */}
            <div className="space-y-3">
              <label className="text-xs font-medium text-[#e8e8ea]">
                Bot Token
              </label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(e) => { setToken(e.target.value); setError(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
                    placeholder="1234567890:ABCdefGHIjklMNOpqrSTUVwxyz"
                    className="w-full px-3 py-2.5 pr-10 rounded-lg bg-[#1a1a1f] border border-[#2a2a30] text-[#e8e8ea] text-sm font-mono placeholder:text-[#3a3a44] focus:outline-none focus:border-[#229ED9]/50 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6b6b7a] hover:text-[#e8e8ea] transition-colors"
                  >
                    {showToken ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                  </button>
                </div>
                <button
                  onClick={handleConnect}
                  disabled={connecting || !token.trim()}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#229ED9] hover:bg-[#1a8ec7] text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  {connecting
                    ? <RefreshCwIcon className="size-4 animate-spin" />
                    : <SendIcon className="size-4" />
                  }
                  {connecting ? "Connecting…" : "Connect"}
                </button>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
                  <XCircleIcon className="size-4 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-400">{error}</p>
                </div>
              )}

              {/* Success */}
              {success && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <CheckCircleIcon className="size-4 text-emerald-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-emerald-400">{success}</p>
                </div>
              )}
            </div>

            {/* Privacy note */}
            <p className="text-xs text-[#4a4a58]">
              🔒 Your token is stored encrypted in Redis and never exposed in the frontend.
              Webhook requests are verified with a SHA-256 secret.
            </p>
          </div>
        )}
      </div>

      {/* ── Activity Feed ─────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {isConnected && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <ActivityFeed activity={activity} onRefresh={onActivityRefresh} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

// ─── Activity Feed ────────────────────────────────────────────────────────────

function ActivityFeed({
  activity,
  onRefresh,
}: {
  activity: ActivityItem[];
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[#e8e8ea]">Recent Activity</h3>
        <button
          onClick={onRefresh}
          className="p-1 rounded hover:bg-[#1e1e22] transition-colors text-[#6b6b7a] hover:text-[#e8e8ea]"
          title="Refresh"
        >
          <RefreshCwIcon className="size-3.5" />
        </button>
      </div>

      <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-md overflow-hidden shadow-sm">
        {activity.length === 0 ? (
          <div className="py-10 text-center">
            <MessageSquareIcon className="size-8 text-[#2a2a30] mx-auto mb-2" />
            <p className="text-sm text-[#4a4a58]">No messages yet</p>
            <p className="text-xs text-[#3a3a44] mt-1">
              Open your bot in Telegram and say hello!
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#1e1e22]/60">
            <AnimatePresence>
              {activity.map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="px-4 py-4 hover:bg-[#1a1a1f]/50 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    {/* User avatar placeholder */}
                    <div className="flex size-6 sm:size-7 items-center justify-center rounded-full bg-[#229ED9]/10 border border-[#229ED9]/20 text-xs text-[#229ED9] font-bold shrink-0">
                      {(item.firstName ?? item.username ?? "?")[0].toUpperCase()}
                    </div>
                    <span className="text-xs sm:text-sm font-bold text-[#e8e8ea]">
                      {item.firstName ?? item.username}
                    </span>
                    {item.username && (
                      <span className="text-[10px] sm:text-xs text-[#4a4a58]">@{item.username}</span>
                    )}
                    <span className="ml-auto text-[10px] sm:text-xs text-[#3a3a44] font-mono">
                      {formatRelTime(item.ts)}
                    </span>
                  </div>

                  <div className="ml-8 sm:ml-9 space-y-1.5">
                    <div className="flex items-start gap-2">
                      <span className="text-[#4a4a58] text-xs shrink-0 mt-0.5 opacity-50">→</span>
                      <p className="text-xs sm:text-sm text-[#8b8b9a] leading-relaxed truncate">
                        {item.messagePreview}
                      </p>
                    </div>
                    <div className="flex items-start gap-2">
                      <div className="size-3 sm:size-4 shrink-0 mt-0.5 flex items-center justify-center">
                        <BotIcon className="size-2.5 sm:size-3 text-[#00e5cc]" />
                      </div>
                      <p className="text-xs sm:text-sm text-[#e8e8ea]/80 leading-relaxed truncate italic">
                        {item.replyPreview}
                      </p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Danger Zone ─────────────────────────────────────────────────────────────

function DangerZone() {
  const [clearing, setClearing] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const handleClearMemory = async () => {
    if (!confirm("Clear ALL stored memories? This cannot be undone.")) return;
    setClearing("memory");
    try {
      const res = await fetch("/api/memory", { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      setDone("memory");
      setTimeout(() => setDone(null), 3000);
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setClearing(null);
    }
  };

  const handleClearHistory = async () => {
    if (!confirm("Clear all conversation history? Sessions will still exist but messages will be gone.")) return;
    // For now, just clear localStorage sessions
    localStorage.removeItem("vega-sessions");
    setDone("history");
    setTimeout(() => setDone(null), 3000);
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="space-y-4"
    >
      <div className="flex items-center gap-2">
        <AlertTriangleIcon className="size-4 sm:size-5 text-red-400" />
        <h2 className="text-sm sm:text-base font-bold text-[#e8e8ea]">Danger Zone</h2>
      </div>

      <div className="rounded-xl border border-red-500/20 bg-[#111113]/80 backdrop-blur-md divide-y divide-red-500/10 overflow-hidden shadow-[0_0_15px_rgba(239,68,68,0.05)]">
        <DangerRow
          title="Clear all memory"
          description="Permanently delete all key-value memories stored in Redis."
          buttonLabel="Clear Memory"
          busy={clearing === "memory"}
          done={done === "memory"}
          onAction={handleClearMemory}
        />
        <DangerRow
          title="Clear conversation history"
          description="Remove all chat session history from this browser."
          buttonLabel="Clear History"
          busy={clearing === "history"}
          done={done === "history"}
          onAction={handleClearHistory}
        />
      </div>
    </motion.section>
  );
}

// ─── Small reusable components ────────────────────────────────────────────────

function SetupStep({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-6 items-center justify-center rounded-full bg-[#229ED9]/10 border border-[#229ED9]/30 text-xs font-bold text-[#229ED9] shrink-0 mt-0.5">
        {n}
      </div>
      <div>
        <p className="text-sm font-medium text-[#e8e8ea]">{title}</p>
        <p className="text-xs text-[#6b6b7a] mt-0.5 leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

function StatCell({
  icon,
  label,
  value,
  valueClass = "text-[#e8e8ea]",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-1.5 text-[#6b6b7a] mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className={`text-lg font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

function DangerRow({
  title,
  description,
  buttonLabel,
  busy,
  done,
  onAction,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  busy: boolean;
  done: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div>
        <p className="text-sm font-medium text-[#e8e8ea]">{title}</p>
        <p className="text-xs text-[#6b6b7a] mt-0.5">{description}</p>
      </div>
      <button
        onClick={onAction}
        disabled={busy}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs font-medium transition-colors shrink-0 disabled:opacity-50"
      >
        {done
          ? <CheckCircleIcon className="size-3.5 text-emerald-400" />
          : busy
            ? <RefreshCwIcon className="size-3.5 animate-spin" />
            : <Trash2Icon className="size-3.5" />
        }
        {done ? "Done!" : busy ? "Working…" : buttonLabel}
      </button>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}