import type { MeetingInsightType, MeetingInsightStatus, MeetingInsight, Prisma, ProposalResolutionOutcome } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { defaultModelGateway } from "@corgtex/models";
import { createAction, updateAction } from "./actions";
import { createTension, updateTension } from "./tensions";
import { createProposal, submitProposal } from "./proposals";
import { appendEvents } from "./events";

const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.8;
const MAX_DIRECT_INSIGHT_TRANSCRIPT_CHARS = 35_000;
const INSIGHT_TRANSCRIPT_EXCERPT_CHARS = 8_000;
const MEETING_INSIGHT_TYPES = new Set<MeetingInsightType>([
  "DECISION",
  "TENSION",
  "ACTION_ITEM",
  "PROPOSAL",
  "FOLLOW_UP",
]);
const MEETING_INSIGHT_TYPE_ALIASES: Record<string, MeetingInsightType> = {
  ACTION: "ACTION_ITEM",
  ACTIONS: "ACTION_ITEM",
  ACTION_ITEMS: "ACTION_ITEM",
  DECISIONS: "DECISION",
  FOLLOWUP: "FOLLOW_UP",
  FOLLOWUPS: "FOLLOW_UP",
  FOLLOW_UPS: "FOLLOW_UP",
  PROPOSALS: "PROPOSAL",
  TENSIONS: "TENSION",
};
const RESOLUTION_OUTCOMES = new Set<ProposalResolutionOutcome>([
  "ADOPTED",
  "NOT_ADOPTED",
  "WITHDRAWN",
]);

function excerptLongTranscript(transcript: string) {
  if (transcript.length <= MAX_DIRECT_INSIGHT_TRANSCRIPT_CHARS) {
    return transcript;
  }

  const middleStart = Math.max(
    INSIGHT_TRANSCRIPT_EXCERPT_CHARS,
    Math.floor(transcript.length / 2) - Math.floor(INSIGHT_TRANSCRIPT_EXCERPT_CHARS / 2),
  );
  const middleEnd = Math.min(transcript.length - INSIGHT_TRANSCRIPT_EXCERPT_CHARS, middleStart + INSIGHT_TRANSCRIPT_EXCERPT_CHARS);

  return [
    `The full transcript is ${transcript.length} characters and was shortened for extraction to avoid model timeouts. Use summaryMd first, then these transcript excerpts as supporting evidence.`,
    `BEGINNING EXCERPT:\n${transcript.slice(0, INSIGHT_TRANSCRIPT_EXCERPT_CHARS)}`,
    `MIDDLE EXCERPT:\n${transcript.slice(middleStart, middleEnd)}`,
    `ENDING EXCERPT:\n${transcript.slice(-INSIGHT_TRANSCRIPT_EXCERPT_CHARS)}`,
  ].join("\n\n---\n\n");
}

function normalizeInsightType(value: unknown, targetEntityType: string | null): MeetingInsightType | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (MEETING_INSIGHT_TYPES.has(normalized as MeetingInsightType)) {
    return normalized as MeetingInsightType;
  }

  const alias = MEETING_INSIGHT_TYPE_ALIASES[normalized];
  if (alias) {
    return alias;
  }

  if (normalized === "RESOLUTION" || normalized === "RESOLUTIONS") {
    if (targetEntityType === "Action") return "ACTION_ITEM";
    if (targetEntityType === "Tension") return "TENSION";
    if (targetEntityType === "Proposal") return "PROPOSAL";
  }

  return null;
}

