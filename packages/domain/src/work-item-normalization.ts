import { formatWorkItemPriority } from "./work-item-priority";

export type WorkItemUserLike = {
  displayName?: string | null;
  email?: string | null;
};

export type WorkItemMemberLike = {
  id?: string | null;
  user?: WorkItemUserLike | null;
} | null | undefined;

type PriorityLike = {
  priority?: number | null;
};

type AdviceRequestLike = {
  status?: string | null;
};

type AdviceProcessLike = {
  requests?: AdviceRequestLike[] | null;
} | null | undefined;

type AdviceRequestCountsLike = {
  adviceRequests?: AdviceRequestLike[] | null;
  inputRequests?: AdviceRequestLike[] | null;
  adviceProcess?: AdviceProcessLike;
  adviceRequestCount?: number | null;
  activeAdviceRequestCount?: number | null;
  inputRequestCount?: number | null;
  activeInputRequestCount?: number | null;
};

type ActionLike = PriorityLike & AdviceRequestCountsLike & {
  assigneeMemberId?: string | null;
  assigneeMember?: WorkItemMemberLike;
};

type TensionLike = PriorityLike & AdviceRequestCountsLike & {
  assigneeMemberId?: string | null;
  assigneeMember?: WorkItemMemberLike;
  raisedByMemberId?: string | null;
  raisedByMember?: WorkItemMemberLike;
  upvotes?: unknown[] | null;
  upvoteCount?: number | null;
};

type ProposalLike = PriorityLike & AdviceRequestCountsLike & {
  ownerMemberId?: string | null;
  ownerMember?: WorkItemMemberLike;
};

type GoalLike = {
  ownerMemberId?: string | null;
  ownerMember?: WorkItemMemberLike;
};

export function workItemUserDisplayName(user: WorkItemUserLike | null | undefined) {
  return user?.displayName ?? user?.email ?? null;
}

export function workItemMemberDisplayName(member: WorkItemMemberLike) {
  return workItemUserDisplayName(member?.user);
}

export function workItemPriorityFields(item: PriorityLike) {
  return {
    priority: item.priority ?? 0,
    priorityLabel: formatWorkItemPriority(item.priority),
  };
}

function resolveMemberId(memberId: string | null | undefined, member: WorkItemMemberLike) {
  return memberId ?? member?.id ?? null;
}

function requestCount(requests: AdviceRequestLike[] | null | undefined) {
  return Array.isArray(requests) ? requests.length : null;
}

function activeRequestCount(requests: AdviceRequestLike[] | null | undefined) {
  return Array.isArray(requests)
    ? requests.filter((request) => request.status === "ACTIVE").length
    : null;
}

function adviceRequestFields(item: AdviceRequestCountsLike) {
  const requests = item.adviceRequests
    ?? item.inputRequests
    ?? item.adviceProcess?.requests
    ?? null;
  const total = item.adviceRequestCount ?? item.inputRequestCount ?? requestCount(requests);
  const active = item.activeAdviceRequestCount ?? item.activeInputRequestCount ?? activeRequestCount(requests);

  return {
    adviceRequestCount: total,
    activeAdviceRequestCount: active,
    inputRequestCount: total,
    activeInputRequestCount: active,
  };
}

export function normalizeActionWorkItem<T extends ActionLike>(action: T) {
  const assigneeMemberId = resolveMemberId(action.assigneeMemberId, action.assigneeMember);
  const assigneeMemberName = workItemMemberDisplayName(action.assigneeMember);
  return {
    ...action,
    ...workItemPriorityFields(action),
    ...adviceRequestFields(action),
    assigneeMemberId,
    assigneeMemberName,
    assignee: assigneeMemberName,
    responsibleMemberId: assigneeMemberId,
    responsibleMemberName: assigneeMemberName,
    responsiblePerson: assigneeMemberName,
    ownerMemberId: assigneeMemberId,
    ownerMemberName: assigneeMemberName,
    owner: assigneeMemberName,
  };
}

export function normalizeTensionWorkItem<T extends TensionLike>(tension: T) {
  const responsibleMemberId = resolveMemberId(tension.assigneeMemberId, tension.assigneeMember);
  const responsibleMemberName = workItemMemberDisplayName(tension.assigneeMember);
  const raisedByMemberId = resolveMemberId(tension.raisedByMemberId, tension.raisedByMember);
  const raisedByMemberName = workItemMemberDisplayName(tension.raisedByMember);
  return {
    ...tension,
    ...workItemPriorityFields(tension),
    ...adviceRequestFields(tension),
    upvoteCount: tension.upvoteCount ?? (Array.isArray(tension.upvotes) ? tension.upvotes.length : null),
    assigneeMemberId: responsibleMemberId,
    assigneeMemberName: responsibleMemberName,
    assignee: responsibleMemberName,
    responsibleMemberId,
    responsibleMemberName,
    responsiblePerson: responsibleMemberName,
    raisedByMemberId,
    raisedByMemberName,
    raisedBy: raisedByMemberName,
    ownerMemberId: responsibleMemberId ?? raisedByMemberId,
    ownerMemberName: responsibleMemberName ?? raisedByMemberName,
    owner: responsibleMemberName ?? raisedByMemberName,
  };
}

export function normalizeProposalWorkItem<T extends ProposalLike>(proposal: T) {
  const ownerMemberId = resolveMemberId(proposal.ownerMemberId, proposal.ownerMember);
  const ownerMemberName = workItemMemberDisplayName(proposal.ownerMember);
  return {
    ...proposal,
    ...workItemPriorityFields(proposal),
    ...adviceRequestFields(proposal),
    ownerMemberId,
    ownerMemberName,
    owner: ownerMemberName,
    responsibleMemberId: ownerMemberId,
    responsibleMemberName: ownerMemberName,
    responsiblePerson: ownerMemberName,
  };
}

export function normalizeGoalWorkItem<T extends GoalLike>(goal: T) {
  const ownerMemberId = resolveMemberId(goal.ownerMemberId, goal.ownerMember);
  const ownerMemberName = workItemMemberDisplayName(goal.ownerMember);
  return {
    ...goal,
    ownerMemberId,
    ownerMemberName,
    owner: ownerMemberName,
  };
}
