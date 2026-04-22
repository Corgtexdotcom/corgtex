import type { MeetingInsightType, MeetingInsightStatus, MeetingInsight, Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { defaultModelGateway } from "@corgtex/models";
import { createAction } from "./actions";
import { createTension } from "./tensions";
import { createProposal } from "./proposals";

export async function extractMeetingInsights(
  actor: AppActor,
  params: { workspaceId: string; meetingId: string }
): Promise<MeetingInsight[]> {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const meeting = await prisma.meeting.findUnique({
    where: {
      id: params.meetingId,
      workspaceId: params.workspaceId,
    },
  });

  invariant(meeting, 404, "NOT_FOUND", "Meeting not found.");
  invariant(meeting.transcript, 400, "INVALID_STATE", "Meeting has no transcript to analyze.");

  const instruction = `
You are analyzing a meeting transcript for a self-managed organization.
Extract all:
- DECISIONS: Agreements or choices made during the meeting
- TENSIONS: Unresolved issues, concerns, or gaps identified
- ACTION_ITEMS: Tasks assigned to specific people with next steps
- PROPOSALS: New ideas or changes proposed for the organization
- FOLLOW_UPS: Items that need to be discussed in the next meeting

For each item, provide:
- type: one of DECISION, TENSION, ACTION_ITEM, PROPOSAL, FOLLOW_UP
- title: concise one-line summary
- body: detailed description in markdown
- assigneeHint: who is responsible (display name from transcript), or null
- confidence: 0.0-1.0 how confident you are
- sourceQuote: the relevant transcript excerpt (max 200 chars)

Be conservative — only extract items you're confident about.
`;

  const schemaHint = `
{
  "type": "object",
  "properties": {
    "insights": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": { "type": "string", "enum": ["DECISION", "TENSION", "ACTION_ITEM", "PROPOSAL", "FOLLOW_UP"] },
          "title": { "type": "string" },
          "body": { "type": "string" },
          "assigneeHint": { "type": "string" },
          "confidence": { "type": "number" },
          "sourceQuote": { "type": "string" }
        },
        "required": ["type", "title", "body", "confidence"]
      }
    }
  },
  "required": ["insights"]
}
`;

  const extraction = await defaultModelGateway.extract({
    workspaceId: params.workspaceId,
    instruction,
    input: meeting.transcript,
    schemaHint,
  });

  const parsed = extraction.output as { insights?: any[] };
  const insights = Array.isArray(parsed.insights) ? parsed.insights : [];

  return prisma.$transaction(async (tx) => {
    const createdInsights: MeetingInsight[] = [];
    
    for (const item of insights) {
      if (!item.type || !item.title || !item.body) continue;
      
      const created = await tx.meetingInsight.create({
        data: {
          meetingId: meeting.id,
          workspaceId: params.workspaceId,
          type: item.type as MeetingInsightType,
          status: "SUGGESTED",
          title: item.title,
          bodyMd: item.body,
          assigneeHint: item.assigneeHint || null,
          confidence: typeof item.confidence === "number" ? item.confidence : 0,
          sourceQuote: item.sourceQuote || null,
        },
      });
      createdInsights.push(created);
    }

    await tx.meeting.update({
      where: { id: meeting.id },
      data: { aiProcessedAt: new Date() },
    });

    return createdInsights;
  });
}

export async function confirmInsight(
  actor: AppActor,
  params: { workspaceId: string; insightId: string }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const insight = await prisma.meetingInsight.findUnique({
    where: { id: params.insightId, workspaceId: params.workspaceId },
  });

  invariant(insight, 404, "NOT_FOUND", "Insight not found.");
  invariant(insight.status === "SUGGESTED", 400, "INVALID_STATE", "Insight is not in SUGGESTED state.");

  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      status: "CONFIRMED",
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
    },
  });
}

export async function updateInsight(
  actor: AppActor,
  params: { workspaceId: string; insightId: string; title?: string | null; bodyMd?: string | null }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const insight = await prisma.meetingInsight.findUnique({
    where: { id: params.insightId, workspaceId: params.workspaceId },
  });

  invariant(insight, 404, "NOT_FOUND", "Insight not found.");
  
  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      ...(params.title ? { title: params.title } : {}),
      ...(params.bodyMd ? { bodyMd: params.bodyMd } : {})
    },
  });
}

