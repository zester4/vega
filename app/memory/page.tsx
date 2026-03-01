"use client";

import { useState, useEffect } from "react";
import { Trash2Icon, RefreshCwIcon, DatabaseIcon } from "lucide-react";

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
      <div className="max-w-4xl mx-auto p-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#e8e8ea] mb-2">
              Knowledge Base
            </h1>
            <p className="text-sm text-[#6b6b7a]">
              Manage persistent memories and facts stored by VEGA
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
            placeholder="Search memories..."
            className="w-full px-4 py-2 rounded-md border border-[#1e1e22] bg-[#111113] text-[#e8e8ea] placeholder-[#6b6b7a] focus:border-[#00e5cc] focus:outline-none"
          />
        </div>

        {loading ? (
          <div className="text-center py-12">
            <p className="text-[#6b6b7a]">Loading memories...</p>
          </div>
        ) : filteredMemories.length === 0 ? (
          <div className="border border-[#1e1e22] rounded-lg p-12 bg-[#111113] text-center">
            <DatabaseIcon className="size-8 text-[#6b6b7a] mx-auto mb-3 opacity-50" />
            <p className="text-[#6b6b7a]">No memories found</p>
            <p className="text-xs text-[#6b6b7a] mt-1">
              Memories will appear here when VEGA stores facts during conversations
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredMemories.map((memory) => (
              <div
                key={memory.id}
                className="border border-[#1e1e22] rounded-lg p-4 bg-[#111113] hover:bg-[#1a1a1f] transition-colors"
              >
                <div className="flex items-start justify-between gap-4 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono font-semibold text-[#00e5cc] truncate">
                      {memory.key}
                    </div>
                    <p className="text-sm text-[#e8e8ea] mt-1 break-words">
                      {memory.value}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(memory.id)}
                    disabled={deleting === memory.id}
                    className="flex items-center gap-2 px-3 py-1 rounded-md bg-[#1e1e22] hover:bg-red-600/10 text-[#6b6b7a] hover:text-red-400 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <Trash2Icon className="size-4" />
                  </button>
                </div>
                {memory.metadata && Object.keys(memory.metadata).length > 0 && (
                  <div className="text-xs text-[#6b6b7a] mt-2 space-y-1">
                    {Object.entries(memory.metadata).map(([k, v]) => (
                      <div key={k}>
                        <span className="font-semibold">{k}:</span> {v}
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-xs text-[#6b6b7a] mt-2">
                  {new Date(memory.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
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
