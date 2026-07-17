import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { Prisma, type ProposalResolutionOutcome, type ProposalStatus } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, isGlobalOperator, requireWorkspaceMembership } from "./auth";
import { getApprovalPolicy, ensureApprovalFlow } from "./approvals";
import { invariant } from "./errors";
import { privacyFilter } from "./privacy";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { requireDraftManager } from "./draft-permissions";
import { humanMemberIdentityWhere } from "./member-identity";
import { createWorkItemEvidenceLinks } from "./work-item-evidence";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";
import {
  changedDataFields,
  pickJsonSnapshot,
  recordWorkItemVersion,
  requireSubmittedWorkItemEditor,
  resolveWorkspaceMemberUserId,
} from "./work-item-versions";

const PROPOSAL_RESOLUTION_OUTCOMES = new Set<ProposalResolutionOutcome>(["ADOPTED", "NOT_ADOPTED", "WITHDRAWN"]);
const AI_SUMMARY_WORD_THRESHOLD = 120;
const SUPPORT_REOPEN_PROPOSALS_LIMIT = 25;
type ProposalApprovalPolicy = Awaited<ReturnType<typeof getApprovalPolicy>>;
type WorkItemSort = "priority" | "date" | "alpha";

type CreateProposalParams = {
  workspaceId: string;
  title: string;
  summary?: string | null;
  includeAiSummary?: boolean;
  bodyMd: string;
  priority?: number | null;
  circleId?: string | null;
  ownerMemberId?: string | null;
  isPrivate?: boolean;
  authorMemberId?: string | null;
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

async function activateProposalApprovalFlow(tx: Prisma.TransactionClient, params: {
  actor: AppActor;
  workspaceId: string;
  proposalId: string;
  policy: ProposalApprovalPolicy;
  openedAt: Date;
}) {
  const flow = await ensureApprovalFlow(tx, {
    workspaceId: params.workspaceId,
    subjectType: "PROPOSAL",
    subjectId: params.proposalId,
    policy: params.policy,
    createdByUserId: params.actor.kind === "user" ? params.actor.user.id : null,
  });

  await tx.approvalFlow.update({
    where: { id: flow.id },
    data: {
      status: "ACTIVE",
      openedAt: params.openedAt,
      closesAt:
        params.policy.mode === "CONSENT"
          ? new Date(params.openedAt.getTime() + params.policy.decisionWindowHours * 60 * 60 * 1000)
          : null,
    },
  });

  return flow;
}

async function recordProposalOpened(tx: Prisma.TransactionClient, actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
  proposalTitle: string;
  flowId: string;
}) {
  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      action: "proposal.opened",
      entityType: "Proposal",
      entityId: params.proposalId,
      meta: { flowId: params.flowId },
    },
  });

  await appendEvents(tx, [
    {
      workspaceId: params.workspaceId,
      type: "proposal.opened",
      aggregateType: "Proposal",
      aggregateId: params.proposalId,
      payload: {
        proposalId: params.proposalId,
        flowId: params.flowId,
        title: params.proposalTitle,
      },
    },
  ]);
}

