//app/settings/page.tsx
"use client";

/**
 * app/settings/page.tsx — VEGA Settings (UPDATED: WhatsApp + Telegram)
 *
 * Sections:
 *   1. Telegram Integration  — connect your own bot (per user, D1-backed)
 *   2. WhatsApp Integration  — connect your WhatsApp Business number (per user, D1-backed)
 *   3. Danger Zone           — reset all memory, clear history
 */

import { useState, useEffect, useCallback } from "react";
import {
  BotIcon, SendIcon, CheckCircleIcon, XCircleIcon, RefreshCwIcon,
  Trash2Icon, AlertTriangleIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon,
  ZapIcon, MessageSquareIcon, ClockIcon, WifiIcon, WifiOffIcon,
  CopyIcon, CheckIcon, PhoneIcon, ShieldCheckIcon, ShieldAlertIcon,
  LockIcon, KeyIcon, FileTextIcon, ActivityIcon, PlusIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// ─── API helper ───────────────────────────────────────────────────────────────

async function api<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
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
  bot?: { id: number; username: string; firstName: string };
  webhookUrl?: string;
  connectedAt?: string;
  pendingUpdates?: number;
  lastError?: string | null;
  activityCount?: number;
}

interface WhatsAppStatus {
  connected: boolean;
  phoneNumber?: string;
  displayName?: string;
  phoneNumberId?: string;
  webhookUrl?: string;
  connectedAt?: string;
  activityCount?: number;
}

interface TgActivityItem {
  chatId: number;
  username: string;
  firstName?: string;
  messagePreview: string;
  replyPreview: string;
  ts: number;
}

interface WaActivityItem {
  from: string;
  contactName: string;
  messagePreview: string;
  replyPreview: string;
  wasAudio: boolean;
  toolsUsed?: string[];
  ts: number;
}

interface VaultSecret {
  key_name: string;
  hint: string;
  description: string | null;
  updated_at: string;
}

