//app/api/chat/route.ts
import { NextRequest } from "next/server";

/**
 * Proxy route: keeps the CF Worker URL (ngrok or deployed) server-side only.
 * Set WORKER_URL in .env.local:
 *   WORKER_URL=https://YOUR-NGROK-ID.ngrok-free.app   (local dev)
 *   WORKER_URL=https://autonomous-ai-agent.YOUR.workers.dev  (production)
 * 
 * Supports both regular JSON responses and streaming SSE responses.
 */
export async function POST(req: NextRequest) {
  const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

  try {
    const body = await req.json();
    const stream = req.headers.get("x-stream") === "true";

    const res = await fetch(`${workerUrl}/chat`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        ...(stream && { "x-stream": "true" }),
      },
      body: JSON.stringify(body),
    });

    // If streaming is requested and the response is streaming, pass through
    if (stream && res.headers.get("content-type")?.includes("event-stream")) {
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Otherwise, return regular JSON response
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (err) {
    console.error("[/api/chat proxy error]", err);
    return Response.json(
      { error: "Failed to reach the agent worker. Is the Worker running?" },
      { status: 502 }
    );
  }
}

