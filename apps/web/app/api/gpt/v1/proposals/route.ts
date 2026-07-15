import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { listProposals, createProposal, createProposalFromTension, getWorkspacePermanentPathForEntity } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";
import { loadProposalWorkItemResponse, serializeProposalWorkItem, workItemPriorityFromBody } from "@/lib/work-item-api";

function ownerMemberIdFromBody(body: Record<string, unknown>) {
  return Object.prototype.hasOwnProperty.call(body, "ownerMemberId")
    ? typeof body.ownerMemberId === "string" || body.ownerMemberId === null
      ? body.ownerMemberId
      : null
    : undefined;
}

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;

    const take = parseInt(request.nextUrl.searchParams.get("take") || "20", 10);
    const skip = parseInt(request.nextUrl.searchParams.get("skip") || "0", 10);

    const result = await listProposals(actor, workspaceId, { take, skip });

    const simplified = result.items.map((p) => {
      const item = serializeProposalWorkItem(p);
      return {
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        priorityLabel: item.priorityLabel,
        summary: p.summary,
        author: p.author?.displayName ?? p.author?.email ?? "Unknown",
        ownerMemberId: item.ownerMemberId,
        ownerMemberName: item.ownerMemberName,
        owner: item.owner,
        createdAt: p.createdAt,
      };
    });

    return NextResponse.json({ items: simplified, total: result.total });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "write");
    const { workspaceId, actor } = sessionCtx;
    const body = await request.json();

    if (!body.sourceTensionId && (!body.title || !body.bodyMd)) {
      return NextResponse.json({ error: "Missing required fields (title, bodyMd) unless sourceTensionId is provided" }, { status: 400 });
    }

    const ownerMemberId = ownerMemberIdFromBody(body);
    const proposal = body.sourceTensionId
      ? await createProposalFromTension(actor, {
          workspaceId,
          sourceTensionId: String(body.sourceTensionId),
          title: typeof body.title === "string" ? body.title : null,
          bodyMd: typeof body.bodyMd === "string" ? body.bodyMd : null,
          summary: typeof body.summary === "string" ? body.summary : null,
          relatedActionIds: Array.isArray(body.relatedActionIds) ? body.relatedActionIds.map(String) : null,
          ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
          priority: workItemPriorityFromBody(body),
        })
      : await createProposal(actor, {
          workspaceId,
          title: body.title,
          bodyMd: body.bodyMd,
          summary: body.summary,
          relatedActionIds: Array.isArray(body.relatedActionIds) ? body.relatedActionIds.map(String) : null,
          ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
          priority: workItemPriorityFromBody(body),
        });
    const proposalForResponse = await loadProposalWorkItemResponse(workspaceId, proposal.id) ?? proposal;
    const item = serializeProposalWorkItem(proposalForResponse);

    const origin = env.APP_URL.replace(/\/$/, "");
    const permanentPath = await getWorkspacePermanentPathForEntity({
      workspaceId,
      entityType: "Proposal",
      entityId: proposal.id,
    });

    return NextResponse.json({
      id: proposal.id,
      title: proposal.title,
      priority: item.priority,
      priorityLabel: item.priorityLabel,
      ownerMemberId: item.ownerMemberId,
      ownerMemberName: item.ownerMemberName,
      status: proposal.status,
      webUrl: `${origin}/workspaces/${workspaceId}/proposals/${proposal.id}`,
      permanentUrl: permanentPath ? `${origin}${permanentPath}` : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
