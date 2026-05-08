import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { Prisma, type ProposalResolutionOutcome } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { getApprovalPolicy, ensureApprovalFlow } from "./approvals";
import { invariant } from "./errors";
import { privacyFilter } from "./privacy";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { requireDraftManager } from "./draft-permissions";

const PROPOSAL_RESOLUTION_OUTCOMES = new Set<ProposalResolutionOutcome>(["ADOPTED", "NOT_ADOPTED", "WITHDRAWN"]);
const AI_SUMMARY_WORD_THRESHOLD = 120;

type CreateProposalParams = {
  workspaceId: string;
  title: string;
  summary?: string | null;
  includeAiSummary?: boolean;
  bodyMd: string;
  circleId?: string | null;
  isPrivate?: boolean;
  meetingId?: string | null;
  sourceTensionId?: string | null;
  relatedActionIds?: string[] | null;
};

type CreateProposalFromTensionParams = Omit<CreateProposalParams, "title" | "bodyMd" | "sourceTensionId"> & {
  sourceTensionId: string;
  title?: string | null;
  bodyMd?: string | null;
};

function normalizeIds(ids?: string[] | null) {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
}

function markdownToProposalText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[\s>*+-]*\[[ xX]\]\s+/gm, "")
    .replace(/^[\s>*+-]*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~>#|{}[\]()]/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function proposalWordCount(title: string, bodyMd: string) {
  const text = markdownToProposalText(`${title}\n\n${bodyMd}`);
  return text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function normalizeGeneratedSummary(value: unknown) {
  if (typeof value !== "string") return null;
  const summary = markdownToProposalText(value);
  if (!summary) return null;
  return summary.length > 500 ? `${summary.slice(0, 497).trim()}...` : summary;
}

async function generateProposalSummary(params: {
  workspaceId: string;
  title: string;
  bodyMd: string;
}) {
  if (proposalWordCount(params.title, params.bodyMd) <= AI_SUMMARY_WORD_THRESHOLD) {
    return null;
  }

  try {
    const extraction = await defaultModelGateway.extract({
      workspaceId: params.workspaceId,
      instruction: [
        "Write a concise plain-text summary for this governance proposal.",
        "Use only the supplied title and body.",
        "Return one or two short sentences and no markdown.",
      ].join("\n"),
      input: JSON.stringify({
        title: params.title,
        bodyMd: params.bodyMd,
      }),
      schemaHint: "{ summary: string }",
    });

    return normalizeGeneratedSummary(extraction.output.summary);
  } catch {
    return null;
  }
}

function proposalDraftFromTension(tension: { title: string; bodyMd: string | null }, params: {
  title?: string | null;
  summary?: string | null;
  bodyMd?: string | null;
}) {
  const title = params.title?.trim() || `Resolve tension: ${tension.title}`;
  const summary = params.summary?.trim() || `Proposal drafted from tension: ${tension.title}`;
  const sourceDescription = tension.bodyMd?.trim() || "_No description provided._";
  const bodyMd = params.bodyMd?.trim() || [
    "## Tension",
    "",
    sourceDescription,
    "",
    "## Proposal",
    "",
    "Describe the governance change that would reduce or resolve this tension.",
    "",
    "## Safe-to-try check",
    "",
    "- What risk does this introduce?",
    "- How will we know it helped?",
  ].join("\n");

  return { title, summary, bodyMd };
}

async function loadVisibleSourceTension(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: MembershipSummary | null,
  workspaceId: string,
  sourceTensionId?: string | null,
) {
  const normalizedTensionId = sourceTensionId?.trim();
  if (!normalizedTensionId) return null;

  const tension = await tx.tension.findFirst({
    where: {
      id: normalizedTensionId,
      workspaceId,
      archivedAt: null,
      ...privacyFilter(actor, membership),
    },
    select: {
      id: true,
      title: true,
      bodyMd: true,
      circleId: true,
      meetingId: true,
      proposalId: true,
      status: true,
    },
  });

  invariant(tension, 404, "NOT_FOUND", "Source tension not found.");
  invariant(!tension.proposalId, 400, "INVALID_STATE", "Source tension is already linked to a proposal.");
  return tension;
}

async function validateRelatedActions(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: MembershipSummary | null,
  workspaceId: string,
  relatedActionIds?: string[] | null,
) {
  const actionIds = normalizeIds(relatedActionIds);
  if (actionIds.length === 0) return actionIds;

  const actions = await tx.action.findMany({
    where: {
      id: { in: actionIds },
      workspaceId,
      archivedAt: null,
      ...privacyFilter(actor, membership),
    },
    select: {
      id: true,
      proposalId: true,
    },
  });

  invariant(actions.length === actionIds.length, 404, "NOT_FOUND", "Related action not found.");
  invariant(!actions.some((action) => action.proposalId), 400, "INVALID_STATE", "Related action is already linked to a proposal.");

  return actionIds;
}

export async function listProposals(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number; circleId?: string | null; archiveFilter?: ArchiveFilter }) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const where: any = { workspaceId, ...privacyFilter(actor, membership), ...archiveFilterWhere(opts?.archiveFilter) };
  if (opts?.circleId !== undefined) {
    where.circleId = opts.circleId;
  }

  const [items, total] = await Promise.all([
    prisma.proposal.findMany({
      where,
      include: {
        author: {
          select: {
            displayName: true,
            email: true,
          },
        },
        reactions: true,
        tensions: { select: { id: true, title: true, status: true } },
        actions: { select: { id: true, title: true, status: true } },
        adviceProcess: {
          include: {
            records: { include: { member: { include: { user: { select: { displayName: true, email: true } } } } } }
          }
        },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.proposal.count({ where }),
  ]);
  return { items, total, take, skip };
}

export async function getProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const proposal = await prisma.proposal.findFirst({
    where: {
      id: params.proposalId,
      workspaceId: params.workspaceId,
      ...privacyFilter(actor, membership),
      archivedAt: null,
    },
    include: {
      author: { select: { id: true, displayName: true, email: true } },
      circle: { select: { id: true, name: true } },
      tensions: { select: { id: true, title: true, status: true } },
      actions: { select: { id: true, title: true, status: true } },
      adviceProcess: {
        include: {
          records: {
            include: { member: { include: { user: { select: { displayName: true, email: true } } } } }
          }
        }
      },
    },
  });
  invariant(proposal, 404, "NOT_FOUND", "Proposal not found.");
  return proposal;
}

export async function createProposal(actor: AppActor, params: CreateProposalParams) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const title = params.title.trim();
  const bodyMd = params.bodyMd.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Proposal title is required.");
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Proposal body is required.");
  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);
  const summary = params.includeAiSummary === true
    ? await generateProposalSummary({ workspaceId: params.workspaceId, title, bodyMd })
    : params.summary?.trim() || null;

  return prisma.$transaction(async (tx) => {
    const sourceTension = await loadVisibleSourceTension(tx, actor, membership, params.workspaceId, params.sourceTensionId);
    const relatedActionIds = await validateRelatedActions(tx, actor, membership, params.workspaceId, params.relatedActionIds);
    const proposal = await tx.proposal.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title,
        summary,
        bodyMd,
        circleId: params.circleId || sourceTension?.circleId || null,
        isPrivate: params.isPrivate ?? true,
        meetingId: params.meetingId || sourceTension?.meetingId || null,
        publishedAt: null,
      },
    });

    if (sourceTension) {
      await tx.tension.update({
        where: { id: sourceTension.id },
        data: { proposalId: proposal.id },
      });
    }

    if (relatedActionIds.length > 0) {
      const linkedActions = await tx.action.updateMany({
        where: {
          id: { in: relatedActionIds },
          workspaceId: params.workspaceId,
          archivedAt: null,
          proposalId: null,
          ...privacyFilter(actor, membership),
        },
        data: { proposalId: proposal.id },
      });

      invariant(linkedActions.count === relatedActionIds.length, 409, "CONFLICT", "Related actions changed before they could be linked.");
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.created",
        entityType: "Proposal",
        entityId: proposal.id,
        meta: {
          title: proposal.title,
          sourceTensionId: sourceTension?.id ?? null,
          relatedActionIds,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "proposal.created",
        aggregateType: "Proposal",
        aggregateId: proposal.id,
        payload: {
          proposalId: proposal.id,
          title: proposal.title,
          sourceTensionId: sourceTension?.id ?? null,
          relatedActionIds,
        },
      },
    ]);

    return proposal;
  });
}

