//app/history/page.tsx
"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Trash2Icon, RefreshCwIcon, MessageSquareIcon, ChevronRightIcon, HistoryIcon } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

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
      <div className="max-w-4xl mx-auto p-4 sm:p-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-[#e8e8ea] mb-1 sm:mb-2 flex items-center gap-2">
              <HistoryIcon className="size-5 sm:size-6 text-[#00e5cc]" />
              Chat History
            </h1>
            <p className="text-xs sm:text-sm text-[#6b6b7a]">
              Browse and restore previous conversations
            </p>
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[#111113] border border-[#1e1e22] text-[#e8e8ea] hover:bg-[#1a1a1f] hover:border-[#3a3a44] transition-all disabled:opacity-50 text-sm w-full sm:w-auto shadow-sm"
            >
              <RefreshCwIcon className={`size-4 ${loading ? "animate-spin text-[#00e5cc]" : "text-[#6b6b7a]"}`} />
              Refresh
            </button>
        </motion.div>

        {/* Search */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-6"
        >
          <div className="relative">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search sessions..."
              className="w-full px-4 py-2.5 rounded-lg border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-sm text-[#e8e8ea] placeholder-[#6b6b7a] focus:border-[#00e5cc]/50 focus:ring-1 focus:ring-[#00e5cc]/20 focus:outline-none transition-all text-sm"
            />
          </div>
        </motion.div>

        {loading ? (
          <div className="text-center py-12">
            <RefreshCwIcon className="size-6 text-[#00e5cc] animate-spin mx-auto mb-3" />
            <p className="text-[#6b6b7a] text-sm">Loading sessions...</p>
          </div>
        ) : filteredSessions.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="border border-[#1e1e22] rounded-xl p-12 bg-[#111113]/50 backdrop-blur-sm text-center shadow-lg"
          >
            <MessageSquareIcon className="size-10 text-[#6b6b7a] mx-auto mb-4 opacity-50" />
            <p className="text-[#e8e8ea] font-medium">No chat history</p>
            <p className="text-xs text-[#6b6b7a] mt-2 max-w-sm mx-auto leading-relaxed">
              Start a new conversation to begin saving history
            </p>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <AnimatePresence>
              {filteredSessions.map((session, index) => (
                <motion.div
                  key={session.id}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ delay: Math.min(index * 0.05, 0.4) }}
                >
                  <Link
                    href={`/chat?session=${session.sessionId}`}
                    className="flex flex-col h-full border border-[#1e1e22] rounded-xl p-5 bg-[#111113]/80 backdrop-blur-md hover:bg-[#1a1a1f] hover:border-[#00e5cc]/40 hover:shadow-lg transition-all group cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-[#1e1e22] rounded-lg text-[#00e5cc] group-hover:bg-[#00e5cc]/10 transition-colors">
                            <MessageSquareIcon className="size-4 shrink-0" />
                          </div>
                          <h3 className="text-sm font-semibold text-[#e8e8ea] group-hover:text-[#00e5cc] transition-colors truncate">
                            {session.title || "Untitled Conversation"}
                          </h3>
                        </div>
                        {session.lastMessage && (
                          <p className="text-xs text-[#8b8b9a] mt-3 line-clamp-2 pr-2 leading-relaxed italic">
                            "{session.lastMessage}"
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
                        className="flex items-center justify-center p-2 rounded-lg border border-transparent hover:border-red-500/30 hover:bg-red-500/10 text-[#6b6b7a] hover:text-red-400 transition-all disabled:opacity-50 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
                        title="Delete Session"
                      >
                        <Trash2Icon className="size-4" />
                      </button>
                    </div>
                    <div className="mt-auto pt-4 border-t border-[#1e1e22]/60 flex items-center justify-between text-[10px] text-[#6b6b7a] font-mono">
                      <div className="flex items-center gap-2 bg-[#0a0a0b] border border-[#1e1e22] px-2 py-1.5 rounded-md">
                        <span>{session.messageCount} msgs</span>
                      </div>
                      <span className="text-[#8b8b9a] flex items-center gap-1">
                        {formatDate(session.updatedAt)}
                        <ChevronRightIcon className="size-3 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
                      </span>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </AnimatePresence>
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
