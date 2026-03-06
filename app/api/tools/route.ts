import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

export async function GET() {
    try {
        // Resolve session server-side
        const session = await auth.api.getSession({
            headers: await headers()
        });

        const userId = session?.user?.id;
        const url = new URL(`${WORKER_URL}/tools/v1/registry`);
        if (userId) {
            url.searchParams.set("userId", userId);
        }

        const res = await fetch(url.toString(), {
            headers: { "Content-Type": "application/json" },
            // Cache for 60 seconds to reduce worker load, but include session in key
            next: { revalidate: 60, tags: userId ? [`tools-${userId}`] : ["tools-guest"] }
        });

        if (!res.ok) {
            const error = await res.text();
            return NextResponse.json({ error: `Worker Registry Error: ${error}` }, { status: res.status });
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (err: any) {
        console.error("[Bridge Network Error]", err);
        return NextResponse.json({ error: `Bridge Network Error: ${err.message}` }, { status: 502 });
    }
}
