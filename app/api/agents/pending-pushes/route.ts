/**
 * app/api/agents/pending-pushes/route.ts
 * Proxies to Worker GET /agents/pending-pushes?session=xxx
 * Passes X-User-Id so the Worker can also check user-scoped pushes.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
const INTERNAL_SECRET = process.env.TELEGRAM_INTERNAL_SECRET;

export async function GET(req: NextRequest): Promise<NextResponse> {
    const session = await auth.api.getSession({ headers: await headers() });
    const userId = session?.user?.id;

    const sessionId = req.nextUrl.searchParams.get("session") ?? "";

    try {
        const url = `${WORKER_URL.trim().replace(/\/$/, "")}/agents/pending-pushes?session=${encodeURIComponent(sessionId)}`;
        const res = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
                ...(userId ? { "X-User-Id": userId } : {}),
                ...(INTERNAL_SECRET ? { Authorization: `Bearer ${INTERNAL_SECRET}` } : {}),
            },
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json({ pushes: [], error: String(err) }, { status: 502 });
    }
}
