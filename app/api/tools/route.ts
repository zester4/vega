import { NextRequest, NextResponse } from "next/server";

const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8787";

export async function GET() {
    try {
        const res = await fetch(`${WORKER_URL}/tools/v1/registry`, {
            headers: { "Content-Type": "application/json" },
            // Cache for 60 seconds to reduce worker load
            next: { revalidate: 60 }
        });

        if (!res.ok) {
            const error = await res.text();
            return NextResponse.json({ error: `Worker Registry Error: ${error}` }, { status: res.status });
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (err: any) {
        return NextResponse.json({ error: `Bridge Network Error: ${err.message}` }, { status: 502 });
    }
}