export async function createProposalFromTension(actor: AppActor, params: CreateProposalFromTensionParams) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const sourceTension = await loadVisibleSourceTension(tx, actor, membership, params.workspaceId, params.sourceTensionId);
    invariant(sourceTension, 404, "NOT_FOUND", "Source tension not found.");
    const relatedActionIds = await validateRelatedActions(tx, actor, membership, params.workspaceId, params.relatedActionIds);
    const draft = proposalDraftFromTension(sourceTension, params);

    const proposal = await tx.proposal.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title: draft.title,
        summary: draft.summary,
        bodyMd: draft.bodyMd,
        circleId: params.circleId || sourceTension.circleId || null,
        isPrivate: params.isPrivate ?? true,
        meetingId: params.meetingId || sourceTension.meetingId || null,
        publishedAt: null,
      },
    });

    await tx.tension.update({
      where: { id: sourceTension.id },
      data: { proposalId: proposal.id },
    });

    if (relatedActionIds.length > 0) {
      const linkedActions = await tx.action.updateMany({
        where: {
          id: { in: relatedActionIds },
          workspaceId: params.workspaceId,
          archivedAt: null,
          proposalId: null,
          ...privacyFilter(actor, membership),
        },
        data: { proposalId: proposal.id },
      });

      invariant(linkedActions.count === relatedActionIds.length, 409, "CONFLICT", "Related actions changed before they could be linked.");
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.created_from_tension",
        entityType: "Proposal",
        entityId: proposal.id,
        meta: {
          title: proposal.title,
          sourceTensionId: sourceTension.id,
          relatedActionIds,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "proposal.created",
        aggregateType: "Proposal",
        aggregateId: proposal.id,
        payload: {
          proposalId: proposal.id,
          title: proposal.title,
          sourceTensionId: sourceTension.id,
          relatedActionIds,
        },
      },
    ]);

    return proposal;
  });
}

