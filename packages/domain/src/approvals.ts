import type {
  ApprovalDecisionChoice,
  ApprovalFlow,
  ApprovalFlowStatus,
  ApprovalMode,
  ApprovalPolicy,
  MemberRole,
  Prisma,
} from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";

type DecisionSummary = {
  approve: number;
  reject: number;
  abstain: number;
  agree: number;
  block: number;
};

type ApprovalOutcome = {
  approved: boolean;
  quorumMet: boolean;
  minApproverCountMet: boolean;
  participationPercent: number;
  summary: DecisionSummary;
};

type LoadedFlow = ApprovalFlow & {
  decisions: Array<{
    choice: ApprovalDecisionChoice;
  }>;
  objections: Array<{
    id: string;
    userId: string;
    bodyMd: string;
    createdAt: Date;
    resolvedAt: Date | null;
  }>;
};

const EXPIRING_FLOW_BATCH_SIZE = 25;

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

async function eligibleApproverIds(tx: Prisma.TransactionClient, workspaceId: string, subjectType: string): Promise<string[]> {
  let roles: MemberRole[] | undefined;

  if (subjectType === "SPEND") {
    roles = ["FINANCE_STEWARD", "ADMIN"];
  }

  const members = await tx.member.findMany({
    where: {
      workspaceId,
      isActive: true,
      role: roles ? { in: roles } : undefined,
    },
    select: {
      id: true,
    },
  });

  return members.map((member) => member.id);
}

