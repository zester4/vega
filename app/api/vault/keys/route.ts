import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
  const userId = req.headers.get("X-User-Id");

  try {
    const res = await fetch(`${workerUrl}/vault/keys`, {
      method: "GET",
      headers: { 
        "Content-Type": "application/json",
        ...(userId ? { "X-User-Id": userId } : {})
      },
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[/api/vault/keys GET proxy error]", err);
    return NextResponse.json({ error: "Failed to reach agent worker" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
  const userId = req.headers.get("X-User-Id");

  try {
    const body = await req.json();
    const res = await fetch(`${workerUrl}/vault/keys`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        ...(userId ? { "X-User-Id": userId } : {})
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[/api/vault/keys POST proxy error]", err);
    return NextResponse.json({ error: "Failed to reach agent worker" }, { status: 502 });
  }
}
