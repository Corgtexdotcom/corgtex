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

  const fetchUrl = process.env.NODE_ENV === "production" ? "https://app.corgtex.com/api/demo-leads" : `${appUrl}/api/demo-leads`;

  try {
    const res = await fetch(fetchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(request.headers.get("x-forwarded-for") ? { "x-forwarded-for": request.headers.get("x-forwarded-for")! } : {}),
        ...(request.headers.get("x-real-ip") ? { "x-real-ip": request.headers.get("x-real-ip")! } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const respText = await res.text().catch(() => "");
      console.error(`Upstream error ${res.status}:`, respText);
      return NextResponse.json({ error: `Upstream error ${res.status}: ${respText.substring(0, 50)}` }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to forward demo lead:", error);
    return NextResponse.json({ error: `Fetch Exception: ${msg}` }, { status: 500 });
  }
}
