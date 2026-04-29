import { NextResponse } from "next/server";
import { z } from "zod";
import { createWorkspaceToolLink, listWorkspaceToolLinks } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const toolLinkSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
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

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const archiveFilter = request.nextUrl.searchParams.get("archiveFilter") as ArchiveFilter | null;
  const links = await listWorkspaceToolLinks(actor, {
    workspaceId,
    archiveFilter: archiveFilter ?? undefined,
  });
  return NextResponse.json({ items: links });
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const parsed = await validateBody(request, toolLinkSchema);
  const link = await createWorkspaceToolLink(actor, {
    workspaceId,
    ...parsed,
  });
  return NextResponse.json(link, { status: 201 });
});
