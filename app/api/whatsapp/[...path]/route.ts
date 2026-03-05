/**
 * app/api/whatsapp/[...path]/route.ts
 *
 * Proxies /api/whatsapp/* → Cloudflare Worker.
 * Requires auth session. Sends X-User-Id + internal secret for per-user scoping.
 *
 * Proxied endpoints:
 *   GET    /api/whatsapp/status      → Worker GET /whatsapp/status
 *   POST   /api/whatsapp/setup       → Worker POST /whatsapp/setup
 *   DELETE /api/whatsapp/disconnect  → Worker DELETE /whatsapp/disconnect
 *   GET    /api/whatsapp/activity    → Worker GET /whatsapp/activity
 *
 * NOT proxied (hits Worker directly):
 *   GET  /whatsapp/webhook  — Meta verification challenge
 *   POST /whatsapp/webhook  — Incoming messages from Meta
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
const INTERNAL_SECRET = process.env.TELEGRAM_INTERNAL_SECRET; // Same secret, reused

async function proxy(
    req: NextRequest,
    segments: string[],
    userId: string
): Promise<NextResponse> {
    const path = segments.join("/");
    const url = `${WORKER_URL.trim().replace(/\/$/, "")}/whatsapp/${path}`;

    let body: string | undefined;
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
        body = await req.text();
        // Inject userId into POST /setup body
        if (req.method === "POST" && path === "setup" && body) {
            try {
                const parsed = JSON.parse(body) as Record<string, unknown>;
                parsed.userId = userId;
                body = JSON.stringify(parsed);
            } catch { /* keep original */ }
        }
    }

    const workerHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "X-User-Id": userId,
    };
    if (INTERNAL_SECRET) {
        workerHeaders["Authorization"] = `Bearer ${INTERNAL_SECRET}`;
    }

    try {
        const res = await fetch(url, {
            method: req.method,
            headers: workerHeaders,
            body,
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json(
            { error: `Proxy error (target: ${url}): ${String(err)}` },
            { status: 502 }
        );
    }
}

async function authenticate(req: NextRequest): Promise<string | null> {
    const session = await auth.api.getSession({ headers: await headers() });
    return session?.user?.id ?? null;
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
    const userId = await authenticate(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { path } = await params;
    return proxy(req, path, userId);
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
    const userId = await authenticate(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { path } = await params;
    return proxy(req, path, userId);
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
    const userId = await authenticate(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { path } = await params;
    return proxy(req, path, userId);
}