export async function updateProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
  title?: string;
  summary?: string | null;
  includeAiSummary?: boolean;
  bodyMd?: string;
  circleId?: string | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "DRAFT", 400, "INVALID_STATE", "Only draft proposals can be edited.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: proposal, resolvedMembership: membership });

    const data: Record<string, unknown> = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Proposal title is required.");
      data.title = title;
    }
    if (params.bodyMd !== undefined) {
      const bodyMd = params.bodyMd.trim();
      invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Proposal body is required.");
      data.bodyMd = bodyMd;
    }
    if (params.includeAiSummary === true) {
      data.summary = await generateProposalSummary({
        workspaceId: params.workspaceId,
        title: String(data.title ?? proposal.title),
        bodyMd: String(data.bodyMd ?? proposal.bodyMd),
      });
    } else if (params.includeAiSummary === false) {
      data.summary = null;
    } else if (params.summary !== undefined) {
      data.summary = params.summary?.trim() || null;
    }
    if (params.circleId !== undefined) data.circleId = params.circleId || null;

    const updated = await tx.proposal.update({
      where: { id: params.proposalId },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.updated",
        entityType: "Proposal",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}

export async function archiveProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Proposal",
    entityId: params.proposalId,
    reason: "Archived from proposal archive path.",
  });
}

export async function submitProposal(actor: AppActor, params: { workspaceId: string; proposalId: string; autoApproveHours?: number }) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const policy = await getApprovalPolicy(params.workspaceId, "PROPOSAL");

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "DRAFT", 400, "INVALID_STATE", "Only draft proposals can be opened.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: proposal, resolvedMembership: membership });

    const flow = await ensureApprovalFlow(tx, {
      workspaceId: params.workspaceId,
      subjectType: "PROPOSAL",
      subjectId: proposal.id,
      policy,
      createdByUserId: actor.kind === "user" ? actor.user.id : null,
    });

    await tx.proposal.update({
      where: { id: proposal.id },
      data: {
        status: "OPEN",
        isPrivate: false,
        publishedAt: proposal.publishedAt || new Date(),
        autoApproveAt: null,
      },
    });

    await tx.approvalFlow.update({
      where: { id: flow.id },
      data: {
        status: "ACTIVE",
        openedAt: new Date(),
        closesAt:
          policy.mode === "CONSENT"
            ? new Date(Date.now() + policy.decisionWindowHours * 60 * 60 * 1000)
            : null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.opened",
        entityType: "Proposal",
        entityId: proposal.id,
        meta: { flowId: flow.id },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "proposal.opened",
        aggregateType: "Proposal",
        aggregateId: proposal.id,
        payload: {
          proposalId: proposal.id,
          flowId: flow.id,
          title: proposal.title,
        },
      },
    ]);

    return {
      proposalId: proposal.id,
      flowId: flow.id,
    };
  });
}

