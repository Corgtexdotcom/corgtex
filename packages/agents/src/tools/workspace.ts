import { prisma } from "@corgtex/shared";
import type { ModelTool } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import { listGoals } from "@corgtex/domain";
import type { TensionStatus, ActionStatus, ProposalStatus, GoalCadence, GoalLevel, GoalStatus } from "@prisma/client";

export const getWorkspaceOverviewTool: ModelTool = {
  type: "function",
  function: {
    name: "get_workspace_overview",
    description: "Get a high-level snapshot of the active workspace state including counts of open items, members, circles, and overall activity. Use this to orient yourself when the user asks general questions about the organization's state.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const queryTensionsTool: ModelTool = {
  type: "function",
  function: {
    name: "query_tensions",
    description: "List tensions in the workspace. Returns up to 20 tensions with their title, status, assignee, body preview, and version. The version must be passed to update_tension to prevent conflicting edits.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: DRAFT, OPEN, RESOLVED" },
        assigneeId: { type: "string", description: "Filter by assigned member ID" },
      },
    },
  },
};

export const queryActionsTool: ModelTool = {
  type: "function",
  function: {
    name: "query_actions",
    description: "List action items in the workspace. Returns up to 20 actions with title, status, assignee, due date, and version. The version must be passed to update_action to prevent conflicting edits.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: DRAFT, OPEN, IN_PROGRESS, COMPLETED" },
        assigneeId: { type: "string", description: "Filter by assigned member ID" },
      },
    },
  },
};

export const queryProposalsTool: ModelTool = {
  type: "function",
  function: {
    name: "query_proposals",
    description: "List proposals in the workspace. Returns up to 20 proposals with their title, status, and author.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: DRAFT, OPEN, RESOLVED" },
      },
    },
  },
};

export const queryOrgStructureTool: ModelTool = {
  type: "function",
  function: {
    name: "query_org_structure",
    description: "Get the organizational structure including circles, roles, and the members who hold them.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const queryGoalsTool: ModelTool = {
  type: "function",
  function: {
    name: "query_goals",
    description: "List workspace goals. Use this when users ask about current goals, OKRs, 10-year, 5-year, annual, quarterly, monthly, or weekly objectives.",
    parameters: {
      type: "object",
      properties: {
        cadence: { type: "string", description: "Filter by cadence: TEN_YEAR, FIVE_YEAR, ANNUAL, QUARTERLY, MONTHLY, or WEEKLY" },
        level: { type: "string", description: "Filter by level: COMPANY, CIRCLE, or PERSONAL" },
        status: { type: "string", description: "Filter by status: DRAFT, ACTIVE, ON_TRACK, AT_RISK, BEHIND, COMPLETED, or ABANDONED" },
      },
    },
  },
};

export async function getWorkspaceOverview(workspaceId: string) {
  const [memberCount, circleCount, openTensions, openActions, activeProposals, activeGoals] = await Promise.all([
    prisma.member.count({ where: { workspaceId, isActive: true } }),
    prisma.circle.count({ where: { workspaceId } }),
    prisma.tension.count({ where: { workspaceId, status: "OPEN" } }),
    prisma.action.count({ where: { workspaceId, status: "OPEN" } }),
    prisma.proposal.count({ where: { workspaceId, status: { in: ["DRAFT", "OPEN"] } } }),
    prisma.goal.count({ where: { workspaceId, archivedAt: null, status: { notIn: ["DRAFT", "ABANDONED"] } } }),
  ]);

  return { memberCount, circleCount, openTensions, openActions, activeProposals, activeGoals };
}

export async function queryTensions(workspaceId: string, status?: TensionStatus, assigneeId?: string) {
  const where: any = { workspaceId };
  if (status) where.status = status;
  if (assigneeId) where.assigneeMemberId = assigneeId;

  const tensions = await prisma.tension.findMany({
    where,
    take: 20,
    orderBy: { createdAt: "desc" },
    include: {
      author: { select: { displayName: true } },
      assigneeMember: { include: { user: { select: { displayName: true } } } },
      raisedByMember: { include: { user: { select: { displayName: true } } } },
    },
  });

  return tensions.map(t => ({
    id: t.id,
    version: t.version,
    title: t.title,
    status: t.status,
    priority: t.priority,
    author: t.author.displayName,
    assignee: t.assigneeMember?.user.displayName || null,
    raisedBy: t.raisedByMember?.user.displayName || null,
    createdAt: t.createdAt,
    bodySnippet: t.bodyMd?.substring(0, 200) + (t.bodyMd && t.bodyMd.length > 200 ? "..." : ""),
  }));
}

export async function queryActions(workspaceId: string, status?: ActionStatus, assigneeId?: string) {
  const where: any = { workspaceId };
  if (status) where.status = status;
  if (assigneeId) where.assigneeMemberId = assigneeId;

  const actions = await prisma.action.findMany({
    where,
    take: 20,
    orderBy: { createdAt: "desc" },
    include: { author: { select: { displayName: true } }, assigneeMember: { include: { user: { select: { displayName: true } } } } },
  });

  return actions.map(a => ({
    id: a.id,
    version: a.version,
    title: a.title,
    status: a.status,
    author: a.author.displayName,
    assignee: a.assigneeMember?.user.displayName || null,
    dueAt: a.dueAt,
    createdAt: a.createdAt,
    bodySnippet: a.bodyMd?.substring(0, 200) + (a.bodyMd && a.bodyMd.length > 200 ? "..." : ""),
  }));
}

export async function queryProposals(workspaceId: string, status?: ProposalStatus) {
  const where: any = { workspaceId };
  if (status) where.status = status;

  const proposals = await prisma.proposal.findMany({
    where,
    take: 20,
    orderBy: { createdAt: "desc" },
    include: { author: { select: { displayName: true } } },
  });

  return proposals.map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    author: p.author.displayName,
    createdAt: p.createdAt,
  }));
}

export async function queryOrgStructure(workspaceId: string) {
  const circles = await prisma.circle.findMany({
    where: { workspaceId },
    include: {
      roles: {
        include: {
          assignments: {
            include: { member: { include: { user: { select: { displayName: true } } } } },
          },
        },
      },
    },
  });

  return circles.map(c => ({
    id: c.id,
    name: c.name,
    purpose: c.purposeMd,
    roles: c.roles.map(r => ({
      id: r.id,
      name: r.name,
      purpose: r.purposeMd,
      assignedMembers: r.assignments.map(a => a.member.user.displayName),
    })),
  }));
}

export async function queryGoals(actor: AppActor, workspaceId: string, cadence?: GoalCadence, level?: GoalLevel, status?: GoalStatus) {
  const goals = await listGoals(actor, {
    workspaceId,
    cadence,
    level,
    status,
    take: 20,
  });

  return goals.map((goal) => ({
    id: goal.id,
    title: goal.title,
    descriptionMd: goal.descriptionMd,
    cadence: goal.cadence,
    level: goal.level,
    status: goal.status,
    progressPercent: goal.progressPercent,
    targetDate: goal.targetDate,
    startDate: goal.startDate,
    circle: goal.circle?.name ?? null,
    owner: goal.ownerMember?.user.displayName ?? null,
    keyResults: goal.keyResults.map((keyResult) => ({
      title: keyResult.title,
      currentValue: keyResult.currentValue,
      targetValue: keyResult.targetValue,
      unit: keyResult.unit,
      progressPercent: keyResult.progressPercent,
    })),
  }));
}
