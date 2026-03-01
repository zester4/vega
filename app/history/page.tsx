"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Trash2Icon, RefreshCwIcon, MessageSquareIcon, ChevronRightIcon } from "lucide-react";

interface Session {
  id: string;
  sessionId: string;
  title: string;
  messageCount: number;
  lastMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export default function HistoryPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  // Fetch sessions from localStorage (simulated)
  useEffect(() => {
    const loadSessions = async () => {
      try {
        // Simulate loading sessions from Redis
        const stored = localStorage.getItem("vega-sessions");
        const list: Session[] = stored ? JSON.parse(stored) : [];
        setSessions(list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
      } catch (err) {
        console.error("Failed to load sessions:", err);
      } finally {
        setLoading(false);
      }
    };

    loadSessions();
  }, []);

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const updated = sessions.filter((s) => s.id !== id);
      setSessions(updated);
      localStorage.setItem("vega-sessions", JSON.stringify(updated));
    } catch (err) {
      console.error("Failed to delete session:", err);
    } finally {
      setDeleting(null);
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const stored = localStorage.getItem("vega-sessions");
      const list: Session[] = stored ? JSON.parse(stored) : [];
      setSessions(list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
    } catch (err) {
      console.error("Failed to refresh sessions:", err);
    } finally {
      setLoading(false);
    }
  };

  const filteredSessions = sessions.filter(
    (s) =>
      s.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.sessionId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (s.lastMessage?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false)
  );

  const formatDate = (date: string) => {
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin bg-[#0a0a0b]">
      <div className="max-w-4xl mx-auto p-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#e8e8ea] mb-2">
              Chat History
            </h1>
            <p className="text-sm text-[#6b6b7a]">
              Browse and restore previous conversations
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-[#1e1e22] text-[#e8e8ea] hover:bg-[#2a2a2f] transition-colors disabled:opacity-50"
          >
            <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Search */}
        <div className="mb-6">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search sessions..."
            className="w-full px-4 py-2 rounded-md border border-[#1e1e22] bg-[#111113] text-[#e8e8ea] placeholder-[#6b6b7a] focus:border-[#00e5cc] focus:outline-none"
          />
        </div>

        {loading ? (
          <div className="text-center py-12">
            <p className="text-[#6b6b7a]">Loading sessions...</p>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="border border-[#1e1e22] rounded-lg p-12 bg-[#111113] text-center">
            <MessageSquareIcon className="size-8 text-[#6b6b7a] mx-auto mb-3 opacity-50" />
            <p className="text-[#6b6b7a]">No chat history</p>
            <p className="text-xs text-[#6b6b7a] mt-1">
              Start a new conversation to begin saving history
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredSessions.map((session) => (
              <Link
                key={session.id}
                href={`/chat?session=${session.sessionId}`}
                className="block border border-[#1e1e22] rounded-lg p-5 bg-[#111113] hover:bg-[#1a1a1f] hover:border-[#2a2a2f] transition-all group cursor-pointer"
              >
                <div className="flex items-start justify-between gap-4 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-[#1e1e22] rounded-md text-[#00e5cc]">
                        <MessageSquareIcon className="size-4 shrink-0" />
                      </div>
                      <h3 className="text-base font-semibold text-[#e8e8ea] group-hover:text-[#00e5cc] transition-colors truncate">
                        {session.title || "Untitled Conversation"}
                      </h3>
                      <ChevronRightIcon className="size-4 text-[#6b6b7a] opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all shrink-0" />
                    </div>
                    {session.lastMessage && (
                      <p className="text-sm text-[#8b8b9a] mt-3 line-clamp-2 pr-4 leading-relaxed">
                        {session.lastMessage}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDelete(session.id);
                    }}
                    disabled={deleting === session.id}
                    className="flex items-center gap-2 px-3 py-1 rounded-md bg-[#1e1e22] hover:bg-red-600/10 text-[#6b6b7a] hover:text-red-400 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <Trash2Icon className="size-4" />
                  </button>
                </div>
                <div className="mt-4 pt-4 border-t border-[#1e1e22] flex items-center justify-between text-xs text-[#6b6b7a] font-medium">
                  <div className="flex items-center gap-2 bg-[#1e1e22] px-2 py-1 rounded-md">
                    <span>{session.messageCount} messages</span>
                  </div>
                  <span className="text-[#8b8b9a]">{formatDate(session.updatedAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Stats */}
        {filteredSessions.length > 0 && (
          <div className="mt-6 pt-6 border-t border-[#1e1e22] text-sm text-[#6b6b7a]">
            Showing {filteredSessions.length} of {sessions.length} sessions
          </div>
        )}
      </div>
    </div>
  );
}
