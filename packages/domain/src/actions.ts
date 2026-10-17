import { WorkItemReadRelease, readWorkItemListSnapshot, readableWorkItemPage, workItemAfter } from "./work-item-readable-page";
import { completeActionWithNativeRequest } from "./action-completion";
import { prepareProducerLineage, finishProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { createHash } from "node:crypto";
import { prisma } from "@corgtex/shared";
import { getMcpOrigin } from "../../shared/src/mcp-context";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import type { ActionStatus, MeetingInsight, Prisma } from "@prisma/client";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { requireWorkspaceOperation } from "./agent-operation-authorization";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { loadAdviceRequestCountSummaries } from "./advice-requests";
import { invariant } from "./errors";
import { humanMemberIdentityWhere } from "./member-identity";
import { requireDraftManager, requireCreationInputRoots } from "./draft-permissions";
import { requireCollaborativeWorkItemEditor } from "./collaborative-permissions";
import { resolveWorkspaceProposalLink } from "./proposal-links";
import { captureImmutableArtifactInputProof, readableArtifactIds } from "./source-lineage";
import { captureReadableDigestInputs, DigestReadRelease } from "./digest-lineage";
import { createWorkItemEvidenceLinks } from "./work-item-evidence";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";
import {
  checkWorkspaceDuplicateGuard,
  duplicateGuardAuditMeta,
  duplicateGuardMergeText,
  type DuplicateGuardOptions,
} from "./duplicate-guard";
import {
  acquireWorkItemAdvisoryLock,
  changedDataFields,
  pickJsonSnapshot,
  recordWorkItemVersion,
  resolveWorkspaceMemberUserId,
} from "./work-item-versions";

import { privacyFilter } from "./privacy";

export type WorkItemSort = "priority" | "date" | "alpha";
export type ActionSort = WorkItemSort | "created_asc" | "due_asc" | "due_desc";

export type ListActionsOptions = {
  take?: number;
  skip?: number;
  archiveFilter?: ArchiveFilter;
  status?: ActionStatus;
  statuses?: readonly ActionStatus[];
  circleId?: string | null;
  circleIds?: string[] | null;
  assigneeMemberId?: string | null;
  assigneeMemberIds?: string[] | null;
  includeOwnDrafts?: boolean;
  memberId?: string | null;
  memberIds?: string[] | null;
  createdFrom?: Date;
  createdTo?: Date;
  dueFrom?: Date;
  dueTo?: Date;
  sort?: ActionSort;
};

type ActionChecklistSummary = {
  checklistItemCount: number;
  checklistCompletedCount: number;
};

type CreateActionParams = ProducerLineageParams & {
  workspaceId: string;
  title: string;
  bodyMd?: string | null;
  circleId?: string | null;
  assigneeMemberId?: string | null;
  authorMemberId?: string | null;
  dueAt?: Date | null;
  proposalId?: string | null;
  isPrivate?: boolean;
  priority?: number | null;
  duplicateGuard?: DuplicateGuardOptions | null;
  source?: { type: string; id: string; groupId?: string | null } | null;
  sourcePayload?: unknown;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
  _tx?: Prisma.TransactionClient;
};

/** GPT OAuth POST authenticates the same direct human submission with or
 * without an idempotency key. A source tag never turns agent/MCP input into a
 * human original; explicit and inherited roots remain with the producer. */
function copiedActionSource(actor: AppActor, source: {type: string} | null | undefined) {
  return Boolean(source && !["WEB_REQUEST", "API_REQUEST"].includes(source.type)
    && !(source.type === "GPT_REQUEST" && actor.kind === "user" && !getMcpOrigin()));
}

export function actionRequestSource(type: "WEB_REQUEST" | "API_REQUEST" | "GPT_REQUEST" | "MCP_REQUEST" | "AGENT_TOOL", principalId: string, key: string) {
  const normalizedKey = key.trim();
  invariant(principalId.trim().length > 0 && normalizedKey.length > 0 && normalizedKey.length <= 128,
    400, "INVALID_INPUT", "Action idempotency key is invalid.");
  return {
    type,
    id: createHash("sha256").update(`${principalId}\0${normalizedKey}`).digest("hex"),
  };
}

export function meetingInsightActionSourcePayload(insight: Pick<MeetingInsight, "type" | "operation" | "title" | "bodyMd" | "assigneeHint" | "dueAt">) {
  return {
    type: insight.type,
    operation: insight.operation,
    title: insight.title.trim(),
    bodyMd: insight.bodyMd.trim(),
    assigneeHint: insight.assigneeHint?.trim() || null,
    dueAt: insight.dueAt?.toISOString() ?? null,
  };
}

function dateRangeWhere(from?: Date, to?: Date): Prisma.DateTimeFilter<"Action"> | undefined {
  const filter: Prisma.DateTimeFilter<"Action"> = {};
  if (from) filter.gte = from;
  if (to) filter.lte = to;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

function nullableDateRangeWhere(from?: Date, to?: Date): Prisma.DateTimeNullableFilter<"Action"> | undefined {
  const filter: Prisma.DateTimeNullableFilter<"Action"> = {};
  if (from) filter.gte = from;
  if (to) filter.lte = to;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

function listFilterValues(values?: readonly (string | null | undefined)[] | null) {
  return [...new Set((values ?? []).map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function isPrismaNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2025";
}

function appendActionWhereAnd(where: Prisma.ActionWhereInput, condition: Prisma.ActionWhereInput) {
  const and = Array.isArray(where.AND) ? [...where.AND] : where.AND ? [where.AND] : [];
  if (where.OR) {
    and.push({ OR: where.OR });
    delete where.OR;
  }
  and.push(condition);
  where.AND = and;
}

function workItemOrderBy(sort: ActionSort | undefined): Prisma.ActionOrderByWithRelationInput[] {
  if (sort === "alpha") {
    return [{ title: "asc" }, { createdAt: "desc" }, { id: "desc" }];
  }
  if (sort === "created_asc") {
    return [{ createdAt: "asc" }, { id: "asc" }];
  }
  if (sort === "due_asc" || sort === "due_desc") {
    return [
      { dueAt: { sort: sort === "due_asc" ? "asc" : "desc", nulls: "last" } },
      { createdAt: "desc" },
      { id: "desc" },
    ];
  }
  if (sort === "date") {
    return [{ createdAt: "desc" }, { id: "desc" }];
  }
  return [{ priority: "desc" }, { createdAt: "desc" }, { id: "desc" }];
}

async function resolveAssigneeMemberId(tx: Prisma.TransactionClient, workspaceId: string, assigneeMemberId?: string | null) {
  if (!assigneeMemberId) return null;

  const member = await tx.member.findFirst({
    where: {
      id: assigneeMemberId,
      workspaceId,
      isActive: true,
      ...humanMemberIdentityWhere(),
    },
    select: { id: true },
  });
  invariant(member, 400, "INVALID_INPUT", "Action assignee must be an active human member of this workspace.");
  return member.id;
}

async function loadActionChecklistSummaries(actor: AppActor, workspaceId: string, actionIds: string[], release?: WorkItemReadRelease) {
  const summaries = new Map<string, ActionChecklistSummary>();
  if (actionIds.length === 0) return summaries;

  const items = await (release?.db ?? prisma).actionChecklistItem.findMany({
    where: {
      workspaceId,
      actionId: { in: actionIds },
    },

  });

  const visible = await readableArtifactIds(actor, workspaceId, "ActionChecklistItem", items, release?.db);
  await release?.observe("ActionChecklistItem", items.filter(item => visible.has(item.id)));
  for (const item of items.filter((item) => visible.has(item.id))) {
    const current = summaries.get(item.actionId) ?? { checklistItemCount: 0, checklistCompletedCount: 0 };
    current.checklistItemCount += 1;
    if (item.completedAt) current.checklistCompletedCount += 1;
    summaries.set(item.actionId, current);
  }

  return summaries;
}

async function requireEditableActionForChecklist(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: import("@corgtex/shared").MembershipSummary | null,
  workspaceId: string,
  actionId: string,
) {
  const action = await tx.action.findFirst({
    where: {
      id: actionId,
      workspaceId,
      ...privacyFilter(actor, membership),
      archivedAt: null,
    },
  });

  invariant(action, 404, "NOT_FOUND", "Action not found.");
  if (action.status === "DRAFT") {
    await requireDraftManager({ actor, workspaceId, record: action, resolvedMembership: membership });
  } else {
    invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "Only draft, open, or in-progress actions can change checklists.");
    requireCollaborativeWorkItemEditor(actor, membership, action);
  }
  return action;
}

async function lockEditableActionForChecklistMutation(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: import("@corgtex/shared").MembershipSummary | null,
  workspaceId: string,
  actionId: string,
) {
  const action = await requireEditableActionForChecklist(tx, actor, membership, workspaceId, actionId);
  const updateWhere: Record<string, unknown> = {
    id: action.id,
    workspaceId,
    archivedAt: null,
    status: action.status,
    isPrivate: action.isPrivate ?? false,
    version: action.version,
  };

  const receipt = await prepareProducerLineage({ tx, actor, workspaceId,
    artifact: { kind: "Action", id: action.id }, before: action, allowSystemTransition: true });
  try {
    const updated = await tx.action.update({
      where: updateWhere as Prisma.ActionWhereUniqueInput,
      data: { updatedAt: new Date() },
    });
    await finishProducerLineage({ tx, actor, workspaceId,
      artifact: { kind: "Action", id: action.id }, content: updated, receipt });
  } catch (error) {
    if (isPrismaNotFoundError(error)) {
      invariant(false, 409, "CONFLICT", "Action changed while editing. Refresh and try again.");
    }
    throw error;
  }

  return action;
}

function completedByUserIdForActor(actor: AppActor, workspaceId: string) {
  return actor.kind === "user" ? actor.user.id : actorUserIdForWorkspace(actor, workspaceId);
}

function actionListWhere(actor: AppActor, membership: MembershipSummary | null, workspaceId: string, opts?: ListActionsOptions) {
  const where: Prisma.ActionWhereInput = {
    workspaceId,
    ...privacyFilter(actor, membership),
    ...archiveFilterWhere(opts?.archiveFilter),
  };
  if (opts?.statuses?.length) where.status = { in: [...opts.statuses] };
  else if (opts?.status) where.status = opts.status;
  const circleIds = listFilterValues(opts?.circleIds);
  if (circleIds.length > 0) where.circleId = { in: circleIds };
  else if (opts?.circleId) where.circleId = opts.circleId;
  const assigneeMemberIds = listFilterValues([...(opts?.assigneeMemberIds ?? []), opts?.assigneeMemberId]);
  if (opts?.includeOwnDrafts && actor.kind === "user" && membership?.id
    && assigneeMemberIds.length === 1 && assigneeMemberIds[0] === membership.id) {
    appendActionWhereAnd(where, {
      OR: [
        { assigneeMemberId: membership.id },
        { authorUserId: actor.user.id, isPrivate: true, status: "DRAFT" },
      ],
    });
  } else if (assigneeMemberIds.length > 0) {
    where.assigneeMemberId = { in: assigneeMemberIds };
  }
  const createdAt = dateRangeWhere(opts?.createdFrom, opts?.createdTo);
  const dueAt = nullableDateRangeWhere(opts?.dueFrom, opts?.dueTo);
  if (createdAt) where.createdAt = createdAt;
  if (dueAt) where.dueAt = dueAt;
  const memberIds = listFilterValues([...(opts?.memberIds ?? []), opts?.memberId]);
  if (memberIds.length > 0) {
    appendActionWhereAnd(where, {
      OR: [
        { assigneeMemberId: { in: memberIds } },
        {
          author: {
            memberships: {
              some: {
                id: { in: memberIds },
                workspaceId,
                isActive: true,
              },
            },
          },
        },
      ],
    });
  }
  return where;
}

export async function countActionsByStatus(actor: AppActor, workspaceId: string, opts?: ListActionsOptions) {
  const membership = await requireWorkspaceOperation({ operation: "list_actions", actor, workspaceId });
  const where = actionListWhere(actor, membership, workspaceId, { ...opts, status: undefined, statuses: undefined });
  const release = new WorkItemReadRelease(actor,workspaceId);
  const counts = { DRAFT: 0, OPEN: 0, IN_PROGRESS: 0, COMPLETED: 0, ALL: 0 };
  let afterId: string | undefined;
  for (;;) {
    const page: import("@prisma/client").Action[] = await prisma.action.findMany({
      where: { AND: [where, ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take: 100,
    });
    const rows = await release.admit("Action",page);
    for (const row of rows) { counts[row.status]++; counts.ALL++; }
    if (page.length < 100) break;
    afterId = page.at(-1)!.id;
  }
  return release.finish(counts);
}

async function redactActionJoins<T extends {
  authorUserId: string;
  author?: { id: string; displayName: string | null; email: string };
  assigneeMemberId?: string | null;
  assigneeMember?: { id: string } | null;
  circleId?: string | null;
  circle?: { id: string } | null;
}>(actor: AppActor, workspaceId: string, rows: T[], release?: WorkItemReadRelease) {
  const capture = <R extends {id: string}>(kind: Parameters<WorkItemReadRelease["capture"]>[0], records: R[]) =>
    release ? release.capture(kind,records) : captureReadableDigestInputs({actor,workspaceId,kind,records});
  const [authors, members, circles] = await Promise.all([
    capture("User", rows.flatMap(row => row.author ? [row.author] : [])),
    capture("Member", rows.flatMap(row => row.assigneeMember ? [row.assigneeMember] : [])),
    capture("Circle", rows.flatMap(row => row.circle ? [row.circle] : [])),
  ]);
  const authorIds = new Set(authors.records.map((row) => row.id));
  const memberIds = new Set(members.records.map((row) => row.id));
  const circleIds = new Set(circles.records.map((row) => row.id));
  return rows.map((row) => ({ ...row,
    authorUserId: authorIds.has(row.authorUserId) ? row.authorUserId : null,
    author: row.author && authorIds.has(row.author.id) ? row.author as NonNullable<T["author"]> : { id: "", displayName: null, email: "" },
    assigneeMemberId: row.assigneeMember && memberIds.has(row.assigneeMember.id) ? row.assigneeMemberId : null,
    assigneeMember: row.assigneeMember && memberIds.has(row.assigneeMember.id) ? row.assigneeMember as NonNullable<T["assigneeMember"]> : null,
    circleId: row.circle && circleIds.has(row.circle.id) ? row.circleId : null,
    circle: row.circle && circleIds.has(row.circle.id) ? row.circle as NonNullable<T["circle"]> : null,
  }));
}

function actionPageAfter(row: import("@prisma/client").Action, sort: ListActionsOptions["sort"]): Prisma.ActionWhereInput {
  if(sort!=="due_asc" && sort!=="due_desc") return workItemAfter(row,sort);
  const tied=workItemAfter(row,"date");
  if(row.dueAt===null) return {dueAt:null,...tied};
  return {OR:[{dueAt:null},{dueAt:sort==="due_asc"?{gt:row.dueAt}:{lt:row.dueAt}},{dueAt:row.dueAt,...tied}]};
}

export async function listActions(actor: AppActor, workspaceId: string, opts?: ListActionsOptions) {
  return readWorkItemListSnapshot(actor, workspaceId, async release => {
    const db = release.db;
    const take = opts?.take ?? 20;
    const skip = opts?.skip ?? 0;
    const membership = await requireWorkspaceOperation({ operation: "list_actions", actor, workspaceId, tx: db });
    const where = actionListWhere(actor, membership, workspaceId, opts);

    const page=await readableWorkItemPage<import("@prisma/client").Action>({actor,workspaceId,release,kind:"Action",take,skip,
      load: after => db.action.findMany({where:after?{AND:[where,actionPageAfter(after,opts?.sort)]}:where,
        orderBy:workItemOrderBy(opts?.sort),take:100})});
    const selected = page.items;
    const hydrated = selected.length ? await db.action.findMany({where:{AND:[where,{id:{in:selected.map(row=>row.id)}}]},
        include: {
          author: {
            select: {
              id: true,
              displayName: true,
              email: true,
            },
          },
          assigneeMember: {
            include: {
              user: {
                select: {
                  id: true,
                  displayName: true,
                  email: true,
                },
              },
            },
          },
          circle: true,
          proposal: true,
        },
    }) : [];
    const byId=new Map(hydrated.map(row=>[row.id,row]));
    const items=selected.flatMap(row=>{const loaded=byId.get(row.id);return loaded?[{...loaded,...row}]:[];});
    invariant(items.length === selected.length,409,"SOURCE_CHANGED","Selected actions changed within collection.");
    const total=page.total;
    const itemIds = items.map((item) => item.id);
    const [requestCountSummaries, checklistSummaries] = await Promise.all([
      loadAdviceRequestCountSummaries(actor, workspaceId, "ACTION", itemIds, rows => release.observe("AdviceRequest", rows), db),
      loadActionChecklistSummaries(actor, workspaceId, itemIds, release),
    ]);
    const redactedItems = await redactActionJoins(actor, workspaceId, items, release);
    const linkedProposals = items.flatMap((item) => item.proposal ? [item.proposal] : []);
    const visibleProposalIds = linkedProposals.length
      ? await release.readable("Proposal", linkedProposals) : new Set<string>();
    await release.observe("Proposal",linkedProposals.filter(row=>visibleProposalIds.has(row.id)));
    return {
      items: redactedItems.map((item) => ({
        ...item,
        proposalId: item.proposal && visibleProposalIds.has(item.proposal.id) ? item.proposalId : null,
        proposal: item.proposal && visibleProposalIds.has(item.proposal.id)
          ? { id: item.proposal.id, title: item.proposal.title } : null,
        ...requestCountSummaries.get(item.id),
        checklistItemCount: checklistSummaries.get(item.id)?.checklistItemCount ?? 0,
        checklistCompletedCount: checklistSummaries.get(item.id)?.checklistCompletedCount ?? 0,
      })),
      total,
      take,
      skip,
    };
  });
}

export async function getAction(actor: AppActor, params: Parameters<typeof readAction>[1]) {
  await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "list_actions" });
  return readAction(actor, params);
}

async function readAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  includeArchived?: boolean;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const action = await prisma.action.findFirst({
    where: {
      id: params.actionId,
      workspaceId: params.workspaceId,
      ...privacyFilter(actor, membership),
      ...(params.includeArchived ? {} : { archivedAt: null }),
    },
    include: {
      author: {
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      },
      assigneeMember: {
        include: {
          user: {
            select: {
              id: true,
              displayName: true,
              email: true,
            },
          },
        },
      },
      circle: {
        select: {
          id: true,
          name: true,
        },
      },
      proposal: true,
    },
  });
  invariant(action, 404, "NOT_FOUND", "Action not found.");
  const release = new WorkItemReadRelease(actor, params.workspaceId);
  invariant((await release.admit("Action", [action])).length, 404, "NOT_FOUND", "Action not found.");
  const proposals = await release.observeRead(() => captureReadableDigestInputs({
    actor, workspaceId: params.workspaceId, kind: "Proposal", records: action.proposal ? [action.proposal] : [],
  }));
  release.add(proposals.roots);
  const visibleProposalIds = new Set(proposals.records.map(row => row.id));
  return release.finish({
    ...(await redactActionJoins(actor, params.workspaceId, [action], release))[0],
    proposalId: action.proposal && visibleProposalIds.has(action.proposal.id) ? action.proposalId : null,
    proposal: action.proposal && visibleProposalIds.has(action.proposal.id)
      ? { id: action.proposal.id, title: action.proposal.title } : null,
  });
}

export async function listActionChecklistItems(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
}) {
  await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "list_actions" });
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const action = await prisma.action.findFirst({ where: {
    id: params.actionId, workspaceId: params.workspaceId, ...privacyFilter(actor, membership), archivedAt: null,
  } });
  invariant(action, 404, "NOT_FOUND", "Action not found.");
  const release = new DigestReadRelease(actor, params.workspaceId);
  invariant((await release.capture("Action", [action])).records.length, 404, "NOT_FOUND", "Action not found.");
  const items = await prisma.actionChecklistItem.findMany({
    where: {
      workspaceId: params.workspaceId,
      actionId: params.actionId,
    },
    orderBy: [
      { sortOrder: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });
  const visible = await release.capture("ActionChecklistItem", items);
  return release.finish(visible.records);
}

export async function createActionChecklistItem(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  actionId: string;
  title: string;
  idempotencyId?: string;
}) {
  const membership = await requireWorkspaceOperation({ operation: "update_action", actor, workspaceId: params.workspaceId });
  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Checklist item title is required.");

  return prisma.$transaction(async (tx) => {
    await lockEditableActionForChecklistMutation(tx, actor, membership, params.workspaceId, params.actionId);
    if (params.idempotencyId) {
      const existing = await tx.actionChecklistItem.findUnique({ where: { id: params.idempotencyId } });
      if (existing) {
        invariant(existing.workspaceId === params.workspaceId && existing.actionId === params.actionId && existing.title === title,
          409, "IDEMPOTENCY_CONFLICT", "This checklist request was already used for different content.");
        invariant((await readableArtifactIds(actor, params.workspaceId, "ActionChecklistItem", [existing], tx)).has(existing.id),
          404, "NOT_FOUND", "The earlier checklist item is no longer readable.");
        return existing;
      }
    }
    const lastItem = await tx.actionChecklistItem.findFirst({
      where: {
        workspaceId: params.workspaceId,
        actionId: params.actionId,
      },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params });
    const item = await tx.actionChecklistItem.create({
      data: {
        ...(params.idempotencyId ? { id: params.idempotencyId } : {}),
        workspaceId: params.workspaceId,
        actionId: params.actionId,
        title,
        sortOrder: (lastItem?.sortOrder ?? -1) + 1,
      },
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "ActionChecklistItem", id: item.id }, content: item, receipt });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.checklist_item.created",
      entityType: "Action",
      entityId: params.actionId,
      meta: { checklistItemId: item.id, title },
    });
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "action.checklist_item.created",
      aggregateType: "Action",
      aggregateId: params.actionId,
      payload: { actionId: params.actionId, checklistItemId: item.id },
    }]);

    return item;
  });
}

