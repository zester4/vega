//app/api/agents/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

/**
 * Proxy GET /api/agents to the Cloudflare Worker.
 * Multi-tenant aware: filters by user's sessionId.
 */
export async function GET(req: NextRequest) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sessionId = `user-${session.user.id}`;
    const workerUrl = (process.env.WORKER_URL ?? "http://127.0.0.1:8787").trim().replace(/\/$/, "");
    const status = new URL(req.url).searchParams.get("status") ?? "all";

    try {
        const res = await fetch(`${workerUrl}/agents?status=${status}&sessionId=${sessionId}`, {
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
