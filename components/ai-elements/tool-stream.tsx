"use client";

import type { ComponentProps } from "react";
import { useState } from "react";
import { CheckCircleIcon, ClockIcon, XCircleIcon, ChevronDownIcon } from "lucide-react";
import { CodeBlock } from "./code-block";

interface ToolCall {
  name: string;
  status: "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
}

interface ToolStreamProps extends ComponentProps<"div"> {
  tools?: ToolCall[];
}

const statusIcons = {
  running: <ClockIcon className="size-3 animate-pulse text-yellow-600" />,
  completed: <CheckCircleIcon className="size-3 text-green-600" />,
  error: <XCircleIcon className="size-3 text-red-600" />,
};

const statusLabels = {
  running: "Running",
  completed: "Completed",
  error: "Error",
};

export function ToolStream({ tools, ...props }: ToolStreamProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({
    0: true, // First tool expanded by default
  });

  if (!tools || tools.length === 0) {
    return null;
  }

  const toggleExpand = (index: number) => {
    setExpanded((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  return (
    <div className="not-prose mb-1" {...props}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b7a] px-1 pb-1">
        Tools ({tools.length})
      </h4>
      <div className="space-y-1">
        {tools.map((tool, i) => (
          <div
            key={`${tool.name}-${i}`}
            className="rounded-sm border border-[#1e1e22] bg-[#111113] overflow-hidden"
          >
            {/* Header - Clickable */}
            <button
              onClick={() => toggleExpand(i)}
              className="w-full px-2 py-1.5 bg-[#111113] hover:bg-[#1a1a1d] border-b border-[#1e1e22] flex items-center justify-between gap-2 transition-colors"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {statusIcons[tool.status]}
                <span className="font-medium text-xs text-[#e8e8ea] truncate">
                  {tool.name}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-[#1e1e22] text-[#6b6b7a]">
                  {statusLabels[tool.status]}
                </span>
                <ChevronDownIcon
                  className={`size-3 text-[#6b6b7a] transition-transform ${
                    expanded[i] ? "rotate-180" : ""
                  }`}
                />
              </div>
            </button>

            {/* Content - Collapsible */}
            {expanded[i] && (
              <>
                {/* Input Parameters */}
                {tool.input && (
                  <div className="px-2 py-1.5 border-b border-[#1e1e22] bg-[#0a0a0b]">
                    <h5 className="text-xs font-semibold text-[#6b6b7a] uppercase tracking-wide mb-1">
                      Params
                    </h5>
                    <div className="text-xs max-h-24 overflow-auto">
                      <CodeBlock
                        code={JSON.stringify(tool.input, null, 2)}
                        language="json"
                      />
                    </div>
                  </div>
                )}

                {/* Output/Error */}
                {(tool.output || tool.errorText) && (
                  <div className="px-2 py-1.5 bg-[#0a0a0b]">
                    <h5
                      className={`text-xs font-semibold uppercase tracking-wide mb-1 ${
                        tool.errorText ? "text-red-400" : "text-[#6b6b7a]"
                      }`}
                    >
                      {tool.errorText ? "Err" : "Out"}
                    </h5>
                    {tool.errorText ? (
                      <div className="rounded-sm bg-destructive/10 text-destructive p-2 text-xs">
                        {tool.errorText}
                      </div>
                    ) : (
                      <div className="text-xs max-h-24 overflow-auto">
                        {typeof tool.output === "string" ? (
                          <CodeBlock code={tool.output} language="json" />
                        ) : (
                          <CodeBlock
                            code={JSON.stringify(tool.output, null, 2)}
                            language="json"
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