export async function updateActionChecklistItem(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  checklistItemId: string;
  title?: string;
  completed?: boolean;
}) {
  const membership = await requireWorkspaceOperation({ operation: "update_action", actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const existing = await tx.actionChecklistItem.findFirst({
      where: {
        id: params.checklistItemId,
        workspaceId: params.workspaceId,
      },
    });
    invariant(existing, 404, "NOT_FOUND", "Checklist item not found.");
    await lockEditableActionForChecklistMutation(tx, actor, membership, params.workspaceId, existing.actionId);

    const data: Prisma.ActionChecklistItemUpdateInput = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Checklist item title is required.");
      data.title = title;
    }
    if (params.completed !== undefined) {
      data.completedAt = params.completed ? new Date() : null;
      data.completedBy = params.completed
        ? { connect: { id: await completedByUserIdForActor(actor, params.workspaceId) } }
        : { disconnect: true };
    }

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "ActionChecklistItem", id: existing.id }, before: existing, capture: params,
      allowSystemTransition: params.title === undefined });
    const updated = Object.keys(data).length > 0
      ? await tx.actionChecklistItem.update({
        where: { id: existing.id },
        data,
      })
      : existing;

    if (Object.keys(data).length) await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "ActionChecklistItem", id: updated.id }, content: updated, receipt });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.checklist_item.updated",
      entityType: "Action",
      entityId: existing.actionId,
      meta: {
        checklistItemId: existing.id,
        fields: [
          ...(params.title !== undefined ? ["title"] : []),
          ...(params.completed !== undefined ? ["completed"] : []),
        ],
      },
    });
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "action.checklist_item.updated",
      aggregateType: "Action",
      aggregateId: existing.actionId,
      payload: { actionId: existing.actionId, checklistItemId: existing.id },
    }]);

    return updated;
  });
}

