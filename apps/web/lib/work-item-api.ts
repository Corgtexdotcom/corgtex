import {
  coerceWorkItemPriorityInput,
  normalizeActionWorkItem,
  normalizeGoalWorkItem,
  normalizeProposalWorkItem,
  normalizeTensionWorkItem,
  workItemMemberDisplayName,
  workItemUserDisplayName,
} from "@corgtex/domain";
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
  return workItemUserDisplayName(user);
}

export function memberDisplayName(member: MemberLike) {
  return workItemMemberDisplayName(member);
}

export function serializeActionWorkItem<T extends ActionLike>(action: T) {
  return normalizeActionWorkItem(action);
}

export function serializeTensionWorkItem<T extends TensionLike>(tension: T) {
  return normalizeTensionWorkItem(tension);
}

export function serializeProposalWorkItem<T extends ProposalLike>(proposal: T) {
  return normalizeProposalWorkItem(proposal);
}

export function serializeGoalWorkItem<T extends GoalLike>(goal: T) {
  return normalizeGoalWorkItem(goal);
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
