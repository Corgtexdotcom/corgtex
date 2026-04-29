import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveWorkspaceToolLink, getWorkspaceToolLink, updateWorkspaceToolLink } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

const updateToolLinkSchema = z.object({
  title: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  category: z.string().min(1).optional().nullable(),
  descriptionMd: z.string().optional().nullable(),
  accessNotesMd: z.string().optional().nullable(),
  previewTitle: z.string().optional().nullable(),
  previewDescription: z.string().optional().nullable(),
  previewImageUrl: z.string().optional().nullable(),
  previewFaviconUrl: z.string().optional().nullable(),
  credentialLabel: z.string().optional().nullable(),
  credentialSecret: z.string().optional().nullable(),
  circleIds: z.array(z.string()).optional(),
});

export const GET = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const link = await getWorkspaceToolLink(actor, {
    workspaceId,
    toolLinkId: params.toolLinkId,
  });
  return NextResponse.json(link);
});

export const PATCH = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const parsed = await validateBody(request, updateToolLinkSchema);
  const link = await updateWorkspaceToolLink(actor, {
    workspaceId,
    toolLinkId: params.toolLinkId,
    ...parsed,
  });
  return NextResponse.json(link);
});

export const DELETE = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  await archiveWorkspaceToolLink(actor, {
    workspaceId,
    toolLinkId: params.toolLinkId,
    reason: request.nextUrl.searchParams.get("reason"),
  });
  return new NextResponse(null, { status: 204 });
});
