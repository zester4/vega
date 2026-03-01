//app/tools/page.tsx
"use client";

import { useState } from "react";
import { PlusIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface Tool {
  id: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  parameters?: Record<string, unknown>;
}

const BUILTIN_TOOLS: Tool[] = [
  {
    id: "web_search",
    name: "web_search",
    description: "Search the web for current information, facts, and news",
    isBuiltin: true,
    parameters: { query: "string" },
  },
  {
    id: "fetch_url",
    name: "fetch_url",
    description: "Fetch and read the content of a specific URL",
    isBuiltin: true,
    parameters: { url: "string" },
  },
  {
    id: "store_memory",
    name: "store_memory",
    description: "Persist a fact to Redis for long-term recall",
    isBuiltin: true,
    parameters: { key: "string", value: "string" },
  },
  {
    id: "recall_memory",
    name: "recall_memory",
    description: "Retrieve a stored memory by key",
    isBuiltin: true,
    parameters: { key: "string" },
  },
  {
    id: "schedule_cron",
    name: "schedule_cron",
    description: "Create a QStash cron job for recurring tasks",
    isBuiltin: true,
    parameters: { schedule: "string", endpoint: "string" },
  },
  {
    id: "trigger_workflow",
    name: "trigger_workflow",
    description: "Start a long-running durable pipeline",
    isBuiltin: true,
    parameters: { workflow: "string", input: "string" },
  },
  {
    id: "calculate",
    name: "calculate",
    description: "Evaluate mathematical expressions",
    isBuiltin: true,
    parameters: { expression: "string" },
  },
  {
    id: "get_datetime",
    name: "get_datetime",
    description: "Get current date/time in any timezone",
    isBuiltin: true,
    parameters: { timezone: "string" },
  },
];

export default function ToolsPage() {
  const [customTools, setCustomTools] = useState<Tool[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ name: "", description: "" });

  const handleAddTool = () => {
    if (formData.name && formData.description) {
      const newTool: Tool = {
        id: `custom-${Date.now()}`,
        name: formData.name,
        description: formData.description,
        isBuiltin: false,
      };
      setCustomTools([...customTools, newTool]);
      setFormData({ name: "", description: "" });
      setShowForm(false);
    }
  };

  const handleDeleteCustom = (id: string) => {
    setCustomTools(customTools.filter((t) => t.id !== id));
  };

  const allTools = [...BUILTIN_TOOLS, ...customTools];

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
              <WrenchIcon className="size-5 sm:size-6 text-[#00e5cc]" />
              Tools & Capabilities
            </h1>
            <p className="text-xs sm:text-sm text-[#6b6b7a]">
              Manage available tools and create custom tool extensions
            </p>
          </div>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[#00e5cc] text-[#0a0a0b] font-semibold hover:bg-[#00d9b8] transition-all w-full sm:w-auto shadow-[0_0_15px_rgba(0,229,204,0.3)] hover:shadow-[0_0_20px_rgba(0,229,204,0.4)]"
            >
              <PlusIcon className="size-4" />
              New Tool
            </button>
          )}
        </motion.div>

        {/* Create Tool Form */}
        <AnimatePresence>
          {showForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden mb-6 sm:mb-8"
            >
              <div className="border border-[#00e5cc]/30 rounded-xl p-5 sm:p-6 bg-[#00e5cc]/5 backdrop-blur-md shadow-[0_0_30px_rgba(0,229,204,0.05)]">
                <h2 className="font-semibold text-[#e8e8ea] mb-4 flex items-center gap-2">
                  <div className="p-1.5 rounded bg-[#00e5cc]/20 text-[#00e5cc]">
                    <PlusIcon className="size-4" />
                  </div>
                  Create Custom Tool
                </h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold text-[#e8e8ea] mb-2">
                      Tool Name
                    </label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) =>
                        setFormData({ ...formData, name: e.target.value })
                      }
                      placeholder="e.g., send_email"
                      className="w-full px-4 py-2.5 rounded-lg border border-[#00e5cc]/20 bg-[#0a0a0b] text-[#e8e8ea] placeholder-[#6b6b7a] focus:border-[#00e5cc] focus:ring-1 focus:ring-[#00e5cc]/30 focus:outline-none transition-all text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-[#e8e8ea] mb-2">
                      Description
                    </label>
                    <textarea
                      value={formData.description}
                      onChange={(e) =>
                        setFormData({ ...formData, description: e.target.value })
                      }
                      placeholder="What does this tool do?"
                      rows={3}
                      className="w-full px-4 py-2.5 rounded-lg border border-[#00e5cc]/20 bg-[#0a0a0b] text-[#e8e8ea] placeholder-[#6b6b7a] focus:border-[#00e5cc] focus:ring-1 focus:ring-[#00e5cc]/30 focus:outline-none transition-all text-sm resize-y"
                    />
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={handleAddTool}
                      disabled={!formData.name || !formData.description}
                      className="flex-1 px-4 py-2.5 rounded-lg bg-[#00e5cc] text-[#0a0a0b] font-bold hover:bg-[#00d9b8] transition-all disabled:opacity-50 text-sm"
                    >
                      Create Tool
                    </button>
                    <button
                      onClick={() => setShowForm(false)}
                      className="flex-1 px-4 py-2.5 rounded-lg bg-[#1e1e22] text-[#e8e8ea] hover:bg-[#2a2a2f] transition-all text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tools List */}
        <div className="space-y-6 sm:space-y-8">
          {/* Built-in Tools */}
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#6b6b7a] mb-4 px-1">
              Built-in Tools ({BUILTIN_TOOLS.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
              {BUILTIN_TOOLS.map((tool, index) => (
                <motion.div
                  key={tool.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="border border-[#1e1e22] rounded-xl p-4 sm:p-5 bg-[#111113]/80 backdrop-blur-md hover:bg-[#1a1a1f] hover:border-[#3a3a44] transition-all shadow-sm flex flex-col h-full"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-3 relative z-10">
                      <div className="p-2 rounded-lg bg-[#00e5cc]/10 text-[#00e5cc] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
                        <WrenchIcon className="size-4 sm:size-5" />
                      </div>
                      <div className="font-bold text-[#e8e8ea] text-sm sm:text-base">
                        {tool.name}
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] sm:text-xs font-semibold bg-[#00e5cc]/10 border border-[#00e5cc]/20 text-[#00e5cc] whitespace-nowrap">
                      Built-in
                    </span>
                  </div>
                  <p className="text-xs sm:text-sm text-[#8b8b9a] mt-1 leading-relaxed pl-[44px]">
                    {tool.description}
                  </p>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Custom Tools */}
          {customTools.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pt-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-[#6b6b7a] mb-4 px-1">
                Custom Tools ({customTools.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                <AnimatePresence>
                  {customTools.map((tool) => (
                    <motion.div
                      key={tool.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      className="group border border-[#f5a623]/30 rounded-xl p-4 sm:p-5 bg-[#f5a623]/5 backdrop-blur-md hover:bg-[#1a1a1f] hover:border-[#f5a623]/50 transition-all shadow-sm flex flex-col h-full relative overflow-hidden"
                    >
                      <div className="absolute top-0 left-0 w-1 h-full bg-[#f5a623]/50"></div>
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex items-center gap-3 relative z-10 pl-2">
                          <div className="p-2 rounded-lg bg-[#f5a623]/10 text-[#f5a623] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
                            <WrenchIcon className="size-4 sm:size-5" />
                          </div>
                          <div className="font-bold text-[#e8e8ea] text-sm sm:text-base">
                            {tool.name}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteCustom(tool.id)}
                          className="p-1.5 rounded-lg border border-transparent hover:border-red-500/30 hover:bg-red-500/10 text-[#6b6b7a] hover:text-red-400 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 relative z-20 bg-[#0a0a0b]"
                          title="Delete custom tool"
                        >
                          <Trash2Icon className="size-4" />
                        </button>
                      </div>
                      <p className="text-xs sm:text-sm text-[#8b8b9a] mt-1 leading-relaxed pl-[52px]">
                        {tool.description}
                      </p>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </div>

        {/* Info */}
        <div className="mt-8 pt-8 border-t border-[#1e1e22] text-sm text-[#6b6b7a]">
          <p>
            <span className="font-semibold">Total Tools:</span> {allTools.length}{" "}
            (Built-in: {BUILTIN_TOOLS.length}, Custom: {customTools.length})
          </p>
          <p className="mt-2 text-xs">
            Custom tools are registered in the agent system and can be used in
            conversations. They persist until you delete them.
          </p>
        </div>
      </div>
    </div>
  );
}
