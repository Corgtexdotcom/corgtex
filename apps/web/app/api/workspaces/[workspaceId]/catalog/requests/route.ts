import { NextResponse } from "next/server";
import { z } from "zod";
import { createCatalogRequest, listCatalogRequests } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

const catalogRequestSchema = z.object({
  catalogItemId: z.string().optional().nullable(),
  type: z.enum(["ACCESS", "API_KEY", "BUDGET_INCREASE", "PUBLISH"]),
  reasonMd: z.string().min(1),
  requestedScopes: z.array(z.string()).optional(),
  requestedBudgetCents: z.number().int().nonnegative().optional().nullable(),
  requestedDailyCallLimit: z.number().int().nonnegative().optional().nullable(),
  title: z.string().optional().nullable(),
  payloadJson: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const status = request.nextUrl.searchParams.get("status");
  const requests = await listCatalogRequests(actor, {
    workspaceId,
    status: status === "PENDING" || status === "APPROVED" || status === "REJECTED" || status === "CANCELLED"
      ? status
      : undefined,
  });
  return NextResponse.json({ requests });
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const body = await validateBody(request, catalogRequestSchema);
  const catalogRequest = await createCatalogRequest(actor, {
    workspaceId,
    ...body,
  });
  const requests = await listCatalogRequests(actor, {
    workspaceId,
  });
  return NextResponse.json(
    requests.find((request) => request.id === catalogRequest.id) ?? catalogRequest,
    { status: 201 },
  );
});
