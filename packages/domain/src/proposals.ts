import { captureReadableDigestInputs } from "./digest-lineage";
import { WorkItemReadRelease, readableWorkItemPage, workItemAfter } from "./work-item-readable-page";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { Prisma, type ProposalResolutionOutcome, type ProposalStatus } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, isGlobalOperator, requireWorkspaceMembership } from "./auth";
import { getApprovalPolicy, ensureApprovalFlow, preserveApprovalFlowHistory, withdrawActiveApprovalFlowForSubject } from "./approvals";
import { AppError, invariant } from "./errors";
import { captureHumanArtifactInputAdvance, advanceHumanArtifactInputLineage, assertArtifactInputWriteFence, captureArtifactInputProof, captureArtifactInputSnapshotProof, captureImmutableArtifactInputProof, invalidateArtifactInputLineage, isArtifactInputProofReadable, lineageContentFingerprint, preserveUnknownArtifactInputSnapshot, currentArtifactInputRoots, currentArtifactInputRootsBatch, readableArtifactIds, recordArtifactInputLineage, type LineageInput, type LineageRoot } from "./source-lineage";
import type { ProducerLineageParams } from "./producer-lineage";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";
import { parsePermissionEpochProof } from "./source-permission-epochs";
import { privacyFilter } from "./privacy";
import { archiveFilterWhere, type ArchiveFilter } from "./archive";
import { requireDraftManager, requireCreationInputRoots } from "./draft-permissions";
import { requireProposalContentEditor } from "./collaborative-permissions";
import { humanMemberIdentityWhere, systemActorMemberIdentityWhere } from "./member-identity";
import { createWorkItemEvidenceLinks } from "./work-item-evidence";
import { acquireConstitutionCorpusAdvisoryLock } from "./constitutions";
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

/**
 * Proposal Lifecycle & Archive Invalidator Inventory:
 * The following Proposal lifecycle and archive writers in this file can invalidate a pending AI-summary update
 * (or concurrent edit) on a Proposal and must acquire the work_item_version advisory lock for the proposal
 * under the transaction before performing state guards or modifications:
 * 1. updateProposal (edits content; generates AI summary outside the lock after admission, then re-checks under lock)
 * 2. archiveProposal / deleteProposal (archives proposal, transitioning archivedAt)
 * 3. submitProposal (lifecycle transition DRAFT -> OPEN)
 * 4. returnProposalToDraft (lifecycle transition OPEN/RESOLVED -> DRAFT)
 * 5. reopenProposal (lifecycle transition RESOLVED -> OPEN)
 * 6. supportReopenResolvedProposals (batch lifecycle transition RESOLVED -> OPEN, locks in deterministic proposal ID order)
 * 7. publishProposal (lifecycle transition isPrivate -> false)
 * 8. resolveProposal (lifecycle transition DRAFT/OPEN -> RESOLVED)
 */
async function acquireProposalAdvisoryLock(tx: Prisma.TransactionClient, proposalId: string) {
  await acquireWorkItemAdvisoryLock(tx, "Proposal", proposalId);
}

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
  duplicateGuard?: DuplicateGuardOptions | null;
  lineageInputs?: LineageInput[];
  lineageRoots?: LineageRoot[];
};

type CreateProposalFromTensionParams = Omit<CreateProposalParams, "title" | "bodyMd" | "sourceTensionId"> & {
  sourceTensionId: string;
  title?: string | null;
  bodyMd?: string | null;
};

function normalizeIds(ids?: string[] | null) {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
}

function isPrismaNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2025";
}

async function preserveProposalResetHistory(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  proposal: { id: string; [key: string]: unknown }) {
  const policies = await tx.policyCorpus.findMany({ where: { workspaceId, proposalId: proposal.id } });
  for (const { kind, row } of [
    { kind: "Proposal" as const, row: proposal },
    ...policies.map((row) => ({ kind: "PolicyCorpus" as const, row })),
  ]) {
    try {
      await captureArtifactInputSnapshotProof(actor, workspaceId,
        { kind, id: row.id, fingerprint: lineageContentFingerprint(kind, row) }, tx);
    } catch (error) {
      if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
      await preserveUnknownArtifactInputSnapshot(tx, workspaceId, { kind, id: row.id }, row);
    }
  }
}

async function advanceProposalResetProof(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  before: { id: string; [key: string]: unknown }, after: unknown, admission?: object) {
  try {
    return await advanceHumanArtifactInputLineage({ tx, actor, workspaceId,
      artifact: { kind: "Proposal", id: before.id }, before, after, admission, allowSystemTransition: true });
  } catch (error) {
    if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
    await invalidateArtifactInputLineage({ tx, workspaceId,
      artifact: { kind: "Proposal", id: before.id }, content: after });
    return false;
  }
}

async function writeProposalApprovalFlow(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  before: { id: string; [key: string]: unknown }, data: Prisma.ApprovalFlowUpdateInput) {
  const updated = await tx.approvalFlow.update({ where: { id: before.id }, data });
  // Clearing decisions/objections removes their old receipt roots. Preserve the
  // content transition, but do not silently make a legacy/reset flow provable.
  if (data.resultJson === Prisma.JsonNull) {
    await invalidateArtifactInputLineage({ tx, workspaceId,
      artifact: { kind: "ApprovalFlow", id: before.id }, content: updated });
  } else {
    await advanceHumanArtifactInputLineage({ tx, actor, workspaceId,
      artifact: { kind: "ApprovalFlow", id: before.id }, before, after: updated, allowSystemTransition: true });
  }
  return updated;
}

async function activateProposalApprovalFlow(tx: Prisma.TransactionClient, params: {
  actor: AppActor;
  workspaceId: string;
  proposalId: string;
  policy: ProposalApprovalPolicy;
  openedAt: Date;
}) {
  const flow = await ensureApprovalFlow(tx, {
    actor: params.actor,
    workspaceId: params.workspaceId,
    subjectType: "PROPOSAL",
    subjectId: params.proposalId,
    policy: params.policy,
    createdByUserId: params.actor.kind === "user" ? params.actor.user.id : null,
  });

  const updated = await tx.approvalFlow.update({
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

  await advanceHumanArtifactInputLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
    artifact: { kind: "ApprovalFlow", id: flow.id }, before: flow, after: updated, allowSystemTransition: true });
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
  });

  invariant(tension, 404, "NOT_FOUND", "Source tension not found.");
  invariant((await readableArtifactIds(actor, workspaceId, "Tension", [tension], tx)).has(tension.id), 404, "NOT_FOUND", "Source tension not found.");
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
  if (actionIds.length === 0) return [];

  const actions = await tx.action.findMany({
    where: {
      id: { in: actionIds },
      workspaceId,
      archivedAt: null,
      ...privacyFilter(actor, membership),
    },
  });

  invariant(actions.length === actionIds.length, 404, "NOT_FOUND", "Related action not found.");
  const permittedIds = await readableArtifactIds(actor, workspaceId, "Action", actions, tx);
  invariant(actions.every((action) => permittedIds.has(action.id)), 404, "NOT_FOUND", "Related action not found.");
  invariant(!actions.some((action) => action.proposalId), 400, "INVALID_STATE", "Related action is already linked to a proposal.");

  return actions;
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

