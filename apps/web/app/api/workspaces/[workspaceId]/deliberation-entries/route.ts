import { NextResponse } from "next/server";
import { z } from "zod";
import { postDeliberationEntry } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const createDeliberationEntrySchema = z.object({
  parentType: z.string().trim().min(1),
  parentId: z.string().trim().min(1),
  entryType: z.string().trim().min(1),
  bodyMd: z.string().trim().min(1),
  targetMemberId: z.string().trim().min(1).optional().nullable(),
  targetCircleId: z.string().trim().min(1).optional().nullable(),
  adviceRequestId: z.string().trim().min(1).optional().nullable(),
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const parsed = await validateBody(request, createDeliberationEntrySchema);
  const entry = await postDeliberationEntry(actor, {
    workspaceId,
    parentType: parsed.parentType,
    parentId: parsed.parentId,
    entryType: parsed.entryType,
    bodyMd: parsed.bodyMd,
    targetMemberId: parsed.targetMemberId ?? undefined,
    targetCircleId: parsed.targetCircleId ?? undefined,
    adviceRequestId: parsed.adviceRequestId ?? undefined,
  });

  return NextResponse.json({ entry }, { status: 201 });
});
