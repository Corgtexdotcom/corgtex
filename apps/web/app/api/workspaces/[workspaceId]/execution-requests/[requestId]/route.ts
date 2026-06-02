import { NextResponse } from "next/server";
import { getExecutionPacket, getExecutionRequest } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const includePacket = request.nextUrl.searchParams.get("packet") === "true";
  const executionRequest = await getExecutionRequest(actor, {
    workspaceId,
    requestId: params.requestId,
  });
  if (!includePacket) {
    return NextResponse.json({ executionRequest });
  }

  const packet = await getExecutionPacket(actor, {
    workspaceId,
    requestId: params.requestId,
  });
  return NextResponse.json({ executionRequest, packet });
});