async function isActiveProposalCircle(tx: Prisma.TransactionClient, workspaceId: string, circleId?: string | null) {
  if (!circleId) return true;
  const circle = await tx.circle.findUnique({
    where: { id: circleId },
    select: { workspaceId: true, archivedAt: true },
  });
  return Boolean(circle && circle.workspaceId === workspaceId && !circle.archivedAt);
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

function workItemOrderBy(sort: WorkItemSort | undefined): Prisma.ProposalOrderByWithRelationInput[] {
  if (sort === "alpha") {
    return [{ title: "asc" }, { createdAt: "desc" }, { id: "desc" }];
  }
  if (sort === "date") {
    return [{ createdAt: "desc" }, { id: "desc" }];
  }
  return [{ priority: "desc" }, { createdAt: "desc" }, { id: "desc" }];
}

async function readableProposalRelations<T extends {
  id: string; circleId: string | null; ownerMemberId: string | null; authorUserId: string; meetingId: string | null;
  circle: ({ id: string; workspaceId: string; name: string } & Record<string, unknown>) | null;
  ownerMember: ({ id: string; workspaceId: string; isActive: boolean; user: { id: string; email: string; displayName: string | null } } & Record<string, unknown>) | null;
  author: ({ id: string; email: string; displayName: string | null } & Record<string, unknown>) | null;
}>(actor: AppActor, workspaceId: string, proposal: T, membership: MembershipSummary | null, release: WorkItemReadRelease) {
  async function capture<R extends {id: string}>(kind: import("./source-lineage").LineageKind, rows: R[]) {
    const captured = await release.observeRead(() => captureReadableDigestInputs({actor, workspaceId, kind, records: rows}));
    release.add(captured.roots);
    return captured.records;
  }
  async function relations<R extends {id: string}, S>(kind: "Action" | "Tension" | "AdviceRequest",
    load: (after: string | undefined) => Promise<R[]>, project: (row: R) => S) {
    const result: S[] = [];
    let after: string | undefined;
    for (;;) {
      const rows = await load(after);
      invariant(rows.length <= 100 && rows.every(row => !after || row.id > after),
        409, "SOURCE_CHANGED", "Proposal relations changed during pagination.");
      const next = rows.at(-1)?.id;
      // Negative discovery only: every surviving canonical row still passes the
      // full evaluator and retains its original proof through the final release.
      const heads = await currentArtifactInputRootsBatch(prisma, workspaceId, kind, rows);
      const candidates = rows.filter(row => heads.get(row.id) != null);
      const admitted = kind === "AdviceRequest" ? await capture(kind, candidates) : await release.admit(kind, candidates);
      result.push(...admitted.map(project));
      if (rows.length < 100) break;
      after = next;
    }
    return result;
  }
  const tensions = await relations("Tension", after => prisma.tension.findMany({where: {
    workspaceId, proposalId: proposal.id, ...privacyFilter(actor, membership), ...(after ? {id: {gt: after}} : {}),
  }, orderBy: {id: "asc"}, take: 100}), row => ({id: row.id, title: row.title, status: row.status}));
  const actions = await relations("Action", after => prisma.action.findMany({where: {
    workspaceId, proposalId: proposal.id, ...privacyFilter(actor, membership), ...(after ? {id: {gt: after}} : {}),
  }, orderBy: {id: "asc"}, take: 100}), row => ({id: row.id, title: row.title, status: row.status}));
  const requests = await relations("AdviceRequest", after => prisma.adviceRequest.findMany({where: {
    workspaceId, process: {workspaceId, proposalId: proposal.id}, ...(after ? {id: {gt: after}} : {}),
  }, orderBy: {id: "asc"}, take: 100}), row => ({status: row.status}));
  const meeting = proposal.meetingId ? await prisma.meeting.findFirst({where: {id: proposal.meetingId, workspaceId}}) : null;
  const [circles, owners, authors, ownerUsers, meetings] = await Promise.all([
    capture("Circle", proposal.circle?.workspaceId === workspaceId ? [proposal.circle] : []),
    capture("Member", proposal.ownerMember?.workspaceId === workspaceId && proposal.ownerMember.isActive
      ? [{...proposal.ownerMember, user: {id: proposal.ownerMember.user.id, email: proposal.ownerMember.user.email, displayName: proposal.ownerMember.user.displayName}}] : []),
    capture("User", proposal.author ? [proposal.author] : []),
    capture("User", proposal.ownerMember?.user ? [proposal.ownerMember.user] : []),
    capture("Meeting", meeting ? [meeting] : []),
  ]);
  const circle = circles[0] ? {id: circles[0].id, name: circles[0].name} : null;
  const ownerMember = owners[0] && ownerUsers[0] ? {id: owners[0].id, user: {
    id: ownerUsers[0].id, email: ownerUsers[0].email, displayName: ownerUsers[0].displayName}} : null;
  const author = authors[0] ? {id: authors[0].id, email: authors[0].email, displayName: authors[0].displayName}
    : {id: "", email: "", displayName: null};
  return {...proposal, circleId: circle ? proposal.circleId : null, ownerMemberId: ownerMember ? proposal.ownerMemberId : null,
    authorUserId: author.id, meetingId: meetings.length ? proposal.meetingId : null, circle, ownerMember, author,
    tensions, actions, adviceProcess: {requests}};
}

export async function listProposals(actor: AppActor, workspaceId: string, opts?: ListProposalsOptions) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  invariant(Number.isInteger(take) && take >= 0 && take <= 5000 && Number.isInteger(skip) && skip >= 0,
    400, "INVALID_INPUT", "Proposal pagination is invalid.");
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
  invariant(memberIds.length <= 5000, 400, "INVALID_INPUT", "Too many proposal member filters.");
  const release = new WorkItemReadRelease(actor,workspaceId);
  const members = memberIds.length ? await prisma.member.findMany({where:{id:{in:memberIds},workspaceId,isActive:true},
    include:{user:{select:{id:true,email:true,displayName:true,bio:true,avatarUrl:true,linkedinUrl:true,websiteUrl:true,createdAt:true,updatedAt:true}}}}) : [];
  const [visibleMembers,visibleUsers]=await Promise.all([
    readableArtifactIds(actor,workspaceId,"Member",members),readableArtifactIds(actor,workspaceId,"User",members.map(member=>member.user))]);
  const permittedMembers=members.filter(member=>visibleMembers.has(member.id)&&visibleUsers.has(member.userId));
  await release.observe("Member",permittedMembers.map(member=>({...member,user:{id:member.user.id,email:member.user.email,displayName:member.user.displayName}})));
  await release.observe("User",permittedMembers.map(member=>member.user));
  const memberSet=new Set(permittedMembers.map(member=>member.id)),authorUsers=new Set(permittedMembers.map(member=>member.userId));
  const actionMemberFilter:Prisma.ActionWhereInput={OR:[{assigneeMemberId:{in:[...memberSet]}},{authorUserId:{in:[...authorUsers]}}]};
  const tensionMemberFilter:Prisma.TensionWhereInput={OR:[{assigneeMemberId:{in:[...memberSet]}},{raisedByMemberId:{in:[...memberSet]}},{authorUserId:{in:[...authorUsers]}}]};
  const page=await readableWorkItemPage<import("@prisma/client").Proposal>({actor,workspaceId,release,kind:"Proposal",take,skip,
    load:after=>prisma.proposal.findMany({where:after?{AND:[where,workItemAfter(after,opts?.sort)]}:where,
      orderBy:workItemOrderBy(opts?.sort),take:100}),
    admit:async candidate=>{
      if(circleIds.length || opts?.circleId) {
        const circle=candidate.circleId?await prisma.circle.findFirst({where:{id:candidate.circleId,workspaceId}}):null;
        if(!circle || !(await readableArtifactIds(actor,workspaceId,"Circle",[circle])).has(circle.id)) return false;
        await release.observe("Circle",[circle]);
      }
      if(!memberIds.length || memberSet.has(candidate.ownerMemberId??"") || authorUsers.has(candidate.authorUserId)) return true;
      if(!memberSet.size) return false;
      if(await release.has("Action",(afterId,take)=>prisma.action.findMany({
        where:{AND:[{workspaceId,proposalId:candidate.id,...privacyFilter(actor,membership)},actionMemberFilter,
          ...(afterId?[{id:{gt:afterId}}]:[])]},orderBy:{id:"asc"},take}))) return true;
      return release.has("Tension",(afterId,take)=>prisma.tension.findMany({
        where:{AND:[{workspaceId,proposalId:candidate.id,...privacyFilter(actor,membership)},tensionMemberFilter,
          ...(afterId?[{id:{gt:afterId}}]:[])]},orderBy:{id:"asc"},take}));
    }});
  const hydrated=page.items.length?await prisma.proposal.findMany({where:{AND:[where,{id:{in:page.items.map(row=>row.id)}}]},
      include: {
        author: {
          select: {
            id: true,
            displayName: true,
            email: true,
            bio: true,
            avatarUrl: true,
            linkedinUrl: true,
            websiteUrl: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        ownerMember: {
          include: {
            user: {
              select: {
                id: true,
                displayName: true,
                email: true,
                bio: true,
                avatarUrl: true,
                linkedinUrl: true,
                websiteUrl: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
        circle: true,
      },
  }):[];
  const byId=new Map(hydrated.map(row=>[row.id,row]));
  const selected=page.items.flatMap(row=>{const loaded=byId.get(row.id);return loaded?[{...loaded,...row}]:[];});
  const items=await Promise.all(selected.map(proposal=>readableProposalRelations(actor,workspaceId,proposal,membership,release)));
  const finalIds=await readableArtifactIds(actor,workspaceId,"Proposal",selected);
  const admitted=items.filter(row=>finalIds.has(row.id));
  return release.finish({items:admitted,total:page.total-(page.items.length-admitted.length),take,skip});
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
      author: { select: { id: true, displayName: true, email: true, bio: true, avatarUrl: true, linkedinUrl: true, websiteUrl: true, createdAt: true, updatedAt: true } },
      ownerMember: {
        include: {
          user: {
            select: { id: true, displayName: true, email: true, bio: true, avatarUrl: true, linkedinUrl: true, websiteUrl: true, createdAt: true, updatedAt: true },
          },
        },
      },
      circle: true,
    },
  });
  invariant(proposal, 404, "NOT_FOUND", "Proposal not found.");
  const release = new WorkItemReadRelease(actor, params.workspaceId);
  invariant((await release.admit("Proposal", [proposal])).length === 1, 404, "NOT_FOUND", "Proposal not found.");
  return release.finish(await readableProposalRelations(actor, params.workspaceId, proposal, membership, release));
}

type SourceTensionForLinking = NonNullable<Awaited<ReturnType<typeof loadVisibleSourceTension>>>;
type RelatedActionForLinking = Awaited<ReturnType<typeof validateRelatedActions>>[number];

async function linkProposalSourcesAndActions(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: MembershipSummary | null,
  params: {
    workspaceId: string;
    proposalId: string;
    sourceTension?: SourceTensionForLinking | null;
    relatedActions?: RelatedActionForLinking[] | null;
  },
) {
  if (params.sourceTension) {
    const currentVersion = params.sourceTension.version;
    const newVersion = await recordWorkItemVersion(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Tension",
      entityId: params.sourceTension.id,
      currentVersion,
      changedFields: ["proposalId"],
      previousState: pickJsonSnapshot(params.sourceTension as unknown as Record<string, unknown>, [
        "id",
        "workspaceId",
        "title",
        "bodyMd",
        "circleId",
        "assigneeMemberId",
        "raisedByMemberId",
        "proposalId",
        "priority",
        "status",
        "version",
      ]),
    });

    const tensionWhere: Record<string, unknown> = {
      id: params.sourceTension.id,
      workspaceId: params.workspaceId,
      archivedAt: null,
      proposalId: null,
      version: currentVersion,
      ...privacyFilter(actor, membership),
    };

    try {
      const updated = await tx.tension.update({
        where: tensionWhere as Prisma.TensionWhereUniqueInput,
        data: {
          proposalId: params.proposalId,
          version: newVersion,
        },
      });
      await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "Tension", id: params.sourceTension.id }, before: params.sourceTension, after: updated, allowSystemTransition: true });
    } catch (error) {
      if (isPrismaNotFoundError(error)) {
        invariant(false, 409, "VERSION_CONFLICT", "The source tension changed before this update could be applied. Please refresh and try again.");
      }
      throw error;
    }
  }

  if (params.relatedActions && params.relatedActions.length > 0) {
    const sortedActions = [...params.relatedActions].sort((a, b) => a.id.localeCompare(b.id));
    for (const action of sortedActions) {
      const currentVersion = action.version;
      const newVersion = await recordWorkItemVersion(tx, actor, {
        workspaceId: params.workspaceId,
        entityType: "Action",
        entityId: action.id,
        currentVersion,
        changedFields: ["proposalId"],
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

      const actionWhere: Record<string, unknown> = {
        id: action.id,
        workspaceId: params.workspaceId,
        archivedAt: null,
        proposalId: null,
        version: currentVersion,
        ...privacyFilter(actor, membership),
      };

      try {
        const updated = await tx.action.update({
          where: actionWhere as Prisma.ActionWhereUniqueInput,
          data: {
            proposalId: params.proposalId,
            version: newVersion,
          },
        });
        await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
          artifact: { kind: "Action", id: action.id }, before: action, after: updated, allowSystemTransition: true });
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          invariant(false, 409, "VERSION_CONFLICT", "A related action changed before this update could be applied. Please refresh and try again.");
        }
        throw error;
      }
    }
  }
}

