//app/memory/page.tsx
"use client";

import { useState, useEffect } from "react";
import { Trash2Icon, RefreshCwIcon, DatabaseIcon } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export interface Memory {
  id: string;
  key: string;
  value: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  // Fetch memories from backend
  const loadMemories = async () => {
    try {
      const res = await fetch("/api/memory");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json() as { memories?: Memory[] };
      setMemories(data.memories || []);
    } catch (err) {
      console.error("Failed to load memories:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMemories();
  }, []);

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const res = await fetch(`/api/memory?key=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setMemories((prev) => prev.filter((m) => m.id !== id));
      } else {
        throw new Error(await res.text());
      }
    } catch (err) {
      console.error("Failed to delete memory:", err);
    } finally {
      setDeleting(null);
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    await loadMemories();
  };

  const filteredMemories = memories.filter(
    (m) =>
      m.key.toLowerCase().includes(searchTerm.toLowerCase()) ||
      m.value.toLowerCase().includes(searchTerm.toLowerCase())
  );

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
              <DatabaseIcon className="size-5 sm:size-6 text-[#00e5cc]" />
              Knowledge Base
            </h1>
            <p className="text-xs sm:text-sm text-[#6b6b7a]">
              Manage persistent memories and facts stored by VEGA
            </p>
          </div>
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
              placeholder="Search memories..."
              className="w-full px-4 py-2.5 rounded-lg border border-[#1e1e22] bg-[#111113]/80 backdrop-blur-sm text-[#e8e8ea] placeholder-[#6b6b7a] focus:border-[#00e5cc]/50 focus:ring-1 focus:ring-[#00e5cc]/20 focus:outline-none transition-all text-sm"
            />
          </div>
        </motion.div>

        {loading ? (
          <div className="text-center py-12">
            <RefreshCwIcon className="size-6 text-[#00e5cc] animate-spin mx-auto mb-3" />
            <p className="text-[#6b6b7a] text-sm">Loading memories...</p>
          </div>
        ) : filteredMemories.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="border border-[#1e1e22] rounded-xl p-12 bg-[#111113]/50 backdrop-blur-sm text-center shadow-lg"
          >
            <DatabaseIcon className="size-10 text-[#6b6b7a] mx-auto mb-4 opacity-50" />
            <p className="text-[#e8e8ea] font-medium">No memories found</p>
            <p className="text-xs text-[#6b6b7a] mt-2 max-w-sm mx-auto leading-relaxed">
              Memories will appear here when VEGA stores facts during conversations
            </p>
          </motion.div>
        ) : (
          <div className="space-y-3 sm:space-y-4">
            <AnimatePresence>
              {filteredMemories.map((memory, index) => (
                <motion.div
                  key={memory.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                  transition={{ delay: Math.min(index * 0.05, 0.5) }}
                  className="group border border-[#1e1e22] rounded-xl p-4 sm:p-5 bg-[#111113]/80 backdrop-blur-md hover:bg-[#1a1a1f] hover:border-[#3a3a44] transition-all shadow-sm"
                >
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs sm:text-sm font-mono font-bold text-[#00e5cc] truncate w-fit px-2 py-0.5 rounded bg-[#00e5cc]/10 border border-[#00e5cc]/20 mb-2">
                        {memory.key}
                      </div>
                      <p className="text-sm text-[#e8e8ea] leading-relaxed break-words">
                        {memory.value}
                      </p>
                    </div>
                    <button
                      onClick={() => handleDelete(memory.id)}
                      disabled={deleting === memory.id}
                      className="flex items-center gap-2 p-2 rounded-lg border border-transparent hover:border-red-500/30 hover:bg-red-500/10 text-[#6b6b7a] hover:text-red-400 transition-all disabled:opacity-50 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
                      title="Delete Memory"
                    >
                      <Trash2Icon className="size-4" />
                    </button>
                  </div>
                  {memory.metadata && Object.keys(memory.metadata).length > 0 && (
                    <div className="text-[10px] sm:text-xs text-[#6b6b7a] mt-3 space-y-1 bg-[#0a0a0b] p-2 rounded-md border border-[#1e1e22]">
                      {Object.entries(memory.metadata).map(([k, v]) => (
                        <div key={k} className="flex gap-2">
                          <span className="font-semibold text-[#8b8b9a] uppercase tracking-wider">{k}:</span>
                          <span className="truncate">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-[10px] text-[#4a4a58] mt-3 font-mono">
                    {new Date(memory.createdAt).toLocaleString()}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

        {/* Stats */}
        {filteredMemories.length > 0 && (
          <div className="mt-6 pt-6 border-t border-[#1e1e22] text-sm text-[#6b6b7a]">
            Showing {filteredMemories.length} of {memories.length} memories
          </div>
        )}
      </div>
    </div>
  );
}
