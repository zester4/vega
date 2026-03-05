//app/chat/page.tsx
"use client";

/**
 * app/chat/page.tsx — VEGA Main Chat Interface
 *
 * Handles:
 *  - SSE streaming from /api/chat (x-stream: true)
 *  - Real-time tool call visualization via ToolStream
 *  - Session persistence in localStorage
 *  - URL param ?session=ID to restore sessions
 */

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { nanoid } from "nanoid";
import {
  ArrowUpIcon,
  AudioLinesIcon,
  CopyIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { MessageResponse } from "@/components/ai-elements/message";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  name: string;
  status: "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolCall[];       // tool calls that happened during this assistant turn
  timestamp: number;
}

interface AttachmentPayload {
  id: string;
  name: string;
  mimeType: string;
  data: string; // base64
}

interface StoredSession {
  id: string;
  sessionId: string;
  title: string;
  messageCount: number;
  lastMessage?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Tool Icons ───────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  web_search: "🔍",
  fetch_url: "🌐",
  store_memory: "💾",
  recall_memory: "🧠",
  list_memories: "📋",
  delete_memory: "🗑️",
  schedule_cron: "⏰",
  trigger_workflow: "⚙️",
  get_task_status: "📊",
  create_tool: "🔧",
  calculate: "🧮",
  get_datetime: "🕐",
  github: "🐙",
  run_code: "💻",
  text_to_speech: "🎤",
  speech_to_text: "👂",
  default: "🛠️",
};

const getToolIcon = (name: string) =>
  TOOL_ICONS[name] ?? TOOL_ICONS.default;

// ─── ToolStream Component ────────────────────────────────────────────────────