async function applyProposalDuplicateUpdate(actor: AppActor, params: CreateProposalParams, proposalId: string) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  const sourceTension = await loadVisibleSourceTension(prisma as unknown as Prisma.TransactionClient, actor, membership, params.workspaceId, params.sourceTensionId);
  const relatedActions = await validateRelatedActions(prisma as unknown as Prisma.TransactionClient, actor, membership, params.workspaceId, params.relatedActionIds);
  const existing = await getProposal(actor, { workspaceId: params.workspaceId, proposalId });
  const mergedBody = duplicateGuardMergeText(existing.bodyMd, params.bodyMd);
  const updateParams: Parameters<typeof updateProposal>[1] = {
    workspaceId: params.workspaceId,
    proposalId,
  };
  if (mergedBody && mergedBody !== existing.bodyMd) updateParams.bodyMd = mergedBody;
  if (!existing.summary && params.summary) updateParams.summary = params.summary;
  if (!existing.circleId && params.circleId) updateParams.circleId = params.circleId;
  if (!existing.ownerMemberId && params.ownerMemberId) updateParams.ownerMemberId = params.ownerMemberId;
  if (params.priority !== undefined && params.priority !== null && existing.priority !== params.priority) updateParams.priority = params.priority;
  const hasContentUpdate = Object.keys(updateParams).length > 2;
  if (hasContentUpdate) updateParams.expectedVersion = existing.version;
  const proposal = hasContentUpdate ? await updateProposal(actor, updateParams) : existing;

  if (sourceTension || relatedActions.length > 0) {
    await prisma.$transaction(async (tx) => {
      await linkProposalSourcesAndActions(tx, actor, membership, {
        workspaceId: params.workspaceId,
        proposalId,
        sourceTension,
        relatedActions,
      });
    });
  }

  return proposal;
}