export async function deleteActionChecklistItem(actor: AppActor, params: {
  workspaceId: string;
  checklistItemId: string;
}) {
  const membership = await requireWorkspaceOperation({ operation: "update_action", actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const existing = await tx.actionChecklistItem.findFirst({
      where: {
        id: params.checklistItemId,
        workspaceId: params.workspaceId,
      },
    });
    invariant(existing, 404, "NOT_FOUND", "Checklist item not found.");
    await lockEditableActionForChecklistMutation(tx, actor, membership, params.workspaceId, existing.actionId);

    await tx.actionChecklistItem.delete({ where: { id: existing.id } });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.checklist_item.deleted",
      entityType: "Action",
      entityId: existing.actionId,
      meta: { checklistItemId: existing.id, title: existing.title },
    });
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "action.checklist_item.deleted",
      aggregateType: "Action",
      aggregateId: existing.actionId,
      payload: { actionId: existing.actionId, checklistItemId: existing.id },
    }]);

    return { id: existing.id };
  });
}

async function applyActionDuplicateUpdate(
  actor: AppActor,
  params: CreateActionParams,
  actionId: string,
  membership: import("@corgtex/shared").MembershipSummary | null,
  tx: Prisma.TransactionClient,
) {
  await acquireWorkItemAdvisoryLock(tx, "Action", actionId);
  const existing = await tx.action.findFirst({
    where: { id: actionId, workspaceId: params.workspaceId, archivedAt: null, duplicateOfActionId: null, ...privacyFilter(actor, membership) },
  });
  invariant(existing, 404, "NOT_FOUND", "Action duplicate target is no longer available.");
  invariant((await readableArtifactIds(actor, params.workspaceId, "Action", [existing], tx)).has(existing.id),
    404, "NOT_FOUND", "Action duplicate target is no longer available.");
  const mergedBody = duplicateGuardMergeText(existing.bodyMd, params.bodyMd);
  const updateParams: Parameters<typeof updateAction>[1] = {
    workspaceId: params.workspaceId,
    actionId,
    lineageInputs: params.lineageInputs,
    lineageRoots: params.lineageRoots,
  };
  if ((mergedBody ?? null) !== (existing.bodyMd ?? null)) updateParams.bodyMd = mergedBody;
  if (!existing.circleId && params.circleId) updateParams.circleId = params.circleId;
  if (!existing.assigneeMemberId && params.assigneeMemberId) updateParams.assigneeMemberId = params.assigneeMemberId;
  if (!existing.dueAt && params.dueAt) updateParams.dueAt = params.dueAt;
  if (!existing.proposalId && params.proposalId) updateParams.proposalId = params.proposalId;
  if (params.priority !== undefined && params.priority !== null && existing.priority !== params.priority) updateParams.priority = params.priority;
  if (!Object.keys(updateParams).some((field) => !["workspaceId", "actionId", "lineageInputs", "lineageRoots"].includes(field))) return existing;
  updateParams.lineageCopied = copiedActionSource(actor, params.source);
  updateParams.expectedVersion = existing.version;
  updateParams._membership = membership;
  updateParams._tx = tx;
  return updateActionRecord(actor, updateParams);
}

