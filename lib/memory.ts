/**
 * Memory utilities for persisting agent learnings
 */

export interface Memory {
  id: string;
  key: string;
  value: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

export function saveMemory(key: string, value: string, metadata?: Record<string, string>): Memory {
  const memory: Memory = {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    key,
    value,
    metadata,
    createdAt: new Date().toISOString(),
  };

  try {
    const existing = localStorage.getItem("vega-memories") || "[]";
    const memories: Memory[] = JSON.parse(existing);
    memories.push(memory);
    localStorage.setItem("vega-memories", JSON.stringify(memories));
  } catch (err) {
    console.error("Failed to save memory:", err);
  }

  return memory;
}

export function getAllMemories(): Memory[] {
  try {
    const stored = localStorage.getItem("vega-memories");
    return stored ? JSON.parse(stored) : [];
  } catch (err) {
    console.error("Failed to load memories:", err);
    return [];
  }
}

export function getMemory(key: string): Memory | undefined {
  const memories = getAllMemories();
  return memories.find((m) => m.key === key);
}

export function deleteMemory(id: string): boolean {
  try {
    const existing = localStorage.getItem("vega-memories") || "[]";
    const memories: Memory[] = JSON.parse(existing);
    const filtered = memories.filter((m) => m.id !== id);
    localStorage.setItem("vega-memories", JSON.stringify(filtered));
    return true;
  } catch (err) {
    console.error("Failed to delete memory:", err);
    return false;
  }
}

export function extractMemoriesFromToolCall(toolName: string, toolInput?: Record<string, unknown>, toolOutput?: unknown): Memory | null {
  if (toolName !== "store_memory") return null;

  const key = toolInput?.key as string;
  const value = toolInput?.value as string;

  if (!key || !value) return null;

  return saveMemory(key, value, {
    source: "agent",
    toolExecution: new Date().toISOString(),
  });
}