async function readableProposalSourceIds(actor: AppActor, workspaceId: string, params: { sourceTensionId?: string | null; relatedActionIds?: string[] | null }, sourceTension?: { id: string; [key: string]: unknown }, tx?: Prisma.TransactionClient) {
  const client = (tx ?? prisma) as Prisma.TransactionClient;
  const actionIds = normalizeIds(params.relatedActionIds);
  const tensionId = params.sourceTensionId?.trim();
  const [actions, tension] = await Promise.all([
    actionIds.length ? client.action.findMany({ where: { workspaceId, id: { in: actionIds }, archivedAt: null } }) : [],
    sourceTension ?? (tensionId ? client.tension.findFirst({ where: { workspaceId, id: tensionId, archivedAt: null } }) : null),
  ]);
  const [actionProof, tensionProof] = await Promise.all([
    tx ? readableArtifactIds(actor, workspaceId, "Action", actions, tx) : readableArtifactIds(actor, workspaceId, "Action", actions),
    tx ? readableArtifactIds(actor, workspaceId, "Tension", tension ? [tension] : [], tx) : readableArtifactIds(actor, workspaceId, "Tension", tension ? [tension] : []),
  ]);
  return [...(tension && tensionProof.has(tension.id) ? [tension.id] : []), ...actions.filter((row) => actionProof.has(row.id)).map((row) => row.id)];
}

async function readableProposalDuplicateRows(actor: AppActor, workspaceId: string, rows: unknown[], tx?: Prisma.TransactionClient) {
  const client = (tx ?? prisma) as Prisma.TransactionClient;
  const records = rows as Array<{ id: string; [key: string]: unknown }>;
  const ids = await (tx ? readableArtifactIds(actor, workspaceId, "Proposal", records, tx)
    : readableArtifactIds(actor, workspaceId, "Proposal", records));
  const visible = records.filter((row) => ids.has(row.id));
  const actionIds = visible.flatMap((row) => (row.actions as Array<{ id: string }> | undefined)?.map((action) => action.id) ?? []);
  const tensionIds = visible.flatMap((row) => (row.tensions as Array<{ id: string }> | undefined)?.map((tension) => tension.id) ?? []);
  const [actions, tensions] = await Promise.all([
    actionIds.length ? client.action.findMany({ where: { workspaceId, id: { in: actionIds }, archivedAt: null } }) : [],
    tensionIds.length ? client.tension.findMany({ where: { workspaceId, id: { in: tensionIds }, archivedAt: null } }) : [],
  ]);
  const [permittedActions, permittedTensions] = await Promise.all([
    tx ? readableArtifactIds(actor, workspaceId, "Action", actions, tx) : readableArtifactIds(actor, workspaceId, "Action", actions),
    tx ? readableArtifactIds(actor, workspaceId, "Tension", tensions, tx) : readableArtifactIds(actor, workspaceId, "Tension", tensions),
  ]);
  return visible.map((row) => ({ ...row,
    actions: (row.actions as Array<{ id: string }> | undefined)?.filter((action) => permittedActions.has(action.id)),
    tensions: (row.tensions as Array<{ id: string }> | undefined)?.filter((tension) => permittedTensions.has(tension.id)),
  }));
}

export async function createProposal(actor: AppActor, params: CreateProposalParams, transaction?: Prisma.TransactionClient) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    tx: transaction,
  });
  params = { ...params, lineageRoots: await requireCreationInputRoots({ actor, workspaceId: params.workspaceId,
    isPrivate: params.isPrivate ?? true, roots: params.lineageRoots, tx: transaction }) };

  invariant(!transaction || !["use_existing", "update_existing"].includes(params.duplicateGuard?.resolution ?? ""),
    400, "DUPLICATE_GUARD_TRANSACTION_UNSUPPORTED", "This duplicate resolution cannot join the supplied transaction.");
  invariant(!transaction || params.includeAiSummary !== true, 400, "AI_SUMMARY_TRANSACTION_UNSUPPORTED",
    "AI summary generation cannot run inside a supplied transaction.");

  const title = params.title.trim();
  const bodyMd = params.bodyMd.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Proposal title is required.");
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Proposal body is required.");
  const duplicateDecision = await checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "Proposal",
    title,
    body: bodyMd,
    circleId: params.circleId,
    ownerMemberId: params.ownerMemberId,
    meetingId: params.meetingId,
    sourceIds: params.duplicateGuard ? await readableProposalSourceIds(actor, params.workspaceId, params, undefined, transaction) : [],
    actorUserId: actor.kind === "user" ? actor.user.id : null,
    membershipId: membership?.id ?? null,
    includePrivate: actor.kind === "user" && membership?.role === "ADMIN",
  }, params.duplicateGuard, transaction, (rows) => readableProposalDuplicateRows(actor, params.workspaceId, rows, transaction));
  invariant(!transaction || !duplicateDecision || duplicateDecision.resolution === "create_new",
    400, "DUPLICATE_GUARD_TRANSACTION_UNSUPPORTED", "This duplicate resolution cannot join the supplied transaction.");
  if (duplicateDecision?.resolution === "use_existing") {
    return getProposal(actor, { workspaceId: params.workspaceId, proposalId: duplicateDecision.match.entityId });
  }
  if (duplicateDecision?.resolution === "update_existing") {
    return applyProposalDuplicateUpdate(actor, params, duplicateDecision.match.entityId);
  }
  const summary = params.includeAiSummary === true
    ? await generateProposalSummary({ workspaceId: params.workspaceId, title, bodyMd })
    : params.summary?.trim() || null;
  const isPrivate = params.isPrivate ?? true;
  const openedAt = isPrivate ? null : new Date();
  const policy = isPrivate ? null : transaction
    ? await transaction.approvalPolicy.findUnique({ where: { workspaceId_subjectType: { workspaceId: params.workspaceId, subjectType: "PROPOSAL" } } })
    : await getApprovalPolicy(params.workspaceId, "PROPOSAL");
  if (!isPrivate) invariant(policy, 404, "NOT_FOUND", "Missing approval policy for PROPOSAL.");

  const create = async (tx: Prisma.TransactionClient) => {
    await requireCreationInputRoots({ actor, workspaceId: params.workspaceId, isPrivate: params.isPrivate ?? true, roots: params.lineageRoots, tx });
    const sourceTension = await loadVisibleSourceTension(tx, actor, membership, params.workspaceId, params.sourceTensionId);
    const relatedActions = await validateRelatedActions(tx, actor, membership, params.workspaceId, params.relatedActionIds);
    const relatedActionIds = relatedActions.map((action) => action.id);
    let authorUserId: string;
    if (actor.kind === "user") authorUserId = actor.user.id;
    else if (transaction) {
      const systemMember = await tx.member.findFirst({ where: {
        workspaceId: params.workspaceId, isActive: true, role: "ADMIN", ...systemActorMemberIdentityWhere(),
      }, select: { userId: true } });
      const adminMember = systemMember ?? await tx.member.findFirst({ where: {
        workspaceId: params.workspaceId, isActive: true, role: "ADMIN",
      }, select: { userId: true } });
      invariant(adminMember, 500, "CONFIG_ERROR", "Workspace has no admin member available for system actions.");
      authorUserId = adminMember.userId;
    } else authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);
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

    if (params.lineageInputs || params.lineageRoots || (actor.kind === "user" && !params.sourceTensionId && !params.meetingId)) {
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "Proposal", id: proposal.id }, content: proposal,
        origin: params.lineageInputs?.length || params.lineageRoots?.length ? "DERIVED" : "HUMAN_ORIGINAL",
        inputs: params.lineageInputs ?? [], inheritedRoots: params.lineageRoots,
      });
    }

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Proposal",
      entityId: proposal.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Proposal", proposal),
    });

    if (sourceTension || relatedActions.length > 0) {
      await linkProposalSourcesAndActions(tx, actor, membership, {
        workspaceId: params.workspaceId,
        proposalId: proposal.id,
        sourceTension,
        relatedActions,
      });
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
          ...duplicateGuardAuditMeta(duplicateDecision),
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
  };
  return transaction ? create(transaction) : prisma.$transaction(create);
}