export async function createAction(actor: AppActor, params: CreateActionParams) {
  params = {...params, duplicateGuard: params.duplicateGuard ? {...params.duplicateGuard} : params.duplicateGuard};
  if (params.duplicateGuard?.resolution === "use_existing" || params.duplicateGuard?.resolution === "update_existing") {
    await requireWorkspaceOperation({actor, workspaceId: params.workspaceId, operation: "get_action", tx: params._tx});
  }
  const membership = await requireWorkspaceOperation({ operation: "create_action", tx: params._tx,
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });
  params = { ...params, lineageRoots: await requireCreationInputRoots({ actor, workspaceId: params.workspaceId,
    isPrivate: params.isPrivate ?? true, roots: params.lineageRoots, tx: params._tx }) };

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Action title is required.");
  const source = params.source && {
    type: params.source.type.trim(), id: params.source.id.trim(), groupId: params.source.groupId?.trim() || null,
  };
  invariant(!source || (source.type.length > 0 && source.type.length <= 64 && source.id.length > 0 && source.id.length <= 191),
    400, "INVALID_INPUT", "Action source identity is invalid.");
  invariant(!source?.groupId || source.groupId.length <= 191, 400, "INVALID_INPUT", "Action source group is invalid.");
  invariant(source?.type !== "MEETING_INSIGHT" || params.sourcePayload != null,
    400, "INVALID_INPUT", "Meeting insight Action source needs its original insight input.");
  let payloadHash: string | null = null;
  if (source?.type === "MEETING_INSIGHT") {
    payloadHash = createHash("sha256").update(JSON.stringify(params.sourcePayload)).digest("hex");
  } else if (source && ["WEB_REQUEST", "API_REQUEST", "GPT_REQUEST", "MCP_REQUEST", "AGENT_TOOL"].includes(source.type)) {
    payloadHash = createHash("sha256").update(JSON.stringify({
      title,
      bodyMd: params.bodyMd?.trim() || null,
      circleId: params.circleId || null,
      assigneeMemberId: params.assigneeMemberId || null,
      authorMemberId: params.authorMemberId || null,
      dueAt: params.dueAt?.toISOString() ?? null,
      proposalId: params.proposalId || null,
      priority: params.priority ?? 0,
      isPrivate: params.isPrivate ?? true,
      sourcePayload: params.sourcePayload ?? null,
      duplicateResolution: params.duplicateGuard?.resolution ?? null,
      duplicateOnExact: params.duplicateGuard?.onExact ?? null,
      duplicateTargetId: params.duplicateGuard?.resolution === "use_existing" || params.duplicateGuard?.resolution === "update_existing"
        ? params.duplicateGuard.targetEntityId?.trim() || null
        : null,
    })).digest("hex");
  }
  const isPrivate = params.isPrivate ?? true;
  const publishedAt = isPrivate ? null : new Date();

  const duplicateDecisionForCreate = (tx?: Prisma.TransactionClient) => checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "Action",
    title,
    body: params.bodyMd,
    circleId: params.circleId,
    assigneeMemberId: params.assigneeMemberId,
    dueAt: params.dueAt,
    proposalId: params.proposalId,
    meetingId: source?.type === "MEETING_INSIGHT" ? source.groupId : null,
    actorUserId: actor.kind === "user" ? actor.user.id : null,
    membershipId: membership?.id ?? null,
    includePrivate: actor.kind === "user" && membership?.role === "ADMIN",
  }, params.duplicateGuard, tx, async (rows) => {
    const records = rows as Array<{ id: string; [key: string]: unknown }>;
    const visible = await readableArtifactIds(actor, params.workspaceId, "Action", records, tx ?? prisma);
    return records.filter((record) => visible.has(record.id));
  });

  const create = async (tx: Prisma.TransactionClient, duplicateDecision: Awaited<ReturnType<typeof duplicateDecisionForCreate>>) => {
    await requireCreationInputRoots({ actor, workspaceId: params.workspaceId, isPrivate: params.isPrivate ?? true, roots: params.lineageRoots, tx });
    const assigneeMemberId = await resolveAssigneeMemberId(tx, params.workspaceId, params.assigneeMemberId);
    invariant(isPrivate || assigneeMemberId, 400, "INVALID_INPUT", "Assign an active human member before opening this Action.");
    const proposalId = await resolveWorkspaceProposalLink(tx, actor, membership, params.workspaceId, params.proposalId);
    let authorUserId = actor.kind === "user"
      ? actor.user.id
      : await actorUserIdForWorkspace(actor, params.workspaceId);
    const attributedMemberId = params.authorMemberId || assigneeMemberId;
    if (actor.kind === "agent" && attributedMemberId) {
      authorUserId = await resolveWorkspaceMemberUserId(tx, params.workspaceId, attributedMemberId, "Action author must be an active member of this workspace.");
    }
    const receipt = await prepareProducerLineage({
      tx, actor, workspaceId: params.workspaceId, capture: params,
      copied: copiedActionSource(actor, source),
      dependencies: actor.kind === "agent" ? [
        ...(source?.type === "MEETING_INSIGHT" ? [{ kind: "MeetingInsight" as const, id: source.id }] : []),
        ...(params.proposalId ? [{ kind: "Proposal" as const, id: params.proposalId }] : []),
        ...(params.circleId ? [{ kind: "Circle" as const, id: params.circleId }] : []),
        ...(params.authorMemberId ? [{ kind: "Member" as const, id: params.authorMemberId }] : []),
        ...(assigneeMemberId ? [{ kind: "Member" as const, id: assigneeMemberId }] : []),
      ] : [],
    });
    const action = await tx.action.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title,
        bodyMd: params.bodyMd?.trim() || null,
        circleId: params.circleId || null,
        assigneeMemberId,
        dueAt: params.dueAt ?? null,
        proposalId,
        priority: params.priority ?? 0,
        status: isPrivate ? "DRAFT" : "OPEN",
        isPrivate,
        publishedAt,
      },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Action", id: action.id }, content: action, receipt });


    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Action",
      entityId: action.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Action", action),
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.created",
      entityType: "Action",
      entityId: action.id,
      meta: { title: action.title, ...duplicateGuardAuditMeta(duplicateDecision) },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.created",
        aggregateType: "Action",
        aggregateId: action.id,
        payload: {
          actionId: action.id,
          title: action.title,
        },
      },
    ]);

    if (!isPrivate) {
      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId,
        action: "action.published",
        entityType: "Action",
        entityId: action.id,
        meta: { title: action.title },
      });

      await appendEvents(tx, [
        {
          workspaceId: params.workspaceId,
          type: "action.published",
          aggregateType: "Action",
          aggregateId: action.id,
          payload: {
            actionId: action.id,
            assigneeMemberId,
            actorUserId: actor.kind === "user" ? actor.user.id : null,
          },
        },
      ]);
    }

    return action;
  };

  if (!source) {
    const duplicateDecision = await duplicateDecisionForCreate();
    if (duplicateDecision?.resolution === "use_existing") {
      return readAction(actor, { workspaceId: params.workspaceId, actionId: duplicateDecision.match.entityId });
    }
    if (duplicateDecision?.resolution === "update_existing") {
      return params._tx
        ? applyActionDuplicateUpdate(actor, params, duplicateDecision.match.entityId, membership, params._tx)
        : prisma.$transaction((tx) => applyActionDuplicateUpdate(actor, params, duplicateDecision.match.entityId, membership, tx));
    }
    return params._tx ? create(params._tx, duplicateDecision) : prisma.$transaction((tx) => create(tx, duplicateDecision));
  }

  const run = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('action_create_workspace'), hashtext(${params.workspaceId}))
    `;
    await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext('action_creation_source'), hashtext(${`${params.workspaceId}:${source.type}:${source.id}`}))
      `;
    const claimed = await tx.actionCreationSource.findUnique({
        where: { workspaceId_sourceType_sourceId: {
          workspaceId: params.workspaceId,
          sourceType: source.type,
          sourceId: source.id,
        } },
      });
    if (claimed) {
        invariant(!payloadHash || !claimed.payloadHash || claimed.payloadHash === payloadHash,
          409, "IDEMPOTENCY_CONFLICT", "This Action idempotency key was already used with different content.");
        await tx.$queryRaw`SELECT "id" FROM "Action" WHERE "workspaceId" = ${params.workspaceId} AND "id" = ${claimed.actionId} FOR SHARE`;
        const existing = await tx.action.findFirst({
          where: { id: claimed.actionId, workspaceId: params.workspaceId, ...privacyFilter(actor, membership) },
        });
        invariant(existing, 404, "NOT_FOUND", "Action source is no longer available.");
        if (existing.duplicateOfActionId) {
          const canonical = await tx.action.findFirst({
            where: { id: existing.duplicateOfActionId, workspaceId: params.workspaceId, archivedAt: null, duplicateOfActionId: null, ...privacyFilter(actor, membership) },
          });
          invariant(canonical, 409, "ACTION_SOURCE_UNAVAILABLE", "Canonical Action is no longer available.");
          invariant((await readableArtifactIds(actor, params.workspaceId, "Action", [canonical], tx)).has(canonical.id),
            404, "NOT_FOUND", "Action source is no longer readable.");
          return canonical;
        }
        invariant(!existing.archivedAt, 409, "ACTION_SOURCE_UNAVAILABLE", "Action source was archived. Review it before retrying.");
        invariant((await readableArtifactIds(actor, params.workspaceId, "Action", [existing], tx)).has(existing.id),
          404, "NOT_FOUND", "Action source is no longer readable.");
        return existing;
    }

    const duplicateDecision = await duplicateDecisionForCreate(tx);
    const action = duplicateDecision?.resolution === "use_existing"
      ? await readAction(actor, { workspaceId: params.workspaceId, actionId: duplicateDecision.match.entityId })
      : duplicateDecision?.resolution === "update_existing"
        ? await applyActionDuplicateUpdate(actor, params, duplicateDecision.match.entityId, membership, tx)
        : await create(tx, duplicateDecision);
    await tx.actionCreationSource.create({
      data: { workspaceId: params.workspaceId, actionId: action.id, sourceType: source.type, sourceId: source.id, sourceGroupId: source.groupId, payloadHash },
    });
    return action;
  };

  return params._tx ? run(params._tx) : prisma.$transaction(run);
}

