import { NextResponse } from "next/server";
import { z } from "zod";
import { decideCatalogRequest } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

const decisionSchema = z.object({
  decisionNoteMd: z.string().optional().nullable(),
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const body = await validateBody(request, decisionSchema);
  const result = await decideCatalogRequest(actor, {
    workspaceId,
    requestId: params.requestId,
    status: "REJECTED",
    decisionNoteMd: body.decisionNoteMd,
  });
  return NextResponse.json(result);
});
