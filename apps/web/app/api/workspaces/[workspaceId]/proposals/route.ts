import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createProposal, createProposalFromTension, getWorkspacePermanentPathForEntity, listProposals, requireWorkspaceMembership } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { loadProposalWorkItemResponse, serializeProposalWorkItem, workItemPriorityFromBody } from "@/lib/work-item-api";

const createProposalSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().optional().nullable(),
  bodyMd: z.string().optional(),
  sourceTensionId: z.string().trim().min(1).optional().nullable(),
  relatedActionIds: z.array(z.string().trim().min(1)).optional().nullable(),
  ownerMemberId: z.string().optional().nullable(),
  priority: z.union([z.number().int(), z.string()]).optional().nullable(),
  priorityLabel: z.string().optional().nullable(),
}).superRefine((body, ctx) => {
  if (!body.sourceTensionId && !body.title) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["title"], message: "Title is required." });
  }
  if (!body.sourceTensionId && !body.bodyMd) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bodyMd"], message: "Proposal body is required." });
  }
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const archiveFilter = request.nextUrl.searchParams.get("archiveFilter") as ArchiveFilter | null;
    const proposals = await listProposals(actor, workspaceId, { archiveFilter: archiveFilter ?? undefined });
    return NextResponse.json({
      proposals: {
        ...proposals,
        items: proposals.items.map(serializeProposalWorkItem),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, createProposalSchema);
    const proposal = body.sourceTensionId
      ? await createProposalFromTension(actor, {
          workspaceId,
          sourceTensionId: body.sourceTensionId,
          title: body.title ?? null,
          summary: body.summary ?? null,
          bodyMd: body.bodyMd ?? null,
          relatedActionIds: body.relatedActionIds ?? null,
          ownerMemberId: body.ownerMemberId ?? null,
          priority: workItemPriorityFromBody(body),
        })
      : await createProposal(actor, {
          workspaceId,
          title: body.title!,
          summary: body.summary ?? null,
          bodyMd: body.bodyMd!,
          relatedActionIds: body.relatedActionIds ?? null,
          ownerMemberId: body.ownerMemberId ?? null,
          priority: workItemPriorityFromBody(body),
        });
    const origin = env.APP_URL.replace(/\/$/, "");
    const permanentPath = await getWorkspacePermanentPathForEntity({ workspaceId, entityType: "Proposal", entityId: proposal.id });
    const proposalForResponse = await loadProposalWorkItemResponse(workspaceId, proposal.id) ?? proposal;
    return NextResponse.json({
      proposal: serializeProposalWorkItem(proposalForResponse),
      webUrl: `${origin}/workspaces/${workspaceId}/proposals/${proposal.id}`,
      permanentUrl: permanentPath ? `${origin}${permanentPath}` : null,
    }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
