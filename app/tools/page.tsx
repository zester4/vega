//app/tools/page.tsx
"use client";

import { useState, useEffect, useMemo } from "react";
import {
  PlusIcon,
  SearchIcon,
  WrenchIcon,
  CpuIcon,
  DatabaseIcon,
  GlobeIcon,
  TerminalIcon,
  ShieldCheckIcon,
  ZapIcon,
  InfoIcon,
  ChevronRightIcon
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

interface Tool {
  id: string;
  name: string;
  description: string;
  source: "system" | "user";
  category: string;
  status: "active" | "offline";
  parameters?: {
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

export default function ToolsDashboard() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");

  useEffect(() => {
    const loadRegistry = async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/tools");
        if (!res.ok) throw new Error("Failed to fetch registry");
        const data = await res.json() as any;
        if (data.success) {
          setTools(data.tools);
        }
      } catch (err) {
        console.error("[Dashboard Load Error]", err);
      } finally {
        setLoading(false);
      }
    };
    loadRegistry();
  }, []);

  const categories = useMemo(() => {
    const cats = new Set(tools.map(t => t.category));
    return ["all", ...Array.from(cats)];
  }, [tools]);

  const filteredTools = useMemo(() => {
    return tools.filter(t => {
      const matchesSearch = t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.description.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCat = selectedCategory === "all" || t.category === selectedCategory;
      return matchesSearch && matchesCat;
    });
  }, [tools, searchQuery, selectedCategory]);

  return (
    <div className="h-full overflow-y-auto bg-[#050507] text-[#e8e8ea] selection:bg-[#00e5cc]/30 p-4 sm:p-10 font-sans">
      <div className="max-w-7xl mx-auto">
        {/* Header Section */}
        <header className="mb-12 relative">
          <div className="absolute -top-20 -left-20 size-64 bg-[#00e5cc]/10 blur-[120px] rounded-full pointer-events-none" />
          <div className="absolute -top-10 right-20 size-48 bg-purple-500/10 blur-[100px] rounded-full pointer-events-none" />

          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5 }}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2.5 rounded-xl bg-gradient-to-br from-[#00e5cc]/20 to-[#00e5cc]/5 border border-[#00e5cc]/20 shadow-[0_0_20px_rgba(0,229,204,0.1)]">
                  <WrenchIcon className="size-6 text-[#00e5cc]" />
                </div>
                <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
                  Tool Registry <span className="text-[#00e5cc] font-mono text-lg align-top ml-2">v1.0</span>
                </h1>
              </div>
              <p className="text-[#9a9aa6] text-lg max-w-2xl leading-relaxed">
                Centralized capability hub for VEGA. Monitor system built-ins and manage autonomous agent extensions.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-3"
            >
              <div className="flex flex-col items-end">
                <span className="text-[10px] uppercase tracking-widest text-[#6b6b7a] font-bold">Registry Status</span>
                <div className="flex items-center gap-2">
                  <div className="size-2 rounded-full bg-[#00e5cc] animate-pulse" />
                  <span className="text-sm font-semibold">Edge Cluster Active</span>
                </div>
              </div>
              <button className="ml-4 px-5 py-2.5 rounded-xl bg-white/[0.03] border border-white/10 hover:bg-white/[0.08] transition-all flex items-center gap-2 group">
                <PlusIcon className="size-4 group-hover:rotate-90 transition-transform duration-300" />
                <span className="text-sm font-semibold">Extend Agent</span>
              </button>
            </motion.div>
          </div>
        </header>

        {/* Filter Bar */}
        <section className="mb-10 flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1 group">
            <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-[#6b6b7a] group-focus-within:text-[#00e5cc] transition-colors" />
            <input
              type="text"
              placeholder="Search capabilities by name or keyword..."
              className="w-full pl-12 pr-4 py-3.5 rounded-2xl bg-white/[0.03] border border-white/[0.08] focus:border-[#00e5cc]/40 focus:bg-white/[0.05] focus:outline-none transition-all placeholder:text-[#6b6b7a] text-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-2 sm:pb-0 scrollbar-none">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-5 py-3 rounded-2xl text-xs font-bold uppercase tracking-widest transition-all whitespace-nowrap border ${selectedCategory === cat
                  ? 'bg-[#00e5cc]/10 border-[#00e5cc]/40 text-[#00e5cc]'
                  : 'bg-white/[0.03] border-white/[0.08] text-[#6b6b7a] hover:border-white/20'
                  }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </section>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-32">
            <div className="relative">
              <div className="size-16 rounded-full border-2 border-[#00e5cc]/20 border-t-[#00e5cc] animate-spin" />
              <ZapIcon className="absolute inset-x-0 top-1/2 -translate-y-1/2 mx-auto size-6 text-[#00e5cc] animate-pulse" />
            </div>
            <p className="mt-6 text-[#6b6b7a] font-medium tracking-wide">Synchronizing capability registry...</p>
          </div>
        ) : (
          <motion.div
            layout
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
          >
            <AnimatePresence mode="popLayout">
              {filteredTools.map((tool, idx) => (
                <ToolCard key={tool.id} tool={tool} index={idx} />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
    </div>
  );
}

function ToolCard({ tool, index }: { tool: Tool, index: number }) {
  const isDestructive = ["delete", "move", "exec", "write"].some(w => tool.name.includes(w) || tool.description.toLowerCase().includes(w));

  const Icon = useMemo(() => {
    if (tool.name.includes("search") || tool.name.includes("fetch")) return GlobeIcon;
    if (tool.name.includes("memory")) return DatabaseIcon;
    if (tool.name.includes("fs") || tool.name.includes("file")) return TerminalIcon;
    if (tool.name.includes("agent") || tool.name.includes("workflow")) return CpuIcon;
    return WrenchIcon;
  }, [tool.name]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: 10 }}
      transition={{ delay: index * 0.05, duration: 0.3 }}
      className="group relative h-full flex flex-col p-6 rounded-3xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.04] hover:border-[#00e5cc]/30 transition-all duration-500 overflow-hidden"
    >
      {/* Background Accent */}
      <div className={`absolute -right-10 -top-10 size-20 blur-3xl rounded-full transition-opacity duration-500 ${tool.source === 'system' ? 'bg-[#00e5cc]/20 opacity-0 group-hover:opacity-100' : 'bg-purple-500/20 opacity-0 group-hover:opacity-100'
        }`} />

      {/* Card Header */}
      <div className="flex items-start justify-between mb-5">
        <div className={`p-3 rounded-2xl ${tool.source === 'system' ? 'bg-[#00e5cc]/10 text-[#00e5cc]' : 'bg-purple-500/10 text-purple-400'
          } group-hover:scale-110 transition-transform duration-500 shadow-inner`}>
          <Icon className="size-6" />
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-widest ${tool.source === 'system'
            ? 'bg-[#00e5cc]/10 text-[#00e5cc] border border-[#00e5cc]/20'
            : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
            }`}>
            {tool.source === 'system' ? 'System' : 'Custom'}
          </span>
          {isDestructive && (
            <div className="flex items-center gap-1 text-[9px] font-black text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
              <ShieldCheckIcon className="size-3" />
              SAFEGUARDED
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1">
        <h3 className="text-xl font-bold text-white mb-2 group-hover:text-[#00e5cc] transition-colors">
          {tool.name}
        </h3>
        <p className="text-sm text-[#9a9aa6] leading-relaxed line-clamp-3 italic font-light mb-6">
          {tool.description}
        </p>
      </div>

      {/* Footer / Parameters */}
      <div className="mt-auto space-y-4">
        {tool.parameters?.properties && (
          <div className="flex flex-wrap gap-1.5 pt-4 border-t border-white/[0.06]">
            {Object.keys(tool.parameters.properties).slice(0, 4).map(p => (
              <span key={p} className="text-[10px] px-2 py-1 rounded-lg bg-black/40 text-[#6b6b7a] border border-white/[0.05] font-mono">
                {p}
              </span>
            ))}
            {Object.keys(tool.parameters.properties).length > 4 && (
              <span className="text-[10px] px-2 py-1 rounded-lg bg-black/40 text-[#6b6b7a] border border-white/[0.05] font-mono">
                +{Object.keys(tool.parameters.properties).length - 4} more
              </span>
            )}
          </div>
        )}

        <button className="w-full flex items-center justify-between text-xs font-bold text-[#6b6b7a] group-hover:text-white transition-colors py-1">
          <div className="flex items-center gap-1.5">
            <InfoIcon className="size-3.5" />
            View Documentation
          </div>
          <ChevronRightIcon className="size-4 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
        </button>
      </div>
    </motion.div>
  );
}
