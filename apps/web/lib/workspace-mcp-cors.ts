import { NextRequest, NextResponse } from "next/server";

const headers = "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID";
function configuredOrigin() {
  const value = process.env.NEXT_PUBLIC_SITE_URL || "https://corgtex.com";
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (value !== url.origin && value !== `${url.origin}/`)) throw new Error("Invalid site origin");
  return url.origin;
}

export async function withWorkspaceMcpCors(request: NextRequest, run: () => Promise<Response>, methods = "GET, POST, DELETE, OPTIONS") {
  let origin: string;
  try { origin = configuredOrigin(); }
  catch { return NextResponse.json({ error: "MCP CORS configuration unavailable" }, { status: 503 }); }
  if (request.headers.get("origin") && request.headers.get("origin") !== origin) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403, headers: { Vary: "Origin" } });
  }
  const response = await run();
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Methods", methods);
  response.headers.set("Access-Control-Allow-Headers", headers);
  response.headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, Allow");
  response.headers.append("Vary", "Origin");
  return response;
}

export function workspaceMcpPreflight(request: NextRequest, methods?: string) {
  return withWorkspaceMcpCors(request, async () => new NextResponse(null, { status: 204 }), methods);
}
