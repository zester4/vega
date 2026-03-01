/**
 * app/api/memory/route.ts
 *
 * Proxies memory management requests to the Cloudflare Worker.
 */

import { NextRequest, NextResponse } from "next/server";

const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

export async function GET(req: NextRequest) {
    try {
        const url = new URL(req.url);
        const prefix = url.searchParams.get("prefix") ?? "";
        const res = await fetch(`${WORKER_URL}/memory?prefix=${encodeURIComponent(prefix)}`);
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json({ error: `Proxy error: ${String(err)}` }, { status: 502 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const url = new URL(req.url);
        const key = url.searchParams.get("key");

        const endpoint = key
            ? `${WORKER_URL}/memory/${encodeURIComponent(key)}`
            : `${WORKER_URL}/memory`;

        const res = await fetch(endpoint, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
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