export async function createProposalFromTension(actor: AppActor, params: CreateProposalFromTensionParams) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  params = { ...params, lineageRoots: await requireCreationInputRoots({ actor, workspaceId: params.workspaceId,
    isPrivate: params.isPrivate ?? true, roots: params.lineageRoots }) };

  let duplicateDecision: Awaited<ReturnType<typeof checkWorkspaceDuplicateGuard>> = null;
  if (params.duplicateGuard != null) {
    const sourceTensionForGuard = await loadVisibleSourceTension(prisma as unknown as Prisma.TransactionClient, actor, membership, params.workspaceId, params.sourceTensionId);
    invariant(sourceTensionForGuard, 404, "NOT_FOUND", "Source tension not found.");
    const draftForGuard = proposalDraftFromTension(sourceTensionForGuard, params);
    duplicateDecision = await checkWorkspaceDuplicateGuard({
      workspaceId: params.workspaceId,
      entityType: "Proposal",
      title: draftForGuard.title,
      body: draftForGuard.bodyMd,
      circleId: params.circleId ?? sourceTensionForGuard.circleId,
      ownerMemberId: params.ownerMemberId,
      meetingId: params.meetingId ?? sourceTensionForGuard.meetingId,
      sourceIds: await readableProposalSourceIds(actor, params.workspaceId, params, sourceTensionForGuard),
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      membershipId: membership?.id ?? null,
      includePrivate: actor.kind === "user" && membership?.role === "ADMIN",
    }, params.duplicateGuard, undefined, (rows) => readableProposalDuplicateRows(actor, params.workspaceId, rows));
    if (duplicateDecision?.resolution === "use_existing") {
      return getProposal(actor, { workspaceId: params.workspaceId, proposalId: duplicateDecision.match.entityId });
    }
    if (duplicateDecision?.resolution === "update_existing") {
      return applyProposalDuplicateUpdate(actor, {
        ...params,
        title: draftForGuard.title,
        summary: draftForGuard.summary,
        bodyMd: draftForGuard.bodyMd,
        priority: params.priority ?? sourceTensionForGuard.priority ?? null,
      }, duplicateDecision.match.entityId);
    }
  }

  const isPrivate = params.isPrivate ?? true;
  const openedAt = isPrivate ? null : new Date();
  const policy = isPrivate ? null : await getApprovalPolicy(params.workspaceId, "PROPOSAL");

  return prisma.$transaction(async (tx) => {
    await requireCreationInputRoots({ actor, workspaceId: params.workspaceId, isPrivate: params.isPrivate ?? true, roots: params.lineageRoots, tx });
    const sourceTension = await loadVisibleSourceTension(tx, actor, membership, params.workspaceId, params.sourceTensionId);
    invariant(sourceTension, 404, "NOT_FOUND", "Source tension not found.");
    const relatedActions = await validateRelatedActions(tx, actor, membership, params.workspaceId, params.relatedActionIds);
    const relatedActionIds = relatedActions.map((action) => action.id);
    const sourceRoots = await captureArtifactInputSnapshotProof(actor, params.workspaceId, { kind: "Tension", id: sourceTension.id }, tx);
    const relatedRoots: LineageRoot[] = [];
    for (const action of relatedActions) relatedRoots.push(...await captureArtifactInputSnapshotProof(actor, params.workspaceId, { kind: "Action", id: action.id }, tx));
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

    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, content: proposal, origin: "DERIVED",
      inputs: params.lineageInputs ?? [], inheritedRoots: [...sourceRoots, ...relatedRoots, ...(params.lineageRoots ?? [])] });

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Proposal",
      entityId: proposal.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Proposal", proposal),
    });

    await linkProposalSourcesAndActions(tx, actor, membership, {
      workspaceId: params.workspaceId,
      proposalId: proposal.id,
      sourceTension,
      relatedActions,
    });

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
          ...duplicateGuardAuditMeta(duplicateDecision),
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

type UpdateProposalParams = {
  workspaceId: string;
  proposalId: string;
  title?: string;
  summary?: string | null;
  includeAiSummary?: boolean;
  bodyMd?: string;
  priority?: number;
  circleId?: string | null;
  ownerMemberId?: string | null;
  expectedVersion?: number;
};

const PROPOSAL_UPDATE_VERSION_CONFLICT_MESSAGE = "The record changed before this update could be applied. Please refresh and try again.";

function requireUpdateProposalEditable(
  actor: AppActor,
  membership: MembershipSummary | null,
  proposal: { archivedAt: Date | null; status: ProposalStatus } & Parameters<typeof requireProposalContentEditor>[2],
) {
  invariant(!proposal.archivedAt, 400, "INVALID_STATE", "Archived proposals cannot be edited.");
  if (proposal.status === "DRAFT") {
    requireProposalContentEditor(actor, membership, proposal);
  } else {
    invariant(proposal.status === "OPEN", 400, "INVALID_STATE", "Only draft or open proposals can be edited.");
    requireProposalContentEditor(actor, membership, proposal);
  }
}

