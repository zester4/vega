import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy GET /api/schedules to the Cloudflare Worker.
 */
export async function GET(_req: NextRequest) {
  const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

  try {
    const res = await fetch(`${workerUrl}/schedules`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[/api/schedules proxy error]", err);
    return NextResponse.json(
      { error: "Failed to reach the agent worker." },
      { status: 502 }
    );
  }
}

