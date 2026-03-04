// app/api/agents/[id]/invoke/route.ts
import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/agents/:id/invoke
 * Proxies the invoke_agent request to the Cloudflare Worker.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id: agentId } = await params;
    const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

    try {
        const body = await req.json() as { instructions: string };

        const res = await fetch(`${workerUrl}/agents/${agentId}/invoke`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, ...body }),
        });

        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        console.error("[/api/agents/[id]/invoke proxy error]", err);
        return NextResponse.json(
            { error: "Failed to reach the agent worker." },
            { status: 502 }
        );
    }
}
