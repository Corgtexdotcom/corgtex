import { prisma } from "@corgtex/shared";
import type { ModelTool } from "@corgtex/models";
import type { TensionStatus, ActionStatus, ProposalStatus } from "@prisma/client";

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
    description: "List tensions in the workspace. Returns up to 20 tensions with their title, status, assignee, and a body preview.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: OPEN, COMPLETED, CANCELLED" },
        assigneeId: { type: "string", description: "Filter by assigned member ID" },
      },
    },
  },
};

export const queryActionsTool: ModelTool = {
  type: "function",
  function: {
    name: "query_actions",
    description: "List action items in the workspace. Returns up to 20 actions with title, status, assignee, and due date.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: OPEN, COMPLETED, CANCELLED" },
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
        status: { type: "string", description: "Filter by status: DRAFT, PROPOSED, EXECUTED, REJECTED, WITHDRAWN" },
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

export async function getWorkspaceOverview(workspaceId: string) {
  const [memberCount, circleCount, openTensions, openActions, activeProposals] = await Promise.all([
    prisma.member.count({ where: { workspaceId, isActive: true } }),
    prisma.circle.count({ where: { workspaceId } }),
    prisma.tension.count({ where: { workspaceId, status: "OPEN" } }),
    prisma.action.count({ where: { workspaceId, status: "OPEN" } }),
    prisma.proposal.count({ where: { workspaceId, status: { in: ["DRAFT", "SUBMITTED"] } } }),
  ]);

  return { memberCount, circleCount, openTensions, openActions, activeProposals };
}

export async function queryTensions(workspaceId: string, status?: TensionStatus, assigneeId?: string) {
  const where: any = { workspaceId };
  if (status) where.status = status;
  if (assigneeId) where.assigneeMemberId = assigneeId;

  const tensions = await prisma.tension.findMany({
    where,
    take: 20,
    orderBy: { createdAt: "desc" },
    include: { author: { select: { displayName: true } }, assigneeMember: { include: { user: { select: { displayName: true } } } } },
  });

  return tensions.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    author: t.author.displayName,
    assignee: t.assigneeMember?.user.displayName || null,
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