function ToolStream({ tools }: { tools: ToolCall[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [decidingApproval, setDecidingApproval] = useState<string | null>(null);

  if (!tools || tools.length === 0) return null;

  const toggleExpand = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="mb-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-[#6b6b7a] px-1 pb-1">
        TOOLS ({tools.length})
      </p>
      <div className="space-y-1">
        <AnimatePresence>
          {tools.map((tool) => {
            const isOpen = expanded[tool.id] ?? (tool.status === "running");

            // Detect human_approval_gate outputs
            const approval =
              tool.name === "human_approval_gate" &&
                tool.output &&
                typeof tool.output === "object"
                ? (tool.output as {
                  id?: string;
                  operation?: string;
                  status?: string;
                  channel?: string;
                  message?: string;
                })
                : null;

            return (
              <motion.div
                key={tool.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="rounded-lg border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-sm overflow-hidden"
              >
                {/* Header */}
                <button
                  onClick={() => toggleExpand(tool.id)}
                  className="w-full px-3 py-2 flex items-center justify-between gap-2 hover:bg-[#1a1a1d] transition-colors text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {tool.status === "running" && (
                      <span className="inline-block size-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
                    )}
                    {tool.status === "completed" && (
                      <span className="inline-block size-1.5 rounded-full bg-[#00e5cc] shrink-0" />
                    )}
                    {tool.status === "error" && (
                      <span className="inline-block size-1.5 rounded-full bg-red-500 shrink-0" />
                    )}
                    <span className="text-[10px] sm:text-xs font-mono text-[#e8e8ea] truncate">
                      {getToolIcon(tool.name)} {tool.name}
                    </span>
                  </div>
                  <span className="text-[9px] sm:text-[10px] text-[#6b6b7a] shrink-0 capitalize">
                    {tool.status === "running" ? "running…" : tool.status}
                  </span>
                </button>

                {/* Body */}
                <AnimatePresence>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="border-t border-[#1e1e22] text-[10px] sm:text-xs font-mono overflow-hidden"
                    >
                      {tool.input && (
                        <div className="px-3 py-2 border-b border-[#1e1e22] bg-[#0a0a0b]/50">
                          <p className="text-[10px] text-[#6b6b7a] uppercase mb-1">Params</p>
                          <pre className="text-[#e8e8ea]/70 overflow-x-auto max-h-20 scrollbar-thin">
                            {JSON.stringify(tool.input, null, 2)}
                          </pre>
                        </div>
                      )}
                      {(tool.output || tool.errorText) && (
                        <div className="px-3 py-2 bg-[#0a0a0b]/50">
                          {/* Human approval special-case */}
                          {approval ? (
                            <div className="space-y-2">
                              <p className="text-[10px] font-semibold text-[#e8e8ea] uppercase">
                                Human Approval Required
                              </p>
                              {approval.operation && (
                                <p className="text-[10px] text-[#e8e8ea]/80 whitespace-pre-wrap">
                                  {approval.operation}
                                </p>
                              )}
                              <p className="text-[10px] text-[#6b6b7a]">
                                ID:{" "}
                                <span className="font-mono">
                                  {approval.id ?? "unknown"}
                                </span>{" "}
                                • Channel:{" "}
                                <span className="uppercase">
                                  {approval.channel ?? "ui"}
                                </span>
                              </p>
                              <p className="text-[10px] text-[#4a4a58]">
                                {approval.message ??
                                  "Review this operation and approve or reject it. This decision will be recorded for the agent to read."}
                              </p>
                              {approval.status === "pending" && approval.id && (
                                <div className="flex items-center gap-2 pt-1">
                                  <button
                                    disabled={decidingApproval === approval.id}
                                    onClick={async () => {
                                      try {
                                        setDecidingApproval(approval.id!);
                                        await fetch(
                                          `/api/approvals/${approval.id}/decision`,
                                          {
                                            method: "POST",
                                            headers: {
                                              "Content-Type":
                                                "application/json",
                                            },
                                            body: JSON.stringify({
                                              approved: false,
                                            }),
                                          }
                                        );
                                      } catch (e) {
                                        console.error(
                                          "[Approval reject error]",
                                          e
                                        );
                                      } finally {
                                        setDecidingApproval(null);
                                      }
                                    }}
                                    className="px-2 py-1 rounded-md border border-red-500/30 text-[10px] text-red-400 hover:bg-red-500/10 transition-colors"
                                  >
                                    {decidingApproval === approval.id
                                      ? "Rejecting…"
                                      : "Reject"}
                                  </button>
                                  <button
                                    disabled={decidingApproval === approval.id}
                                    onClick={async () => {
                                      try {
                                        setDecidingApproval(approval.id!);
                                        await fetch(
                                          `/api/approvals/${approval.id}/decision`,
                                          {
                                            method: "POST",
                                            headers: {
                                              "Content-Type":
                                                "application/json",
                                            },
                                            body: JSON.stringify({
                                              approved: true,
                                            }),
                                          }
                                        );
                                      } catch (e) {
                                        console.error(
                                          "[Approval approve error]",
                                          e
                                        );
                                      } finally {
                                        setDecidingApproval(null);
                                      }
                                    }}
                                    className="px-2 py-1 rounded-md border border-emerald-500/30 text-[10px] text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                                  >
                                    {decidingApproval === approval.id
                                      ? "Approving…"
                                      : "Approve"}
                                  </button>
                                </div>
                              )}
                              {approval.status &&
                                approval.status !== "pending" && (
                                  <p className="text-[10px] text-[#8b8b9a]">
                                    Status:{" "}
                                    <span className="font-semibold uppercase">
                                      {approval.status}
                                    </span>
                                  </p>
                                )}
                            </div>
                          ) : (
                            <>
                              <p
                                className={`text-[10px] uppercase mb-1 ${tool.errorText
                                  ? "text-red-400"
                                  : "text-[#6b6b7a]"
                                  }`}
                              >
                                {tool.errorText ? "Error" : "Output"}
                              </p>
                              {tool.errorText ? (
                                <pre className="text-red-400 overflow-x-auto max-h-24 scrollbar-thin">
                                  {tool.errorText}
                                </pre>
                              ) : (
                                <pre className="text-[#e8e8ea]/70 overflow-x-auto max-h-24 scrollbar-thin">
                                  {typeof tool.output === "string"
                                    ? tool.output
                                    : JSON.stringify(tool.output, null, 2)}
                                </pre>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Copy Button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={copy}
      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-[#1e1e22] text-[#6b6b7a] hover:text-[#e8e8ea]"
      title="Copy"
    >
      {copied ? (
        <span className="text-[10px] text-[#00e5cc]">✓</span>
      ) : (
        <CopyIcon className="size-3" />
      )}
    </button>
  );
}

// ─── Markdown-like renderer (simple) ─────────────────────────────────────────
// For full markdown, use Streamdown from message.tsx in a real integration.
// This inline version handles bold, inline code, and headers.

function isImageUrl(url: string): boolean {
  if (!url) return false;
  // Clean URL of trailing junk (markdown closing parens, brackets, etc)
  const u = url.trim().split(/[)\]\s]/)[0] ?? url;
  if (u.includes("/files/generated/")) return true;
  return /\.(jpg|jpeg|png|webp|gif|svg)(\?.*)?$/i.test(u);
}

function isAudioUrl(url: string): boolean {
  if (!url) return false;
  const u = url.trim().split(/[)\]\s]/)[0] ?? url;
  if (u.includes("/files/voice/")) return true;
  if (/\/files\/.*\.wav/.test(u)) return true; // specific R2 wav
  return /\.(mp3|wav|ogg|m4a|aac)(\?.*)?$/i.test(u);
}

/** Extract image URLs from generate_image tool results for display as <img> */
function getGeneratedImageUrls(tools: ToolCall[] | undefined): Array<{ url: string; alt: string }> {
  if (!tools?.length) return [];
  const out: Array<{ url: string; alt: string }> = [];
  for (const t of tools) {
    if (t.name !== "generate_image" || t.status !== "completed" || !t.output) continue;
    const o = t.output as Record<string, unknown>;
    const url = typeof o.imageUrl === "string" ? o.imageUrl.trim() : "";
    if (!url.startsWith("http")) continue;
    out.push({
      url,
      alt: (typeof o.description === "string" ? o.description : "Generated image") || "Generated image",
    });
  }
  return out;
}

function InlineImage({ url, alt = "Generated image" }: { url: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  return (
    <span className="my-2 rounded-xl overflow-hidden border border-[#1e1e22] bg-[#111113] max-w-[400px] block">
      {!error ? (
        <>
          {!loaded && (
            <span className="h-40 flex items-center justify-center text-[10px] text-[#6b6b7a] gap-2">
              <span className="inline-block size-2 rounded-full bg-[#00e5cc]/60 animate-pulse" />
              Loading image…
            </span>
          )}
          <img
            src={url}
            alt={alt}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            className={`w-full object-contain rounded-xl transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0 h-0"}`}
          />
          {loaded && (
            <span className="flex items-center justify-between px-3 py-1.5 border-t border-[#1e1e22]">
              <span className="text-[10px] text-[#6b6b7a] truncate max-w-[200px] block">{alt}</span>
              <a
                href={url}
                download
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-[#00e5cc] hover:underline shrink-0 ml-2"
              >
                ↓ Download
              </a>
            </span>
          )}
        </>
      ) : (
        <span className="px-3 py-2 text-[10px] text-red-400 block">⚠️ Could not load image</span>
      )}
    </span>
  );
}

function InlineAudio({ url }: { url: string }) {
  // Extract filename for display
  const filename = url.split("/").pop()?.split(/[?#]/)[0] ?? "Audio Message";

  return (
    <span className="my-2 p-3 sm:p-4 rounded-xl border border-white/10 bg-white/5 backdrop-blur-md max-w-[400px] shadow-lg block">
      <span className="flex items-center gap-3 mb-3">
        <span className="size-10 rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 shadow-inner">
          <AudioLinesIcon className="size-5 text-emerald-400" />
        </span>
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="text-[12px] font-bold text-white tracking-tight">VEGA Audio</span>
          <span className="text-[10px] text-white/40 truncate font-mono">{filename}</span>
        </span>
      </span>
      <audio
        controls
        src={url}
        className="w-full h-9 brightness-90 contrast-125 saturate-50 opacity-90 hover:opacity-100 transition-opacity block"
      />
      <span className="mt-2 flex items-center justify-between px-1">
        <span className="text-[10px] text-white/20 select-none uppercase tracking-widest font-mono">24kHz PCM</span>
        <a href={url} download className="text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors uppercase font-bold">Download</a>
      </span>
    </span>
  );
}

// ─── Streamdown Custom Components ───────────────────────────────────────────────

const markdownComponents = {
  a: ({ href, children }: any) => {
    if (href && isAudioUrl(href)) {
      return <InlineAudio url={href} />;
    }
    if (href && isImageUrl(href)) {
      return <InlineImage url={href} alt={typeof children === "string" ? children : "Generated image"} />;
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">
        {children}
      </a>
    );
  },
  img: ({ src, alt }: any) => {
    if (src && isImageUrl(src)) {
      return <InlineImage url={src} alt={alt || "Generated image"} />;
    }
    // Fallback if it's an external image not matching our R2 rules
    return <img src={src} alt={alt} className="max-w-full rounded-md" />;
  },
};

// ─── In-progress Indicator ────────────────────────────────────────────────────

function ThinkingDot() {
  return (
    <div className="flex gap-1 items-center py-1 px-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block size-1.5 rounded-full bg-[#00e5cc]/60 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function ChatPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [isMounted, setIsMounted] = useState(false);
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    setIsMounted(true);
    const urlSession = searchParams.get("session");
    if (urlSession) {
      setSessionId(urlSession);
    } else {
      const newSessionId = `session-${nanoid(8)}`;
      setSessionId(newSessionId);
      router.replace(`/chat?session=${newSessionId}`);
    }
  }, [searchParams, router]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Tool state for the currently-streaming assistant turn
  const [liveTools, setLiveTools] = useState<ToolCall[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── Restore session from localStorage ──────────────────────────────────────

  useEffect(() => {
    if (!sessionId) return;
    try {
      const stored = localStorage.getItem(`vega-chat-${sessionId}`);
      if (stored) {
        const parsed: ChatMessage[] = JSON.parse(stored);
        setMessages(parsed);
      } else {
        setMessages([]);
      }
    } catch { /* ignore */ }
  }, [sessionId]);

  // ── Auto-scroll ─────────────────────────────────────────────────────────────

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, liveTools, scrollToBottom]);

  // ── Poll for pending sub-agent results ──────────────────────────────────────

  // ── Persist messages ────────────────────────────────────────────────────────

  const persistMessages = useCallback((msgs: ChatMessage[]) => {
    try {
      localStorage.setItem(`vega-chat-${sessionId}`, JSON.stringify(msgs));

      // Also update the sessions index
      const sessionsRaw = localStorage.getItem("vega-sessions");
      const sessions: StoredSession[] = sessionsRaw ? JSON.parse(sessionsRaw) : [];
      const now = new Date().toISOString();
      const existing = sessions.find((s) => s.sessionId === sessionId);
      const userMsgs = msgs.filter((m) => m.role === "user");
      const title =
        userMsgs[0]?.content?.slice(0, 60) || "New Conversation";
      const lastMsg = msgs[msgs.length - 1]?.content?.slice(0, 100);

      if (existing) {
        existing.messageCount = msgs.length;
        existing.lastMessage = lastMsg;
        existing.updatedAt = now;
        existing.title = title;
      } else {
        sessions.unshift({
          id: sessionId,
          sessionId,
          title,
          messageCount: msgs.length,
          lastMessage: lastMsg,
          createdAt: now,
          updatedAt: now,
        });
      }
      localStorage.setItem("vega-sessions", JSON.stringify(sessions.slice(0, 50)));
    } catch { /* ignore */ }
  }, [sessionId]);

  // ── Poll for pending sub-agent results ──────────────────────────────────────

  useEffect(() => {
    if (!sessionId) return;

    const checkPending = async () => {
      try {
        const res = await fetch("/api/agents/pending");
        const data = (await res.json()) as { messages?: any[] };

        if (data.messages && data.messages.length > 0) {
          const newMessages: ChatMessage[] = data.messages.map((msg: any) => ({
            id: nanoid(),
            role: "assistant",
            content: msg.synthesis,
            timestamp: Date.now(),
          }));

          setMessages((prev) => {
            const updated = [...prev, ...newMessages];
            // We use a small timeout to let state update before persisting
            setTimeout(() => persistMessages(updated), 0);
            return updated;
          });
        }
      } catch (err) {
        console.warn("[pending check failed]", err);
      }
    };

    // Check on load + every 30s
    checkPending();
    const interval = setInterval(checkPending, 30_000);
    return () => clearInterval(interval);
  }, [sessionId, persistMessages]);

  // ── Send message ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;

    // Cancel previous request if any
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg: ChatMessage = {
      id: nanoid(),
      role: "user",
      content: text.trim(),
      timestamp: Date.now(),
    };

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    persistMessages(nextMessages);
    setInput("");
    setIsLoading(true);
    setLiveTools([]);

    // Track tools for this assistant turn
    let turnTools: ToolCall[] = [];

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-stream": "true",
        },
        body: JSON.stringify({
          message: text.trim(),
          sessionId,
          attachments: attachments.map((a) => ({
            mimeType: a.mimeType,
            data: a.data,
            name: a.name,
          })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }

      const contentType = res.headers.get("content-type") ?? "";

      // ── SSE streaming path ────────────────────────────────────────────────
      if (contentType.includes("event-stream")) {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process all complete SSE messages (split by double newline)
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? ""; // keep incomplete last chunk

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;

            const jsonStr = line.slice(5).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;

            let event: { type: string; data: unknown };
            try {
              event = JSON.parse(jsonStr);
            } catch {
              console.warn("[SSE parse error]", jsonStr);
              continue;
            }

            if (event.type === "tool-start") {
              const d = event.data as { name: string; input?: Record<string, unknown> };
              const tc: ToolCall = {
                id: nanoid(),
                name: d.name,
                status: "running",
                input: d.input,
              };
              turnTools = [...turnTools, tc];
              setLiveTools([...turnTools]);

            } else if (event.type === "tool-result") {
              const d = event.data as { name: string; output?: unknown };
              turnTools = turnTools.map((t) =>
                t.name === d.name && t.status === "running"
                  ? { ...t, status: "completed", output: d.output }
                  : t
              );
              setLiveTools([...turnTools]);

            } else if (event.type === "tool-error") {
              const d = event.data as { name: string; error?: string };
              turnTools = turnTools.map((t) =>
                t.name === d.name && t.status === "running"
                  ? { ...t, status: "error", errorText: d.error }
                  : t
              );
              setLiveTools([...turnTools]);

            } else if (event.type === "message") {
              const replyText =
                typeof event.data === "string"
                  ? event.data
                  : (event.data as { text?: string })?.text ?? "";

              if (replyText.trim()) {
                const assistantMsg: ChatMessage = {
                  id: nanoid(),
                  role: "assistant",
                  content: replyText,
                  tools: turnTools.length > 0 ? [...turnTools] : undefined,
                  timestamp: Date.now(),
                };
                const withAssistant = [...nextMessages, assistantMsg];
                setMessages(withAssistant);
                persistMessages(withAssistant);
              }
              setLiveTools([]);
              turnTools = [];

            } else if (event.type === "error") {
              const errMsg: ChatMessage = {
                id: nanoid(),
                role: "assistant",
                content: `⚠️ Error: ${(event.data as { error?: string })?.error ?? "Unknown error"}`,
                timestamp: Date.now(),
              };
              const withErr = [...nextMessages, errMsg];
              setMessages(withErr);
              persistMessages(withErr);
              setLiveTools([]);
              turnTools = [];
            }
          }
        }

        // Handle any incomplete last buffer chunk
        if (buffer.trim().startsWith("data:")) {
          try {
            const jsonStr = buffer.slice(buffer.indexOf(":") + 1).trim();
            const event = JSON.parse(jsonStr);
            if (event.type === "message") {
              const replyText = typeof event.data === "string" ? event.data : (event.data as { text?: string })?.text ?? "";
              if (replyText.trim()) {
                const assistantMsg: ChatMessage = {
                  id: nanoid(),
                  role: "assistant",
                  content: replyText,
                  tools: turnTools.length > 0 ? [...turnTools] : undefined,
                  timestamp: Date.now(),
                };
                const withAssistant = [...nextMessages, assistantMsg];
                setMessages(withAssistant);
                persistMessages(withAssistant);
              }
            }
          } catch { /* ignore */ }
        }

      } else {
        // ── Fallback: plain JSON ───────────────────────────────────────────
        const data = await res.json() as { reply?: string; error?: string };
        const replyText = data.reply ?? data.error ?? "No response";
        const assistantMsg: ChatMessage = {
          id: nanoid(),
          role: "assistant",
          content: replyText,
          timestamp: Date.now(),
        };
        const withAssistant = [...nextMessages, assistantMsg];
        setMessages(withAssistant);
        persistMessages(withAssistant);
      }

    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") return;
      const errMsg: ChatMessage = {
        id: nanoid(),
        role: "assistant",
        content: `⚠️ Connection error: ${String(err)}`,
        timestamp: Date.now(),
      };
      const withErr = [...nextMessages, errMsg];
      setMessages(withErr);
      persistMessages(withErr);
    } finally {
      setIsLoading(false);
      setLiveTools([]);
      textareaRef.current?.focus();
      setAttachments([]);
    }
  }, [attachments, isLoading, messages, sessionId, persistMessages]);

  // ── Handle form submit ──────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      sendMessage(input);
    },
    [input, sendMessage]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  // ── Auto-resize textarea ────────────────────────────────────────────────────

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string | null;
        if (!result) return;
        const [, base64] = result.split(",", 2);
        if (!base64) return;
        setAttachments((prev) => [
          ...prev,
          {
            id: nanoid(),
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            data: base64,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });

    // Reset input so the same file can be selected again
    e.target.value = "";
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // ── Stop generation ─────────────────────────────────────────────────────────

  const stopGeneration = () => {
    abortRef.current?.abort();
    setIsLoading(false);
    setLiveTools([]);
  };

  // ─── Log count for footer ─────────────────────────────────────────────────

  const logCount = messages.length + liveTools.length;

  // ─── Render ───────────────────────────────────────────────────────────────

  if (!isMounted || !sessionId) {
    return (
      <div className="flex h-[100dvh] w-full items-center justify-center bg-[#0a0a0b]">
        <div className="size-4 rounded-full bg-[#00e5cc] animate-ping" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0b] font-mono">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e1e22] shrink-0">
        <div className="flex items-center gap-2">
          <div className="size-2 rounded-full bg-[#00e5cc] animate-pulse" />
          <span className="text-xs font-semibold text-[#e8e8ea] tracking-wider">VEGA</span>
          <span className="text-[10px] text-[#6b6b7a]">ID: {sessionId.slice(-8).toUpperCase()}</span>
        </div>
        <button
          onClick={() => router.push(`/chat?session=session-${nanoid(8)}`)}
          className="text-[#6b6b7a] hover:text-[#e8e8ea] transition-colors"
          title="New session"
        >
          <RefreshCwIcon className="size-3.5" />
        </button>
      </div>

      {/* ── Messages ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 sm:px-4 py-4 space-y-4 sm:space-y-6">

        {messages.length === 0 && !isLoading && (
          <motion.div className="flex flex-col items-center justify-center h-full gap-3 sm:gap-4 text-center py-10 sm:py-20"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5 }}
          >
            <div className="text-4xl sm:text-5xl drop-shadow-[0_0_15px_rgba(0,229,204,0.3)]">⚡</div>
            <p className="text-[#e8e8ea] font-bold tracking-widest text-base sm:text-lg">VEGA CORE ACTIVE</p>
            <p className="text-[#6b6b7a] text-[11px] sm:text-xs max-w-sm leading-relaxed px-4">
              Autonomous AI agent with web search, memory, code execution, workflows, and more.
            </p>
          </motion.div>
        )}

        {messages.map((msg, idx) => (
          <motion.div
            key={msg.id}
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              duration: 0.3,
              ease: "easeOut",
              delay: idx === messages.length - 1 ? 0 : 0 // Only animate the last one typically, or fast stagger
            }}
            className={`flex w-full ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {msg.role === "user" ? (
              /* User bubble */
              <div className="group max-w-[85%] sm:max-w-[75%] flex flex-row-reverse sm:flex-row items-end sm:items-start gap-1 sm:gap-1.5">
                <div className="rounded-2xl rounded-br-sm sm:rounded-2xl bg-gradient-to-br from-[#00e5cc]/20 to-[#00e5cc]/5 border border-[#00e5cc]/20 px-3 py-2 sm:px-3 sm:py-2.5 text-[11px] sm:text-xs text-[#e8e8ea] shadow-sm backdrop-blur-sm">
                  {msg.content}
                </div>
                <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                  <CopyButton text={msg.content} />
                </div>
              </div>
            ) : (
              /* Assistant message */
              <div className="group max-w-[95%] w-full flex flex-col gap-2">
                {/* Tool calls for this message */}
                {msg.tools && msg.tools.length > 0 && (
                  <ToolStream tools={msg.tools} />
                )}
                {/* Generated images from tools (display as <img>, not links) */}
                {getGeneratedImageUrls(msg.tools).map((img, i) => (
                  <InlineImage key={`img-${i}`} url={img.url} alt={img.alt} />
                ))}
                {/* Response body */}
                <div className="flex items-start gap-2 sm:gap-2.5">
                  <div className="border-l-2 border-[#00e5cc]/40 pl-3 py-0.5 text-[11px] sm:text-xs text-[#e8e8ea]/90 flex-1">
                    <MessageResponse components={markdownComponents}>
                      {msg.content}
                    </MessageResponse>

                  </div>
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
                    <CopyButton text={msg.content} />
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        ))}

        {/* ── Live streaming turn ───────────────────────────────────────── */}
        {isLoading && (
          <div className="flex justify-start w-full">
            <div className="max-w-[95%] w-full flex flex-col gap-1">
              {liveTools.length > 0 && <ToolStream tools={liveTools} />}
              {liveTools.length === 0 && <ThinkingDot />}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input area ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 bg-gradient-to-t from-[#0a0a0b] via-[#0a0a0b] to-transparent pt-4 sm:pt-6 pb-2 sm:pb-6 px-2 sm:px-4 pb-safe">
        <div className="max-w-4xl mx-auto">
          <form onSubmit={handleSubmit} className="flex flex-col gap-1.5 sm:gap-2">
            {/* Attachments preview */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1">
                {attachments.map((a) => (
                  <span
                    key={a.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#111113] border border-[#1e1e22] text-[10px] text-[#e8e8ea]"
                  >
                    <PaperclipIcon className="size-3 text-[#6b6b7a]" />
                    <span className="max-w-[140px] truncate">{a.name}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveAttachment(a.id)}
                      className="text-[#6b6b7a] hover:text-[#e8e8ea]"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="relative rounded-2xl border border-[#1e1e22] bg-[#111113]/90 backdrop-blur-xl shadow-2xl focus-within:border-[#00e5cc]/50 focus-within:ring-1 focus-within:ring-[#00e5cc]/20 transition-all">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Message VEGA..."
                disabled={isLoading}
                rows={1}
                className="w-full resize-none bg-transparent px-3 py-3 sm:px-4 sm:py-4 pr-20 sm:pr-24 text-[13px] sm:text-sm text-[#e8e8ea] placeholder-[#6b6b7a] focus:outline-none disabled:opacity-50 min-h-[48px] sm:min-h-[52px] max-h-[150px] sm:max-h-[200px] font-sans"
              />
              <div className="absolute right-1.5 bottom-1.5 sm:right-2 sm:bottom-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="size-8 sm:size-9 flex items-center justify-center rounded-xl border border-[#1e1e22] bg-[#0a0a0b] text-[#6b6b7a] hover:text-[#e8e8ea] hover:bg-[#1e1e22] transition-all"
                  title="Attach files"
                >
                  <PlusIcon className="size-4" />
                </button>
                <button
                  type={isLoading ? "button" : "submit"}
                  onClick={isLoading ? stopGeneration : undefined}
                  disabled={!isLoading && !input.trim() && attachments.length === 0}
                  className="size-8 sm:size-9 flex items-center justify-center rounded-xl bg-[#00e5cc] hover:bg-[#00c4b0] disabled:bg-[#1e1e22] disabled:text-[#6b6b7a] text-[#0a0a0b] transition-all"
                >
                  {isLoading ? (
                    <span className="size-3 sm:size-3.5 rounded-sm bg-current" />
                  ) : (
                    <ArrowUpIcon className="size-4 sm:size-5" />
                  )}
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
                accept="image/*,application/pdf"
              />
            </div>

            {/* Footer status */}
            <div className="flex items-center justify-between px-2 opacity-60">
              <p className="text-[9px] sm:text-[10px] text-[#6b6b7a] tracking-widest font-mono">
                MISSION: <span className="text-[#00e5cc]">{sessionId.slice(-8).toUpperCase()}</span>{" "}
                <span className="hidden sm:inline">[{logCount} LOG ENTRIES]</span>
              </p>
              <p className="text-[9px] sm:text-[10px] text-[#6b6b7a] tracking-widest font-mono text-right">
                <span className="hidden sm:inline">VEGA CORE ACTIVE.{" "}</span>
                <span className="text-[#e8e8ea]/40">AI CAN MAKE MISTAKES.</span>
              </p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={
      <div className="flex h-[100dvh] w-full items-center justify-center bg-[#0a0a0b]">
        <div className="size-4 rounded-full bg-[#00e5cc] animate-ping" />
      </div>
    }>
      <ChatPageContent />
    </Suspense>
  );
}