function requireValidExpectedVersion(expectedVersion: number, currentVersion: number) {
  invariant(Number.isInteger(expectedVersion) && expectedVersion > 0, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
  invariant(expectedVersion === currentVersion, 409, "VERSION_CONFLICT", PROPOSAL_UPDATE_VERSION_CONFLICT_MESSAGE);
}

function proposalEditsContent(params: UpdateProposalParams) {
  return params.title !== undefined
    || params.summary !== undefined
    || params.bodyMd !== undefined
    || params.priority !== undefined
    || params.circleId !== undefined
    || params.ownerMemberId !== undefined
    || params.includeAiSummary !== undefined;
}

function requireExpectedVersionForProposalContent(params: UpdateProposalParams, currentVersion: number) {
  if (proposalEditsContent(params)) {
    invariant(params.expectedVersion !== undefined, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
  }
  if (params.expectedVersion !== undefined) {
    requireValidExpectedVersion(params.expectedVersion, currentVersion);
  }
}

type UpdateProposalAiAdmission = {
  data: Record<string, unknown>;
  effectiveTitle: string;
  effectiveBodyMd: string;
  status: ProposalStatus;
  isPrivate: boolean;
};

async function runUpdateProposalTransaction(
  actor: AppActor,
  membership: MembershipSummary | null,
  params: UpdateProposalParams,
  aiAdmission: UpdateProposalAiAdmission | null,
) {
  return prisma.$transaction(async (tx) => {
    await acquireProposalAdvisoryLock(tx, params.proposalId);

    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "Proposal", [proposal], tx)).has(proposal.id),
      404, "NOT_FOUND", "Proposal not found.");
    const priorRoots = await currentArtifactInputRoots(tx, params.workspaceId,
      { kind: "Proposal", id: proposal.id }, proposal);
    if (aiAdmission) {
      // Drift checks: any inference input derived from stored state (fields the
      // caller did not supply) must still match the authoritative reloaded
      // state, and the lifecycle must not have moved since admission, otherwise
      // the generated summary is stale.
      const titleDrift = params.title === undefined && proposal.title !== aiAdmission.effectiveTitle;
      const bodyDrift = params.bodyMd === undefined && proposal.bodyMd !== aiAdmission.effectiveBodyMd;
      invariant(
        !proposal.archivedAt
          && proposal.status === aiAdmission.status
          && proposal.isPrivate === aiAdmission.isPrivate
          && !titleDrift
          && !bodyDrift,
        409,
        "VERSION_CONFLICT",
        PROPOSAL_UPDATE_VERSION_CONFLICT_MESSAGE,
      );
      invariant(
        await isActiveProposalCircle(tx, params.workspaceId, params.circleId),
        409, "VERSION_CONFLICT", PROPOSAL_UPDATE_VERSION_CONFLICT_MESSAGE,
      );
    }
    requireUpdateProposalEditable(actor, membership, proposal);

    requireExpectedVersionForProposalContent(params, proposal.version);

    const data: Record<string, unknown> = aiAdmission ? { ...aiAdmission.data } : {};
    if (!aiAdmission) {
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
      if (params.includeAiSummary === false) {
        data.summary = null;
      } else if (params.summary !== undefined) {
        data.summary = params.summary?.trim() || null;
      }
      if (params.priority !== undefined) data.priority = params.priority;
      if (params.circleId !== undefined) data.circleId = params.circleId || null;
    }
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

    const updateWhere: Record<string, unknown> = {
      id: params.proposalId,
      workspaceId: params.workspaceId,
      archivedAt: null,
      status: proposal.status,
    };
    if (proposal.isPrivate !== undefined) updateWhere.isPrivate = proposal.isPrivate ?? false;
    updateWhere.version = params.expectedVersion ?? proposal.version;

    let updated;
    try {
      updated = await tx.proposal.update({
        where: updateWhere as Prisma.ProposalWhereUniqueInput,
        data,
      });
    } catch (error) {
      if (isPrismaNotFoundError(error)) {
        invariant(false, 409, "VERSION_CONFLICT", PROPOSAL_UPDATE_VERSION_CONFLICT_MESSAGE);
      }
      throw error;
    }
    if (priorRoots) await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: updated.id }, content: updated,
      origin: priorRoots.length ? "DERIVED" : "HUMAN_ORIGINAL", inputs: [], inheritedRoots: priorRoots,
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

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "proposal.updated",
        aggregateType: "Proposal",
        aggregateId: updated.id,
        payload: { proposalId: updated.id, fields: changedUpdateFields },
      },
    ]);

    return updated;
  });
}

export async function updateProposal(actor: AppActor, params: UpdateProposalParams) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  if (params.includeAiSummary === true) {
    // Admission phase: validate everything before any model gateway call,
    // without holding a transaction or the proposal advisory lock.
    const admissionProposal = await prisma.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(admissionProposal && admissionProposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "Proposal", [admissionProposal])).has(admissionProposal.id),
      404, "NOT_FOUND", "Proposal not found.");
    requireUpdateProposalEditable(actor, membership, admissionProposal);
    requireExpectedVersionForProposalContent(params, admissionProposal.version);

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
    if (params.priority !== undefined) data.priority = params.priority;
    if (params.circleId !== undefined) {
      invariant(await isActiveProposalCircle(prisma, params.workspaceId, params.circleId),
        400, "INVALID_INPUT", "Proposal circle must be active and belong to this workspace.");
      data.circleId = params.circleId || null;
    }
    if (params.ownerMemberId !== undefined) {
      // Resolvability is validated at admission; the value is re-resolved
      // against the transaction client inside the final transaction.
      await resolveProposalOwnerMemberId(prisma, params.workspaceId, params.ownerMemberId);
    }

    // Inference phase: outside every transaction and lock, exactly once.
    const effectiveTitle = String(data.title ?? admissionProposal.title);
    const effectiveBodyMd = String(data.bodyMd ?? admissionProposal.bodyMd);
    data.summary = await generateProposalSummary({
      workspaceId: params.workspaceId,
      title: effectiveTitle,
      bodyMd: effectiveBodyMd,
    });

    const finalMembership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

    return runUpdateProposalTransaction(actor, finalMembership, params, {
      data,
      effectiveTitle,
      effectiveBodyMd,
      status: admissionProposal.status,
      isPrivate: admissionProposal.isPrivate,
    });
  }

  return runUpdateProposalTransaction(actor, membership, params, null);
}

async function archiveProposalArtifactWithLock(
  actor: AppActor,
  params: {
    workspaceId: string;
    proposalId: string;
    reason: string;
  },
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    await acquireProposalAdvisoryLock(tx, params.proposalId);
    const record = await tx.proposal.findFirst({
      where: { id: params.proposalId, workspaceId: params.workspaceId },
    });
    invariant(record, 404, "NOT_FOUND", "Proposal not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "Proposal", [record], tx)).has(record.id),
      404, "NOT_FOUND", "Proposal not found.");
    if (record.archivedAt) {
      return record;
    }

    const previousState = JSON.parse(JSON.stringify(record)) as Prisma.InputJsonObject;
    const archivedAt = new Date();
    const actorUserId = actor.kind === "user" ? actor.user.id : null;
    const actorLabel = actor.kind === "user"
      ? (actor.user.displayName || actor.user.email || actor.user.id)
      : (actor.label || actor.authProvider || "agent");

    const updated = await tx.proposal.update({
      where: { id: record.id },
      data: {
        archivedAt,
        archivedByUserId: actorUserId,
        archiveReason: params.reason,
      },
    });

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Proposal",
      entityId: record.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Proposal", record),
    });

    await tx.workspaceArchiveRecord.create({
      data: {
        workspaceId: params.workspaceId,
        entityType: "Proposal",
        entityId: record.id,
        entityLabel: record.title ?? record.id,
        previousState: previousState as Prisma.InputJsonObject,
        archiveReason: params.reason,
        archivedByUserId: actorUserId,
        archivedByLabel: actorLabel,
        archivedAt,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId,
        action: "workspace-artifact.archived",
        entityType: "Proposal",
        entityId: record.id,
        meta: {
          label: record.title ?? record.id,
          reason: params.reason,
        },
      },
    });

    await withdrawActiveApprovalFlowForSubject(tx, {
      workspaceId: params.workspaceId,
      subjectType: "PROPOSAL",
      subjectId: record.id,
      cleanupReason: "Proposal archived",
      actorUserId,
      now: archivedAt,
    });

    return updated;
  });
}

