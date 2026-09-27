import { NextResponse } from "next/server";
import { z } from "zod";
import { invariant, previewActionDuplicateResolution, resolveActionDuplicate } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

const resolveSchema = z.object({
  canonicalId: z.string().uuid(),
  duplicateId: z.string().uuid(),
  expectedCanonicalVersion: z.number().int().positive(),
  expectedDuplicateVersion: z.number().int().positive(),
  confirmDuplicateId: z.string().uuid(),
}).strict();

export const GET = withWorkspaceRoute(async (req, { actor, workspaceId }) => {
  const canonicalId = req.nextUrl.searchParams.get("canonicalId");
  const duplicateId = req.nextUrl.searchParams.get("duplicateId");
  invariant(canonicalId && duplicateId, 400, "INVALID_INPUT", "Choose a canonical Action and a duplicate Action.");
  const preview = await previewActionDuplicateResolution(actor, { workspaceId, canonicalId, duplicateId });
  return NextResponse.json(preview);
});

export const POST = withWorkspaceRoute(async (req, { actor, workspaceId }) => {
  const body = await validateBody(req, resolveSchema);
  const result = await resolveActionDuplicate(actor, { workspaceId, ...body });
  return NextResponse.json(result);
});