function normalizeResolutionOutcome(
  value: unknown,
  operation: "CREATE" | "RESOLVE",
  targetEntityType: string | null,
): ProposalResolutionOutcome | null {
  if (operation !== "RESOLVE" || targetEntityType !== "Proposal" || typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return RESOLUTION_OUTCOMES.has(normalized as ProposalResolutionOutcome)
    ? normalized as ProposalResolutionOutcome
    : null;
}

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

  const [openActions, openTensions, openProposals] = await Promise.all([
    prisma.action.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, status: { in: ["DRAFT", "OPEN", "IN_PROGRESS"] } },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.tension.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, status: { in: ["DRAFT", "OPEN"] } },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.proposal.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, status: { in: ["DRAFT", "OPEN"] } },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const instruction = `
You are analyzing a meeting transcript for a self-managed organization.
Extract all:
- DECISIONS: Agreements or choices made during the meeting
- TENSIONS: Unresolved issues, concerns, or gaps identified
- ACTION_ITEMS: Tasks assigned to specific people with next steps
- PROPOSALS: New ideas or changes proposed for the organization
- FOLLOW_UPS: Items that need to be discussed in the next meeting
- RESOLUTIONS: existing actions, tensions, or proposals that the meeting clearly completed, resolved, adopted, rejected, or withdrew

Use any user-provided ingestion guidance to prioritize what matters and what follow-up work the operator wanted highlighted. Treat guidance as trusted operator context for spelling, name, and terminology corrections. When guidance corrects a transcript term, use the corrected term in titles and body text. Do not invent new decisions, tasks, tensions, proposals, or resolutions from guidance alone. If an item mainly comes from guidance rather than transcript evidence, say that clearly in the body and leave sourceQuote null.
If transcriptCondensedForExtraction is true, the full transcript was too large for direct structured extraction. Use summaryMd as the primary meeting digest and the transcript excerpts only as supporting evidence. Do not treat the transcript-shortening note itself as meeting content.

For each item, provide:
- operation: CREATE for new records/decisions/follow-ups, RESOLVE for existing records resolved in this meeting
- type: one of DECISION, TENSION, ACTION_ITEM, PROPOSAL, FOLLOW_UP
- title: a concise numbered summary, e.g. "#001 > Owner Name Topic/Category - short description"
- body: use this structured markdown format:
  **CONTEXT:** [Background or situation that prompted this item]
  **REQUEST:** [What was asked, raised, or proposed]
  **ANSWER:** [What was decided, agreed upon, or the next step]
  **RESULT:** [PROCESSED / OPEN / PENDING — the current status]
- assigneeHint: who is responsible (display name from transcript), or null
- confidence: 0.0-1.0 how confident you are
- sourceQuote: the relevant transcript or summary excerpt (max 200 chars)
- targetEntityType and targetEntityId only for RESOLVE items, using the existing records supplied in the input
- resolutionOutcome only for resolved proposals: ADOPTED, NOT_ADOPTED, or WITHDRAWN

Be conservative — only extract items you're confident about.
Number items sequentially (#001, #002, ...) across all types.
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
          "operation": { "type": "string", "enum": ["CREATE", "RESOLVE"] },
          "title": { "type": "string" },
          "body": { "type": "string" },
          "assigneeHint": { "type": "string" },
          "confidence": { "type": "number" },
          "sourceQuote": { "type": "string" },
          "targetEntityType": { "type": "string", "enum": ["Action", "Tension", "Proposal"] },
          "targetEntityId": { "type": "string" },
          "resolutionOutcome": { "type": "string", "enum": ["ADOPTED", "NOT_ADOPTED", "WITHDRAWN"] }
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
    input: JSON.stringify({
      transcript: excerptLongTranscript(meeting.transcript),
      transcriptLength: meeting.transcript.length,
      transcriptCondensedForExtraction: meeting.transcript.length > MAX_DIRECT_INSIGHT_TRANSCRIPT_CHARS,
      summaryMd: meeting.summaryMd,
      ingestionGuidanceMd: meeting.ingestionGuidanceMd,
      existingRecords: {
        actions: openActions,
        tensions: openTensions,
        proposals: openProposals,
      },
    }),
    schemaHint,
  });

  const parsed = extraction.output as { insights?: any[] };
  const insights = Array.isArray(parsed.insights) ? parsed.insights : [];

  const validTargets = new Map<string, string>([
    ...openActions.map((item) => [`Action:${item.id}`, item.id] as const),
    ...openTensions.map((item) => [`Tension:${item.id}`, item.id] as const),
    ...openProposals.map((item) => [`Proposal:${item.id}`, item.id] as const),
  ]);

  return prisma.$transaction(async (tx) => {
    const createdInsights: MeetingInsight[] = [];

    await tx.meetingInsight.deleteMany({
      where: {
        workspaceId: params.workspaceId,
        meetingId: meeting.id,
        status: "SUGGESTED",
      },
    });
    
    for (const item of insights) {
      const targetEntityType = typeof item.targetEntityType === "string" ? item.targetEntityType : null;
      const targetEntityId = typeof item.targetEntityId === "string" ? item.targetEntityId : null;
      const targetKey = targetEntityType && targetEntityId ? `${targetEntityType}:${targetEntityId}` : null;
      const operation = item.operation === "RESOLVE" && targetKey && validTargets.has(targetKey) ? "RESOLVE" : "CREATE";
      const type = normalizeInsightType(item.type, operation === "RESOLVE" ? targetEntityType : null);
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const bodyMd = typeof item.body === "string" ? item.body.trim() : "";
      const resolutionOutcome = normalizeResolutionOutcome(item.resolutionOutcome, operation, targetEntityType);
      if (!type || title.length === 0 || bodyMd.length === 0) continue;
      if (operation === "RESOLVE" && targetEntityType === "Proposal" && !resolutionOutcome) continue;
      
      const created = await tx.meetingInsight.create({
        data: {
          meetingId: meeting.id,
          workspaceId: params.workspaceId,
          type,
          operation,
          status: "SUGGESTED",
          title,
          bodyMd,
          assigneeHint: typeof item.assigneeHint === "string" ? item.assigneeHint : null,
          confidence: typeof item.confidence === "number" ? item.confidence : 0,
          sourceQuote: typeof item.sourceQuote === "string" ? item.sourceQuote.slice(0, 200) : null,
          targetEntityType: operation === "RESOLVE" ? targetEntityType : null,
          targetEntityId: operation === "RESOLVE" ? targetEntityId : null,
          resolutionOutcome,
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
  params: { workspaceId: string; insightId: string; title?: string | null; bodyMd?: string | null; assigneeHint?: string | null }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const insight = await prisma.meetingInsight.findUnique({
    where: { id: params.insightId, workspaceId: params.workspaceId },
  });

  invariant(insight, 404, "NOT_FOUND", "Insight not found.");
  invariant(insight.status === "SUGGESTED" || insight.status === "CONFIRMED", 400, "INVALID_STATE", "Only reviewable insights can be edited.");

  const title = params.title?.trim();
  const bodyMd = params.bodyMd?.trim();
  const assigneeHint = params.assigneeHint?.trim();
  invariant(title === undefined || title.length > 0, 400, "INVALID_INPUT", "Insight title is required.");
  
  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(bodyMd !== undefined ? { bodyMd } : {}),
      ...(params.assigneeHint !== undefined ? { assigneeHint: assigneeHint || null } : {}),
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
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
  params: { workspaceId: string; insightId: string; autoApplied?: boolean }
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
  invariant(insight.status === "CONFIRMED" || insight.status === "SUGGESTED", 400, "INVALID_STATE", "Insight must be suggested or confirmed before applying.");

  let appliedEntityType: string | null = null;
  let appliedEntityId: string | null = null;

  const meetingContext = `\n\n*Created from meeting:* [${insight.meeting.title || 'Untitled'}](/workspaces/${params.workspaceId}/meetings/${insight.meetingId})`;
  const fullBody = (insight.bodyMd || "") + meetingContext;

  if (insight.operation === "RESOLVE") {
    invariant(insight.targetEntityType && insight.targetEntityId, 400, "INVALID_STATE", "Resolved insight must point to a target record.");

    if (insight.targetEntityType === "Action") {
      await updateAction(actor, {
        workspaceId: params.workspaceId,
        actionId: insight.targetEntityId,
        status: "COMPLETED",
      });
      appliedEntityType = "Action";
      appliedEntityId = insight.targetEntityId;
    } else if (insight.targetEntityType === "Tension") {
      await updateTension(actor, {
        workspaceId: params.workspaceId,
        tensionId: insight.targetEntityId,
        status: "RESOLVED",
        resolvedVia: `Meeting: ${insight.meeting.title || insight.meetingId}`,
      });
      appliedEntityType = "Tension";
      appliedEntityId = insight.targetEntityId;
    } else if (insight.targetEntityType === "Proposal") {
      const outcome = (insight.resolutionOutcome || "ADOPTED") as ProposalResolutionOutcome;
      await prisma.$transaction(async (tx) => {
        const proposal = await tx.proposal.findFirst({
          where: { id: insight.targetEntityId!, workspaceId: params.workspaceId, archivedAt: null },
        });
        invariant(proposal, 404, "NOT_FOUND", "Proposal not found.");
        const updatedProposal = await tx.proposal.update({
          where: { id: proposal.id },
          data: {
            status: "RESOLVED",
            resolutionOutcome: outcome,
            decisionMd: fullBody,
            decidedAt: new Date(),
            isPrivate: false,
            publishedAt: proposal.publishedAt || new Date(),
          },
        });
        if (outcome === "ADOPTED") {
          await tx.policyCorpus.upsert({
            where: { proposalId: updatedProposal.id },
            update: {
              title: updatedProposal.title,
              bodyMd: updatedProposal.bodyMd,
              acceptedAt: updatedProposal.decidedAt ?? new Date(),
              circleId: updatedProposal.circleId,
            },
            create: {
              workspaceId: updatedProposal.workspaceId,
              proposalId: updatedProposal.id,
              title: updatedProposal.title,
              bodyMd: updatedProposal.bodyMd,
              acceptedAt: updatedProposal.decidedAt ?? new Date(),
              circleId: updatedProposal.circleId,
            },
          });
        }
        await tx.auditLog.create({
          data: {
            workspaceId: params.workspaceId,
            actorUserId: actor.kind === "user" ? actor.user.id : null,
            action: "proposal.resolved_from_meeting",
            entityType: "Proposal",
            entityId: proposal.id,
            meta: { meetingId: insight.meetingId, outcome },
          },
        });
        await appendEvents(tx, [
          {
            workspaceId: params.workspaceId,
            type: outcome === "ADOPTED" ? "proposal.approved" : "proposal.rejected",
            aggregateType: "Proposal",
            aggregateId: proposal.id,
            payload: { proposalId: proposal.id, subjectId: proposal.id, outcome },
          },
        ]);
      });
      appliedEntityType = "Proposal";
      appliedEntityId = insight.targetEntityId;
    }
  } else if (insight.type === "DECISION") {
    appliedEntityType = "Decision";
    
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
  } else {
    // Attempt fuzzy match for a member reference if a hint exists.
    let hintedMemberId: string | null = null;
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
      if (match) hintedMemberId = match.id;
    }

    if (insight.type === "ACTION_ITEM" || insight.type === "FOLLOW_UP") {
      const action = await createAction(actor, {
        workspaceId: params.workspaceId,
        title: insight.title,
        bodyMd: fullBody,
        assigneeMemberId: hintedMemberId,
        isPrivate: false,
      });
      const opened = await updateAction(actor, {
        workspaceId: params.workspaceId,
        actionId: action.id,
        status: "OPEN",
      });
      appliedEntityType = "Action";
      appliedEntityId = opened.id;
    } else if (insight.type === "TENSION") {
      const tension = await createTension(actor, {
        workspaceId: params.workspaceId,
        title: insight.title,
        bodyMd: fullBody,
        raisedByMemberId: hintedMemberId,
        meetingId: insight.meetingId,
        isPrivate: false,
      });
      const opened = await updateTension(actor, {
        workspaceId: params.workspaceId,
        tensionId: tension.id,
        status: "OPEN",
      });
      appliedEntityType = "Tension";
      appliedEntityId = opened.id;
    } else if (insight.type === "PROPOSAL") {
      const proposal = await createProposal(actor, {
        workspaceId: params.workspaceId,
        title: insight.title,
        bodyMd: fullBody,
        meetingId: insight.meetingId,
        isPrivate: false,
      });
      await submitProposal(actor, {
        workspaceId: params.workspaceId,
        proposalId: proposal.id,
      });
      appliedEntityType = "Proposal";
      appliedEntityId = proposal.id;
    }
  }

  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      status: "APPLIED",
      appliedEntityType,
      appliedEntityId,
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
      autoAppliedAt: params.autoApplied ? new Date() : null,
      autoApplyError: null,
    },
  });
}

export async function autoApplyMeetingInsights(
  actor: AppActor,
  params: { workspaceId: string; meetingId: string; confidenceThreshold?: number }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const confidenceThreshold = params.confidenceThreshold ?? AUTO_APPLY_CONFIDENCE_THRESHOLD;
  const insights = await prisma.meetingInsight.findMany({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      status: { in: ["SUGGESTED", "CONFIRMED"] },
      confidence: { gte: confidenceThreshold },
    },
    orderBy: { createdAt: "asc" },
  });

  let applied = 0;
  let failed = 0;
  let skipped = 0;

  for (const insight of insights) {
    if (insight.operation === "RESOLVE" && (!insight.targetEntityType || !insight.targetEntityId)) {
      skipped++;
      continue;
    }

    try {
      await applyInsight(actor, {
        workspaceId: params.workspaceId,
        insightId: insight.id,
        autoApplied: true,
      });
      applied++;
    } catch (error) {
      failed++;
      await prisma.meetingInsight.update({
        where: { id: insight.id },
        data: {
          autoApplyError: error instanceof Error ? error.message : "Failed to auto-apply insight.",
        },
      });
    }
  }

  return { applied, failed, skipped, threshold: confidenceThreshold };
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