export async function dismissInsight(
  actor: AppActor,
  params: { workspaceId: string; insightId: string }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const insight = await prisma.meetingInsight.findUnique({
    where: { id: params.insightId, workspaceId: params.workspaceId },
  });

  invariant(insight, 404, "NOT_FOUND", "Insight not found.");

  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      status: "DISMISSED",
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
    },
  });
}

export async function applyInsight(
  actor: AppActor,
  params: { workspaceId: string; insightId: string }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const insight = await prisma.meetingInsight.findUnique({
    where: { id: params.insightId, workspaceId: params.workspaceId },
    include: { meeting: true },
  });

  invariant(insight, 404, "NOT_FOUND", "Insight not found.");
  invariant(insight.status === "CONFIRMED", 400, "INVALID_STATE", "Insight must be CONFIRMED before applying.");

  let appliedEntityType: string | null = null;
  let appliedEntityId: string | null = null;

  // Attempt fuzzy match for assignee if hint exists
  let assigneeMemberId: string | null = null;
  if (insight.assigneeHint) {
    const mems = await prisma.member.findMany({
      where: { workspaceId: params.workspaceId },
      include: { user: true }
    });
    const lowHint = insight.assigneeHint.toLowerCase();
    const match = mems.find(m => 
      m.user.displayName?.toLowerCase().includes(lowHint) || 
      m.user.email.toLowerCase().includes(lowHint)
    );
    if (match) assigneeMemberId = match.id;
  }

  const meetingContext = `\n\n*Created from meeting:* [${insight.meeting.title || 'Untitled'}](/workspaces/${params.workspaceId}/meetings/${insight.meetingId})`;
  const fullBody = (insight.bodyMd || "") + meetingContext;

  if (insight.type === "ACTION_ITEM" || insight.type === "FOLLOW_UP") {
    // Both map to an Action
    const action = await createAction(actor, {
      workspaceId: params.workspaceId,
      title: insight.title,
      bodyMd: fullBody,
      assigneeMemberId,
    });
    appliedEntityType = "Action";
    appliedEntityId = action.id;
  } else if (insight.type === "TENSION") {
    const tension = await createTension(actor, {
      workspaceId: params.workspaceId,
      title: insight.title,
      bodyMd: fullBody,
      assigneeMemberId,
      meetingId: insight.meetingId,
    });
    appliedEntityType = "Tension";
    appliedEntityId = tension.id;
  } else if (insight.type === "PROPOSAL") {
    const proposal = await createProposal(actor, {
      workspaceId: params.workspaceId,
      title: insight.title,
      bodyMd: fullBody,
      meetingId: insight.meetingId,
    });
    appliedEntityType = "Proposal";
    appliedEntityId = proposal.id;
  } else if (insight.type === "DECISION") {
    // We already have meeting decisionsJSON, we will just merge it there
    appliedEntityType = "Decision";
    
    // Read existing decisions
    const existing = insight.meeting.decisionsJson as { items: any[] } | null;
    const items = Array.isArray(existing?.items) ? existing.items : [];
    items.push({
      title: insight.title,
      bodyMd: insight.bodyMd,
      confirmedAt: new Date().toISOString(),
    });

    await prisma.meeting.update({
      where: { id: insight.meetingId },
      data: { decisionsJson: { items } }
    });
  }

  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      status: "APPLIED",
      appliedEntityType,
      appliedEntityId,
    },
  });
}

export async function confirmAllInsights(
  actor: AppActor,
  params: { workspaceId: string; meetingId: string; onlyType?: MeetingInsightType }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const updateWhere: Prisma.MeetingInsightWhereInput = {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    status: "SUGGESTED",
  };
  if (params.onlyType) {
    updateWhere.type = params.onlyType;
  }

  await prisma.meetingInsight.updateMany({
    where: updateWhere,
    data: {
      status: "CONFIRMED",
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
    },
  });
}
