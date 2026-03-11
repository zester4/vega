import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
  const userId = req.headers.get("X-User-Id");

  try {
    const res = await fetch(`${workerUrl}/audit/stats`, {
      method: "GET",
      headers: { 
        "Content-Type": "application/json",
        ...(userId ? { "X-User-Id": userId } : {})
      },
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[/api/audit/stats GET proxy error]", err);
    return NextResponse.json({ error: "Failed to reach agent worker" }, { status: 502 });
  }
}
