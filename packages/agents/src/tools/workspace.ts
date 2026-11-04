import { prisma } from "@corgtex/shared";
import { authorizeConversationTool } from "../conversation-capabilities";
import type { ModelTool } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import { AppError, listCircles, listRoleAssignments, listGoals, privacyFilter, requireWorkspaceMembership, type LineageKind, captureReadableDigestInputs, DigestReadRelease, loadReadableArtifactSample } from "@corgtex/domain";
import type { Prisma, TensionStatus, ActionStatus, ProposalStatus, GoalCadence, GoalLevel, GoalStatus } from "@prisma/client";

export const getWorkspaceOverviewTool: ModelTool = {
  type: "function",
  function: {
    name: "get_workspace_overview",
    description: "Get a bounded snapshot of the active workspace. Numeric counts are exact only for complete families; null counts have countWindows with a permitted lower bound and complete:false. Use this to orient yourself when the user asks general questions about the organization's state.",
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
  const release = new DigestReadRelease(caller, workspaceId);
  async function countWindow<T extends { id: string }>(params: {
    actor: AppActor; workspaceId: string; kind: LineageKind;
    load: (afterId: string | undefined, take: number) => Promise<T[]>;
  }) {
    let afterId: string | undefined;
    let count = 0;
    for (let page = 0; page < 2; page++) {
      const rows = await params.load(afterId, 100);
      if (rows.length > 100) throw new AppError(409, "SOURCE_CHANGED", "Overview page exceeded its bound.");
      for (const row of rows) {
        if (afterId !== undefined && row.id <= afterId) throw new AppError(409, "SOURCE_CHANGED", "Overview page did not advance.");
        afterId = row.id;
      }
      count += (await release.capture(params.kind, rows)).records.length;
      if (rows.length < 100) return { count, complete: true, scope: "WINDOW" as const };
    }
    return { count, complete: false, scope: "WINDOW" as const };
  }
  const scans = await Promise.all([
    countWindow({ actor: caller, workspaceId, kind: "Member", load: (afterId, take) => prisma.member.findMany({ where: { workspaceId, isActive: true, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take, include: { user: { select: { id: true, email: true, displayName: true } } } }) }),
    countWindow({ actor: caller, workspaceId, kind: "Circle", load: (afterId, take) => prisma.circle.findMany({ where: { workspaceId, archivedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take }) }),
    countWindow({ actor: caller, workspaceId, kind: "Tension", load: (afterId, take) => prisma.tension.findMany({ where: { AND: [{ ...where, status: "OPEN" }, ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take }) }),
    countWindow({ actor: caller, workspaceId, kind: "Action", load: (afterId, take) => prisma.action.findMany({ where: { AND: [{ ...where, status: "OPEN" }, ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take }) }),
    countWindow({ actor: caller, workspaceId, kind: "Proposal", load: (afterId, take) => prisma.proposal.findMany({ where: { AND: [{ ...where, status: { in: ["DRAFT", "OPEN"] } }, ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take }) }),
    countWindow({ actor: caller, workspaceId, kind: "Goal", load: (afterId, take) => prisma.goal.findMany({ where: { AND: [{ ...where, status: { notIn: ["DRAFT", "ABANDONED"] } }, ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take }) }),
  ]);
  const [members, circles, tensions, actions, proposals, goals] = scans;
  const countWindows = { memberCount: members, circleCount: circles, openTensions: tensions,
    openActions: actions, activeProposals: proposals, activeGoals: goals };
  const exact = (window: { count: number; complete: boolean }) => window.complete ? window.count : null;
  return release.finish({ memberCount: exact(members), circleCount: exact(circles), openTensions: exact(tensions),
    openActions: exact(actions), activeProposals: exact(proposals), activeGoals: exact(goals), countWindows });
}

const workspaceAuthorSelect = { id: true, displayName: true, email: true, bio: true, avatarUrl: true,
  linkedinUrl: true, websiteUrl: true, createdAt: true, updatedAt: true } satisfies Prisma.UserSelect;
const workspaceMemberInclude = { user: { select: { id: true, displayName: true, email: true } } } satisfies Prisma.MemberInclude;
const tensionIncludes = { author: { select: workspaceAuthorSelect }, assigneeMember: { include: workspaceMemberInclude },
  raisedByMember: { include: workspaceMemberInclude } } satisfies Prisma.TensionInclude;
const actionIncludes = { author: { select: workspaceAuthorSelect }, assigneeMember: { include: workspaceMemberInclude } } satisfies Prisma.ActionInclude;
const proposalIncludes = { author: { select: workspaceAuthorSelect } } satisfies Prisma.ProposalInclude;

export async function queryTensions(workspaceId: string, status?: TensionStatus, assigneeId?: string, tensionId?: string, actor?: AppActor) {
  if (actor) await authorizeConversationTool(actor, workspaceId, "query_tensions");
  const where: Prisma.TensionWhereInput = await workspaceReaderWhere(workspaceId, actor);
  if (tensionId) where.id = tensionId;
  if (status) where.status = status;
  if (assigneeId) where.assigneeMemberId = assigneeId;

  const release = new DigestReadRelease(actor!, workspaceId);
  const { records: tensions } = await loadReadableArtifactSample<Prisma.TensionGetPayload<{ include: typeof tensionIncludes }>>({ actor: actor!, workspaceId, kind: "Tension", limit: 20, release,
    loadBatch: (after, take) => prisma.tension.findMany({
      where: { AND: [where, ...(after ? [{ OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }] : [])] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, include: tensionIncludes,
    }),
  });

  const authors = await release.capture("User", tensions.map((row) => row.author));
  const authorIds = new Set(authors.records.map((row) => row.id));
  const assigneeMemberInputs = await release.capture("Member", tensions.flatMap((row) => row.assigneeMember ? [row.assigneeMember] : []));
  const assigneeMemberIds = new Set(assigneeMemberInputs.records.map((row) => row.id));
  const raisedByMemberInputs = await release.capture("Member", tensions.flatMap((row) => row.raisedByMember ? [row.raisedByMember] : []));
  const raisedByMemberIds = new Set(raisedByMemberInputs.records.map((row) => row.id));
  return release.finish(tensions.map(t => ({
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
  })));
}

export async function queryActions(workspaceId: string, status?: ActionStatus, assigneeId?: string, actionId?: string, actor?: AppActor) {
  if (actor) await authorizeConversationTool(actor, workspaceId, "query_actions");
  const where: Prisma.ActionWhereInput = await workspaceReaderWhere(workspaceId, actor);
  if (actionId) where.id = actionId;
  if (status) where.status = status;
  if (assigneeId) where.assigneeMemberId = assigneeId;

  const release = new DigestReadRelease(actor!, workspaceId);
  const { records: actions } = await loadReadableArtifactSample<Prisma.ActionGetPayload<{ include: typeof actionIncludes }>>({ actor: actor!, workspaceId, kind: "Action", limit: 20, release,
    loadBatch: (after, take) => prisma.action.findMany({
      where: { AND: [where, ...(after ? [{ OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }] : [])] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, include: actionIncludes,
    }),
  });

  const authors = await release.capture("User", actions.map((row) => row.author));
  const authorIds = new Set(authors.records.map((row) => row.id));
  const assigneeMemberInputs = await release.capture("Member", actions.flatMap((row) => row.assigneeMember ? [row.assigneeMember] : []));
  const assigneeMemberIds = new Set(assigneeMemberInputs.records.map((row) => row.id));
  return release.finish(actions.map(a => ({
    id: a.id,
    version: a.version,
    title: a.title,
    status: a.status,
    author: authorIds.has(a.author.id) ? a.author.displayName : null,
    assignee: a.assigneeMember && assigneeMemberIds.has(a.assigneeMember.id) ? a.assigneeMember.user.displayName : null,
    dueAt: a.dueAt,
    createdAt: a.createdAt,
    bodySnippet: a.bodyMd?.substring(0, 200) + (a.bodyMd && a.bodyMd.length > 200 ? "..." : ""),
  })));
}

export async function queryProposals(workspaceId: string, status?: ProposalStatus, actor?: AppActor) {
  if (actor) await authorizeConversationTool(actor, workspaceId, "query_proposals");
  const where: Prisma.ProposalWhereInput = await workspaceReaderWhere(workspaceId, actor);
  if (status) where.status = status;

  const release = new DigestReadRelease(actor!, workspaceId);
  const { records: proposals } = await loadReadableArtifactSample<Prisma.ProposalGetPayload<{ include: typeof proposalIncludes }>>({ actor: actor!, workspaceId, kind: "Proposal", limit: 20, release,
    loadBatch: (after, take) => prisma.proposal.findMany({
      where: { AND: [where, ...(after ? [{ OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }] : [])] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, include: proposalIncludes,
    }),
  });

  const authors = await release.capture("User", proposals.map((row) => row.author));
  const authorIds = new Set(authors.records.map((row) => row.id));
  return release.finish(proposals.map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    author: authorIds.has(p.author.id) ? p.author.displayName : null,
    createdAt: p.createdAt,
  })));
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
