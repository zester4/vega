// app/api/agents/pending/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

/**
 * GET /api/agents/pending
 *
 * Proxies to the Worker's GET /agents/pending/:sessionId endpoint.
 * The chat page polls this every 30s to pick up completed sub-agent results
 * and inject them as assistant messages.
 *
 * The Worker stores pending messages under:
 *   Redis key: agent:pending:user-{userId}
 *
 * Reading this endpoint CLEARS the pending queue — messages are delivered once.
 */
export async function GET(req: NextRequest) {
  const workerUrl = (process.env.WORKER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

  try {
    // Get the authenticated user so we can build the correct sessionId key
    const session = await auth.api.getSession({ headers: await headers() });

    if (!session?.user?.id) {
      // Not authenticated — return empty, don't error (page polls on load before auth check)
      return NextResponse.json({ messages: [], count: 0 });
    }

    // sessionId format must match what the Worker injected: "user-{userId}"
    const sessionId = `user-${session.user.id}`;

    const res = await fetch(`${workerUrl}/agents/pending/${sessionId}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      console.error(`[/api/agents/pending] Worker returned ${res.status}`);
      return NextResponse.json({ messages: [], count: 0 });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[/api/agents/pending] Error:", err);
    // Return empty rather than erroring — poll should be silent on failure
    return NextResponse.json({ messages: [], count: 0 });
  }
}