function requireSupportRepairActor(actor: AppActor) {
  if (isGlobalOperator(actor)) return;
  if (actor.kind === "agent" && (actor.authProvider === "bootstrap" || actor.scopes?.includes("support:write"))) return;
  invariant(false, 403, "FORBIDDEN", "Support repair requires a support-scoped actor.");
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
      priority: true,
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

async function resolveProposalOwnerMemberId(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  ownerMemberId?: string | null,
  defaultAuthorUserId?: string | null,
) {
  if (ownerMemberId === undefined) {
    if (!defaultAuthorUserId) return null;
    const defaultOwner = await tx.member.findFirst({
      where: {
        workspaceId,
        userId: defaultAuthorUserId,
        isActive: true,
        ...humanMemberIdentityWhere(),
      },
      select: { id: true },
    });
    return defaultOwner?.id ?? null;
  }

  const normalizedOwnerMemberId = ownerMemberId?.trim();
  if (!normalizedOwnerMemberId) return null;
  const owner = await tx.member.findFirst({
    where: {
      id: normalizedOwnerMemberId,
      workspaceId,
      isActive: true,
      ...humanMemberIdentityWhere(),
    },
    select: { id: true },
  });
  invariant(owner, 400, "INVALID_INPUT", "Proposal owner must be an active human member in the same workspace.");
  return owner.id;
}

export type ListProposalsOptions = {
  take?: number;
  skip?: number;
  circleId?: string | null;
  circleIds?: string[] | null;
  memberId?: string | null;
  memberIds?: string[] | null;
  status?: ProposalStatus;
  archiveFilter?: ArchiveFilter;
  sort?: WorkItemSort;
};

function listFilterValues(values?: readonly (string | null | undefined)[] | null) {
  return [...new Set((values ?? []).map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function memberRelatedProposalWhere(workspaceId: string, memberIds: string[]): Prisma.ProposalWhereInput[] {
  const authorMembershipWhere = {
    memberships: {
      some: {
        id: { in: memberIds },
        workspaceId,
        isActive: true,
      },
    },
  };
  return [
    { author: authorMembershipWhere },
    { ownerMemberId: { in: memberIds } },
    {
      actions: {
        some: {
          OR: [
            { assigneeMemberId: { in: memberIds } },
            { author: authorMembershipWhere },
          ],
        },
      },
    },
    {
      tensions: {
        some: {
          OR: [
            { assigneeMemberId: { in: memberIds } },
            { raisedByMemberId: { in: memberIds } },
            { author: authorMembershipWhere },
          ],
        },
      },
    },
  ];
}

function appendProposalWhereAnd(where: Prisma.ProposalWhereInput, condition: Prisma.ProposalWhereInput) {
  const and = Array.isArray(where.AND) ? [...where.AND] : where.AND ? [where.AND] : [];
  if (where.OR) {
    and.push({ OR: where.OR });
    delete where.OR;
  }
  and.push(condition);
  where.AND = and;
}

function workItemOrderBy(sort: WorkItemSort | undefined): Prisma.ProposalOrderByWithRelationInput[] {
  if (sort === "alpha") {
    return [{ title: "asc" }, { createdAt: "desc" }, { id: "desc" }];
  }
  if (sort === "date") {
    return [{ createdAt: "desc" }, { id: "desc" }];
  }
  return [{ priority: "desc" }, { createdAt: "desc" }, { id: "desc" }];
}

export async function listProposals(actor: AppActor, workspaceId: string, opts?: ListProposalsOptions) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const where: Prisma.ProposalWhereInput = {
    workspaceId,
    ...privacyFilter(actor, membership),
    ...archiveFilterWhere(opts?.archiveFilter),
  };
  const circleIds = listFilterValues(opts?.circleIds);
  if (circleIds.length > 0) {
    where.circleId = { in: circleIds };
  } else if (opts?.circleId !== undefined) {
    where.circleId = opts.circleId;
  }
  if (opts?.status) where.status = opts.status;
  const memberIds = listFilterValues([...(opts?.memberIds ?? []), opts?.memberId]);
  if (memberIds.length > 0) {
    appendProposalWhereAnd(where, { OR: memberRelatedProposalWhere(workspaceId, memberIds) });
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
        ownerMember: {
          include: {
            user: {
              select: {
                displayName: true,
                email: true,
              },
            },
          },
        },
        circle: { select: { id: true, name: true } },
        tensions: { select: { id: true, title: true, status: true } },
        actions: { select: { id: true, title: true, status: true } },
        adviceProcess: {
          include: {
            requests: {
              select: { status: true },
            },
          },
        },
      },
      orderBy: workItemOrderBy(opts?.sort),
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
  includeArchived?: boolean;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const proposal = await prisma.proposal.findFirst({
    where: {
      id: params.proposalId,
      workspaceId: params.workspaceId,
      ...privacyFilter(actor, membership),
      ...(params.includeArchived ? {} : { archivedAt: null }),
    },
    include: {
      author: { select: { id: true, displayName: true, email: true } },
      ownerMember: {
        include: {
          user: {
            select: { displayName: true, email: true },
          },
        },
      },
      circle: { select: { id: true, name: true } },
      tensions: { select: { id: true, title: true, status: true } },
      actions: { select: { id: true, title: true, status: true } },
      adviceProcess: {
        include: {
          requests: {
            select: { status: true },
          },
        },
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
  const summary = params.includeAiSummary === true
    ? await generateProposalSummary({ workspaceId: params.workspaceId, title, bodyMd })
    : params.summary?.trim() || null;
  const isPrivate = params.isPrivate ?? true;
  const openedAt = isPrivate ? null : new Date();
  const policy = isPrivate ? null : await getApprovalPolicy(params.workspaceId, "PROPOSAL");

  return prisma.$transaction(async (tx) => {
    const sourceTension = await loadVisibleSourceTension(tx, actor, membership, params.workspaceId, params.sourceTensionId);
    const relatedActionIds = await validateRelatedActions(tx, actor, membership, params.workspaceId, params.relatedActionIds);
    let authorUserId = actor.kind === "user"
      ? actor.user.id
      : await actorUserIdForWorkspace(actor, params.workspaceId);
    if (actor.kind === "agent" && params.authorMemberId) {
      authorUserId = await resolveWorkspaceMemberUserId(tx, params.workspaceId, params.authorMemberId, "Proposal author must be an active member of this workspace.");
    }
    const ownerMemberId = await resolveProposalOwnerMemberId(tx, params.workspaceId, params.ownerMemberId, authorUserId);
    const proposal = await tx.proposal.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title,
        summary,
        bodyMd,
        priority: params.priority ?? 0,
        ownerMemberId,
        circleId: params.circleId || sourceTension?.circleId || null,
        status: isPrivate ? "DRAFT" : "OPEN",
        isPrivate,
        meetingId: params.meetingId || sourceTension?.meetingId || null,
        publishedAt: openedAt,
        autoApproveAt: null,
      },
    });

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Proposal",
      entityId: proposal.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Proposal", proposal),
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

    if (!isPrivate && policy && openedAt) {
      const flow = await activateProposalApprovalFlow(tx, {
        actor,
        workspaceId: params.workspaceId,
        proposalId: proposal.id,
        policy,
        openedAt,
      });

      await recordProposalOpened(tx, actor, {
        workspaceId: params.workspaceId,
        proposalId: proposal.id,
        proposalTitle: proposal.title,
        flowId: flow.id,
      });
    }

    return proposal;
  });
}

export async function createProposalFromTension(actor: AppActor, params: CreateProposalFromTensionParams) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const isPrivate = params.isPrivate ?? true;
  const openedAt = isPrivate ? null : new Date();
  const policy = isPrivate ? null : await getApprovalPolicy(params.workspaceId, "PROPOSAL");

  return prisma.$transaction(async (tx) => {
    const sourceTension = await loadVisibleSourceTension(tx, actor, membership, params.workspaceId, params.sourceTensionId);
    invariant(sourceTension, 404, "NOT_FOUND", "Source tension not found.");
    const relatedActionIds = await validateRelatedActions(tx, actor, membership, params.workspaceId, params.relatedActionIds);
    const draft = proposalDraftFromTension(sourceTension, params);
    let authorUserId = actor.kind === "user"
      ? actor.user.id
      : await actorUserIdForWorkspace(actor, params.workspaceId);
    if (actor.kind === "agent" && params.authorMemberId) {
      authorUserId = await resolveWorkspaceMemberUserId(tx, params.workspaceId, params.authorMemberId, "Proposal author must be an active member of this workspace.");
    }
    const ownerMemberId = await resolveProposalOwnerMemberId(tx, params.workspaceId, params.ownerMemberId, authorUserId);

    const proposal = await tx.proposal.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title: draft.title,
        summary: draft.summary,
        bodyMd: draft.bodyMd,
        priority: params.priority ?? sourceTension.priority ?? 0,
        ownerMemberId,
        circleId: params.circleId || sourceTension.circleId || null,
        status: isPrivate ? "DRAFT" : "OPEN",
        isPrivate,
        meetingId: params.meetingId || sourceTension.meetingId || null,
        publishedAt: openedAt,
        autoApproveAt: null,
      },
    });

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Proposal",
      entityId: proposal.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Proposal", proposal),
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

    if (!isPrivate && policy && openedAt) {
      const flow = await activateProposalApprovalFlow(tx, {
        actor,
        workspaceId: params.workspaceId,
        proposalId: proposal.id,
        policy,
        openedAt,
      });

      await recordProposalOpened(tx, actor, {
        workspaceId: params.workspaceId,
        proposalId: proposal.id,
        proposalTitle: proposal.title,
        flowId: flow.id,
      });
    }

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
  priority?: number;
  circleId?: string | null;
  ownerMemberId?: string | null;
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
    invariant(!proposal.archivedAt, 400, "INVALID_STATE", "Archived proposals cannot be edited.");
    if (proposal.status === "DRAFT") {
      await requireDraftManager({ actor, workspaceId: params.workspaceId, record: proposal, resolvedMembership: membership });
    } else {
      invariant(proposal.status === "OPEN", 400, "INVALID_STATE", "Only draft or open proposals can be edited.");
      requireSubmittedWorkItemEditor(actor, membership, proposal);
    }

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
    if (params.priority !== undefined) data.priority = params.priority;
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.ownerMemberId !== undefined) {
      data.ownerMemberId = await resolveProposalOwnerMemberId(tx, params.workspaceId, params.ownerMemberId);
    }

    const contentFields = ["title", "summary", "bodyMd", "priority", "circleId", "ownerMemberId"];
    const changedFields = changedDataFields(proposal as unknown as Record<string, unknown>, data)
      .filter((field) => contentFields.includes(field));
    if (changedFields.length > 0) {
      data.version = await recordWorkItemVersion(tx, actor, {
        workspaceId: params.workspaceId,
        entityType: "Proposal",
        entityId: proposal.id,
        currentVersion: proposal.version,
        changedFields,
        previousState: pickJsonSnapshot(proposal as unknown as Record<string, unknown>, [
          "id",
          "workspaceId",
          "title",
          "summary",
          "bodyMd",
          "priority",
          "circleId",
          "ownerMemberId",
          "status",
          "version",
        ]),
      });
    }
    const changedUpdateFields = changedDataFields(proposal as unknown as Record<string, unknown>, data);
    if (changedUpdateFields.length === 0) return proposal;

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
        meta: { fields: changedUpdateFields, version: updated.version },
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

    const openedAt = new Date();
    const flow = await activateProposalApprovalFlow(tx, {
      actor,
      workspaceId: params.workspaceId,
      proposalId: proposal.id,
      policy,
      openedAt,
    });

    await tx.proposal.update({
      where: { id: proposal.id },
      data: {
        status: "OPEN",
        isPrivate: false,
        publishedAt: proposal.publishedAt || openedAt,
        autoApproveAt: null,
      },
    });

    await recordProposalOpened(tx, actor, {
      workspaceId: params.workspaceId,
      proposalId: proposal.id,
      proposalTitle: proposal.title,
      flowId: flow.id,
    });

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
    invariant(proposal.status === "OPEN" || proposal.status === "RESOLVED", 400, "INVALID_STATE", "Only open or resolved proposals can be returned to draft.");
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
    await tx.policyCorpus.deleteMany({
      where: { proposalId: proposal.id },
    });

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
    const updated = await tx.proposal.update({
      where: { id: proposal.id },
      data: {
        status: "DRAFT",
        resolutionOutcome: null,
        decisionMd: null,
        decidedAt: null,
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

export async function reopenProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const policy = await getApprovalPolicy(params.workspaceId, "PROPOSAL");
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant(!proposal.archivedAt, 400, "INVALID_STATE", "Archived proposals cannot be reopened.");
    invariant(proposal.status === "RESOLVED", 400, "INVALID_STATE", "Only resolved proposals can be reopened.");

    const existingFlow = await tx.approvalFlow.findUnique({
      where: {
        subjectType_subjectId: {
          subjectType: "PROPOSAL",
          subjectId: proposal.id,
        },
      },
    });
    const flow = existingFlow ?? await ensureApprovalFlow(tx, {
      workspaceId: params.workspaceId,
      subjectType: "PROPOSAL",
      subjectId: proposal.id,
      policy,
      createdByUserId: actor.kind === "user" ? actor.user.id : null,
    });

    const deletedDecisions = await tx.approvalDecision.deleteMany({ where: { flowId: flow.id } });
    const deletedObjections = await tx.objection.deleteMany({ where: { flowId: flow.id } });
    const deletedPolicyCorpus = await tx.policyCorpus.deleteMany({
      where: { proposalId: proposal.id },
    });

    await tx.approvalFlow.update({
      where: { id: flow.id },
      data: {
        status: "ACTIVE",
        openedAt: flow.openedAt ?? now,
        closesAt: null,
        closedAt: null,
        resultJson: Prisma.JsonNull,
      },
    });

    const updated = await tx.proposal.update({
      where: { id: proposal.id },
      data: {
        status: "OPEN",
        resolutionOutcome: null,
        decisionMd: null,
        decidedAt: null,
        autoApproveAt: null,
        isPrivate: false,
        publishedAt: proposal.publishedAt ?? now,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "proposal.reopened",
        entityType: "Proposal",
        entityId: proposal.id,
        meta: {
          flowId: flow.id,
          approvalDecisionsDeleted: deletedDecisions.count,
          objectionsDeleted: deletedObjections.count,
          policyCorpusRowsDeleted: deletedPolicyCorpus.count,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "proposal.reopened",
        aggregateType: "Proposal",
        aggregateId: proposal.id,
        payload: {
          proposalId: proposal.id,
          flowId: flow.id,
          approvalDecisionsDeleted: deletedDecisions.count,
          objectionsDeleted: deletedObjections.count,
          policyCorpusRowsDeleted: deletedPolicyCorpus.count,
        },
      },
    ]);

    return updated;
  });
}

export async function supportReopenResolvedProposals(actor: AppActor, params: {
  workspaceId: string;
  proposalIds: string[];
  reason: string;
}) {
  requireSupportRepairActor(actor);
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const proposalIds = normalizeIds(params.proposalIds);
  invariant(proposalIds.length > 0, 400, "INVALID_INPUT", "At least one proposal ID is required.");
  invariant(proposalIds.length <= SUPPORT_REOPEN_PROPOSALS_LIMIT, 400, "INVALID_INPUT", `Cannot repair more than ${SUPPORT_REOPEN_PROPOSALS_LIMIT} proposals at once.`);
  const reason = params.reason.trim();
  invariant(reason.length > 0, 400, "INVALID_INPUT", "Support repair reason is required.");

  const policy = await getApprovalPolicy(params.workspaceId, "PROPOSAL");
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const proposals = await tx.proposal.findMany({
      where: {
        id: { in: proposalIds },
        workspaceId: params.workspaceId,
      },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        authorUserId: true,
        status: true,
        resolutionOutcome: true,
        decisionMd: true,
        decidedAt: true,
        publishedAt: true,
        archivedAt: true,
      },
    });
    const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const missingIds = proposalIds.filter((proposalId) => !proposalById.has(proposalId));
    invariant(missingIds.length === 0, 404, "NOT_FOUND", `Proposal not found: ${missingIds.join(", ")}.`);

    const reopened = [];
    const events = [];

    for (const proposalId of proposalIds) {
      const proposal = proposalById.get(proposalId);
      invariant(proposal, 404, "NOT_FOUND", "Proposal not found.");
      invariant(!proposal.archivedAt, 400, "INVALID_STATE", `Archived proposal cannot be reopened: ${proposal.id}.`);
      invariant(proposal.status === "RESOLVED", 400, "INVALID_STATE", `Only resolved proposals can be reopened: ${proposal.id}.`);

      const existingFlow = await tx.approvalFlow.findUnique({
        where: {
          subjectType_subjectId: {
            subjectType: "PROPOSAL",
            subjectId: proposal.id,
          },
        },
      });
      const flow = existingFlow ?? await ensureApprovalFlow(tx, {
        workspaceId: params.workspaceId,
        subjectType: "PROPOSAL",
        subjectId: proposal.id,
        policy,
        createdByUserId: null,
      });

      const deletedDecisions = await tx.approvalDecision.deleteMany({ where: { flowId: flow.id } });
      const deletedObjections = await tx.objection.deleteMany({ where: { flowId: flow.id } });

      await tx.approvalFlow.update({
        where: { id: flow.id },
        data: {
          status: "ACTIVE",
          openedAt: flow.openedAt ?? now,
          closesAt: null,
          closedAt: null,
          resultJson: Prisma.JsonNull,
        },
      });

      const deletedPolicyCorpus = await tx.policyCorpus.deleteMany({
        where: { proposalId: proposal.id },
      });

      const updated = await tx.proposal.update({
        where: { id: proposal.id },
        data: {
          status: "OPEN",
          resolutionOutcome: null,
          decisionMd: null,
          decidedAt: null,
          autoApproveAt: null,
          isPrivate: false,
          publishedAt: proposal.publishedAt ?? now,
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: params.workspaceId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
          action: "proposal.support_reopened_resolved",
          entityType: "Proposal",
          entityId: proposal.id,
          meta: {
            reason,
            previousStatus: proposal.status,
            previousResolutionOutcome: proposal.resolutionOutcome,
            previousDecidedAt: proposal.decidedAt,
            flowId: flow.id,
            approvalDecisionsDeleted: deletedDecisions.count,
            objectionsDeleted: deletedObjections.count,
            policyCorpusRowsDeleted: deletedPolicyCorpus.count,
          },
        },
      });

      events.push({
        workspaceId: params.workspaceId,
        type: "proposal.support_reopened_resolved",
        aggregateType: "Proposal",
        aggregateId: proposal.id,
        payload: {
          proposalId: proposal.id,
          flowId: flow.id,
          reason,
          approvalDecisionsDeleted: deletedDecisions.count,
          objectionsDeleted: deletedObjections.count,
          policyCorpusRowsDeleted: deletedPolicyCorpus.count,
        },
      });

      reopened.push({
        id: updated.id,
        status: updated.status,
        flowId: flow.id,
        approvalDecisionsDeleted: deletedDecisions.count,
        objectionsDeleted: deletedObjections.count,
        policyCorpusRowsDeleted: deletedPolicyCorpus.count,
      });
    }

    await appendEvents(tx, events);

    return {
      workspaceId: params.workspaceId,
      reopened,
    };
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
  evidenceDocumentIds?: string[] | null;
}) {
  const membership = await requireWorkspaceMembership({
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
    invariant(proposal.status === "DRAFT" || proposal.status === "OPEN", 400, "INVALID_STATE", "Only draft or open proposals can be resolved.");
    if (proposal.status === "DRAFT") {
      await requireDraftManager({ actor, workspaceId: params.workspaceId, record: proposal, resolvedMembership: membership });
    }

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

    const evidenceDocumentIds = await createWorkItemEvidenceLinks(tx, {
      workspaceId: params.workspaceId,
      entityType: "Proposal",
      entityId: proposal.id,
      documentIds: params.evidenceDocumentIds,
      purpose: "resolution_evidence",
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
          evidenceDocumentIds,
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
          evidenceDocumentIds,
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
