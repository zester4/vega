/**
 * app/api/telegram/[...path]/route.ts
 *
 * Proxies /api/telegram/* to the Cloudflare Worker. Requires auth session and
 * sends X-User-Id + internal secret so the Worker can scope Telegram config by user (D1).
 *
 * Proxied: GET status, POST setup, DELETE disconnect, GET activity.
 * Webhook is NOT proxied — Telegram hits the Worker URL directly.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
const INTERNAL_SECRET = process.env.TELEGRAM_INTERNAL_SECRET;

async function proxy(
  req: NextRequest,
  segments: string[],
  userId: string
): Promise<NextResponse> {
  const path = segments.join("/");
  const url = `${WORKER_URL.trim().replace(/\/$/, "")}/telegram/${path}`;

  let body: string | undefined;
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    body = await req.text();
    if (req.method === "POST" && path === "setup" && body) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        parsed.userId = userId;
        body = JSON.stringify(parsed);
      } catch {
        /* keep original body */
      }
    }
  }

  const workerHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-User-Id": userId,
  };
  if (INTERNAL_SECRET) {
    workerHeaders["Authorization"] = `Bearer ${INTERNAL_SECRET}`;
  } else if (process.env.TELEGRAM_INTERNAL_SECRET) {
    workerHeaders["Authorization"] = `Bearer ${process.env.TELEGRAM_INTERNAL_SECRET}`;
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxy(req, path, session.user.id);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxy(req, path, session.user.id);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxy(req, path, session.user.id);
}
