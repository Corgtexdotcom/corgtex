import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function demoBackendOrigin() {
  const configured = process.env.DEMO_BACKEND_URL;
  const value = configured === undefined
    ? (process.env.NODE_ENV === "production" ? "https://app.corgtex.com" : "http://localhost:3000")
    : configured.trim();
  const url = new URL(value);
  const localHttp = process.env.NODE_ENV !== "production" && url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid demo backend origin");
  }
  return url.origin;
}

function unavailable(status = 502) {
  return NextResponse.json({ error: "Demo service is temporarily unavailable. Please try again." }, { status });
}

function publicError(data: Record<string, unknown>) {
  const error = data.error;
  const message = typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error ? error.message : null;
  if (typeof message !== "string" || !message.trim() || message.length > 500 || /[<>]/.test(message)) {
    return { error: "Unable to process this request. Please check your details and try again." };
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)
    ? { error: { code, message } } : { error: message };
}

// Both stages must use the backend that owns the lead and its qualification token.
export async function forwardDemoRequest(request: NextRequest, stage: "capture" | "qualify") {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  let origin: string;
  try {
    origin = demoBackendOrigin();
  } catch {
    return unavailable(503);
  }
  try {
    const response = await fetch(`${origin}/api/demo-leads${stage === "qualify" ? "/qualify" : ""}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(request.headers.get("x-forwarded-for") ? { "x-forwarded-for": request.headers.get("x-forwarded-for")! } : {}),
        ...(request.headers.get("x-real-ip") ? { "x-real-ip": request.headers.get("x-real-ip")! } : {}),
      },
      body: JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 500) return unavailable(response.status);
    if (response.status >= 300 && response.status < 400) return unavailable();
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return unavailable();
    return NextResponse.json(response.ok ? data : publicError(data as Record<string, unknown>), { status: response.status });
  } catch {
    return unavailable();
  }
}
