import { NextResponse } from "next/server";
import { revealWorkspaceToolLinkCredential } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

export const POST = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const credential = await revealWorkspaceToolLinkCredential(actor, {
    workspaceId,
    toolLinkId: params.toolLinkId,
  });
  return NextResponse.json(credential);
});