async function loadFlow(tx: Prisma.TransactionClient, flowId: string) {
  return tx.approvalFlow.findUnique({
    where: { id: flowId },
    include: {
      decisions: {
        select: {
          choice: true,
        },
      },
      objections: {
        where: {
          resolvedAt: null,
        },
        select: {
          id: true,
          userId: true,
          bodyMd: true,
          createdAt: true,
          resolvedAt: true,
        },
      },
    },
  });
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

async function applySubjectOutcome(tx: Prisma.TransactionClient, params: {
  flow: ApprovalFlow;
  status: "APPROVED" | "REJECTED";
  outcome: ApprovalOutcome;
  eligibleApprovers: number;
  openObjections: number;
}) {
  if (params.status === "APPROVED" && params.flow.subjectType === "PROPOSAL") {
    const proposal = await tx.proposal.update({
      where: { id: params.flow.subjectId },
      data: {
        status: "APPROVED",
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

    await tx.policyCorpus.upsert({
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
  }

  if (params.status === "REJECTED" && params.flow.subjectType === "PROPOSAL") {
    await tx.proposal.update({
      where: { id: params.flow.subjectId },
      data: {
        status: "REJECTED",
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
  }

  if (params.status === "APPROVED" && params.flow.subjectType === "SPEND") {
    await tx.spendRequest.update({
      where: { id: params.flow.subjectId },
      data: { status: "APPROVED" },
    });
  }

  if (params.status === "REJECTED" && params.flow.subjectType === "SPEND") {
    await tx.spendRequest.update({
      where: { id: params.flow.subjectId },
      data: { status: "REJECTED" },
    });
  }
}

async function finalizeApprovalFlow(tx: Prisma.TransactionClient, params: {
  flow: LoadedFlow;
  nextStatus: "APPROVED" | "REJECTED";
  outcome: ApprovalOutcome;
  eligibleApprovers: number;
  actorUserId?: string | null;
  finalizedBy: "decision" | "expiry";
}) {
  await tx.approvalFlow.update({
    where: { id: params.flow.id },
    data: {
      status: params.nextStatus,
      closedAt: new Date(),
      resultJson: params.outcome as Prisma.InputJsonValue,
    },
  });

  await applySubjectOutcome(tx, {
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

  return tx.approvalFlow.create({
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
    assertConsentWindowOpen(current);
    validateDecisionChoice(current.mode, params.choice);

    await tx.approvalDecision.upsert({
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

    const flow = await loadFlow(tx, current.id);
    invariant(flow, 404, "NOT_FOUND", "Approval flow not found.");

    const approverIds = await eligibleApproverIds(tx, params.workspaceId, flow.subjectType);
    const outcome = calculateApprovalOutcome({
      mode: flow.mode,
      quorumPercent: flow.quorumPercent,
      minApproverCount: flow.minApproverCount,
      decisions: flow.decisions,
      eligibleApprovers: approverIds.length,
      openObjections: flow.objections.length,
    });

    let nextStatus: ApprovalFlowStatus = flow.status;

    if (flow.mode !== "CONSENT") {
      if (outcome.approved) {
        nextStatus = "APPROVED";
        await finalizeApprovalFlow(tx, {
          flow,
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
          flow,
          nextStatus: "REJECTED",
          outcome,
          eligibleApprovers: approverIds.length,
          actorUserId,
          finalizedBy: "decision",
        });
      } else {
        await tx.approvalFlow.update({
          where: { id: flow.id },
          data: {
            resultJson: outcome as Prisma.InputJsonValue,
          },
        });
      }
    } else {
      await tx.approvalFlow.update({
        where: { id: flow.id },
        data: {
          resultJson: outcome as Prisma.InputJsonValue,
        },
      });
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
    invariant(flow.status === "ACTIVE", 400, "INVALID_STATE", "Approval flow is not active.");
    invariant(flow.mode === "CONSENT", 400, "INVALID_STATE", "Objections are only supported on consent flows.");
    assertConsentWindowOpen(flow);

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

    const objection = await tx.objection.create({
      data: {
        flowId: flow.id,
        userId: membership.userId,
        bodyMd,
      },
    });

    const refreshed = await loadFlow(tx, flow.id);
    invariant(refreshed, 404, "NOT_FOUND", "Approval flow not found.");
    const approverIds = await eligibleApproverIds(tx, params.workspaceId, refreshed.subjectType);
    const outcome = calculateApprovalOutcome({
      mode: refreshed.mode,
      quorumPercent: refreshed.quorumPercent,
      minApproverCount: refreshed.minApproverCount,
      decisions: refreshed.decisions,
      eligibleApprovers: approverIds.length,
      openObjections: refreshed.objections.length,
    });

    await tx.approvalFlow.update({
      where: { id: flow.id },
      data: {
        resultJson: outcome as Prisma.InputJsonValue,
      },
    });

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
    invariant(flow.status === "ACTIVE", 400, "INVALID_STATE", "Approval flow is not active.");
    invariant(flow.mode === "CONSENT", 400, "INVALID_STATE", "Objections are only supported on consent flows.");
    assertConsentWindowOpen(flow);

    const objection = await tx.objection.findUnique({
      where: { id: params.objectionId },
      select: {
        id: true,
        flowId: true,
        userId: true,
        resolvedAt: true,
      },
    });

    invariant(objection && objection.flowId === flow.id, 404, "NOT_FOUND", "Objection not found.");
    invariant(!objection.resolvedAt, 400, "INVALID_STATE", "Objection has already been resolved.");

    const canResolve =
      objection.userId === membership.userId ||
      membership.role === "FACILITATOR" ||
      membership.role === "ADMIN";

    invariant(canResolve, 403, "FORBIDDEN", "You cannot resolve this objection.");

    await tx.objection.update({
      where: { id: objection.id },
      data: {
        resolvedAt: new Date(),
      },
    });

    const refreshed = await loadFlow(tx, flow.id);
    invariant(refreshed, 404, "NOT_FOUND", "Approval flow not found.");
    const approverIds = await eligibleApproverIds(tx, params.workspaceId, refreshed.subjectType);
    const outcome = calculateApprovalOutcome({
      mode: refreshed.mode,
      quorumPercent: refreshed.quorumPercent,
      minApproverCount: refreshed.minApproverCount,
      decisions: refreshed.decisions,
      eligibleApprovers: approverIds.length,
      openObjections: refreshed.objections.length,
    });

    await tx.approvalFlow.update({
      where: { id: flow.id },
      data: {
        resultJson: outcome as Prisma.InputJsonValue,
      },
    });

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
        AND flow."closesAt" IS NOT NULL
        AND flow."closesAt" <= NOW()
      ORDER BY flow."closesAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;

    let finalized = 0;

    for (const row of rows) {
      const flow = await loadFlow(tx, row.id);
      if (!flow || flow.status !== "ACTIVE" || flow.mode !== "CONSENT") {
        continue;
      }

      const approverIds = await eligibleApproverIds(tx, flow.workspaceId, flow.subjectType);
      const outcome = calculateApprovalOutcome({
        mode: flow.mode,
        quorumPercent: flow.quorumPercent,
        minApproverCount: flow.minApproverCount,
        decisions: flow.decisions,
        eligibleApprovers: approverIds.length,
        openObjections: flow.objections.length,
      });

      await finalizeApprovalFlow(tx, {
        flow,
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