export async function updateAction(actor: AppActor, params: Parameters<typeof updateActionRecord>[1]) {
  await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "update_action", tx: params._tx });
  return updateActionRecord(actor, params);
}

/** Completion has its own write-only canonical capability. Keep the shared
 * mutation implementation private so callers cannot bypass operation authority. */
export async function completeAction(actor: AppActor, params: {
  workspaceId: string; actionId: string; completedVia: string;
}) {
  return completeActionWithNativeRequest(actor, params);
}

async function updateActionRecord(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  actionId: string;
  lineageCopied?: boolean;
  title?: string;
  bodyMd?: string | null;
  status?: "DRAFT" | "OPEN" | "IN_PROGRESS" | "COMPLETED";
  priority?: number;
  circleId?: string | null;
  assigneeMemberId?: string | null;
  dueAt?: Date | null;
  proposalId?: string | null;
  isPrivate?: boolean;
  completedVia?: string | null;
  evidenceDocumentIds?: string[] | null;
  expectedVersion?: number;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
  _tx?: Prisma.TransactionClient;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const run = async (tx: Prisma.TransactionClient) => {
    await acquireWorkItemAdvisoryLock(tx, "Action", params.actionId);
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "Action", [action], tx)).has(action.id),
      404, "NOT_FOUND", "Action not found.");

    invariant(!action.archivedAt && !action.duplicateOfActionId, 400, "INVALID_STATE", "Archived or resolved duplicate actions cannot be edited.");

    const data: Record<string, unknown> = {};
    const editsContent = params.title !== undefined
      || params.bodyMd !== undefined
      || params.priority !== undefined
      || params.circleId !== undefined
      || params.assigneeMemberId !== undefined
      || params.dueAt !== undefined
      || params.proposalId !== undefined;
    if (editsContent) {
      if (action.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
      } else {
        invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "Only draft, open, or in-progress actions can be edited.");
        requireCollaborativeWorkItemEditor(actor, membership, action);
      }
    }
    if (params.isPrivate !== undefined) {
      invariant(action.status === "DRAFT", 400, "INVALID_STATE", "Only draft actions can change privacy.");
      await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
    }
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Action title is required.");
      data.title = title;
    }
    if (params.bodyMd !== undefined) data.bodyMd = params.bodyMd?.trim() || null;
    if (params.priority !== undefined) data.priority = params.priority;
    if (params.status !== undefined) {
      if (params.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
        data.isPrivate = true;
        data.publishedAt = null;
        data.completedVia = null;
      } else if (params.status === "COMPLETED") {
        if (action.status === "DRAFT") {
          await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
        }
      } else if (action.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
      }
      data.status = params.status;
      if (params.status !== "DRAFT") {
        data.isPrivate = false;
        data.publishedAt = action.publishedAt || new Date();
      }
      if (params.status === "COMPLETED") {
        const completedVia = params.completedVia?.trim() || "";
        invariant(completedVia.length > 0, 400, "INVALID_INPUT", "Completion note is required.");
        data.completedVia = completedVia;
      } else if (params.status === "OPEN" || params.status === "IN_PROGRESS") {
        data.completedVia = null;
      }
    }
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.assigneeMemberId !== undefined) {
      data.assigneeMemberId = await resolveAssigneeMemberId(tx, params.workspaceId, params.assigneeMemberId);
    }
    const effectiveStatus = params.status ?? action.status;
    if (effectiveStatus !== "DRAFT" && (params.status !== undefined || params.assigneeMemberId !== undefined)) {
      const assigneeMemberId = data.assigneeMemberId !== undefined
        ? data.assigneeMemberId as string | null
        : await resolveAssigneeMemberId(tx, params.workspaceId, action.assigneeMemberId);
      invariant(assigneeMemberId, 400, "INVALID_INPUT", "Assign an active human member before opening this Action.");
    }
    if (params.dueAt !== undefined) data.dueAt = params.dueAt;
    if (params.proposalId !== undefined) {
      data.proposalId = await resolveWorkspaceProposalLink(tx, actor, membership, params.workspaceId, params.proposalId);
    }
    if (params.isPrivate !== undefined) data.isPrivate = params.isPrivate;

    if (editsContent) {
      invariant(params.expectedVersion !== undefined, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
    }
    if (params.expectedVersion !== undefined) {
      invariant(Number.isInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
      invariant(params.expectedVersion === action.version, 409, "VERSION_CONFLICT", "The record changed before this update could be applied. Please refresh and try again.");
    }

    const contentFields = ["title", "bodyMd", "priority", "circleId", "assigneeMemberId", "dueAt", "proposalId"];
    const changedFields = changedDataFields(action as unknown as Record<string, unknown>, data)
      .filter((field) => contentFields.includes(field));
    if (changedFields.length > 0) {
      data.version = await recordWorkItemVersion(tx, actor, {
        workspaceId: params.workspaceId,
        entityType: "Action",
        entityId: action.id,
        currentVersion: action.version,
        changedFields,
        previousState: pickJsonSnapshot(action as unknown as Record<string, unknown>, [
          "id",
          "workspaceId",
          "title",
          "bodyMd",
          "priority",
          "circleId",
          "assigneeMemberId",
          "dueAt",
          "proposalId",
          "status",
          "version",
        ]),
      });
    }
    const changedUpdateFields = changedDataFields(action as unknown as Record<string, unknown>, data);
    if (changedUpdateFields.length === 0) return action;

    const updateWhere: Record<string, unknown> = {
      id: params.actionId,
      workspaceId: params.workspaceId,
      archivedAt: null,
      status: action.status,
    };
    if (action.isPrivate !== undefined) updateWhere.isPrivate = action.isPrivate ?? false;
    updateWhere.version = params.expectedVersion ?? action.version;

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Action", id: action.id }, before: action, capture: params, copied: params.lineageCopied });
    if (params._tx && params.lineageCopied && receipt.mode === "DERIVED") {
      receipt.roots = await captureImmutableArtifactInputProof(actor, params.workspaceId, receipt.roots, tx);
    }
    let updated;
    try {
      updated = await tx.action.update({
        where: updateWhere as Prisma.ActionWhereUniqueInput,
        data,
      });
    } catch (error) {
      if (isPrismaNotFoundError(error)) {
        invariant(false, 409, "VERSION_CONFLICT", "The record changed before this update could be applied. Please refresh and try again.");
      }
      throw error;
    }

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Action", id: updated.id }, content: updated, receipt });

    const evidenceDocumentIds = params.status === "COMPLETED"
      ? await createWorkItemEvidenceLinks(tx, {
        workspaceId: params.workspaceId,
        entityType: "Action",
        entityId: updated.id,
        documentIds: params.evidenceDocumentIds,
        purpose: "completion_evidence",
      })
      : [];

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.updated",
      entityType: "Action",
      entityId: updated.id,
      meta: { fields: changedUpdateFields, version: updated.version, evidenceDocumentIds },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.updated",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: {
          actionId: updated.id,
          fields: changedUpdateFields,
          evidenceDocumentIds,
        },
      },
    ]);

    if (action.status !== "DRAFT" && (updated.status === "OPEN" || updated.status === "IN_PROGRESS") && !updated.isPrivate
      && updated.assigneeMemberId && action.assigneeMemberId !== updated.assigneeMemberId) {
      await appendEvents(tx, [{
        workspaceId: params.workspaceId,
        type: "action.assigned",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: {
          actionId: updated.id,
          assigneeMemberId: updated.assigneeMemberId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
        },
      }]);
    }

    if (action.status === "DRAFT" && updated.status !== "DRAFT" && !updated.isPrivate) {
      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId,
        action: "action.published",
        entityType: "Action",
        entityId: updated.id,
        meta: { title: updated.title },
      });
      await appendEvents(tx, [{
        workspaceId: params.workspaceId,
        type: "action.published",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: {
          actionId: updated.id,
          assigneeMemberId: updated.assigneeMemberId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
        },
      }]);
    }

    return updated;
  };
  return params._tx ? run(params._tx) : prisma.$transaction(run);
}