export async function archiveProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
}) {
  return archiveProposalArtifactWithLock(actor, {
    workspaceId: params.workspaceId,
    proposalId: params.proposalId,
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
    await acquireProposalAdvisoryLock(tx, params.proposalId);

    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "Proposal", [proposal], tx)).has(proposal.id),
      404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "DRAFT", 400, "INVALID_STATE", "Only draft proposals can be opened.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: proposal, resolvedMembership: membership });

    const admission = await captureHumanArtifactInputAdvance({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, before: proposal });
    const openedAt = new Date();
    const flow = await activateProposalApprovalFlow(tx, {
      actor,
      workspaceId: params.workspaceId,
      proposalId: proposal.id,
      policy,
      openedAt,
    });

    const openedProposal = await tx.proposal.update({
      where: { id: proposal.id },
      data: {
        status: "OPEN",
        isPrivate: false,
        publishedAt: proposal.publishedAt || openedAt,
        autoApproveAt: null,
      },
    });
    await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, before: proposal, after: openedProposal, admission });

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
    await acquireProposalAdvisoryLock(tx, params.proposalId);
    await acquireConstitutionCorpusAdvisoryLock(tx, params.workspaceId);

    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "Proposal", [proposal], tx)).has(proposal.id),
      404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "OPEN" || proposal.status === "RESOLVED", 400, "INVALID_STATE", "Only open or resolved proposals can be returned to draft.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: proposal, resolvedMembership: membership });

    const admission = await captureHumanArtifactInputAdvance({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, before: proposal, allowSystemTransition: true });
    await preserveProposalResetHistory(tx, actor, params.workspaceId, proposal);

    const flow = await tx.approvalFlow.findUnique({
      where: {
        subjectType_subjectId: {
          subjectType: "PROPOSAL",
          subjectId: proposal.id,
        },
      },
    });

    if (flow) {
      await preserveApprovalFlowHistory(tx, actor, params.workspaceId, flow);
      await tx.approvalDecision.deleteMany({ where: { flowId: flow.id } });
      await tx.objection.deleteMany({ where: { flowId: flow.id } });
      await writeProposalApprovalFlow(tx, actor, params.workspaceId, flow, {
          status: "DRAFT",
          openedAt: null,
          closesAt: null,
          closedAt: null,
          resultJson: Prisma.JsonNull,
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
    const contentReadable = await advanceProposalResetProof(tx, actor, params.workspaceId, proposal, updated, admission);

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

    return contentReadable === false ? { id: updated.id, contentWithheld: true as const } : updated;
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
    await acquireProposalAdvisoryLock(tx, params.proposalId);
    await acquireConstitutionCorpusAdvisoryLock(tx, params.workspaceId);

    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "Proposal", [proposal], tx)).has(proposal.id),
      404, "NOT_FOUND", "Proposal not found.");
    invariant(!proposal.archivedAt, 400, "INVALID_STATE", "Archived proposals cannot be reopened.");
    invariant(proposal.status === "RESOLVED", 400, "INVALID_STATE", "Only resolved proposals can be reopened.");

    const admission = await captureHumanArtifactInputAdvance({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, before: proposal, allowSystemTransition: true });
    await preserveProposalResetHistory(tx, actor, params.workspaceId, proposal);

    const existingFlow = await tx.approvalFlow.findUnique({
      where: {
        subjectType_subjectId: {
          subjectType: "PROPOSAL",
          subjectId: proposal.id,
        },
      },
    });
    const flow = existingFlow ?? await ensureApprovalFlow(tx, {
      actor,
      workspaceId: params.workspaceId,
      subjectType: "PROPOSAL",
      subjectId: proposal.id,
      policy,
      createdByUserId: actor.kind === "user" ? actor.user.id : null,
    });

    await preserveApprovalFlowHistory(tx, actor, params.workspaceId, flow);
    const deletedDecisions = await tx.approvalDecision.deleteMany({ where: { flowId: flow.id } });
    const deletedObjections = await tx.objection.deleteMany({ where: { flowId: flow.id } });
    const deletedPolicyCorpus = await tx.policyCorpus.deleteMany({
      where: { proposalId: proposal.id },
    });

    await writeProposalApprovalFlow(tx, actor, params.workspaceId, flow, {
        status: "ACTIVE",
        openedAt: flow.openedAt ?? now,
        closesAt: null,
        closedAt: null,
        resultJson: Prisma.JsonNull,
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
    const contentReadable = await advanceProposalResetProof(tx, actor, params.workspaceId, proposal, updated, admission);

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

    return contentReadable === false ? { id: updated.id, contentWithheld: true as const } : updated;
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
    const sortedIds = [...proposalIds].sort((a, b) => a.localeCompare(b));
    for (const proposalId of sortedIds) {
      await acquireProposalAdvisoryLock(tx, proposalId);
    }
    await acquireConstitutionCorpusAdvisoryLock(tx, params.workspaceId);

    const proposals = await tx.proposal.findMany({
      where: {
        id: { in: proposalIds },
        workspaceId: params.workspaceId,
      },
    });
    const readableProposalIds = await readableArtifactIds(actor, params.workspaceId, "Proposal", proposals, tx);
    const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const missingIds = proposalIds.filter((proposalId) => !proposalById.has(proposalId));
    invariant(missingIds.length === 0, 404, "NOT_FOUND", `Proposal not found: ${missingIds.join(", ")}.`);

    const reopened = [];
    const events = [];

    for (const proposalId of proposalIds) {
      const proposal = proposalById.get(proposalId);
      invariant(proposal, 404, "NOT_FOUND", "Proposal not found.");
      invariant(readableProposalIds.has(proposal.id), 404, "NOT_FOUND", "Proposal not found.");
      invariant(!proposal.archivedAt, 400, "INVALID_STATE", `Archived proposal cannot be reopened: ${proposal.id}.`);
      invariant(proposal.status === "RESOLVED", 400, "INVALID_STATE", `Only resolved proposals can be reopened: ${proposal.id}.`);

      const admission = await captureHumanArtifactInputAdvance({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, before: proposal, allowSystemTransition: true });
    await preserveProposalResetHistory(tx, actor, params.workspaceId, proposal);

      const existingFlow = await tx.approvalFlow.findUnique({
        where: {
          subjectType_subjectId: {
            subjectType: "PROPOSAL",
            subjectId: proposal.id,
          },
        },
      });
      const flow = existingFlow ?? await ensureApprovalFlow(tx, {
        actor,
        workspaceId: params.workspaceId,
        subjectType: "PROPOSAL",
        subjectId: proposal.id,
        policy,
        createdByUserId: null,
      });

      await preserveApprovalFlowHistory(tx, actor, params.workspaceId, flow);
      const deletedDecisions = await tx.approvalDecision.deleteMany({ where: { flowId: flow.id } });
      const deletedObjections = await tx.objection.deleteMany({ where: { flowId: flow.id } });

      await writeProposalApprovalFlow(tx, actor, params.workspaceId, flow, {
          status: "ACTIVE",
          openedAt: flow.openedAt ?? now,
          closesAt: null,
          closedAt: null,
          resultJson: Prisma.JsonNull,
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
      const contentReadable = await advanceProposalResetProof(tx, actor, params.workspaceId, proposal, updated, admission);

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

      reopened.push(contentReadable === false ? { id: updated.id, contentWithheld: true as const } : {
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
    await acquireProposalAdvisoryLock(tx, params.proposalId);

    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "Proposal", [proposal], tx)).has(proposal.id),
      404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.isPrivate, 400, "INVALID_STATE", "Proposal is already public.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: proposal, resolvedMembership: membership });

    const admission = await captureHumanArtifactInputAdvance({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, before: proposal });
    const updated = await tx.proposal.update({
      where: { id: params.proposalId },
      data: { isPrivate: false, publishedAt: new Date() },
    });
    await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, before: proposal, after: updated, admission });

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

export async function resolveProposal(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  proposalId: string;
  outcome: ProposalResolutionOutcome;
  decisionMd: string;
  evidenceDocumentIds?: string[] | null;
  lineageCopied?: boolean;
}, transaction?: Prisma.TransactionClient) {

  invariant(PROPOSAL_RESOLUTION_OUTCOMES.has(params.outcome), 400, "INVALID_INPUT", "Resolution outcome is required.");
  const decisionMd = params.decisionMd.trim();
  invariant(decisionMd.length > 0, 400, "INVALID_INPUT", "Resolution note is required.");

  const now = new Date();

  const run = async (tx: Prisma.TransactionClient) => {
    await assertArtifactInputWriteFence(tx);
    const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
    await acquireProposalAdvisoryLock(tx, params.proposalId);
    if (params.outcome === "ADOPTED") {
      await acquireConstitutionCorpusAdvisoryLock(tx, params.workspaceId);
    }

    const proposal = await tx.proposal.findUnique({
      where: { id: params.proposalId },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "Proposal", [proposal], tx)).has(proposal.id),
      404, "NOT_FOUND", "Proposal not found.");
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

    const priorRoots = await currentArtifactInputRoots(tx, params.workspaceId, { kind: "Proposal", id: proposal.id }, proposal);
    invariant(priorRoots, 409, "UNKNOWN_LINEAGE", "Proposal inputs cannot be verified.");
    const evidenceInputs = normalizeIds(params.evidenceDocumentIds).map((id) => ({ kind: "Document" as const, id }));
    const evidenceRoots = evidenceInputs.length ? await captureArtifactInputProof(actor, params.workspaceId, evidenceInputs, tx) : [];
    const suppliedRoots = [
      ...(params.lineageRoots ?? []),
      ...getMcpToolInputRoots(actor, params.workspaceId),
      ...await captureArtifactInputProof(actor, params.workspaceId, params.lineageInputs ?? [], tx),
    ];
    invariant(actor.kind === "user" || suppliedRoots.length > 0, 409, "UNKNOWN_LINEAGE", "Generated resolution requires its complete input receipt.");
    invariant(!params.lineageCopied || suppliedRoots.length > 0, 409, "UNKNOWN_LINEAGE", "Copied resolution requires its complete input receipt.");
    invariant(!suppliedRoots.length || await isArtifactInputProofReadable(actor, params.workspaceId, suppliedRoots, tx),
      409, "SOURCE_CHANGED", "Resolution inputs changed before persistence.");
    const priorManifest = await tx.artifactInputLineage.findFirst({ where: {
      workspaceId: params.workspaceId, artifactType: "Proposal", artifactId: proposal.id,
    }, orderBy: { revision: "desc" }, select: {
      origin: true, contentHash: true, rootsJson: true, inputsJson: true, epochProofVersion: true, permissionEpochsJson: true,
    } });
    const originalEpochs = parsePermissionEpochProof(priorManifest?.permissionEpochsJson);
    const nativeOriginal = actor.kind === "user" && !params.lineageCopied && !priorRoots.length
      && !evidenceRoots.length && !suppliedRoots.length && !params.lineageInputs?.length
      && priorManifest?.origin === "HUMAN_ORIGINAL" && priorManifest.contentHash === lineageContentFingerprint("Proposal", proposal)
      && Array.isArray(priorManifest.rootsJson) && priorManifest.rootsJson.length === 0
      && Array.isArray(priorManifest.inputsJson) && priorManifest.inputsJson.length === 0
      && priorManifest.epochProofVersion === 1
      && originalEpochs?.entries.some(entry => entry.kind === "Proposal" && entry.id === proposal.id)
      && originalEpochs.entries.some(entry => entry.kind === "Workspace" && entry.id === params.workspaceId);
    // A proven independent human original may be explicitly published by its
    // draft manager. Retain its old private snapshot as history, never rebase
    // that old vector or apply this distinction to copied/model/MCP inputs.
    const priorSnapshots = await captureArtifactInputSnapshotProof(actor, params.workspaceId,
      { kind: "Proposal", id: proposal.id, fingerprint: lineageContentFingerprint("Proposal", proposal) }, tx);
    if (flow) priorSnapshots.push(...await captureArtifactInputSnapshotProof(actor, params.workspaceId,
      { kind: "ApprovalFlow", id: flow.id, fingerprint: lineageContentFingerprint("ApprovalFlow", flow) }, tx));
    const resolutionRoots = await captureImmutableArtifactInputProof(actor, params.workspaceId,
      [...priorSnapshots, ...priorRoots, ...evidenceRoots, ...suppliedRoots], tx);

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
    const derived = !nativeOriginal;
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Proposal", id: proposal.id }, content: updated,
      origin: derived ? "DERIVED" : "HUMAN_ORIGINAL",
      inputs: [], inheritedRoots: derived ? resolutionRoots : [] });
    const proposalOutputRoots = await captureImmutableArtifactInputProof(actor, params.workspaceId,
      await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Proposal", id: updated.id }], tx), tx);

    const evidenceDocumentIds = await createWorkItemEvidenceLinks(tx, {
      workspaceId: params.workspaceId,
      entityType: "Proposal",
      entityId: proposal.id,
      documentIds: params.evidenceDocumentIds,
      purpose: "resolution_evidence",
    });

    if (flow) {
      const updatedFlow = await tx.approvalFlow.update({ where: { id: flow.id }, data: {
          status: params.outcome === "ADOPTED" ? "APPROVED" : params.outcome === "WITHDRAWN" ? "WITHDRAWN" : "REJECTED",
          closedAt: now,
          resultJson: {
            manuallyResolved: true,
            outcome: params.outcome,
            decisionMd,
          } as Prisma.InputJsonValue,
      } });
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "ApprovalFlow", id: updatedFlow.id }, content: updatedFlow,
        origin: "DERIVED", inputs: [], inheritedRoots: [...resolutionRoots, ...proposalOutputRoots] });
    }

    if (params.outcome === "ADOPTED") {
      const policy = await tx.policyCorpus.upsert({
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
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "PolicyCorpus", id: policy.id }, content: policy,
        origin: "DERIVED", inputs: [], inheritedRoots: proposalOutputRoots });
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

    await assertArtifactInputWriteFence(tx);
    invariant(nativeOriginal || await isArtifactInputProofReadable(actor, params.workspaceId, resolutionRoots, tx),
      409, "SOURCE_CHANGED", "Resolution input permissions changed during persistence.");
    return updated;
  };
  return transaction ? run(transaction) : prisma.$transaction(run);
}

export async function deleteProposal(actor: AppActor, params: { workspaceId: string; proposalId: string }) {
  return archiveProposalArtifactWithLock(actor, {
    workspaceId: params.workspaceId,
    proposalId: params.proposalId,
    reason: "Archived from proposal delete path.",
  });
}
