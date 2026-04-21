import { NextRequest, NextResponse } from "next/server";
import { getSiteConfig } from "../../../lib/site";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { appUrl } = getSiteConfig();

  try {
    const res = await fetch(`${appUrl}/api/demo-leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(request.headers.get("x-forwarded-for") ? { "x-forwarded-for": request.headers.get("x-forwarded-for")! } : {}),
        ...(request.headers.get("x-real-ip") ? { "x-real-ip": request.headers.get("x-real-ip")! } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`Upstream error ${res.status}:`, await res.text().catch(() => ""));
      return NextResponse.json({ error: "Failed to forward lead" }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error("Failed to forward demo lead:", error);
    return NextResponse.json({ error: "Failed to forward lead" }, { status: 500 });
  }
}