interface AuditEntry {
  id: string;
  tool_name: string;
  args_summary: string;
  status: "ok" | "error" | "denied";
  created_at: string;
  duration_ms: number | null;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppStatus | null>(null);
  const [tgActivity, setTgActivity] = useState<TgActivityItem[]>([]);
  const [waActivity, setWaActivity] = useState<WaActivityItem[]>([]);
  const [vaultSecrets, setVaultSecrets] = useState<VaultSecret[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTgStatus = useCallback(async () => {
    try {
      const s = await api<TelegramStatus>("GET", "/telegram/status");
      setTelegramStatus(s);
    } catch { setTelegramStatus({ connected: false }); }
    finally { setLoading(false); }
  }, []);

  const fetchWaStatus = useCallback(async () => {
    try {
      const s = await api<WhatsAppStatus>("GET", "/whatsapp/status");
      setWhatsappStatus(s);
    } catch { setWhatsappStatus({ connected: false }); }
  }, []);

  const fetchTgActivity = useCallback(async () => {
    try {
      const d = await api<{ activity: TgActivityItem[] }>("GET", "/telegram/activity");
      setTgActivity(d.activity ?? []);
    } catch { /* ignore */ }
  }, []);

  const fetchWaActivity = useCallback(async () => {
    try {
      const d = await api<{ activity: WaActivityItem[] }>("GET", "/whatsapp/activity");
      setWaActivity(d.activity ?? []);
    } catch { /* ignore */ }
  }, []);

  const fetchVault = useCallback(async () => {
    try {
      const d = await api<{ secrets: VaultSecret[] }>("GET", "/vault/keys");
      setVaultSecrets(d.secrets ?? []);
    } catch { /* ignore */ }
  }, []);

  const fetchAudit = useCallback(async () => {
    try {
      const d = await api<{ entries: AuditEntry[] }>("GET", "/audit?limit=20");
      setAuditLogs(d.entries ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchTgStatus();
    fetchWaStatus();
    fetchTgActivity();
    fetchWaActivity();
    fetchVault();
    fetchAudit();

    const i1 = setInterval(fetchTgStatus, 15_000);
    const i2 = setInterval(fetchWaStatus, 15_000);
    const i3 = setInterval(fetchTgActivity, 10_000);
    const i4 = setInterval(fetchWaActivity, 10_000);
    const i5 = setInterval(fetchVault, 30_000);
    const i6 = setInterval(fetchAudit, 15_000);
    return () => {
      clearInterval(i1); clearInterval(i2); clearInterval(i3);
      clearInterval(i4); clearInterval(i5); clearInterval(i6);
    };
  }, [fetchTgStatus, fetchWaStatus, fetchTgActivity, fetchWaActivity, fetchVault, fetchAudit]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <RefreshCwIcon className="size-6 text-[#00e5cc] animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-2xl mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-8 sm:space-y-10">

        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-xl sm:text-2xl font-bold text-[#e8e8ea]">Settings</h1>
          <p className="text-xs sm:text-sm text-[#6b6b7a] mt-1">Connect integrations and configure VEGA.</p>
        </motion.div>

        {/* ── Telegram ──────────────────────────────────────────────────────── */}
        <TelegramSection
          status={telegramStatus}
          activity={tgActivity}
          onRefresh={fetchTgStatus}
          onActivityRefresh={fetchTgActivity}
        />

        {/* ── WhatsApp ──────────────────────────────────────────────────────── */}
        <WhatsAppSection
          status={whatsappStatus}
          activity={waActivity}
          onRefresh={fetchWaStatus}
        />

        {/* ── Vault (Secrets) ───────────────────────────────────────────────── */}
        <VaultSection
          secrets={vaultSecrets}
          onRefresh={fetchVault}
        />

        {/* ── Audit Logs ────────────────────────────────────────────────────── */}
        <AuditLogSection
          entries={auditLogs}
          onRefresh={fetchAudit}
        />

        {/* ── Danger Zone ───────────────────────────────────────────────────── */}
        <DangerZone />

        {/* Debug */}
        <motion.section
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="space-y-3 mt-8 pt-8 border-t border-[#1e1e22]"
        >
          <p className="text-xs text-[#4a4a58]">Debug: Force clear configurations</p>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={async () => {
                if (!confirm("Force clear your Telegram configuration?")) return;
                try { await api("DELETE", "/telegram/disconnect"); window.location.reload(); }
                catch (e) { alert(`Error: ${String(e)}`); }
              }}
              className="px-3 py-1.5 rounded-lg bg-red-600/10 border border-red-600/30 text-red-500 text-xs font-medium hover:bg-red-600/20 transition-all"
            >
              Clear Telegram Config
            </button>
            <button
              onClick={async () => {
                if (!confirm("Force clear your WhatsApp configuration?")) return;
                try { await api("DELETE", "/whatsapp/disconnect"); window.location.reload(); }
                catch (e) { alert(`Error: ${String(e)}`); }
              }}
              className="px-3 py-1.5 rounded-lg bg-red-600/10 border border-red-600/30 text-red-500 text-xs font-medium hover:bg-red-600/20 transition-all"
            >
              Clear WhatsApp Config
            </button>
          </div>
        </motion.section>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM SECTION
// ═══════════════════════════════════════════════════════════════════════════════

function TelegramSection({ status, activity, onRefresh, onActivityRefresh }: {
  status: TelegramStatus | null; activity: TgActivityItem[];
  onRefresh: () => void; onActivityRefresh: () => void;
}) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isConnected = status?.connected && status.bot;

  const handleConnect = async () => {
    if (!token.trim()) { setError("Paste your bot token first."); return; }
    setConnecting(true); setError(null); setSuccess(null);
    try {
      const data = await api<{ success: boolean; bot: { username: string }; message: string }>(
        "POST", "/telegram/setup", { botToken: token.trim() }
      );
      setSuccess(data.message); setToken(""); onRefresh();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setConnecting(false); }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect the Telegram bot?")) return;
    setDisconnecting(true); setError(null);
    try { await api("DELETE", "/telegram/disconnect"); setSuccess("Disconnected."); onRefresh(); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setDisconnecting(false); }
  };

  const copyWebhook = async () => {
    if (!status?.webhookUrl) return;
    await navigator.clipboard.writeText(status.webhookUrl);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-8 sm:size-9 items-center justify-center rounded-lg bg-[#229ED9]/10 border border-[#229ED9]/20">
            <svg className="size-4 sm:size-5" viewBox="0 0 24 24" fill="#229ED9">
              <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-[#e8e8ea]">Telegram</h2>
            <p className="text-[10px] sm:text-xs text-[#6b6b7a]">Chat with VEGA directly in Telegram</p>
          </div>
        </div>
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] sm:text-xs font-bold uppercase tracking-wider ${isConnected ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-[#1e1e22] text-[#6b6b7a] border border-[#2a2a30]"}`}>
          {isConnected ? <><WifiIcon className="size-3" /> Connected</> : <><WifiOffIcon className="size-3" /> Not connected</>}
        </div>
      </div>

      <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-md overflow-hidden shadow-sm">
        {isConnected && status?.bot ? (
          <div className="divide-y divide-[#1e1e22]">
            <div className="p-5 flex items-center gap-4">
              <div className="flex size-12 items-center justify-center rounded-full bg-[#229ED9]/10 border border-[#229ED9]/20 text-xl shrink-0">🤖</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#e8e8ea]">{status.bot.firstName}</p>
                <p className="text-xs text-[#229ED9]">@{status.bot.username}</p>
                <p className="text-xs text-[#6b6b7a] mt-0.5">Connected {status.connectedAt ? formatRelTime(new Date(status.connectedAt).getTime()) : ""}</p>
              </div>
              <a href={`https://t.me/${status.bot.username}`} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#229ED9] hover:bg-[#1a8ec7] text-white text-xs font-medium transition-colors">
                Open Bot <ExternalLinkIcon className="size-3" />
              </a>
            </div>
            <div className="grid grid-cols-3 divide-x divide-[#1e1e22]">
              <StatCell icon={<MessageSquareIcon className="size-3.5" />} label="Messages" value={String(status.activityCount ?? 0)} />
              <StatCell icon={<ClockIcon className="size-3.5" />} label="Pending" value={String(status.pendingUpdates ?? 0)} />
              <StatCell icon={<ZapIcon className="size-3.5" />} label="Status" value={status.lastError ? "Error" : "Active"} valueClass={status.lastError ? "text-red-400" : "text-emerald-400"} />
            </div>
            <div className="p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-[#6b6b7a] mb-0.5">Webhook URL</p>
                <p className="text-xs text-[#e8e8ea] font-mono truncate">{status.webhookUrl}</p>
              </div>
              <button onClick={copyWebhook} className="shrink-0 p-2 rounded-lg hover:bg-[#1e1e22] transition-colors text-[#6b6b7a] hover:text-[#e8e8ea]">
                {copied ? <CheckIcon className="size-4 text-emerald-400" /> : <CopyIcon className="size-4" />}
              </button>
            </div>
            {status.lastError && (
              <div className="px-4 py-3 flex items-start gap-2 bg-red-500/5">
                <AlertTriangleIcon className="size-4 text-red-400 shrink-0 mt-0.5" />
                <p className="text-xs text-red-400/70">{status.lastError}</p>
              </div>
            )}
            <div className="p-4 flex justify-end">
              <button onClick={handleDisconnect} disabled={disconnecting}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 text-xs transition-colors disabled:opacity-50">
                {disconnecting ? <RefreshCwIcon className="size-3.5 animate-spin" /> : <XCircleIcon className="size-3.5" />} Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-6">
            <div className="space-y-4">
              {[
                { n: 1, title: "Create a bot with BotFather", body: <>Open Telegram → search <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-[#229ED9] hover:underline">@BotFather</a> → send <code className="px-1.5 py-0.5 rounded bg-[#1e1e22] text-[#00e5cc] text-xs">/newbot</code></> },
                { n: 2, title: "Copy the bot token", body: "BotFather gives you a token like 1234567890:ABCdef... — copy it." },
                { n: 3, title: "Paste here and connect", body: "VEGA registers the webhook automatically and links this bot to your account only." },
              ].map(({ n, title, body }) => (
                <div key={n} className="flex items-start gap-3">
                  <div className="flex size-6 items-center justify-center rounded-full bg-[#229ED9]/10 border border-[#229ED9]/30 text-xs font-bold text-[#229ED9] shrink-0 mt-0.5">{n}</div>
                  <div><p className="text-sm font-medium text-[#e8e8ea]">{title}</p><p className="text-xs text-[#6b6b7a] mt-0.5 leading-relaxed">{body}</p></div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input type={showToken ? "text" : "password"} value={token}
                  onChange={(e) => { setToken(e.target.value); setError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
                  placeholder="1234567890:ABCdefGHIjklMNOpqrSTUVwxyz"
                  className="w-full px-3 py-2.5 pr-10 rounded-lg bg-[#1a1a1f] border border-[#2a2a30] text-[#e8e8ea] text-sm font-mono placeholder:text-[#3a3a44] focus:outline-none focus:border-[#229ED9]/50 transition-colors" />
                <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6b6b7a] hover:text-[#e8e8ea]">
                  {showToken ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                </button>
              </div>
              <button onClick={handleConnect} disabled={connecting || !token.trim()}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#229ED9] hover:bg-[#1a8ec7] text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
                {connecting ? <RefreshCwIcon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </div>
            {error && <FeedbackBox type="error" message={error} />}
            {success && <FeedbackBox type="success" message={success} />}
            <p className="text-xs text-[#4a4a58]">🔒 Your bot token is stored server-side in D1, scoped to your account only.</p>
          </div>
        )}
      </div>

      <AnimatePresence>
        {isConnected && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <ActivityFeed title="Telegram Activity" activity={activity} onRefresh={onActivityRefresh} color="#229ED9"
              renderItem={(item) => ({ name: (item as TgActivityItem).firstName ?? (item as TgActivityItem).username, sub: `@${(item as TgActivityItem).username}`, msg: (item as TgActivityItem).messagePreview, reply: (item as TgActivityItem).replyPreview, ts: (item as TgActivityItem).ts, badge: undefined })} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// WHATSAPP SECTION
// ═══════════════════════════════════════════════════════════════════════════════

function WhatsAppSection({ status, activity, onRefresh }: {
  status: WhatsAppStatus | null; activity: WaActivityItem[]; onRefresh: () => void;
}) {
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isConnected = status?.connected && status.phoneNumber;

  const handleConnect = async () => {
    if (!phoneNumberId.trim() || !accessToken.trim()) { setError("Phone Number ID and Access Token are required."); return; }
    setConnecting(true); setError(null); setSuccess(null);
    try {
      const data = await api<{ success: boolean; phoneNumber: string; displayName: string; nextStep: string }>(
        "POST", "/whatsapp/setup",
        { phoneNumberId: phoneNumberId.trim(), accessToken: accessToken.trim(), wabaId: wabaId.trim() || undefined }
      );
      setSuccess(`✅ Connected: ${data.displayName} (${data.phoneNumber})\n\n${data.nextStep}`);
      setPhoneNumberId(""); setAccessToken(""); setWabaId(""); onRefresh();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setConnecting(false); }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect this WhatsApp number?")) return;
    setDisconnecting(true);
    try { await api("DELETE", "/whatsapp/disconnect"); setSuccess("Disconnected."); onRefresh(); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setDisconnecting(false); }
  };

  const copyWebhook = async () => {
    if (!status?.webhookUrl) return;
    await navigator.clipboard.writeText(status.webhookUrl);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-8 sm:size-9 items-center justify-center rounded-lg bg-[#25D366]/10 border border-[#25D366]/20">
            <svg className="size-4 sm:size-5" viewBox="0 0 24 24" fill="#25D366">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-[#e8e8ea]">WhatsApp Business</h2>
            <p className="text-[10px] sm:text-xs text-[#6b6b7a]">Chat with VEGA via WhatsApp</p>
          </div>
        </div>
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] sm:text-xs font-bold uppercase tracking-wider ${isConnected ? "bg-[#25D366]/10 text-[#25D366] border border-[#25D366]/20" : "bg-[#1e1e22] text-[#6b6b7a] border border-[#2a2a30]"}`}>
          {isConnected ? <><WifiIcon className="size-3" /> Connected</> : <><WifiOffIcon className="size-3" /> Not connected</>}
        </div>
      </div>

      <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-md overflow-hidden shadow-sm">
        {isConnected && status ? (
          <div className="divide-y divide-[#1e1e22]">
            <div className="p-5 flex items-center gap-4">
              <div className="flex size-12 items-center justify-center rounded-full bg-[#25D366]/10 border border-[#25D366]/20 text-xl shrink-0">📱</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#e8e8ea]">{status.displayName}</p>
                <p className="text-xs text-[#25D366]">{status.phoneNumber}</p>
                <p className="text-xs text-[#6b6b7a] mt-0.5">Connected {status.connectedAt ? formatRelTime(new Date(status.connectedAt).getTime()) : ""}</p>
              </div>
              <div className="text-right text-xs text-[#6b6b7a]">
                <p className="text-lg font-bold text-[#e8e8ea]">{status.activityCount ?? 0}</p>
                <p className="text-[10px]">messages</p>
              </div>
            </div>
            <div className="p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-[#6b6b7a] mb-0.5">Webhook URL — configure in Meta Console</p>
                <p className="text-xs text-[#e8e8ea] font-mono truncate">{status.webhookUrl}</p>
              </div>
              <button onClick={copyWebhook} className="shrink-0 p-2 rounded-lg hover:bg-[#1e1e22] transition-colors text-[#6b6b7a] hover:text-[#e8e8ea]">
                {copied ? <CheckIcon className="size-4 text-emerald-400" /> : <CopyIcon className="size-4" />}
              </button>
            </div>
            <div className="px-4 py-3 bg-amber-500/5 flex items-start gap-2">
              <AlertTriangleIcon className="size-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-400/80">
                Confirm the webhook URL above is set in your{" "}
                <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer" className="underline">Meta App</a>
                {" "}→ WhatsApp → Configuration. Subscribe field: <strong>messages</strong>.
              </p>
            </div>
            <div className="p-4 flex justify-end">
              <button onClick={handleDisconnect} disabled={disconnecting}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 text-xs transition-colors disabled:opacity-50">
                {disconnecting ? <RefreshCwIcon className="size-3.5 animate-spin" /> : <XCircleIcon className="size-3.5" />} Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-6">
            <div className="space-y-4">
              {[
                { n: 1, title: "Create a Meta App", body: <>Go to <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer" className="text-[#25D366] hover:underline">developers.facebook.com</a> → Create App → Business → Add WhatsApp product.</> },
                { n: 2, title: "Get your Phone Number ID", body: "Meta App → WhatsApp → API Setup. Copy the Phone Number ID (numbers only, not the actual phone number)." },
                { n: 3, title: "Create a Permanent Token", body: "Meta Business Manager → System Users → Create System User → Generate Token with whatsapp_business_messaging permission." },
                { n: 4, title: "Configure webhook after connecting", body: <>Set the webhook URL (shown after connect) in Meta App → WhatsApp → Configuration. Verify token = your <code className="text-[10px] px-1 py-0.5 rounded bg-[#1e1e22] text-[#00e5cc]">WHATSAPP_WEBHOOK_VERIFY_TOKEN</code> secret. Subscribe to: messages.</> },
              ].map(({ n, title, body }) => (
                <div key={n} className="flex items-start gap-3">
                  <div className="flex size-6 items-center justify-center rounded-full bg-[#25D366]/10 border border-[#25D366]/30 text-xs font-bold text-[#25D366] shrink-0 mt-0.5">{n}</div>
                  <div><p className="text-sm font-medium text-[#e8e8ea]">{title}</p><p className="text-xs text-[#6b6b7a] mt-0.5 leading-relaxed">{body}</p></div>
                </div>
              ))}
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-[#e8e8ea] block mb-1">Phone Number ID <span className="text-red-400">*</span></label>
                <input type="text" value={phoneNumberId} onChange={(e) => { setPhoneNumberId(e.target.value); setError(null); }}
                  placeholder="123456789012345"
                  className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1f] border border-[#2a2a30] text-[#e8e8ea] text-sm font-mono placeholder:text-[#3a3a44] focus:outline-none focus:border-[#25D366]/50 transition-colors" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#e8e8ea] block mb-1">Permanent Access Token <span className="text-red-400">*</span></label>
                <div className="relative">
                  <input type={showToken ? "text" : "password"} value={accessToken} onChange={(e) => { setAccessToken(e.target.value); setError(null); }}
                    placeholder="EAAxxxxxxxx..."
                    className="w-full px-3 py-2.5 pr-10 rounded-lg bg-[#1a1a1f] border border-[#2a2a30] text-[#e8e8ea] text-sm font-mono placeholder:text-[#3a3a44] focus:outline-none focus:border-[#25D366]/50 transition-colors" />
                  <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6b6b7a] hover:text-[#e8e8ea]">
                    {showToken ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-[#e8e8ea] block mb-1">WABA ID <span className="text-[#6b6b7a]">(optional)</span></label>
                <input type="text" value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="WhatsApp Business Account ID"
                  className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1f] border border-[#2a2a30] text-[#e8e8ea] text-sm font-mono placeholder:text-[#3a3a44] focus:outline-none focus:border-[#25D366]/50 transition-colors" />
              </div>
              <button onClick={handleConnect} disabled={connecting || !phoneNumberId.trim() || !accessToken.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#25D366] hover:bg-[#1ebe58] text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {connecting ? <RefreshCwIcon className="size-4 animate-spin" /> : <PhoneIcon className="size-4" />}
                {connecting ? "Connecting…" : "Connect WhatsApp Number"}
              </button>
              {error && <FeedbackBox type="error" message={error} />}
              {success && <FeedbackBox type="success" message={success} />}
            </div>
            <p className="text-xs text-[#4a4a58]">🔒 Your access token is stored server-side in D1, scoped to your account. Webhooks verified via HMAC using your Meta App Secret.</p>
          </div>
        )}
      </div>

      <AnimatePresence>
        {isConnected && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <ActivityFeed title="WhatsApp Activity" activity={activity} onRefresh={onRefresh} color="#25D366"
              renderItem={(item) => {
                const w = item as WaActivityItem;
                return { name: w.contactName, sub: w.from, msg: w.messagePreview, reply: w.replyPreview, ts: w.ts, badge: w.wasAudio ? "🎙️ voice" : undefined };
              }} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function ActivityFeed<T>({ title, activity, onRefresh, color, renderItem }: {
  title: string; activity: T[]; onRefresh: () => void; color: string;
  renderItem: (item: T) => { name: string; sub?: string; msg: string; reply: string; ts: number; badge?: string };
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[#e8e8ea]">{title}</h3>
        <button onClick={onRefresh} className="p-1 rounded hover:bg-[#1e1e22] transition-colors text-[#6b6b7a] hover:text-[#e8e8ea]"><RefreshCwIcon className="size-3.5" /></button>
      </div>
      <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-md overflow-hidden">
        {activity.length === 0 ? (
          <div className="py-10 text-center">
            <MessageSquareIcon className="size-8 text-[#2a2a30] mx-auto mb-2" />
            <p className="text-sm text-[#4a4a58]">No messages yet</p>
          </div>
        ) : (
          <div className="divide-y divide-[#1e1e22]/60">
            {activity.map((item, i) => {
              const r = renderItem(item);
              return (
                <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }} className="px-4 py-4 hover:bg-[#1a1a1f]/50 transition-colors">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex size-6 items-center justify-center rounded-full border text-xs font-bold shrink-0" style={{ backgroundColor: `${color}15`, borderColor: `${color}30`, color }}>
                      {(r.name ?? "?")[0].toUpperCase()}
                    </div>
                    <span className="text-xs font-bold text-[#e8e8ea]">{r.name}</span>
                    {r.sub && <span className="text-[10px] text-[#4a4a58]">{r.sub}</span>}
                    {r.badge && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: `${color}15`, color }}>{r.badge}</span>}
                    <span className="ml-auto text-[10px] text-[#3a3a44] font-mono">{formatRelTime(r.ts)}</span>
                  </div>
                  <div className="ml-8 space-y-1">
                    <p className="text-xs text-[#8b8b9a] truncate">→ {r.msg}</p>
                    <p className="text-xs text-[#e8e8ea]/80 truncate italic">⚡ {r.reply}</p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FeedbackBox({ type, message }: { type: "error" | "success"; message: string }) {
  const isError = type === "error";
  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-lg ${isError ? "bg-red-500/10 border border-red-500/20" : "bg-emerald-500/10 border border-emerald-500/20"}`}>
      {isError ? <XCircleIcon className="size-4 text-red-400 shrink-0 mt-0.5" /> : <CheckCircleIcon className="size-4 text-emerald-400 shrink-0 mt-0.5" />}
      <p className={`text-xs whitespace-pre-line ${isError ? "text-red-400" : "text-emerald-400"}`}>{message}</p>
    </div>
  );
}

function StatCell({ icon, label, value, valueClass = "text-[#e8e8ea]" }: { icon: React.ReactNode; label: string; value: string; valueClass?: string; }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-1.5 text-[#6b6b7a] mb-1">{icon}<span className="text-xs">{label}</span></div>
      <p className={`text-lg font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

function DangerZone() {
  const [clearing, setClearing] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const handleClearMemory = async () => {
    if (!confirm("Clear ALL stored memories? This cannot be undone.")) return;
    setClearing("memory");
    try { const res = await fetch("/api/memory", { method: "DELETE" }); if (!res.ok) throw new Error(await res.text()); setDone("memory"); setTimeout(() => setDone(null), 3000); }
    catch (e) { alert(`Failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setClearing(null); }
  };

  const handleClearHistory = async () => {
    if (!confirm("Clear all conversation history?")) return;
    localStorage.removeItem("vega-sessions");
    setDone("history"); setTimeout(() => setDone(null), 3000);
  };

  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="space-y-4">
      <div className="flex items-center gap-2">
        <AlertTriangleIcon className="size-4 sm:size-5 text-red-400" />
        <h2 className="text-sm sm:text-base font-bold text-[#e8e8ea]">Danger Zone</h2>
      </div>
      <div className="rounded-xl border border-red-500/20 bg-[#111113]/80 backdrop-blur-md divide-y divide-red-500/10 overflow-hidden">
        {[
          { id: "memory", title: "Clear all memory", desc: "Permanently delete all key-value memories stored in Redis.", label: "Clear Memory", action: handleClearMemory },
          { id: "history", title: "Clear conversation history", desc: "Remove all chat session history from this browser.", label: "Clear History", action: handleClearHistory },
        ].map(({ id, title, desc, label, action }) => (
          <div key={id} className="flex items-center justify-between gap-4 p-4">
            <div><p className="text-sm font-medium text-[#e8e8ea]">{title}</p><p className="text-xs text-[#6b6b7a] mt-0.5">{desc}</p></div>
            <button onClick={action} disabled={clearing === id}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs font-medium transition-colors shrink-0 disabled:opacity-50">
              {done === id ? <CheckCircleIcon className="size-3.5 text-emerald-400" /> : clearing === id ? <RefreshCwIcon className="size-3.5 animate-spin" /> : <Trash2Icon className="size-3.5" />}
              {done === id ? "Done!" : clearing === id ? "Working…" : label}
            </button>
          </div>
        ))}
      </div>
    </motion.section>
  );
}

function formatRelTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VAULT SECTION
// ═══════════════════════════════════════════════════════════════════════════════

function VaultSection({ secrets, onRefresh }: { secrets: VaultSecret[]; onRefresh: () => void }) {
  const [keyName, setKeyName] = useState("");
  const [value, setValue] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!keyName.trim() || !value.trim()) return;
    setSaving(true); setError(null);
    try {
      await api("POST", "/vault/keys", { key_name: keyName, value, description: desc });
      setKeyName(""); setValue(""); setDesc(""); onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  const handleDelete = async (kn: string) => {
    if (!confirm(`Delete secret ${kn}?`)) return;
    try { await api("DELETE", `/vault/keys/${kn}`); onRefresh(); }
    catch (e) { alert(String(e)); }
  };

  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-8 sm:size-9 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <LockIcon className="size-4 sm:size-5 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-[#e8e8ea]">Secrets Vault</h2>
            <p className="text-[10px] sm:text-xs text-[#6b6b7a]">Securely store API keys for integrations</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 divide-y divide-[#1e1e22] overflow-hidden">
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input placeholder="key_name (e.g. openai_key)" value={keyName} onChange={e => setKeyName(e.target.value)} className="bg-[#1a1a1f] border border-[#2a2a30] rounded-lg px-3 py-2 text-xs text-[#e8e8ea] focus:outline-none focus:border-emerald-500/40 transition-colors" />
            <input type="password" placeholder="secret value" value={value} onChange={e => setValue(e.target.value)} className="bg-[#1a1a1f] border border-[#2a2a30] rounded-lg px-3 py-2 text-xs text-[#e8e8ea] focus:outline-none focus:border-emerald-500/40 transition-colors" />
          </div>
          <div className="flex gap-2">
            <input placeholder="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)} className="flex-1 bg-[#1a1a1f] border border-[#2a2a30] rounded-lg px-3 py-2 text-xs text-[#e8e8ea] focus:outline-none focus:border-emerald-500/40 transition-colors" />
            <button onClick={handleSave} disabled={saving || !keyName || !value} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-colors disabled:opacity-50 min-w-10 flex items-center justify-center">
              {saving ? <RefreshCwIcon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
            </button>
          </div>
          {error && <p className="text-[10px] text-red-400">{error}</p>}
        </div>

        {secrets.length === 0 ? (
          <div className="p-8 text-center text-[#4a4a58] text-xs">No secrets stored.</div>
        ) : (
          secrets.map(s => (
            <div key={s.key_name} className="p-4 flex items-center justify-between gap-4 hover:bg-[#1a1a1f]/30 transition-colors">
              <div className="flex items-center gap-3">
                <KeyIcon className="size-4 text-[#6b6b7a]" />
                <div>
                  <p className="text-xs font-bold text-[#e8e8ea]">{s.key_name}</p>
                  <p className="text-[10px] text-[#4a4a58] font-mono">{s.hint}</p>
                </div>
              </div>
              <button onClick={() => handleDelete(s.key_name)} className="p-2 text-[#4a4a58] hover:text-red-400 transition-colors">
                <Trash2Icon className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </motion.section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG SECTION
// ═══════════════════════════════════════════════════════════════════════════════

function AuditLogSection({ entries, onRefresh }: { entries: AuditEntry[]; onRefresh: () => void }) {
  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="space-y-4">
       <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-8 sm:size-9 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/20">
            <ActivityIcon className="size-4 sm:size-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-[#e8e8ea]">Execution Audit Log</h2>
            <p className="text-[10px] sm:text-xs text-[#6b6b7a]">History of agent tool operations</p>
          </div>
        </div>
        <button onClick={onRefresh} className="p-2 text-[#6b6b7a] hover:text-[#e8e8ea] transition-colors"><RefreshCwIcon className="size-4" /></button>
      </div>

      <div className="rounded-xl border border-[#1e1e22] bg-[#111113]/80 overflow-hidden shadow-sm">
        {entries.length === 0 ? (
          <div className="p-10 text-center text-[#4a4a58] text-xs italic">No entries recorded yet.</div>
        ) : (
          <div className="divide-y divide-[#1e1e22]/50">
            {entries.map(e => (
              <div key={e.id} className="p-3 hover:bg-[#1a1a1f]/40 transition-colors flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`size-1.5 rounded-full shrink-0 ${e.status === 'ok' ? 'bg-emerald-500' : e.status === 'denied' ? 'bg-amber-500' : 'bg-red-500'}`} />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-[#e8e8ea] truncate">{e.tool_name}</p>
                    <p className="text-[10px] text-[#4a4a58] truncate font-mono">{e.args_summary}</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                   <p className="text-[10px] text-[#4a4a58] font-mono">{formatRelTime(new Date(e.created_at).getTime())}</p>
                   {e.duration_ms && <p className="text-[9px] text-[#3a3a44] font-mono">{e.duration_ms}ms</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.section>
  );
}