export async function assertCanAttachActionReference(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
}) {
  const membership = await requireWorkspaceOperation({ operation: "update_action", actor, workspaceId: params.workspaceId });
  const action = await prisma.action.findUnique({ where: { id: params.actionId } });
  invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");
  invariant(!action.archivedAt && !action.duplicateOfActionId, 400, "INVALID_STATE", "Archived actions cannot accept references.");
  if (action.status === "DRAFT") {
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
  } else {
    invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "This action cannot accept references.");
    requireCollaborativeWorkItemEditor(actor, membership, action);
  }
}

export async function attachActionReferenceDocument(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  documentId: string;
}) {
  await assertCanAttachActionReference(actor, params);
  const membership = await requireWorkspaceOperation({ operation: "update_action", actor, workspaceId: params.workspaceId });
  return prisma.$transaction(async (tx) => {
    await acquireWorkItemAdvisoryLock(tx, "Action", params.actionId);
    const action = await tx.action.findUnique({ where: { id: params.actionId } });
    invariant(action && action.workspaceId === params.workspaceId && !action.archivedAt && !action.duplicateOfActionId,
      404, "NOT_FOUND", "Action not found.");
    if (action.status === "DRAFT") {
      await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
    } else {
      invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "This action cannot accept references.");
      requireCollaborativeWorkItemEditor(actor, membership, action);
    }
    await createWorkItemEvidenceLinks(tx, {
      workspaceId: params.workspaceId,
      entityType: "Action",
      entityId: params.actionId,
      documentIds: [params.documentId],
      purpose: "reference",
    });
  });
}

