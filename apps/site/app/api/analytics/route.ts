import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function stringField(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxLength);
}

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid analytics payload" }, { status: 400 });
  }

  const payload = typeof body === "object" && body ? (body as Record<string, unknown>) : {};
  const name = stringField(payload.name, 80);

  if (!name) {
    return NextResponse.json({ error: "Missing analytics event name" }, { status: 400 });
  }

  const event = {
    href: stringField(payload.href, 300),
    name,
    path: stringField(payload.path, 300),
    referer: stringField(request.headers.get("referer"), 300),
    timestamp: new Date().toISOString(),
    userAgent: stringField(request.headers.get("user-agent"), 160),
  };

  console.info("[site-analytics]", JSON.stringify(event));

  return NextResponse.json({ ok: true }, { status: 202 });
}
