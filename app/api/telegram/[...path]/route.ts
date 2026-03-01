/**
 * app/api/telegram/[...path]/route.ts
 *
 * Catches all /api/telegram/* requests from the Next.js frontend and
 * proxies them to the Cloudflare Worker.
 *
 * Proxied routes:
 *   GET    /api/telegram/status       → GET  {worker}/telegram/status
 *   POST   /api/telegram/setup        → POST {worker}/telegram/setup
 *   DELETE /api/telegram/disconnect   → DELETE {worker}/telegram/disconnect
 *   GET    /api/telegram/activity     → GET  {worker}/telegram/activity
 *
 * The webhook itself (/api/telegram/webhook) is NOT proxied through Next.js.
 * Telegram sends webhooks DIRECTLY to the Cloudflare Worker URL.
 * This is intentional — Workers respond faster and don't add Next.js latency.
 */

import { NextRequest, NextResponse } from "next/server";

const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

async function proxy(req: NextRequest, segments: string[]): Promise<NextResponse> {
    const path = segments.join("/");
    const url = `${WORKER_URL}/telegram/${path}`;

    try {
        const body = ["POST", "PUT", "PATCH"].includes(req.method)
            ? await req.text()
            : undefined;

        const res = await fetch(url, {
            method: req.method,
            headers: { "Content-Type": "application/json" },
            body,
        });

        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json(
            { error: `Proxy error: ${String(err)}` },
            { status: 502 }
        );
    }
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
    const { path } = await params;
    return proxy(req, path);
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
    const { path } = await params;
    return proxy(req, path);
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
    const { path } = await params;
    return proxy(req, path);
}
