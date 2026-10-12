import type {
  ApprovalDecisionChoice,
  ApprovalFlow,
  ApprovalFlowStatus,
  ApprovalMode,
  ApprovalPolicy,
  Prisma,
} from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { acquireWorkItemAdvisoryLock } from "./work-item-versions";
import { acquireConstitutionCorpusAdvisoryLock } from "./constitutions";
import { humanMemberIdentityWhere } from "./member-identity";
import { advanceHumanArtifactInputLineage, captureArtifactInputProof, captureArtifactInputSnapshotProof, currentArtifactInputRoots,
  invalidateArtifactInputLineage, lineageContentFingerprint, preserveUnknownArtifactInputSnapshot, readableArtifactIds, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";

export type DecisionSummary = {
  approve: number;
  reject: number;
  abstain: number;
  agree: number;
  block: number;
};

export type ApprovalOutcome = {
  approved: boolean;
  quorumMet: boolean;
  minApproverCountMet: boolean;
  participationPercent: number;
  summary: DecisionSummary;
};

type LoadedFlow = ApprovalFlow & {
  decisions: Prisma.ApprovalDecisionGetPayload<Record<string, never>>[];
  objections: Prisma.ObjectionGetPayload<Record<string, never>>[];
};

const EXPIRING_FLOW_BATCH_SIZE = 25;
export type ActionableApprovalFlow = ApprovalFlow & {
  decisions: Array<{
    choice: ApprovalDecisionChoice;
  }>;
  subjectLabel: string;
};

export type ProposalDecisionState = {
  proposalId: string;
  flowId: string;
  mode: ApprovalMode;
  openedAt: Date | null;
  closesAt: Date | null;
  quorumPercent: number;
  minApproverCount: number;
  eligibleApprovers: number;
  reviewers: Array<{
    memberId: string;
    name: string;
    choice: ApprovalDecisionChoice | null;
    hasOpenObjection: boolean;
  }>;
  outcome: ApprovalOutcome;
  currentMemberDecision: {
    choice: ApprovalDecisionChoice;
    rationale: string | null;
    updatedAt: Date;
  } | null;
  openObjections: Array<{
    id: string;
    userId: string;
    bodyMd: string;
    createdAt: Date;
    user: {
      displayName: string | null;
      email: string;
    };
  }>;
  currentUserOpenObjectionId: string | null;
  canReview: boolean;
  needsReview: boolean;
};

export function buildDecisionSummary(decisions: Array<{ choice: ApprovalDecisionChoice }>): DecisionSummary {
  const summary: DecisionSummary = {
    approve: 0,
    reject: 0,
    abstain: 0,
    agree: 0,
    block: 0,
  };

  for (const decision of decisions) {
    switch (decision.choice) {
      case "APPROVE":
        summary.approve += 1;
        break;
      case "REJECT":
        summary.reject += 1;
        break;
      case "ABSTAIN":
        summary.abstain += 1;
        break;
      case "AGREE":
        summary.agree += 1;
        break;
      case "BLOCK":
        summary.block += 1;
        break;
    }
  }

  return summary;
}

export function calculateApprovalOutcome(params: {
  mode: ApprovalMode;
  quorumPercent: number;
  minApproverCount: number;
  decisions: Array<{ choice: ApprovalDecisionChoice }>;
  eligibleApprovers: number;
  openObjections: number;
}): ApprovalOutcome {
  const summary = buildDecisionSummary(params.decisions);
  const participationPercent =
    params.eligibleApprovers > 0 ? (params.decisions.length / params.eligibleApprovers) * 100 : 0;
  const quorumMet = participationPercent >= params.quorumPercent;
  const minApproverCountMet = params.decisions.length >= params.minApproverCount;

  let approved = false;

  if (params.mode === "SINGLE") {
    approved = minApproverCountMet && (summary.approve > 0 || summary.agree > 0);
  } else if (params.mode === "MAJORITY") {
    approved = minApproverCountMet && quorumMet && summary.approve > summary.reject;
  } else if (params.mode === "CONSENSUS") {
    const allAgree = params.decisions.length > 0 && params.decisions.every((decision) => decision.choice === "AGREE");
    approved = minApproverCountMet && quorumMet && !summary.block && allAgree;
  } else {
    approved = params.openObjections === 0;
  }

  return {
    approved,
    quorumMet,
    minApproverCountMet,
    participationPercent,
    summary,
  };
}

function assertConsentWindowOpen(flow: ApprovalFlow) {
  if (flow.mode !== "CONSENT") {
    return;
  }

  if (flow.subjectType === "PROPOSAL") {
    return;
  }

  invariant(
    !flow.closesAt || flow.closesAt > new Date(),
    400,
    "INVALID_STATE",
    "The approval window has already closed.",
  );
}

function validateDecisionChoice(mode: ApprovalMode, choice: ApprovalDecisionChoice) {
  if (mode !== "CONSENT") {
    return;
  }

  invariant(
    choice === "AGREE" || choice === "ABSTAIN",
    400,
    "INVALID_INPUT",
    "Consent flows accept AGREE or ABSTAIN decisions. Use objections for blocks.",
  );
}

async function eligibleApproverIds(tx: Prisma.TransactionClient, workspaceId: string, excludedUserId?: string | null): Promise<string[]> {
  const members = await tx.member.findMany({
    where: {
      workspaceId,
      isActive: true,
      ...humanMemberIdentityWhere(),
    },
    select: {
      id: true,
      userId: true,
    },
  });

  return members.filter((member) => !excludedUserId || member.userId !== excludedUserId).map((member) => member.id);
}

async function loadFlow(tx: Prisma.TransactionClient, flowId: string) {
  return tx.approvalFlow.findUnique({ where: { id: flowId },
    include: { decisions: true, objections: { where: { resolvedAt: null } } } });
}

async function approvalInputsReadable(actor: AppActor, workspaceId: string, flow: { id: string; decisions?: Array<{ id: string; [key: string]: unknown }>; objections?: Array<{ id: string; [key: string]: unknown }>; [key: string]: unknown }, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const [flows, decisions, objections] = await Promise.all([
    readableArtifactIds(actor, workspaceId, "ApprovalFlow", [flow], tx),
    readableArtifactIds(actor, workspaceId, "ApprovalDecision", flow.decisions ?? [], tx),
    readableArtifactIds(actor, workspaceId, "Objection", flow.objections ?? [], tx),
  ]);
  return flows.has(flow.id) && (flow.decisions ?? []).every((row) => decisions.has(row.id))
    && (flow.objections ?? []).every((row) => objections.has(row.id));
}

async function outcomeInputRoots(tx: Prisma.TransactionClient, actor: AppActor, flow: LoadedFlow, approverIds: string[]) {
  const previous = await currentArtifactInputRoots(tx, flow.workspaceId, { kind: "ApprovalFlow", id: flow.id }, flow);
  invariant(previous, 409, "UNKNOWN_LINEAGE", "Approval inputs cannot be verified.");
  const allMembers = await tx.member.findMany({ where: { workspaceId: flow.workspaceId, isActive: true, ...humanMemberIdentityWhere() }, include: { user: true } });
  const authorUserId = await proposalAuthorUserIdForFlow(tx, flow);
  const members = allMembers.filter((row) => !authorUserId || row.userId !== authorUserId);
  invariant(members.length === approverIds.length && members.every((row) => approverIds.includes(row.id)), 409, "SOURCE_CHANGED", "Approval reviewers changed during the decision.");
  const inputs = [
    ...members.map((row) => ({ kind: "Member" as const, id: row.id, snapshot: row })),
    ...eligibleFlowDecisions(flow, approverIds).map((row) => ({ kind: "ApprovalDecision" as const, id: row.id, snapshot: row })),
    ...flow.objections.map((row) => ({ kind: "Objection" as const, id: row.id, snapshot: row })),
  ];
  // The outcome replaces resultJson completely. Retain config/subject provenance,
  // then recapture all current reviewers and review rows instead of carrying a
  // superseded choice or resolved objection into the new result.
  const base = previous.filter((root) => !["Member", "ApprovalDecision", "Objection"].includes(root.kind));
  return [...base, ...await captureArtifactInputProof(actor, flow.workspaceId, inputs, tx)];
}

async function writeFlowOutcome(tx: Prisma.TransactionClient, actor: AppActor, flow: LoadedFlow,
  roots: LineageRoot[], data: Prisma.ApprovalFlowUpdateInput) {
  const updated = await tx.approvalFlow.update({ where: { id: flow.id }, data });
  await recordArtifactInputLineage({ tx, actor, workspaceId: flow.workspaceId,
    artifact: { kind: "ApprovalFlow", id: flow.id }, content: updated, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  return updated;
}

async function approvalSubjectRoots(tx: Prisma.TransactionClient, actor: AppActor, flow: ApprovalFlow) {
  const kind = flow.subjectType === "PROPOSAL" ? "Proposal" : flow.subjectType === "ACTION" ? "Action" : flow.subjectType === "TENSION" ? "Tension" : null;
  if (kind) return captureArtifactInputSnapshotProof(actor, flow.workspaceId, { kind, id: flow.subjectId }, tx);
  // Unsupported subjects cannot be assigned a complete receipt from a subject id.
  invariant(false, 409, "UNKNOWN_LINEAGE", "Approval subject inputs cannot be verified.");
}

function eligibleFlowDecisions(flow: LoadedFlow, approverIds: string[]) {
  return flow.subjectType === "PROPOSAL"
    ? flow.decisions.filter((decision) => approverIds.includes(decision.memberId))
    : flow.decisions;
}

async function proposalAuthorUserIdForFlow(tx: Prisma.TransactionClient, flow: { workspaceId: string; subjectType: string; subjectId: string }) {
  if (flow.subjectType !== "PROPOSAL") return null;
  const [proposal] = await tx.proposal.findMany({
    where: {
      id: flow.subjectId,
      workspaceId: flow.workspaceId,
    },
    select: {
      authorUserId: true,
    },
    take: 1,
  });
  return proposal?.authorUserId ?? null;
}

async function assertProposalAuthorCanReview(tx: Prisma.TransactionClient, flow: { workspaceId: string; subjectType: string; subjectId: string }, actorUserId: string) {
  const authorUserId = await proposalAuthorUserIdForFlow(tx, flow);
  invariant(
    !authorUserId || authorUserId !== actorUserId,
    403,
    "FORBIDDEN",
    "Proposal authors cannot review their own proposal.",
  );
}

function approvalDecisionMd(params: {
  mode: ApprovalMode;
  status: "APPROVED" | "REJECTED";
  outcome: ApprovalOutcome;
  eligibleApprovers: number;
  openObjections: number;
  closesAt?: Date | null;
}) {
  if (params.mode === "CONSENT") {
    return (
      `Approval finalized by system.\n\n` +
      `- Mode: ${params.mode}\n` +
      `- Eligible approvers: ${params.eligibleApprovers}\n` +
      `- Open objections: ${params.openObjections}\n` +
      `- Closed at: ${params.closesAt?.toISOString() ?? new Date().toISOString()}\n` +
      `- Outcome: ${params.status}`
    );
  }

  return (
    `Approval finalized by system.\n\n` +
    `- Mode: ${params.mode}\n` +
    `- Eligible approvers: ${params.eligibleApprovers}\n` +
    `- Participation: ${params.outcome.participationPercent.toFixed(2)}%\n` +
    `- Quorum met: ${params.outcome.quorumMet ? "yes" : "no"}\n` +
    `- Minimum approvers met: ${params.outcome.minApproverCountMet ? "yes" : "no"}\n` +
    `- APPROVE: ${params.outcome.summary.approve}\n` +
    `- REJECT: ${params.outcome.summary.reject}\n` +
    `- ABSTAIN: ${params.outcome.summary.abstain}\n` +
    `- AGREE: ${params.outcome.summary.agree}\n` +
    `- BLOCK: ${params.outcome.summary.block}\n` +
    `- Outcome: ${params.status}`
  );
}

async function applySubjectOutcome(tx: Prisma.TransactionClient, actor: AppActor, params: {
  flow: ApprovalFlow;
  status: "APPROVED" | "REJECTED";
  outcome: ApprovalOutcome;
  eligibleApprovers: number;
  openObjections: number;
}) {
  let previousRoots: LineageRoot[] = [];
  if (params.flow.subjectType === "PROPOSAL") {
    const before = await tx.proposal.findFirst({ where: { id: params.flow.subjectId, workspaceId: params.flow.workspaceId } });
    invariant(before, 404, "NOT_FOUND", "Proposal not found.");
    const roots = await currentArtifactInputRoots(tx, params.flow.workspaceId, { kind: "Proposal", id: before.id }, before);
    invariant(roots, 409, "UNKNOWN_LINEAGE", "Proposal inputs cannot be verified.");
    previousRoots = roots;
  }
  if (params.status === "APPROVED" && params.flow.subjectType === "PROPOSAL") {
    const proposal = await tx.proposal.update({
      where: { id: params.flow.subjectId },
      data: {
        status: "RESOLVED",
        resolutionOutcome: "ADOPTED",
        decidedAt: new Date(),
        decisionMd: approvalDecisionMd({
          mode: params.flow.mode,
          status: "APPROVED",
          outcome: params.outcome,
          eligibleApprovers: params.eligibleApprovers,
          openObjections: params.openObjections,
          closesAt: params.flow.closesAt,
        }),
      },
    });

    await recordArtifactInputLineage({ tx, actor, workspaceId: proposal.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, content: proposal, origin: "DERIVED",
      inputs: [{ kind: "ApprovalFlow", id: params.flow.id }], inheritedRoots: previousRoots });
    const policy = await tx.policyCorpus.upsert({
      where: { proposalId: proposal.id },
      update: {
        title: proposal.title,
        bodyMd: proposal.bodyMd,
        acceptedAt: proposal.decidedAt ?? new Date(),
        circleId: proposal.circleId,
      },
      create: {
        workspaceId: proposal.workspaceId,
        proposalId: proposal.id,
        title: proposal.title,
        bodyMd: proposal.bodyMd,
        acceptedAt: proposal.decidedAt ?? new Date(),
        circleId: proposal.circleId,
      },
    });
    await recordArtifactInputLineage({ tx, actor, workspaceId: proposal.workspaceId,
      artifact: { kind: "PolicyCorpus", id: policy.id }, content: policy, origin: "DERIVED",
      inputs: [{ kind: "Proposal", id: proposal.id }] });
  }

  if (params.status === "REJECTED" && params.flow.subjectType === "PROPOSAL") {
    const proposal = await tx.proposal.update({
      where: { id: params.flow.subjectId },
      data: {
        status: "RESOLVED",
        resolutionOutcome: "NOT_ADOPTED",
        decidedAt: new Date(),
        decisionMd: approvalDecisionMd({
          mode: params.flow.mode,
          status: "REJECTED",
          outcome: params.outcome,
          eligibleApprovers: params.eligibleApprovers,
          openObjections: params.openObjections,
          closesAt: params.flow.closesAt,
        }),
      },
    });
    await recordArtifactInputLineage({ tx, actor, workspaceId: proposal.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, content: proposal, origin: "DERIVED",
      inputs: [{ kind: "ApprovalFlow", id: params.flow.id }], inheritedRoots: previousRoots });
  }

}

async function finalizeApprovalFlow(tx: Prisma.TransactionClient, params: {
  actor: AppActor;
  roots: LineageRoot[];
  flow: LoadedFlow;
  nextStatus: "APPROVED" | "REJECTED";
  outcome: ApprovalOutcome;
  eligibleApprovers: number;
  actorUserId?: string | null;
  finalizedBy: "decision" | "expiry";
}) {
  if (params.flow.subjectType === "PROPOSAL") {
    await acquireWorkItemAdvisoryLock(tx, "Proposal", params.flow.subjectId);
    if (params.nextStatus === "APPROVED") {
      await acquireConstitutionCorpusAdvisoryLock(tx, params.flow.workspaceId);
    }
  }

  await writeFlowOutcome(tx, params.actor, params.flow, params.roots, {
      status: params.nextStatus,
      closedAt: new Date(),
      resultJson: params.outcome as Prisma.InputJsonValue,
  });

  await applySubjectOutcome(tx, params.actor, {
    flow: params.flow,
    status: params.nextStatus,
    outcome: params.outcome,
    eligibleApprovers: params.eligibleApprovers,
    openObjections: params.flow.objections.length,
  });

  await tx.auditLog.create({
    data: {
      workspaceId: params.flow.workspaceId,
      actorUserId: params.actorUserId ?? null,
      action: "approval.finalized",
      entityType: "ApprovalFlow",
      entityId: params.flow.id,
      meta: {
        nextStatus: params.nextStatus,
        subjectType: params.flow.subjectType,
        subjectId: params.flow.subjectId,
        finalizedBy: params.finalizedBy,
      },
    },
  });

  await appendEvents(tx, [
    {
      workspaceId: params.flow.workspaceId,
      type: "approval.finalized",
      aggregateType: "ApprovalFlow",
      aggregateId: params.flow.id,
      payload: {
        flowId: params.flow.id,
        nextStatus: params.nextStatus,
        finalizedBy: params.finalizedBy,
      },
    },
    {
      workspaceId: params.flow.workspaceId,
      type: `${params.flow.subjectType.toLowerCase()}.${params.nextStatus.toLowerCase()}`,
      aggregateType: params.flow.subjectType,
      aggregateId: params.flow.subjectId,
      payload: {
        subjectId: params.flow.subjectId,
        flowId: params.flow.id,
        outcome: params.nextStatus,
      } as Prisma.InputJsonValue,
    },
  ]);
}

export async function getApprovalPolicy(workspaceId: string, subjectType: string) {
  const policy = await prisma.approvalPolicy.findUnique({
    where: {
      workspaceId_subjectType: {
        workspaceId,
        subjectType,
      },
    },
  });

  invariant(policy, 404, "NOT_FOUND", `Missing approval policy for ${subjectType}.`);
  return policy;
}

export async function ensureApprovalFlow(tx: Prisma.TransactionClient, params: {
  actor?: AppActor;
  workspaceId: string;
  subjectType: string;
  subjectId: string;
  policy: ApprovalPolicy;
  createdByUserId?: string | null;
}) {
  const existing = await tx.approvalFlow.findUnique({
    where: {
      subjectType_subjectId: {
        subjectType: params.subjectType,
        subjectId: params.subjectId,
      },
    },
  });

  if (existing) {
    return existing;
  }

  const flow = await tx.approvalFlow.create({
    data: {
      workspaceId: params.workspaceId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      mode: params.policy.mode,
      quorumPercent: params.policy.quorumPercent,
      minApproverCount: params.policy.minApproverCount,
      createdByUserId: params.createdByUserId ?? null,
    },
  });
  if (params.actor && ["PROPOSAL", "ACTION", "TENSION"].includes(params.subjectType)) {
    const roots = await approvalSubjectRoots(tx, params.actor, flow);
    await recordArtifactInputLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
      artifact: { kind: "ApprovalFlow", id: flow.id }, content: flow, origin: "DERIVED",
      inputs: [{ kind: "ApprovalPolicy", id: params.policy.id }], inheritedRoots: roots });
  } else {
    await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
      artifact: { kind: "ApprovalFlow", id: flow.id }, content: flow });
  }
  return flow;

}

