import { prisma } from "@corgtex/shared";
import { authorizeConversationTool } from "../conversation-capabilities";
import type { ModelTool } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import { AppError, listCircles, listRoleAssignments, listGoals, privacyFilter, requireWorkspaceMembership, scanSourceReadableRecords, captureReadableDigestInputs } from "@corgtex/domain";
import type { Prisma, TensionStatus, ActionStatus, ProposalStatus, GoalCadence, GoalLevel, GoalStatus } from "@prisma/client";

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
        tensionId: { type: "string", description: "Filter by exact tension ID to read its version" },
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
        actionId: { type: "string", description: "Filter by exact action ID to read its version" },
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

async function workspaceReaderWhere(workspaceId: string, actor?: AppActor) {
  if (!actor) {
    throw new AppError(401, "AUTH_REQUIRED", "Authenticated actor is required for workspace readers.");
  }
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  return { workspaceId, archivedAt: null, ...privacyFilter(actor, membership) };
}

export async function getWorkspaceOverview(workspaceId: string, actor?: AppActor) {
  if (actor) await authorizeConversationTool(actor, workspaceId, "get_workspace_overview");
  const where = await workspaceReaderWhere(workspaceId, actor);
  const caller = actor!;
  const scans = await Promise.all([
    scanSourceReadableRecords({ actor: caller, workspaceId, kind: "Member", load: (afterId, take) => prisma.member.findMany({ where: { workspaceId, isActive: true, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take, include: { user: { select: { id: true, email: true, displayName: true } } } }) }),
    scanSourceReadableRecords({ actor: caller, workspaceId, kind: "Circle", load: (afterId, take) => prisma.circle.findMany({ where: { workspaceId, archivedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take }) }),
    scanSourceReadableRecords({ actor: caller, workspaceId, kind: "Tension", load: (afterId, take) => prisma.tension.findMany({ where: { AND: [{ ...where, status: "OPEN" }, ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take }) }),
    scanSourceReadableRecords({ actor: caller, workspaceId, kind: "Action", load: (afterId, take) => prisma.action.findMany({ where: { AND: [{ ...where, status: "OPEN" }, ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take }) }),
    scanSourceReadableRecords({ actor: caller, workspaceId, kind: "Proposal", load: (afterId, take) => prisma.proposal.findMany({ where: { AND: [{ ...where, status: { in: ["DRAFT", "OPEN"] } }, ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take }) }),
    scanSourceReadableRecords({ actor: caller, workspaceId, kind: "Goal", load: (afterId, take) => prisma.goal.findMany({ where: { AND: [{ ...where, status: { notIn: ["DRAFT", "ABANDONED"] } }, ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take }) }),
  ]);
  const [members, circles, tensions, actions, proposals, goals] = scans;
  const memberCount = members.length;
  const circleCount = circles.length, openTensions = tensions.length, openActions = actions.length;
  const activeProposals = proposals.length, activeGoals = goals.length;

  return { memberCount, circleCount, openTensions, openActions, activeProposals, activeGoals };
}

export async function queryTensions(workspaceId: string, status?: TensionStatus, assigneeId?: string, tensionId?: string, actor?: AppActor) {
  if (actor) await authorizeConversationTool(actor, workspaceId, "query_tensions");
  const where: Prisma.TensionWhereInput = await workspaceReaderWhere(workspaceId, actor);
  if (tensionId) where.id = tensionId;
  if (status) where.status = status;
  if (assigneeId) where.assigneeMemberId = assigneeId;

  const tensions = (await scanSourceReadableRecords({ actor: actor!, workspaceId, kind: "Tension", load: (afterId, take) => prisma.tension.findMany({
    where: { AND: [where, ...(afterId ? [{ id: { gt: afterId } }] : [])] },
    orderBy: { id: "asc" }, take, include: { author: { select: { id: true, displayName: true, email: true, bio: true } }, assigneeMember: { include: { user: { select: { id: true, displayName: true, email: true } } } }, raisedByMember: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
  }) })).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)).slice(0, 20);

  const authors = await captureReadableDigestInputs({ actor: actor!, workspaceId, kind: "User", records: tensions.map((row) => row.author) });
  const authorIds = new Set(authors.records.map((row) => row.id));
  const assigneeMemberInputs = await captureReadableDigestInputs({ actor: actor!, workspaceId, kind: "Member", records: tensions.flatMap((row) => row.assigneeMember ? [row.assigneeMember] : []) });
  const assigneeMemberIds = new Set(assigneeMemberInputs.records.map((row) => row.id));
  const raisedByMemberInputs = await captureReadableDigestInputs({ actor: actor!, workspaceId, kind: "Member", records: tensions.flatMap((row) => row.raisedByMember ? [row.raisedByMember] : []) });
  const raisedByMemberIds = new Set(raisedByMemberInputs.records.map((row) => row.id));
  return tensions.map(t => ({
    id: t.id,
    version: t.version,
    title: t.title,
    status: t.status,
    priority: t.priority,
    author: authorIds.has(t.author.id) ? t.author.displayName : null,
    assignee: t.assigneeMember && assigneeMemberIds.has(t.assigneeMember.id) ? t.assigneeMember.user.displayName : null,
    raisedBy: t.raisedByMember && raisedByMemberIds.has(t.raisedByMember.id) ? t.raisedByMember.user.displayName : null,
    createdAt: t.createdAt,
    bodySnippet: t.bodyMd?.substring(0, 200) + (t.bodyMd && t.bodyMd.length > 200 ? "..." : ""),
  }));
}

export async function queryActions(workspaceId: string, status?: ActionStatus, assigneeId?: string, actionId?: string, actor?: AppActor) {
  if (actor) await authorizeConversationTool(actor, workspaceId, "query_actions");
  const where: Prisma.ActionWhereInput = await workspaceReaderWhere(workspaceId, actor);
  if (actionId) where.id = actionId;
  if (status) where.status = status;
  if (assigneeId) where.assigneeMemberId = assigneeId;

  const actions = (await scanSourceReadableRecords({ actor: actor!, workspaceId, kind: "Action", load: (afterId, take) => prisma.action.findMany({
    where: { AND: [where, ...(afterId ? [{ id: { gt: afterId } }] : [])] },
    orderBy: { id: "asc" }, take, include: { author: { select: { id: true, displayName: true, email: true, bio: true } }, assigneeMember: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
  }) })).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)).slice(0, 20);

  const authors = await captureReadableDigestInputs({ actor: actor!, workspaceId, kind: "User", records: actions.map((row) => row.author) });
  const authorIds = new Set(authors.records.map((row) => row.id));
  const assigneeMemberInputs = await captureReadableDigestInputs({ actor: actor!, workspaceId, kind: "Member", records: actions.flatMap((row) => row.assigneeMember ? [row.assigneeMember] : []) });
  const assigneeMemberIds = new Set(assigneeMemberInputs.records.map((row) => row.id));
  return actions.map(a => ({
    id: a.id,
    version: a.version,
    title: a.title,
    status: a.status,
    author: authorIds.has(a.author.id) ? a.author.displayName : null,
    assignee: a.assigneeMember && assigneeMemberIds.has(a.assigneeMember.id) ? a.assigneeMember.user.displayName : null,
    dueAt: a.dueAt,
    createdAt: a.createdAt,
    bodySnippet: a.bodyMd?.substring(0, 200) + (a.bodyMd && a.bodyMd.length > 200 ? "..." : ""),
  }));
}

export async function queryProposals(workspaceId: string, status?: ProposalStatus, actor?: AppActor) {
  if (actor) await authorizeConversationTool(actor, workspaceId, "query_proposals");
  const where: Prisma.ProposalWhereInput = await workspaceReaderWhere(workspaceId, actor);
  if (status) where.status = status;

  const proposals = (await scanSourceReadableRecords({ actor: actor!, workspaceId, kind: "Proposal", load: (afterId, take) => prisma.proposal.findMany({
    where: { AND: [where, ...(afterId ? [{ id: { gt: afterId } }] : [])] },
    orderBy: { id: "asc" }, take, include: { author: { select: { id: true, displayName: true, email: true, bio: true } } },
  }) })).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)).slice(0, 20);

  const authors = await captureReadableDigestInputs({ actor: actor!, workspaceId, kind: "User", records: proposals.map((row) => row.author) });
  const authorIds = new Set(authors.records.map((row) => row.id));
  return proposals.map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    author: authorIds.has(p.author.id) ? p.author.displayName : null,
    createdAt: p.createdAt,
  }));
}

export async function queryOrgStructure(workspaceId: string, actor?: AppActor) {
  await workspaceReaderWhere(workspaceId, actor);
  const [circles, assignments] = await Promise.all([listCircles(actor!, workspaceId), listRoleAssignments(actor!, workspaceId)]);
  return circles.map(c => ({
    id: c.id, name: c.name, purpose: c.purposeMd,
    roles: c.roles.map(r => ({ id: r.id, name: r.name, purpose: r.purposeMd,
      assignedMembers: assignments.filter((assignment) => assignment.roleId === r.id).map((assignment) => assignment.member.user.displayName),
    })),
  }));
}

export async function queryGoals(actor: AppActor, workspaceId: string, cadence?: GoalCadence, level?: GoalLevel, status?: GoalStatus) {
  if (actor) await authorizeConversationTool(actor, workspaceId, "query_goals");
  const goals = await listGoals(actor, {
    workspaceId,
    cadence,
    level,
    status,
    take: 20,
  });

  const circles = await captureReadableDigestInputs({ actor, workspaceId, kind: "Circle", records: goals.flatMap((goal) => goal.circle ? [goal.circle] : []) });
  const circleIds = new Set(circles.records.map((circle) => circle.id));
  const owners = goals.flatMap((goal) => goal.ownerMember ? [{ ...goal.ownerMember,
    user: { id: goal.ownerMember.userId, ...goal.ownerMember.user } }] : []);
  const ownerInputs = await captureReadableDigestInputs({ actor, workspaceId, kind: "Member", records: owners,
    additionalInputs: (member) => [{ kind: "User", id: member.userId, snapshot: member.user }] });
  const ownerIds = new Set(ownerInputs.records.map((member) => member.id));
  const keyResults = await captureReadableDigestInputs({ actor, workspaceId, kind: "KeyResult", records: goals.flatMap((goal) => goal.keyResults) });
  const keyResultIds = new Set(keyResults.records.map((keyResult) => keyResult.id));

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
    circle: goal.circle && circleIds.has(goal.circle.id) ? goal.circle.name : null,
    owner: goal.ownerMember && ownerIds.has(goal.ownerMember.id) ? goal.ownerMember.user.displayName : null,
    keyResults: goal.keyResults.filter((keyResult) => keyResultIds.has(keyResult.id)).map((keyResult) => ({
      title: keyResult.title,
      currentValue: keyResult.currentValue,
      targetValue: keyResult.targetValue,
      unit: keyResult.unit,
      progressPercent: keyResult.progressPercent,
    })),
  }));
}
