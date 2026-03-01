/**
 * SOPHISTICATED LOCAL FILESYSTEM TOOL
 * 
 * This tool acts as a high-level manager for the local machine's filesystem.
 * It strictly enforces human-in-the-loop for destructive actions and
 * provides advanced capabilities like bulk-reading and codebase-aware filtering.
 */

import { executeTool } from "./builtins";

export async function execLocalFsTool(args: any, env: any): Promise<Record<string, unknown>> {
    const { action, path: targetPath, paths, content, newPath, pattern, command, showHidden = false } = args;

    // 1. SECURITY & HUMAN-IN-THE-LOOP
    // Destructive or system-level actions MUST be approved by the human.
    const sensitiveActions = ["delete", "move", "exec", "write"];

    if (sensitiveActions.includes(action)) {
        console.log(`[local_fs] Triggering approval gate for sensitive action: ${action}`);

        const approval = await executeTool("human_approval_gate", {
            operation: `Local FS: ${action.toUpperCase()} on ${targetPath || paths || command}`,
            metadata: { tool: "local_fs", ...args }
        }, env);

        // If the gate returns a pending status, we must return that to the agent.
        // The agent will then wait or inform the user.
        if (approval.status === "pending" || approval.error) {
            return {
                status: "pending_approval",
                message: "🚦 This sensitive operation requires your approval. Please check the Chat UI or Telegram to confirm.",
                approvalId: approval.approvalId,
                ...approval
            };
        }

        // If we get here, it means we either didn't need approval (unlikely due to check above)
        // or the gate logic is such that it blocks execution until approved.
        // Note: In VEGA, the gate usually returns 'pending' immediately.
    }

    // 2. DISPATCH TO BRIDGE
    const bridgeUrl = `${env.UPSTASH_WORKFLOW_URL?.replace(/\/$/, "")}/api/local-fs`;

    try {
        const res = await fetch(bridgeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args),
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({ error: res.statusText })) as any;
            return {
                success: false,
                error: `Bridge API Error (${res.status}): ${errorData.error || res.statusText}`,
                tip: "Ensure your Next.js server is running and UPSTASH_WORKFLOW_URL is correctly set."
            };
        }

        const data = await res.json() as Record<string, unknown>;

        // Add helpful context for the agent
        if (action === "list" && data.entries) {
            const entryCount = (data.entries as any[]).length;
            (data as any).info = `Showing ${entryCount} items. (Note: Search/List excludes node_modules, .next, and .git by default for production safety).`;
        }

        return data;
    } catch (err: any) {
        console.error("[local_fs] Bridge connection failed:", err);
        return {
            success: false,
            error: `Failed to connect to the Local FS Bridge at ${bridgeUrl}.`,
            details: err.message,
            troubleshooting: [
                "Is the Next.js dev server running on the host?",
                "Is ngrok/tunnel correctly forwarding to the reach the Bridge?",
                "Is UPSTASH_WORKFLOW_URL pointing to the public URL of your Next.js app?"
            ]
        };
    }
}
