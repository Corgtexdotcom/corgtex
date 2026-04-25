import type { AppActor } from "@corgtex/shared";
import { prisma, logger } from "@corgtex/shared";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { getApprovalPolicy, ensureApprovalFlow } from "./approvals";
import { invariant } from "./errors";
import { privacyFilter } from "./privacy";

export async function listProposals(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number; circleId?: string | null }) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const where: any = { workspaceId, ...privacyFilter(actor, membership) };
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

export async function createProposal(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  summary?: string | null;
  bodyMd: string;
  circleId?: string | null;
  isPrivate?: boolean;
  meetingId?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const title = params.title.trim();
  const bodyMd = params.bodyMd.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Proposal title is required.");
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Proposal body is required.");
  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title,
        summary: params.summary?.trim() || null,
        bodyMd,
        circleId: params.circleId || null,
        isPrivate: params.isPrivate ?? false,
        meetingId: params.meetingId || null,
        publishedAt: params.isPrivate ? null : new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.created",
        entityType: "Proposal",
        entityId: proposal.id,
        meta: { title: proposal.title },
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
  bodyMd?: string;
  circleId?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "DRAFT", 400, "INVALID_STATE", "Only draft proposals can be edited.");

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
    if (params.summary !== undefined) data.summary = params.summary?.trim() || null;
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

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(
      proposal.status === "DRAFT" || proposal.status === "APPROVED" || proposal.status === "REJECTED",
      400,
      "INVALID_STATE",
      "Only draft, approved, or rejected proposals can be archived.",
    );

    const updated = await tx.proposal.update({
      where: { id: params.proposalId },
      data: { status: "ARCHIVED" },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.archived",
        entityType: "Proposal",
        entityId: updated.id,
        meta: {},
      },
    });

    return updated;
  });
}

export async function submitProposal(actor: AppActor, params: { workspaceId: string; proposalId: string; autoApproveHours?: number }) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const policy = await getApprovalPolicy(params.workspaceId, "PROPOSAL");

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "DRAFT", 400, "INVALID_STATE", "Only draft proposals can be submitted.");

    const flow = await ensureApprovalFlow(tx, {
      workspaceId: params.workspaceId,
      subjectType: "PROPOSAL",
      subjectId: proposal.id,
      policy,
      createdByUserId: actor.kind === "user" ? actor.user.id : null,
    });

    const autoApproveAt = params.autoApproveHours ? new Date(Date.now() + params.autoApproveHours * 60 * 60 * 1000) : null;

    await tx.proposal.update({
      where: { id: proposal.id },
      data: {
        status: "SUBMITTED",
        isPrivate: false,
        publishedAt: proposal.publishedAt || new Date(),
        autoApproveAt,
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
        action: "proposal.submitted",
        entityType: "Proposal",
        entityId: proposal.id,
        meta: { flowId: flow.id },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "proposal.submitted",
        aggregateType: "Proposal",
        aggregateId: proposal.id,
        payload: {
          proposalId: proposal.id,
          flowId: flow.id,
        },
      },
    ]);

    return {
      proposalId: proposal.id,
      flowId: flow.id,
    };
  });
}

export async function publishProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.isPrivate, 400, "INVALID_STATE", "Proposal is already public.");
    invariant(actor.kind === "user" && proposal.authorUserId === actor.user.id, 403, "FORBIDDEN", "Only the author can publish this proposal.");

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

export async function autoApproveProposals(): Promise<number> {
  const now = new Date();
  
  const proposalsToApprove = await prisma.proposal.findMany({
    where: {
      status: "SUBMITTED",
      autoApproveAt: { lt: now, not: null },
      reactions: {
        none: {
          reaction: "OBJECTION",
          resolvedAt: null
        }
      }
    },
    select: { id: true, workspaceId: true }
  });

  if (proposalsToApprove.length === 0) return 0;

  let approvedCount = 0;
  for (const p of proposalsToApprove) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.proposal.update({
          where: { id: p.id },
          data: { status: "APPROVED", decidedAt: now },
        });

        await tx.auditLog.create({
          data: {
            workspaceId: p.workspaceId,
            action: "proposal.auto_approved",
            entityType: "Proposal",
            entityId: p.id,
          },
        });

        await appendEvents(tx, [
          {
            workspaceId: p.workspaceId,
            type: "proposal.auto_approved",
            aggregateType: "Proposal",
            aggregateId: p.id,
            payload: { proposalId: p.id },
          },
        ]);
      });
      approvedCount++;
    } catch (error) {
      logger.error(`Failed to auto-approve proposal ${p.id}`, { error });
    }
  }
  return approvedCount;
}
export async function deleteProposal(actor: AppActor, params: { workspaceId: string; proposalId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId, workspaceId: params.workspaceId },
    });
    invariant(proposal, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "DRAFT", 400, "INVALID_STATE", "Only draft proposals can be deleted.");
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.deleted",
        entityType: "Proposal",
        entityId: proposal.id,
      },
    });
    return tx.proposal.delete({ where: { id: params.proposalId } });
  });
}
