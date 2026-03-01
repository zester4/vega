import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy GET /api/agents to the Cloudflare Worker.
 */
export async function GET(req: NextRequest) {
    const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
    const status = new URL(req.url).searchParams.get("status") ?? "all";

    try {
        const res = await fetch(`${workerUrl}/agents?status=${status}`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });

        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        console.error("[/api/agents proxy error]", err);
        return NextResponse.json(
            { error: "Failed to reach the agent worker." },
            { status: 502 }
        );
    }
}
