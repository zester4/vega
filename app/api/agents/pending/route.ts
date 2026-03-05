import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

/**
 * Proxy GET /agents/pending/:sessionId to the Cloudflare Worker.
 * Allows the frontend to poll for sub-agent completion messages.
 */
export async function GET() {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user?.id) {
      return NextResponse.json({ messages: [] }, { status: 401 });
    }

    const sessionId = `user-${session.user.id}`;
    const rawWorker = (process.env.WORKER_URL ?? "http://127.0.0.1:8787").trim();
    const workerUrl = rawWorker.replace(/\/+$/, "");

    const res = await fetch(`${workerUrl}/agents/pending/${sessionId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[pending-proxy] Worker returned ${res.status}: ${errText}`);
      return NextResponse.json({ messages: [] }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[pending-proxy error]", err);
    return NextResponse.json(
      { messages: [], error: "Failed to reach the agent worker." },
      { status: 502 }
    );
  }
}