export async function deleteAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  await requireWorkspaceOperation({ operation: "delete_action",
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Action",
    entityId: params.actionId,
    reason: "Archived from action delete path.",
  });

  return { id: params.actionId };
}

export async function publishAction(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  const membership = await requireWorkspaceOperation({ operation: "create_action",
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    await acquireWorkItemAdvisoryLock(tx, "Action", params.actionId);
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");
    invariant(!action.archivedAt && !action.duplicateOfActionId, 400, "INVALID_STATE", "Archived or resolved duplicate actions cannot be opened.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });
    if (action.status !== "DRAFT") {
      invariant(!action.isPrivate && ["OPEN", "IN_PROGRESS", "COMPLETED"].includes(action.status),
        400, "INVALID_STATE", "Only draft actions can be opened.");
      return action;
    }

    const assigneeMemberId = await resolveAssigneeMemberId(tx, params.workspaceId, action.assigneeMemberId);
    invariant(assigneeMemberId, 400, "INVALID_INPUT", "Assign an active human member before opening this Action.");

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Action", id: action.id }, before: action, allowSystemTransition: true });
    const updated = await tx.action.update({
      where: { id: params.actionId, workspaceId: params.workspaceId, archivedAt: null, duplicateOfActionId: null, status: "DRAFT" },
      data: { status: "OPEN", isPrivate: false, publishedAt: new Date() },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Action", id: updated.id }, content: updated, receipt });


    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.published",
      entityType: "Action",
      entityId: updated.id,
      meta: { title: updated.title },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.published",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: {
          actionId: updated.id,
          assigneeMemberId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
        },
      },
    ]);

    return updated;
  });
}

