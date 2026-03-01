"use client";

import { useState } from "react";
import { PlusIcon, Trash2Icon, WrenchIcon } from "lucide-react";

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
      <div className="max-w-4xl mx-auto p-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#e8e8ea] mb-2">
              Tools & Capabilities
            </h1>
            <p className="text-sm text-[#6b6b7a]">
              Manage available tools and create custom tool extensions
            </p>
          </div>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-[#00e5cc] text-[#0a0a0b] font-semibold hover:bg-[#00d9b8] transition-colors"
            >
              <PlusIcon className="size-4" />
              New Tool
            </button>
          )}
        </div>

        {/* Create Tool Form */}
        {showForm && (
          <div className="mb-8 border border-[#1e1e22] rounded-lg p-6 bg-[#111113]">
            <h2 className="font-semibold text-[#e8e8ea] mb-4">Create Custom Tool</h2>
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
                  className="w-full px-4 py-2 rounded-md border border-[#1e1e22] bg-[#0a0a0b] text-[#e8e8ea] placeholder-[#6b6b7a] focus:border-[#00e5cc] focus:outline-none"
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
                  className="w-full px-4 py-2 rounded-md border border-[#1e1e22] bg-[#0a0a0b] text-[#e8e8ea] placeholder-[#6b6b7a] focus:border-[#00e5cc] focus:outline-none"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAddTool}
                  disabled={!formData.name || !formData.description}
                  className="flex-1 px-4 py-2 rounded-md bg-[#00e5cc] text-[#0a0a0b] font-semibold hover:bg-[#00d9b8] transition-colors disabled:opacity-50"
                >
                  Create Tool
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="flex-1 px-4 py-2 rounded-md bg-[#1e1e22] text-[#e8e8ea] hover:bg-[#2a2a2f] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tools List */}
        <div className="space-y-4">
          {/* Built-in Tools */}
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[#6b6b7a] mb-3">
              Built-in Tools ({BUILTIN_TOOLS.length})
            </h2>
            <div className="space-y-2">
              {BUILTIN_TOOLS.map((tool) => (
                <div
                  key={tool.id}
                  className="border border-[#1e1e22] rounded-lg p-4 bg-[#111113] hover:bg-[#1a1a1f] transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-md bg-[#00e5cc]/10">
                      <WrenchIcon className="size-5 text-[#00e5cc]" />
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold text-[#e8e8ea]">
                        {tool.name}
                      </div>
                      <p className="text-sm text-[#6b6b7a] mt-1">
                        {tool.description}
                      </p>
                    </div>
                    <span className="px-2 py-1 rounded-full text-xs bg-[#00e5cc]/10 text-[#00e5cc] whitespace-nowrap">
                      Built-in
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Custom Tools */}
          {customTools.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#6b6b7a] mb-3">
                Custom Tools ({customTools.length})
              </h2>
              <div className="space-y-2">
                {customTools.map((tool) => (
                  <div
                    key={tool.id}
                    className="border border-[#1e1e22] rounded-lg p-4 bg-[#111113] hover:bg-[#1a1a1f] transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1">
                        <div className="p-2 rounded-md bg-[#f5a623]/10">
                          <WrenchIcon className="size-5 text-[#f5a623]" />
                        </div>
                        <div className="flex-1">
                          <div className="font-semibold text-[#e8e8ea]">
                            {tool.name}
                          </div>
                          <p className="text-sm text-[#6b6b7a] mt-1">
                            {tool.description}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteCustom(tool.id)}
                        className="p-2 rounded-md hover:bg-red-600/10 text-[#6b6b7a] hover:text-red-400 transition-colors"
                      >
                        <Trash2Icon className="size-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