export async function returnProposalToDraft(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "OPEN", 400, "INVALID_STATE", "Only open proposals can be returned to draft.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: proposal, resolvedMembership: membership });

    const flow = await tx.approvalFlow.findUnique({
      where: {
        subjectType_subjectId: {
          subjectType: "PROPOSAL",
          subjectId: proposal.id,
        },
      },
    });

    if (flow) {
      await tx.approvalDecision.deleteMany({ where: { flowId: flow.id } });
      await tx.objection.deleteMany({ where: { flowId: flow.id } });
      await tx.approvalFlow.update({
        where: { id: flow.id },
        data: {
          status: "DRAFT",
          openedAt: null,
          closesAt: null,
          closedAt: null,
          resultJson: Prisma.JsonNull,
        },
      });
    }

    const now = new Date();
    await tx.deliberationEntry.updateMany({
      where: {
        workspaceId: params.workspaceId,
        parentType: "PROPOSAL",
        parentId: proposal.id,
        resolvedAt: null,
      },
      data: {
        resolvedAt: now,
        resolvedNote: "Cleared when proposal returned to draft.",
      },
    });
    await tx.proposalReaction.updateMany({
      where: {
        proposalId: proposal.id,
        resolvedAt: null,
      },
      data: {
        resolvedAt: now,
        resolvedNote: "Cleared when proposal returned to draft.",
      },
    });

    const updated = await tx.proposal.update({
      where: { id: proposal.id },
      data: {
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        autoApproveAt: null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.returned_to_draft",
        entityType: "Proposal",
        entityId: proposal.id,
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "proposal.returned_to_draft",
        aggregateType: "Proposal",
        aggregateId: proposal.id,
        payload: { proposalId: proposal.id },
      },
    ]);

    return updated;
  });
}

export async function publishProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.isPrivate, 400, "INVALID_STATE", "Proposal is already public.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: proposal, resolvedMembership: membership });

    const updated = await tx.proposal.update({
      where: { id: params.proposalId },
      data: { isPrivate: false, publishedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.published",
        entityType: "Proposal",
        entityId: updated.id,
        meta: { title: updated.title },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "proposal.published",
        aggregateType: "Proposal",
        aggregateId: updated.id,
        payload: { proposalId: updated.id },
      },
    ]);

    return updated;
  });
}

export async function resolveProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
  outcome: ProposalResolutionOutcome;
  decisionMd: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(PROPOSAL_RESOLUTION_OUTCOMES.has(params.outcome), 400, "INVALID_INPUT", "Resolution outcome is required.");
  const decisionMd = params.decisionMd.trim();
  invariant(decisionMd.length > 0, 400, "INVALID_INPUT", "Resolution note is required.");

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "OPEN", 400, "INVALID_STATE", "Only open proposals can be resolved.");

    const flow = await tx.approvalFlow.findUnique({
      where: {
        subjectType_subjectId: {
          subjectType: "PROPOSAL",
          subjectId: proposal.id,
        },
      },
    });

    const updated = await tx.proposal.update({
      where: { id: proposal.id },
      data: {
        status: "RESOLVED",
        resolutionOutcome: params.outcome,
        decisionMd,
        decidedAt: now,
        autoApproveAt: null,
        isPrivate: false,
        publishedAt: proposal.publishedAt || now,
      },
    });

    if (flow) {
      await tx.approvalFlow.update({
        where: { id: flow.id },
        data: {
          status: params.outcome === "ADOPTED" ? "APPROVED" : params.outcome === "WITHDRAWN" ? "WITHDRAWN" : "REJECTED",
          closedAt: now,
          resultJson: {
            manuallyResolved: true,
            outcome: params.outcome,
            decisionMd,
          } as Prisma.InputJsonValue,
        },
      });
    }

    if (params.outcome === "ADOPTED") {
      await tx.policyCorpus.upsert({
        where: { proposalId: updated.id },
        update: {
          title: updated.title,
          bodyMd: updated.bodyMd,
          acceptedAt: updated.decidedAt ?? now,
          circleId: updated.circleId,
        },
        create: {
          workspaceId: updated.workspaceId,
          proposalId: updated.id,
          title: updated.title,
          bodyMd: updated.bodyMd,
          acceptedAt: updated.decidedAt ?? now,
          circleId: updated.circleId,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.resolved",
        entityType: "Proposal",
        entityId: proposal.id,
        meta: {
          outcome: params.outcome,
          flowId: flow?.id ?? null,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: params.outcome === "ADOPTED" ? "proposal.approved" : "proposal.rejected",
        aggregateType: "Proposal",
        aggregateId: proposal.id,
        payload: {
          proposalId: proposal.id,
          subjectId: proposal.id,
          outcome: params.outcome,
          flowId: flow?.id ?? null,
        },
      },
    ]);

    return updated;
  });
}

export async function deleteProposal(actor: AppActor, params: { workspaceId: string; proposalId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Proposal",
    entityId: params.proposalId,
    reason: "Archived from proposal delete path.",
  });
}
