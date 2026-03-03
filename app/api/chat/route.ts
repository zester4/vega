// app/api/chat/route.ts
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

/**
 * Proxy to Worker /chat. Keeps WORKER_URL server-side only.
 * When the user is logged in, sessionId is set to user-{id} so chat history
 * is persistent per user across devices and sessions.
 */
function getWorkerBaseUrl(): string {
  const raw = (process.env.WORKER_URL ?? "http://127.0.0.1:8787").trim();
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? raw;
  const base = firstLine.replace(/\/+$/, "");
  try {
    return new URL(base).origin;
  } catch {
    return base || "http://127.0.0.1:8787";
  }
}

export async function POST(req: NextRequest) {
  const workerBase = getWorkerBaseUrl();

  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const stream = req.headers.get("x-stream") === "true";
    body.sessionId = `user-${session.user.id}`;

    const res = await fetch(`${workerBase}/chat`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        ...(stream && { "x-stream": "true" }),
      },
      body: JSON.stringify(body as Record<string, unknown>),
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

