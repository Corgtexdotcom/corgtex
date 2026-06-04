import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getLatestSelfServeEmailCapture } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

function bearerSecret(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const capture = await getLatestSelfServeEmailCapture({
      secret: bearerSecret(request),
      toEmail: url.searchParams.get("to") ?? "",
      runId: url.searchParams.get("runId"),
      consume: url.searchParams.get("consume") === "true",
    });
    return NextResponse.json({ capture });
  } catch (error) {
    return handleRouteError(error);
  }
}