async function activeApprovalFlowsForWorkspace(workspaceId: string) {
  return prisma.approvalFlow.findMany({
    where: { workspaceId, status: "ACTIVE" },
    include: {
      decisions: true,
      objections: { where: { resolvedAt: null } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function listActionableApprovalFlows(
  actor: AppActor,
  workspaceId: string,
  opts?: { take?: number; skip?: number },
) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const flows = await activeApprovalFlowsForWorkspace(workspaceId);
  const proposalIds = flows
    .filter((flow) => flow.subjectType === "PROPOSAL")
    .map((flow) => flow.subjectId);
  const proposals = proposalIds.length > 0
    ? await prisma.proposal.findMany({
      where: { id: { in: proposalIds } },

    })
    : [];

  const permittedProposalIds = await readableArtifactIds(actor, workspaceId, "Proposal", proposals);
  const proposalById = new Map(proposals.filter((row) => permittedProposalIds.has(row.id)).map((proposal) => [proposal.id, proposal]));
  const actionable: ActionableApprovalFlow[] = [];

  for (const flow of flows) {
    if (!await approvalInputsReadable(actor, workspaceId, flow)) continue;
    if (flow.subjectType === "PROPOSAL") {
      const proposal = proposalById.get(flow.subjectId);
      if (!proposal || proposal.archivedAt || proposal.status !== "OPEN" || proposal.isPrivate) {
        continue;
      }
      actionable.push({ ...flow, subjectLabel: proposal.title });
    }
  }

  const skip = opts?.skip ?? 0;
  const take = opts?.take ?? 20;

  return {
    items: actionable.slice(skip, skip + take),
    total: actionable.length,
    take,
    skip,
  };
}

export async function listProposalDecisionStates(
  actor: AppActor,
  params: {
    workspaceId: string;
    proposalIds: string[];
  },
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  const proposalIds = Array.from(new Set(params.proposalIds.filter(Boolean)));
  if (proposalIds.length === 0) {
    return new Map<string, ProposalDecisionState>();
  }

  const [eligibleMembers, flows, proposals] = await Promise.all([
    prisma.member.findMany({
      where: { workspaceId: params.workspaceId, isActive: true, ...humanMemberIdentityWhere() },
      include: { user: true },
      orderBy: { joinedAt: "asc" },
    }),
    prisma.approvalFlow.findMany({
      where: {
        workspaceId: params.workspaceId,
        subjectType: "PROPOSAL",
        subjectId: { in: proposalIds },
        status: "ACTIVE",
      },
      include: {
        decisions: true,
        objections: {
          where: {
            resolvedAt: null,
          },
          include: {
            user: {
              select: {
                displayName: true,
                email: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.proposal.findMany({
      where: {
        workspaceId: params.workspaceId,
        id: { in: proposalIds },
      },
    }),
  ]);

  const states = new Map<string, ProposalDecisionState>();
  const permittedIds = await readableArtifactIds(actor, params.workspaceId, "Proposal", proposals);
  const proposalAuthorById = new Map(proposals.filter((row) => permittedIds.has(row.id)).map((proposal) => [proposal.id, proposal.authorUserId]));
  const actorUserId = actor.kind === "user" ? actor.user.id : null;

  for (const flow of flows) {
    if (!permittedIds.has(flow.subjectId) || !await approvalInputsReadable(actor, params.workspaceId, flow)) continue;
    const authorUserId = proposalAuthorById.get(flow.subjectId);
    const reviewers = eligibleMembers
      .filter((member) => !authorUserId || member.userId !== authorUserId)
      .map((member) => ({
        memberId: member.id,
        name: member.user?.displayName || member.user?.email || "Member",
        choice: flow.decisions.find((decision) => decision.memberId === member.id)?.choice ?? null,
        hasOpenObjection: flow.objections.some((objection) => objection.userId === member.userId),
      }));
    const eligibleIds = reviewers.map((reviewer) => reviewer.memberId);
    const outcome = calculateApprovalOutcome({
      mode: flow.mode,
      quorumPercent: flow.quorumPercent,
      minApproverCount: flow.minApproverCount,
      decisions: flow.decisions.filter((decision) => eligibleIds.includes(decision.memberId)),
      eligibleApprovers: eligibleIds.length,
      openObjections: flow.objections.length,
    });
    const isProposalAuthor = actorUserId !== null && authorUserId === actorUserId;
    const reviewMembership = membership && eligibleIds.includes(membership.id) && !isProposalAuthor ? membership : null;
    const currentMemberDecision = reviewMembership
      ? flow.decisions.find((decision) => decision.memberId === reviewMembership.id) ?? null
      : null;
    const currentUserOpenObjection = reviewMembership
      ? flow.objections.find((objection) => objection.userId === reviewMembership.userId) ?? null
      : null;
    const needsReview = Boolean(
      reviewMembership
      && (flow.mode === "CONSENT"
        ? !currentMemberDecision && !currentUserOpenObjection
        : !currentMemberDecision),
    );

    states.set(flow.subjectId, {
      proposalId: flow.subjectId,
      flowId: flow.id,
      mode: flow.mode,
      openedAt: flow.openedAt,
      closesAt: flow.closesAt,
      quorumPercent: flow.quorumPercent,
      minApproverCount: flow.minApproverCount,
      eligibleApprovers: eligibleIds.length,
      reviewers,
      outcome,
      currentMemberDecision: currentMemberDecision
        ? {
          choice: currentMemberDecision.choice,
          rationale: currentMemberDecision.rationale,
          updatedAt: currentMemberDecision.updatedAt,
        }
        : null,
      openObjections: flow.objections,
      currentUserOpenObjectionId: currentUserOpenObjection?.id ?? null,
      canReview: Boolean(reviewMembership),
      needsReview,
    });
  }

  return states;
}

/** Keep immutable history before a workflow reset clears its live review rows. */
export async function preserveApprovalFlowHistory(tx: Prisma.TransactionClient, actor: AppActor,
  workspaceId: string, flow: ApprovalFlow) {
  const [decisions, objections] = await Promise.all([
    tx.approvalDecision.findMany({ where: { flowId: flow.id } }),
    tx.objection.findMany({ where: { flowId: flow.id } }),
  ]);
  const inputs = [
    { kind: "ApprovalFlow" as const, row: flow },
    ...decisions.map((row) => ({ kind: "ApprovalDecision" as const, row })),
    ...objections.map((row) => ({ kind: "Objection" as const, row })),
  ];
  for (const { kind, row } of inputs) {
    try {
      await captureArtifactInputSnapshotProof(actor, workspaceId,
        { kind, id: row.id, fingerprint: lineageContentFingerprint(kind, row) }, tx);
    } catch (error) {
      if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
      await preserveUnknownArtifactInputSnapshot(tx, workspaceId, { kind, id: row.id }, row);
    }
  }
}

export async function withdrawActiveApprovalFlowForSubject(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  subjectType: string;
  subjectId: string;
  cleanupReason: string;
  actorUserId?: string | null;
  now?: Date;
}) {
  const flow = await tx.approvalFlow.findFirst({
    where: {
      workspaceId: params.workspaceId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      status: "ACTIVE",
    },
  });

  if (!flow) {
    return null;
  }

  // This legacy internal writer has no requester proof. Preserve its prior
  // content as history and make the rewritten result explicitly unknown.
  await preserveUnknownArtifactInputSnapshot(tx, params.workspaceId, { kind: "ApprovalFlow", id: flow.id }, flow);
  const closedAt = params.now ?? new Date();
  const updated = await tx.approvalFlow.updateMany({
    where: {
      id: flow.id,
      status: "ACTIVE",
    },
    data: {
      status: "WITHDRAWN",
      closedAt,
      resultJson: {
        cleanupReason: params.cleanupReason,
        subjectType: params.subjectType,
        subjectId: params.subjectId,
        withdrawnAt: closedAt.toISOString(),
      } as Prisma.InputJsonValue,
    },
  });

  if (updated.count === 0) {
    return null;
  }

  const after = await tx.approvalFlow.findFirst({ where: { id: flow.id, workspaceId: params.workspaceId } });
  invariant(after, 409, "SOURCE_CHANGED", "Approval flow changed during withdrawal.");
  await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
    artifact: { kind: "ApprovalFlow", id: flow.id }, content: after });

  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId ?? null,
      action: "approval.withdrawn",
      entityType: "ApprovalFlow",
      entityId: flow.id,
      meta: {
        cleanupReason: params.cleanupReason,
        subjectType: params.subjectType,
        subjectId: params.subjectId,
      },
    },
  });

  return { id: flow.id, workspaceId: flow.workspaceId, subjectType: flow.subjectType, subjectId: flow.subjectId };
}

export async function recordApprovalDecision(actor: AppActor, params: {
  workspaceId: string;
  flowId: string;
  choice: ApprovalDecisionChoice;
  rationale?: string | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(membership, 403, "FORBIDDEN", "Agents cannot submit approval decisions.");
  const actorUserId = membership.userId;

  return prisma.$transaction(async (tx) => {
    const current = await loadFlow(tx, params.flowId);

    invariant(current && current.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Approval flow not found.");
    invariant(current.status === "ACTIVE", 400, "INVALID_STATE", "Approval flow is not active.");
    invariant(await approvalInputsReadable(actor, params.workspaceId, current, tx), 409, "UNKNOWN_LINEAGE", "Approval inputs cannot be verified.");
    const subjectRoots = await approvalSubjectRoots(tx, actor, current);
    await assertProposalAuthorCanReview(tx, current, actorUserId);
    assertConsentWindowOpen(current);
    validateDecisionChoice(current.mode, params.choice);
    const approverIds = await eligibleApproverIds(tx, params.workspaceId, await proposalAuthorUserIdForFlow(tx, current));
    invariant(approverIds.includes(membership.id), 403, "FORBIDDEN", "Only active reviewers can submit a decision.");

    const previousDecision = current.decisions.find((decision) => decision.memberId === membership.id);
    if (previousDecision) await captureArtifactInputSnapshotProof(actor, params.workspaceId,
      { kind: "ApprovalDecision", id: previousDecision.id, fingerprint: lineageContentFingerprint("ApprovalDecision", previousDecision) }, tx);

    const decision = await tx.approvalDecision.upsert({
      where: {
        flowId_memberId: {
          flowId: current.id,
          memberId: membership.id,
        },
      },
      update: {
        choice: params.choice,
        rationale: params.rationale?.trim() || null,
      },
      create: {
        flowId: current.id,
        memberId: membership.id,
        choice: params.choice,
        rationale: params.rationale?.trim() || null,
      },
    });

    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "ApprovalDecision", id: decision.id }, content: decision,
      origin: "DERIVED", inputs: [], inheritedRoots: subjectRoots });

    const flow = await loadFlow(tx, current.id);
    invariant(flow, 404, "NOT_FOUND", "Approval flow not found.");

    const outcome = calculateApprovalOutcome({
      mode: flow.mode,
      quorumPercent: flow.quorumPercent,
      minApproverCount: flow.minApproverCount,
      decisions: eligibleFlowDecisions(flow, approverIds),
      eligibleApprovers: approverIds.length,
      openObjections: flow.objections.length,
    });

    const roots = await outcomeInputRoots(tx, actor, flow, approverIds);
    let nextStatus: ApprovalFlowStatus = flow.status;

    if (flow.subjectType === "PROPOSAL") {
      await writeFlowOutcome(tx, actor, flow, roots, { resultJson: outcome as Prisma.InputJsonValue });
    } else if (flow.mode !== "CONSENT") {
      if (outcome.approved) {
        nextStatus = "APPROVED";
        await finalizeApprovalFlow(tx, {
          actor, roots, flow,
          nextStatus: "APPROVED",
          outcome,
          eligibleApprovers: approverIds.length,
          actorUserId,
          finalizedBy: "decision",
        });
      } else if (
        (flow.mode === "SINGLE" && flow.decisions.some((decision) => decision.choice === "REJECT" || decision.choice === "BLOCK")) ||
        (flow.mode !== "SINGLE" && flow.decisions.length >= Math.max(flow.minApproverCount, approverIds.length))
      ) {
        nextStatus = "REJECTED";
        await finalizeApprovalFlow(tx, {
          actor, roots, flow,
          nextStatus: "REJECTED",
          outcome,
          eligibleApprovers: approverIds.length,
          actorUserId,
          finalizedBy: "decision",
        });
      } else {
        await writeFlowOutcome(tx, actor, flow, roots, { resultJson: outcome as Prisma.InputJsonValue });
      }
    } else {
      await writeFlowOutcome(tx, actor, flow, roots, { resultJson: outcome as Prisma.InputJsonValue });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId,
        action: "approval.decision_recorded",
        entityType: "ApprovalFlow",
        entityId: flow.id,
        meta: {
          choice: params.choice,
          nextStatus,
          subjectType: flow.subjectType,
          subjectId: flow.subjectId,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "approval.decision_recorded",
        aggregateType: "ApprovalFlow",
        aggregateId: flow.id,
        payload: {
          flowId: flow.id,
          choice: params.choice,
          nextStatus,
        },
      },
    ]);

    return {
      flowId: flow.id,
      status: nextStatus,
      closesAt: flow.closesAt,
      outcome,
    };
  });
}

export async function createObjection(actor: AppActor, params: {
  workspaceId: string;
  flowId: string;
  bodyMd: string;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(membership, 403, "FORBIDDEN", "Agents cannot object to approvals.");
  const bodyMd = params.bodyMd.trim();
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Objection body is required.");

  return prisma.$transaction(async (tx) => {
    const flow = await loadFlow(tx, params.flowId);

    invariant(flow && flow.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Approval flow not found.");
    invariant(await approvalInputsReadable(actor, params.workspaceId, flow, tx), 409, "UNKNOWN_LINEAGE", "Approval inputs cannot be verified.");
    invariant(flow.status === "ACTIVE", 400, "INVALID_STATE", "Approval flow is not active.");
    invariant(flow.mode === "CONSENT", 400, "INVALID_STATE", "Objections are only supported on consent flows.");
    await assertProposalAuthorCanReview(tx, flow, membership.userId);
    assertConsentWindowOpen(flow);
    const approverIds = await eligibleApproverIds(tx, params.workspaceId, await proposalAuthorUserIdForFlow(tx, flow));
    invariant(approverIds.includes(membership.id), 403, "FORBIDDEN", "Only active reviewers can object.");

    const existing = await tx.objection.findFirst({
      where: {
        flowId: flow.id,
        userId: membership.userId,
        resolvedAt: null,
      },
      select: {
        id: true,
      },
    });
    invariant(!existing, 409, "ALREADY_EXISTS", "You already have an open objection on this flow.");

    const subjectRoots = await approvalSubjectRoots(tx, actor, flow);
    const objection = await tx.objection.create({
      data: {
        flowId: flow.id,
        userId: membership.userId,
        bodyMd,
      },
    });

    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Objection", id: objection.id }, content: objection,
      origin: "DERIVED", inputs: [], inheritedRoots: subjectRoots });

    const refreshed = await loadFlow(tx, flow.id);
    invariant(refreshed, 404, "NOT_FOUND", "Approval flow not found.");
    const outcome = calculateApprovalOutcome({
      mode: refreshed.mode,
      quorumPercent: refreshed.quorumPercent,
      minApproverCount: refreshed.minApproverCount,
      decisions: eligibleFlowDecisions(refreshed, approverIds),
      eligibleApprovers: approverIds.length,
      openObjections: refreshed.objections.length,
    });

    const roots = await outcomeInputRoots(tx, actor, refreshed, approverIds);
    await writeFlowOutcome(tx, actor, refreshed, roots, { resultJson: outcome as Prisma.InputJsonValue });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: membership.userId,
        action: "approval.objection_created",
        entityType: "ApprovalFlow",
        entityId: flow.id,
        meta: {
          objectionId: objection.id,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "approval.objection_created",
        aggregateType: "ApprovalFlow",
        aggregateId: flow.id,
        payload: {
          flowId: flow.id,
          objectionId: objection.id,
        },
      },
    ]);

    return {
      objection,
      flowId: flow.id,
      status: flow.status,
      closesAt: flow.closesAt,
      outcome,
    };
  });
}

export async function resolveObjection(actor: AppActor, params: {
  workspaceId: string;
  flowId: string;
  objectionId: string;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(membership, 403, "FORBIDDEN", "Agents cannot resolve objections.");

  return prisma.$transaction(async (tx) => {
    const flow = await loadFlow(tx, params.flowId);

    invariant(flow && flow.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Approval flow not found.");
    invariant(await approvalInputsReadable(actor, params.workspaceId, flow, tx), 409, "UNKNOWN_LINEAGE", "Approval inputs cannot be verified.");
    invariant(flow.status === "ACTIVE", 400, "INVALID_STATE", "Approval flow is not active.");
    invariant(flow.mode === "CONSENT", 400, "INVALID_STATE", "Objections are only supported on consent flows.");
    assertConsentWindowOpen(flow);

    const objection = await tx.objection.findUnique({
      where: { id: params.objectionId },
    });

    invariant(objection && objection.flowId === flow.id, 404, "NOT_FOUND", "Objection not found.");
    invariant(!objection.resolvedAt, 400, "INVALID_STATE", "Objection has already been resolved.");

    const canResolve =
      objection.userId === membership.userId ||
      membership.role === "FACILITATOR" ||
      membership.role === "ADMIN";

    invariant(canResolve, 403, "FORBIDDEN", "You cannot resolve this objection.");

    await captureArtifactInputSnapshotProof(actor, params.workspaceId,
      { kind: "Objection", id: objection.id, fingerprint: lineageContentFingerprint("Objection", objection) }, tx);
    const updatedObjection = await tx.objection.update({
      where: { id: objection.id },
      data: {
        resolvedAt: new Date(),
      },
    });

    await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Objection", id: objection.id }, before: objection, after: updatedObjection });

    const refreshed = await loadFlow(tx, flow.id);
    invariant(refreshed, 404, "NOT_FOUND", "Approval flow not found.");
    const approverIds = await eligibleApproverIds(tx, params.workspaceId, await proposalAuthorUserIdForFlow(tx, refreshed));
    const outcome = calculateApprovalOutcome({
      mode: refreshed.mode,
      quorumPercent: refreshed.quorumPercent,
      minApproverCount: refreshed.minApproverCount,
      decisions: eligibleFlowDecisions(refreshed, approverIds),
      eligibleApprovers: approverIds.length,
      openObjections: refreshed.objections.length,
    });

    const roots = await outcomeInputRoots(tx, actor, refreshed, approverIds);
    roots.push(...await captureArtifactInputProof(actor, params.workspaceId,
      [{ kind: "Objection", id: updatedObjection.id, snapshot: updatedObjection }], tx));
    await writeFlowOutcome(tx, actor, refreshed, roots, { resultJson: outcome as Prisma.InputJsonValue });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: membership.userId,
        action: "approval.objection_resolved",
        entityType: "ApprovalFlow",
        entityId: flow.id,
        meta: {
          objectionId: objection.id,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "approval.objection_resolved",
        aggregateType: "ApprovalFlow",
        aggregateId: flow.id,
        payload: {
          flowId: flow.id,
          objectionId: objection.id,
        },
      },
    ]);

    return {
      flowId: flow.id,
      status: flow.status,
      closesAt: flow.closesAt,
      outcome,
    };
  });
}

export async function finalizeExpiredApprovalFlows(batchSize = EXPIRING_FLOW_BATCH_SIZE) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT flow.id
      FROM "ApprovalFlow" AS flow
      WHERE flow.status = 'ACTIVE'
        AND flow.mode = 'CONSENT'
        AND flow."subjectType" <> 'PROPOSAL'
        AND flow."closesAt" IS NOT NULL
        AND flow."closesAt" <= NOW()
        AND NOT EXISTS (
          SELECT 1 FROM "WorkspaceFeatureFlag" AS flag
          WHERE flag."workspaceId" = flow."workspaceId"
            AND flag.flag = 'operator_import_inactive'
            AND flag.enabled = true
        )
      ORDER BY flow."closesAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;

    let finalized = 0;

    for (const row of rows) {
      const flow = await loadFlow(tx, row.id);
      if (!flow || flow.status !== "ACTIVE" || flow.mode !== "CONSENT" || flow.subjectType === "PROPOSAL") {
        continue;
      }

      const actor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "approval-resolution", workspaceIds: [flow.workspaceId] };
      if (!await approvalInputsReadable(actor, flow.workspaceId, flow, tx)) continue;
      const approverIds = await eligibleApproverIds(tx, flow.workspaceId);
      const outcome = calculateApprovalOutcome({
        mode: flow.mode,
        quorumPercent: flow.quorumPercent,
        minApproverCount: flow.minApproverCount,
        decisions: flow.decisions,
        eligibleApprovers: approverIds.length,
        openObjections: flow.objections.length,
      });

      const roots = await outcomeInputRoots(tx, actor, flow, approverIds);
      await finalizeApprovalFlow(tx, {
        actor, roots, flow,
        nextStatus: outcome.approved ? "APPROVED" : "REJECTED",
        outcome,
        eligibleApprovers: approverIds.length,
        actorUserId: null,
        finalizedBy: "expiry",
      });

      finalized += 1;
    }

    return finalized;
  });
}
