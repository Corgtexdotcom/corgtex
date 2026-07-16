import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, getAction, getProposal, getTension, postDeliberationEntry } from "@corgtex/domain";
import type { AppActor } from "@corgtex/shared";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const deliberationParentTypeSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toUpperCase() : value,
  z.enum(["PROPOSAL", "TENSION", "ACTION"]),
);

type DeliberationParentType = z.infer<typeof deliberationParentTypeSchema>;

const createDeliberationEntrySchema = z.object({
  parentType: deliberationParentTypeSchema,
  parentId: z.string().trim().min(1),
  entryType: z.string().trim().min(1),
  bodyMd: z.string().trim().min(1),
  targetMemberId: z.string().trim().min(1).optional().nullable(),
  targetCircleId: z.string().trim().min(1).optional().nullable(),
  adviceRequestId: z.string().trim().min(1).optional().nullable(),
});

async function assertReadableDeliberationParent(
  actor: AppActor,
  workspaceId: string,
  parentType: DeliberationParentType,
  parentId: string,
) {
  if (parentType === "PROPOSAL") {
    await getProposal(actor, { workspaceId, proposalId: parentId });
    return;
  }

  if (parentType === "ACTION") {
    await getAction(actor, { workspaceId, actionId: parentId });
    return;
  }

  if (parentType === "TENSION") {
    const tension = await getTension(actor, { workspaceId, tensionId: parentId });
    if (tension.archivedAt) {
      throw new AppError(404, "NOT_FOUND", "Tension not found.");
    }
    return;
  }

  const unreachable: never = parentType;
  throw new AppError(400, "INVALID_INPUT", `Unsupported deliberation parent: ${unreachable}`);
}

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const parsed = await validateBody(request, createDeliberationEntrySchema);
  await checkApiDemoGuard(workspaceId);
  await assertReadableDeliberationParent(actor, workspaceId, parsed.parentType, parsed.parentId);

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