export async function returnActionToDraft(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  _membership?: import("@corgtex/shared").MembershipSummary | null;
}) {
  const membership = await requireWorkspaceOperation({ operation: "return_action_to_draft",
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    await acquireWorkItemAdvisoryLock(tx, "Action", params.actionId);
    const action = await tx.action.findUnique({
      where: { id: params.actionId },
    });

    invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");
    invariant(!action.archivedAt && !action.duplicateOfActionId, 400, "INVALID_STATE", "Archived or resolved duplicate actions cannot be returned to draft.");
    invariant(action.status === "OPEN" || action.status === "IN_PROGRESS" || action.status === "COMPLETED", 400, "INVALID_STATE", "Only open, in-progress, or completed actions can be returned to draft.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, resolvedMembership: membership });

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Action", id: action.id }, before: action, allowSystemTransition: true });
    const updated = await tx.action.update({
      where: { id: params.actionId, workspaceId: params.workspaceId, archivedAt: null, duplicateOfActionId: null, status: action.status },
      data: {
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        completedVia: null,
      },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Action", id: updated.id }, content: updated, receipt });


    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "action.returned_to_draft",
      entityType: "Action",
      entityId: updated.id,
      meta: { title: updated.title },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "action.returned_to_draft",
        aggregateType: "Action",
        aggregateId: updated.id,
        payload: { actionId: updated.id },
      },
    ]);

    return updated;
  });
}
