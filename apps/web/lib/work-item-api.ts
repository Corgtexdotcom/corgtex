import {
  captureReadableDigestInputs,
  WorkItemReadRelease,
  coerceWorkItemPriorityInput,
  getProposal,
  loadAdviceRequestCountSummaries,
  normalizeActionWorkItem,
  normalizeGoalWorkItem,
  normalizeProposalWorkItem,
  normalizeTensionWorkItem,
  workItemMemberDisplayName,
  workItemUserDisplayName,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";

type UserLike = {
  displayName?: string | null;
  email?: string | null;
};

type MemberLike = {
  id?: string | null;
  user?: UserLike | null;
} | null | undefined;

type PriorityLike = {
  priority?: number | null;
};

type ActionLike = PriorityLike & {
  assigneeMemberId?: string | null;
  assigneeMember?: MemberLike;
};

type TensionLike = PriorityLike & {
  assigneeMemberId?: string | null;
  assigneeMember?: MemberLike;
  raisedByMemberId?: string | null;
  raisedByMember?: MemberLike;
};

type ProposalLike = PriorityLike & {
  ownerMemberId?: string | null;
  ownerMember?: MemberLike;
};

type GoalLike = {
  ownerMemberId?: string | null;
  ownerMember?: MemberLike;
};

const memberUserInclude = {
  user: {
    select: {
      displayName: true,
      email: true,
    },
  },
} as const;

export function workItemPriorityFromBody(body: Record<string, unknown>) {
  if ("priority" in body) return coerceWorkItemPriorityInput(body.priority);
  if ("priorityLabel" in body) return coerceWorkItemPriorityInput(body.priorityLabel, "priorityLabel");
  return undefined;
}

export function userDisplayName(user: UserLike | null | undefined) {
  return workItemUserDisplayName(user);
}

export function memberDisplayName(member: MemberLike) {
  return workItemMemberDisplayName(member);
}

export function serializeActionWorkItem<T extends ActionLike>(action: T): ReturnType<typeof normalizeActionWorkItem<T>>;
export function serializeActionWorkItem<T extends ActionLike>(action: T | { id: string; contentWithheld: boolean }): ReturnType<typeof normalizeActionWorkItem<T>> | { id: string; contentWithheld: boolean };
export function serializeActionWorkItem<T extends ActionLike>(action: T | { id: string; contentWithheld: boolean }) {
  if ("contentWithheld" in action) return { id: action.id, contentWithheld: true };
  return normalizeActionWorkItem(action);
}

export function serializeTensionWorkItem<T extends TensionLike>(tension: T): ReturnType<typeof normalizeTensionWorkItem<T>>;
export function serializeTensionWorkItem<T extends TensionLike>(tension: T | { id: string; contentWithheld: boolean }): ReturnType<typeof normalizeTensionWorkItem<T>> | { id: string; contentWithheld: boolean };
export function serializeTensionWorkItem<T extends TensionLike>(tension: T | { id: string; contentWithheld: boolean }) {
  if ("contentWithheld" in tension) return { id: tension.id, contentWithheld: true };
  return normalizeTensionWorkItem(tension);
}

export function serializeProposalWorkItem<T extends ProposalLike>(proposal: T) {
  return normalizeProposalWorkItem(proposal);
}

export function serializeGoalWorkItem<T extends GoalLike>(goal: T) {
  return normalizeGoalWorkItem(goal);
}

// A member's presentation includes a separately governed user profile. Retain
// both original proofs and lineage heads until the complete response is ready.
async function readableResponseMembers<T extends { id: string; userId: string; user: UserLike }>(
  actor: AppActor, workspaceId: string, release: WorkItemReadRelease, members: T[],
) {
  const captured = await release.observeRead(() => captureReadableDigestInputs({
    actor, workspaceId, kind: "Member", records: members,
    additionalInputs: member => [{ kind: "User", id: member.userId, snapshot: { ...member.user, id: member.userId } }],
  }));
  release.add(captured.roots);
  return new Set(captured.records.map(member => member.id));
}

export async function loadActionWorkItemResponse(actor: AppActor, workspaceId: string, actionId: string) {
  const release = new WorkItemReadRelease(actor, workspaceId);
  const action = await prisma.action.findFirst({
    where: { id: actionId, workspaceId },
    include: {
      assigneeMember: { include: memberUserInclude },
    },
  });
  if (!action) return null;
  if (!(await release.admit("Action", [action])).length) return { id: action.id, contentWithheld: true };
  const members = await readableResponseMembers(actor, workspaceId, release, action.assigneeMember ? [action.assigneeMember] : []);
  const requestCountSummaries = await loadAdviceRequestCountSummaries(actor, workspaceId, "ACTION", [action.id],
    requests => release.observe("AdviceRequest", requests));
  return release.finish({
    ...action,
    assigneeMemberId: action.assigneeMember && members.has(action.assigneeMember.id) ? action.assigneeMemberId : null,
    assigneeMember: action.assigneeMember && members.has(action.assigneeMember.id) ? action.assigneeMember : null,
    ...requestCountSummaries.get(action.id),
  });
}

export async function loadTensionWorkItemResponse(actor: AppActor, workspaceId: string, tensionId: string) {
  const release = new WorkItemReadRelease(actor, workspaceId);
  const tension = await prisma.tension.findFirst({
    where: { id: tensionId, workspaceId },
    include: {
      assigneeMember: { include: memberUserInclude },
      raisedByMember: { include: memberUserInclude },
      upvotes: true,
    },
  });
  if (!tension) return null;
  if (!(await release.admit("Tension", [tension])).length) return { id: tension.id, contentWithheld: true };
  const members = await readableResponseMembers(actor, workspaceId, release,
    [tension.assigneeMember, tension.raisedByMember].filter(member => member !== null));
  const votes = await release.observeRead(() => captureReadableDigestInputs({
    actor, workspaceId, kind: "TensionUpvote", records: tension.upvotes,
    additionalInputs: vote => [{ kind: "User", id: vote.userId }],
  }));
  release.add(votes.roots);
  const requestCountSummaries = await loadAdviceRequestCountSummaries(actor, workspaceId, "TENSION", [tension.id],
    requests => release.observe("AdviceRequest", requests));
  return release.finish({
    ...tension,
    assigneeMemberId: tension.assigneeMember && members.has(tension.assigneeMember.id) ? tension.assigneeMemberId : null,
    assigneeMember: tension.assigneeMember && members.has(tension.assigneeMember.id) ? tension.assigneeMember : null,
    raisedByMemberId: tension.raisedByMember && members.has(tension.raisedByMember.id) ? tension.raisedByMemberId : null,
    raisedByMember: tension.raisedByMember && members.has(tension.raisedByMember.id) ? tension.raisedByMember : null,
    upvotes: votes.records,
    ...requestCountSummaries.get(tension.id),
  });
}

export async function loadProposalWorkItemResponse(actor: AppActor, workspaceId: string, proposalId: string) {
  return getProposal(actor, { workspaceId, proposalId });
}
