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
import { CopyIcon, RefreshCwIcon } from "lucide-react";

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
  default: "🛠️",
};

const getToolIcon = (name: string) =>
  TOOL_ICONS[name] ?? TOOL_ICONS.default;

// ─── ToolStream Component ────────────────────────────────────────────────────

function ToolStream({ tools }: { tools: ToolCall[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (!tools || tools.length === 0) return null;

  const toggleExpand = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="mb-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-[#6b6b7a] px-1 pb-1">
        TOOLS ({tools.length})
      </p>
      <div className="space-y-1">
        {tools.map((tool) => {
          const isOpen = expanded[tool.id] ?? (tool.status === "running");
          return (
            <div
              key={tool.id}
              className="rounded border border-[#1e1e22] bg-[#111113] overflow-hidden"
            >
              {/* Header */}
              <button
                onClick={() => toggleExpand(tool.id)}
                className="w-full px-3 py-1.5 flex items-center justify-between gap-2 hover:bg-[#1a1a1d] transition-colors text-left"
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
                  <span className="text-xs font-mono text-[#e8e8ea] truncate">
                    {getToolIcon(tool.name)} {tool.name}
                  </span>
                </div>
                <span className="text-[10px] text-[#6b6b7a] shrink-0 capitalize">
                  {tool.status === "running" ? "running…" : tool.status}
                </span>
              </button>

              {/* Body */}
              {isOpen && (
                <div className="border-t border-[#1e1e22] text-xs font-mono">
                  {tool.input && (
                    <div className="px-3 py-2 border-b border-[#1e1e22] bg-[#0a0a0b]">
                      <p className="text-[10px] text-[#6b6b7a] uppercase mb-1">Params</p>
                      <pre className="text-[#e8e8ea]/70 overflow-x-auto max-h-20 scrollbar-thin">
                        {JSON.stringify(tool.input, null, 2)}
                      </pre>
                    </div>
                  )}
                  {(tool.output || tool.errorText) && (
                    <div className="px-3 py-2 bg-[#0a0a0b]">
                      <p className={`text-[10px] uppercase mb-1 ${tool.errorText ? "text-red-400" : "text-[#6b6b7a]"}`}>
                        {tool.errorText ? "Error" : "Output"}
                      </p>
                      {tool.errorText ? (
                        <pre className="text-red-400 overflow-x-auto max-h-24 scrollbar-thin">{tool.errorText}</pre>
                      ) : (
                        <pre className="text-[#e8e8ea]/70 overflow-x-auto max-h-24 scrollbar-thin">
                          {typeof tool.output === "string"
                            ? tool.output
                            : JSON.stringify(tool.output, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
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

function SimpleMarkdown({ content }: { content: string }) {
  const lines = content.split("\n");

  const renderInline = (text: string) => {
    // Bold: **text** or __text__
    // Inline code: `code`
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let key = 0;

    const patterns = [
      { re: /\*\*(.+?)\*\*/s, wrap: (m: string) => <strong key={key++} className="font-semibold text-[#e8e8ea]">{m}</strong> },
      { re: /`([^`]+)`/, wrap: (m: string) => <code key={key++} className="bg-[#1e1e22] rounded px-1 text-[#00e5cc] font-mono text-[0.85em]">{m}</code> },
    ];

    while (remaining.length > 0) {
      let earliest: { index: number; match: RegExpMatchArray; wrap: (m: string) => React.ReactNode } | null = null;

      for (const { re, wrap } of patterns) {
        const m = remaining.match(re);
        if (m && m.index !== undefined) {
          if (!earliest || m.index < earliest.index) {
            earliest = { index: m.index, match: m, wrap };
          }
        }
      }

      if (!earliest) {
        parts.push(remaining);
        break;
      }

      if (earliest.index > 0) {
        parts.push(remaining.slice(0, earliest.index));
      }
      parts.push(earliest.wrap(earliest.match[1]));
      remaining = remaining.slice(earliest.index + earliest.match[0].length);
    }

    return parts;
  };

  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        if (line.startsWith("### ")) {
          return <h3 key={i} className="text-sm font-semibold text-[#e8e8ea] mt-3 mb-1">{renderInline(line.slice(4))}</h3>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={i} className="text-base font-semibold text-[#e8e8ea] mt-3 mb-1">{renderInline(line.slice(3))}</h2>;
        }
        if (line.startsWith("# ")) {
          return <h1 key={i} className="text-lg font-bold text-[#e8e8ea] mt-3 mb-1">{renderInline(line.slice(2))}</h1>;
        }
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <div key={i} className="flex gap-2">
              <span className="text-[#00e5cc] mt-0.5 shrink-0">·</span>
              <span>{renderInline(line.slice(2))}</span>
            </div>
          );
        }
        if (/^\d+\. /.test(line)) {
          const match = line.match(/^(\d+)\. (.*)/);
          if (match) {
            return (
              <div key={i} className="flex gap-2">
                <span className="text-[#00e5cc] shrink-0 font-mono text-xs mt-0.5">{match[1]}.</span>
                <span>{renderInline(match[2])}</span>
              </div>
            );
          }
        }
        if (line.trim() === "") {
          return <div key={i} className="h-2" />;
        }
        return <p key={i} className="leading-relaxed">{renderInline(line)}</p>;
      })}
    </div>
  );
}

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
        body: JSON.stringify({ message: text.trim(), sessionId }),
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
    }
  }, [isLoading, messages, sessionId, persistMessages]);

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
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-6">

        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-20">
            <div className="text-4xl">⚡</div>
            <p className="text-[#e8e8ea] font-semibold text-lg">VEGA CORE ACTIVE</p>
            <p className="text-[#6b6b7a] text-xs max-w-xs">
              Autonomous AI agent with web search, memory, code execution, workflows, and more.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex w-full ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {msg.role === "user" ? (
              /* User bubble */
              <div className="group max-w-[80%] flex items-start gap-2">
                <div className="rounded-2xl bg-gradient-to-br from-[#00e5cc]/20 to-[#00e5cc]/5 border border-[#00e5cc]/20 px-4 py-2.5 text-sm text-[#e8e8ea]">
                  {msg.content}
                </div>
                <CopyButton text={msg.content} />
              </div>
            ) : (
              /* Assistant message */
              <div className="group max-w-[95%] w-full flex flex-col gap-1">
                {/* Tool calls for this message */}
                {msg.tools && msg.tools.length > 0 && (
                  <ToolStream tools={msg.tools} />
                )}
                {/* Response body */}
                <div className="flex items-start gap-2">
                  <div className="border-l-2 border-[#00e5cc]/30 pl-4 py-1 text-sm text-[#e8e8ea]/90 flex-1">
                    <SimpleMarkdown content={msg.content} />
                  </div>
                  <CopyButton text={msg.content} />
                </div>
              </div>
            )}
          </div>
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
      <div className="shrink-0 border-t border-[#1e1e22] px-4 py-3">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <div className="relative rounded-lg border border-[#1e1e22] bg-[#111113] focus-within:border-[#00e5cc]/40 transition-colors">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="System prompt ready. Awaiting instructions..."
              disabled={isLoading}
              rows={1}
              className="w-full resize-none bg-transparent px-4 py-3 pr-14 text-sm text-[#e8e8ea] placeholder-[#6b6b7a] focus:outline-none disabled:opacity-50 min-h-[44px] max-h-[160px] font-mono"
            />
            <button
              type={isLoading ? "button" : "submit"}
              onClick={isLoading ? stopGeneration : undefined}
              disabled={!isLoading && !input.trim()}
              className="absolute right-2 bottom-2 size-8 flex items-center justify-center rounded-md bg-[#00e5cc] hover:bg-[#00c4b0] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? (
                <span className="size-3 rounded-sm bg-[#0a0a0b]" /> // stop icon
              ) : (
                <svg
                  className="size-4 text-[#0a0a0b]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              )}
            </button>
          </div>

          {/* Footer status */}
          <div className="flex items-center justify-between px-1">
            <p className="text-[10px] text-[#6b6b7a] tracking-widest">
              MISSION: <span className="text-[#00e5cc]">{sessionId.slice(-8).toUpperCase()}</span>{" "}
              [{logCount} LOG ENTRIES]
            </p>
            <p className="text-[10px] text-[#6b6b7a] tracking-widest">
              VEGA CORE ACTIVE.{" "}
              <span className="text-[#e8e8ea]/40">WEB_SEARCH · RUN_CODE · WORKFLOW · MEMORY</span>
            </p>
          </div>
        </form>
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
