import { NextResponse } from "next/server";
import { z } from "zod";
import {
  listWorkspaceExternalResources,
  upsertWorkspaceExternalResourceFromUrl,
  WORKSPACE_EXTERNAL_RESOURCE_ENTITY_TYPES,
  WORKSPACE_EXTERNAL_RESOURCE_PURPOSES,
} from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const resourceSchema = z.object({
  url: z.string().min(1),
  descriptionMd: z.string().optional().nullable(),
  summaryMd: z.string().optional().nullable(),
  entityType: z.enum(WORKSPACE_EXTERNAL_RESOURCE_ENTITY_TYPES).optional().nullable(),
  entityId: z.string().optional().nullable(),
  purpose: z.enum(WORKSPACE_EXTERNAL_RESOURCE_PURPOSES).optional().nullable(),
});

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const providerKey = request.nextUrl.searchParams.get("providerKey");
  const query = request.nextUrl.searchParams.get("q");
  const items = await listWorkspaceExternalResources(actor, {
    workspaceId,
    providerKey,
    query,
  });
  return NextResponse.json({ items });
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const parsed = await validateBody(request, resourceSchema);
  const item = await upsertWorkspaceExternalResourceFromUrl(actor, {
    workspaceId,
    url: parsed.url,
    descriptionMd: parsed.descriptionMd,
    summaryMd: parsed.summaryMd,
    entityType: parsed.entityType,
    entityId: parsed.entityId,
    purpose: parsed.purpose,
  });
  return NextResponse.json({ item }, { status: 201 });
});
