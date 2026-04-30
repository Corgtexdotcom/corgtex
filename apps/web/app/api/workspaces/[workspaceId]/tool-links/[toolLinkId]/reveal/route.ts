import { NextResponse } from "next/server";
import { revealWorkspaceToolLinkCredential } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

export const POST = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const credential = await revealWorkspaceToolLinkCredential(actor, {
    workspaceId,
    toolLinkId: params.toolLinkId,
  });
  return NextResponse.json(credential);
});
