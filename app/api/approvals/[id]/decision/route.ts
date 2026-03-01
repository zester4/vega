import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy POST /api/approvals/:id/decision to the Cloudflare Worker.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

  try {
    const body = await req.json();

    const res = await fetch(`${workerUrl}/approvals/${id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[/api/approvals/:id/decision proxy error]", err);
    return NextResponse.json(
      { error: "Failed to reach the agent worker." },
      { status: 502 }
    );
  }
}

