import { coerceWorkItemPriorityInput, formatWorkItemPriority } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";

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
  return user?.displayName ?? user?.email ?? null;
}

export function memberDisplayName(member: MemberLike) {
  return userDisplayName(member?.user);
}

function priorityFields(item: PriorityLike) {
  return {
    priority: item.priority ?? 0,
    priorityLabel: formatWorkItemPriority(item.priority),
  };
}

export function serializeActionWorkItem<T extends ActionLike>(action: T) {
  const assigneeMemberName = memberDisplayName(action.assigneeMember);
  return {
    ...action,
    ...priorityFields(action),
    assigneeMemberId: action.assigneeMemberId ?? action.assigneeMember?.id ?? null,
    assigneeMemberName,
    assignee: assigneeMemberName,
  };
}

export function serializeTensionWorkItem<T extends TensionLike>(tension: T) {
  const responsibleMemberName = memberDisplayName(tension.assigneeMember);
  const raisedByMemberName = memberDisplayName(tension.raisedByMember);
  return {
    ...tension,
    ...priorityFields(tension),
    assigneeMemberId: tension.assigneeMemberId ?? tension.assigneeMember?.id ?? null,
    assigneeMemberName: responsibleMemberName,
    responsibleMemberId: tension.assigneeMemberId ?? tension.assigneeMember?.id ?? null,
    responsibleMemberName,
    responsiblePerson: responsibleMemberName,
    raisedByMemberId: tension.raisedByMemberId ?? tension.raisedByMember?.id ?? null,
    raisedByMemberName,
    raisedBy: raisedByMemberName,
  };
}

export function serializeProposalWorkItem<T extends ProposalLike>(proposal: T) {
  const ownerMemberName = memberDisplayName(proposal.ownerMember);
  return {
    ...proposal,
    ...priorityFields(proposal),
    ownerMemberId: proposal.ownerMemberId ?? proposal.ownerMember?.id ?? null,
    ownerMemberName,
    owner: ownerMemberName,
  };
}

export function serializeGoalWorkItem<T extends GoalLike>(goal: T) {
  const ownerMemberName = memberDisplayName(goal.ownerMember);
  return {
    ...goal,
    ownerMemberId: goal.ownerMemberId ?? goal.ownerMember?.id ?? null,
    ownerMemberName,
    owner: ownerMemberName,
  };
}

export async function loadActionWorkItemResponse(workspaceId: string, actionId: string) {
  return prisma.action.findFirst({
    where: { id: actionId, workspaceId },
    include: {
      assigneeMember: { include: memberUserInclude },
    },
  });
}

export async function loadTensionWorkItemResponse(workspaceId: string, tensionId: string) {
  return prisma.tension.findFirst({
    where: { id: tensionId, workspaceId },
    include: {
      assigneeMember: { include: memberUserInclude },
      raisedByMember: { include: memberUserInclude },
    },
  });
}

export async function loadProposalWorkItemResponse(workspaceId: string, proposalId: string) {
  return prisma.proposal.findFirst({
    where: { id: proposalId, workspaceId },
    include: {
      ownerMember: { include: memberUserInclude },
    },
  });
}
