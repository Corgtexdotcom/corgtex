import { NextResponse } from "next/server";
import { z } from "zod";
import {
  EXTERNAL_CONTENT_SOURCE_KINDS,
  listExternalContentSources,
  selectExternalContentSource,
} from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const sourceSchema = z.object({
  providerKey: z.literal("box"),
  sourceKind: z.enum(EXTERNAL_CONTENT_SOURCE_KINDS),
  externalId: z.string().min(1),
  title: z.string().optional().nullable(),
  externalUrl: z.string().optional().nullable(),
  connectionId: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const providerKey = request.nextUrl.searchParams.get("providerKey");
  const items = await listExternalContentSources(actor, {
    workspaceId,
    providerKey,
  });
  return NextResponse.json({ items });
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const parsed = await validateBody(request, sourceSchema);
  const item = await selectExternalContentSource(actor, {
    workspaceId,
    providerKey: parsed.providerKey,
    sourceKind: parsed.sourceKind,
    externalId: parsed.externalId,
    title: parsed.title,
    externalUrl: parsed.externalUrl,
    connectionId: parsed.connectionId,
    metadata: parsed.metadata,
  });
  return NextResponse.json({ item }, { status: 201 });
});
