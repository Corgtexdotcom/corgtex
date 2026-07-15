import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { ModelTool } from "@corgtex/models";
import { AppError, createTension, updateTension, createAction, updateAction, createProposal, createProposalFromTension, createGoal } from "@corgtex/domain";
import type { TensionStatus, ActionStatus, GoalCadence, GoalLevel, GoalStatus, Prisma } from "@prisma/client";

export const createTensionTool: ModelTool = {
  type: "function",
  function: {
    name: "create_tension",
    description: "Create a new tension based on user input. Only do this if the user has implicitly or explicitly requested a new tension to be created.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Clear, concise title of the tension" },
        bodyMd: { type: "string", description: "Detailed description in Markdown format" },
        circleId: { type: "string", description: "Optional UUID of the circle this belongs to" },
        assigneeMemberId: { type: "string", description: "Optional UUID of a member assigned to resolve this" },
        raisedByMemberId: { type: "string", description: "Optional UUID of the member who raised this tension" },
      },
      required: ["title"],
    },
  },
};

export const updateTensionTool: ModelTool = {
  type: "function",
  function: {
    name: "update_tension",
    description: "Update an existing tension (e.g. resolve it with a note, change assignee, or update body).",
    parameters: {
      type: "object",
      properties: {
        tensionId: { type: "string", description: "The UUID of the tension to update" },
        status: { type: "string", description: "DRAFT, OPEN, or RESOLVED" },
        resolvedVia: { type: "string", description: "Required when setting status to RESOLVED" },
        title: { type: "string" },
        bodyMd: { type: "string" },
        assigneeMemberId: { type: "string", description: "Set or clear the assigned member UUID" },
        raisedByMemberId: { type: "string", description: "Set or clear the member who raised this tension" },
      },
      required: ["tensionId"],
    },
  },
};

export const createActionTool: ModelTool = {
  type: "function",
  function: {
    name: "create_action",
    description: "Create a new action item.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the action" },
        bodyMd: { type: "string", description: "Description in Markdown" },
        circleId: { type: "string" },
        assigneeMemberId: { type: "string" },
        dueAt: { type: "string", description: "ISO 8601 UTC date string for when this is due" },
      },
      required: ["title"],
    },
  },
};

export const updateActionTool: ModelTool = {
  type: "function",
  function: {
    name: "update_action",
    description: "Update an existing action. When setting status to COMPLETED, include completedVia with a note explaining how it was completed.",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string" },
        status: { type: "string", description: "DRAFT, OPEN, IN_PROGRESS, or COMPLETED" },
        completedVia: { type: "string", description: "Required when setting status to COMPLETED" },
        title: { type: "string" },
        bodyMd: { type: "string" },
        assigneeMemberId: { type: "string" },
      },
      required: ["actionId"],
    },
  },
};

export const createProposalTool: ModelTool = {
  type: "function",
  function: {
    name: "create_proposal",
    description: "Draft and create a new governance proposal. When the user asks to turn a tension into a proposal, pass sourceTensionId. Only pass relatedActionIds for existing implementation or follow-up actions that are clearly connected.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Required unless sourceTensionId is provided" },
        summary: { type: "string" },
        bodyMd: { type: "string", description: "The full proposal text in Markdown. Required unless sourceTensionId is provided." },
        circleId: { type: "string" },
        sourceTensionId: { type: "string", description: "Optional UUID of the tension this proposal is drafted from" },
        ownerMemberId: {
          type: ["string", "null"],
          description: "Optional owner member UUID. Omit to default to the creator; pass null only when the user explicitly asks for no owner.",
        },
        relatedActionIds: {
          type: "array",
          description: "Optional UUIDs of existing action items related to implementing or following up on this proposal",
          items: { type: "string" },
        },
      },
      required: [],
    },
  },
};

export const createGoalTool: ModelTool = {
  type: "function",
  function: {
    name: "create_goal",
    description: "Create a new workspace goal in the Goals tab. Use this when users ask to add goals, OKRs, objectives, or 10-year/5-year/annual/quarterly/monthly/weekly goals.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Clear goal title" },
        descriptionMd: { type: "string", description: "Optional goal description in Markdown" },
        cadence: { type: "string", description: "TEN_YEAR, FIVE_YEAR, ANNUAL, QUARTERLY, MONTHLY, or WEEKLY. Defaults to QUARTERLY." },
        level: { type: "string", description: "COMPANY, CIRCLE, or PERSONAL. Defaults to COMPANY." },
        status: { type: "string", description: "DRAFT, ACTIVE, ON_TRACK, AT_RISK, BEHIND, COMPLETED, or ABANDONED. Defaults to ACTIVE." },
        targetDate: { type: "string", description: "Optional ISO 8601 date string" },
        startDate: { type: "string", description: "Optional ISO 8601 date string" },
        parentGoalId: { type: "string", description: "Optional parent goal UUID" },
        circleId: { type: "string", description: "Optional circle UUID" },
        ownerMemberId: { type: "string", description: "Optional owner member UUID" },
        keyResults: {
          type: "array",
          description: "Optional measurable key results for the goal",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              targetValue: { type: "number" },
              currentValue: { type: "number" },
              unit: { type: "string" },
            },
            required: ["title"],
          },
        },
      },
      required: ["title"],
    },
  },
};

async function appendAuditMeta(entityType: string, entityId: string, actionName: string, metaToAdd: Prisma.InputJsonObject) {
  const log = await prisma.auditLog.findFirst({
    where: { entityType, entityId, action: actionName },
    orderBy: { createdAt: "desc" },
  });
  if (log) {
    await prisma.auditLog.update({
      where: { id: log.id },
      data: {
        meta: { ...(log.meta as Record<string, unknown>), ...metaToAdd } as any,
      },
    });
  }
}

export async function createTensionAction(actor: AppActor, ctx: any, args: any) {
  const result = await createTension(actor, {
    workspaceId: ctx.workspaceId,
    title: args.title,
    bodyMd: args.bodyMd,
    circleId: args.circleId,
    assigneeMemberId: args.assigneeMemberId,
    raisedByMemberId: args.raisedByMemberId,
  });
  
  await appendAuditMeta("Tension", result.id, "tension.created", {
    conversationSessionId: ctx.sessionId,
    toolCallInput: args,
  });
  
  return { success: true, tensionId: result.id };
}

export async function updateTensionAction(actor: AppActor, ctx: any, args: any) {
  const result = await updateTension(actor, {
    workspaceId: ctx.workspaceId,
    tensionId: args.tensionId,
    status: args.status as TensionStatus,
    title: args.title,
    bodyMd: args.bodyMd,
    assigneeMemberId: args.assigneeMemberId,
    raisedByMemberId: args.raisedByMemberId,
    resolvedVia: args.resolvedVia,
  });

  await appendAuditMeta("Tension", result.id, "tension.updated", {
    conversationSessionId: ctx.sessionId,
    toolCallInput: args,
  });
  
  return { success: true, tensionId: result.id };
}

export async function createActionItemAction(actor: AppActor, ctx: any, args: any) {
  const result = await createAction(actor, {
    workspaceId: ctx.workspaceId,
    title: args.title,
    bodyMd: args.bodyMd,
    circleId: args.circleId,
    assigneeMemberId: args.assigneeMemberId,
    dueAt: args.dueAt ? new Date(args.dueAt) : undefined,
  });

  await appendAuditMeta("Action", result.id, "action.created", {
    conversationSessionId: ctx.sessionId,
    toolCallInput: args,
  });

  return { success: true, actionId: result.id };
}

export async function updateActionItemAction(actor: AppActor, ctx: any, args: any) {
  const result = await updateAction(actor, {
    workspaceId: ctx.workspaceId,
    actionId: args.actionId,
    status: args.status as ActionStatus,
    title: args.title,
    bodyMd: args.bodyMd,
    assigneeMemberId: args.assigneeMemberId,
    completedVia: args.completedVia,
  });

  await appendAuditMeta("Action", result.id, "action.updated", {
    conversationSessionId: ctx.sessionId,
    toolCallInput: args,
  });

  return { success: true, actionId: result.id };
}

export async function createProposalAction(actor: AppActor, ctx: any, args: any) {
  const relatedActionIds = Array.isArray(args.relatedActionIds) ? args.relatedActionIds : undefined;
  const sourceTensionId = typeof args.sourceTensionId === "string" && args.sourceTensionId.trim().length > 0
    ? args.sourceTensionId
    : null;
  const hasOwnerMemberId = Object.prototype.hasOwnProperty.call(args, "ownerMemberId");
  if (hasOwnerMemberId && typeof args.ownerMemberId !== "string" && args.ownerMemberId !== null) {
    throw new AppError(400, "INVALID_OWNER_MEMBER_ID", "ownerMemberId must be a string, null, or omitted.");
  }
  const ownerMemberId = hasOwnerMemberId ? args.ownerMemberId as string | null : undefined;
  const result = sourceTensionId
    ? await createProposalFromTension(actor, {
        workspaceId: ctx.workspaceId,
        sourceTensionId,
        title: typeof args.title === "string" ? args.title : null,
        summary: typeof args.summary === "string" ? args.summary : null,
        bodyMd: typeof args.bodyMd === "string" ? args.bodyMd : null,
        circleId: typeof args.circleId === "string" ? args.circleId : null,
        relatedActionIds,
        ...(hasOwnerMemberId ? { ownerMemberId } : {}),
      })
    : await createProposal(actor, {
        workspaceId: ctx.workspaceId,
        title: typeof args.title === "string" ? args.title : "",
        summary: typeof args.summary === "string" ? args.summary : null,
        bodyMd: typeof args.bodyMd === "string" ? args.bodyMd : "",
        circleId: typeof args.circleId === "string" ? args.circleId : null,
        relatedActionIds,
        ...(hasOwnerMemberId ? { ownerMemberId } : {}),
      });

  await appendAuditMeta("Proposal", result.id, "proposal.created", {
    conversationSessionId: ctx.sessionId,
    toolCallInput: args,
  });

  return { success: true, proposalId: result.id };
}

export async function createGoalAction(actor: AppActor, ctx: any, args: any) {
  const result = await createGoal(actor, {
    workspaceId: ctx.workspaceId,
    title: args.title,
    descriptionMd: args.descriptionMd,
    cadence: args.cadence as GoalCadence | undefined,
    level: args.level as GoalLevel | undefined,
    status: args.status as GoalStatus | undefined,
    targetDate: args.targetDate ? new Date(args.targetDate) : undefined,
    startDate: args.startDate ? new Date(args.startDate) : undefined,
    parentGoalId: args.parentGoalId,
    circleId: args.circleId,
    ownerMemberId: args.ownerMemberId,
    keyResults: Array.isArray(args.keyResults) ? args.keyResults : undefined,
  });

  await appendAuditMeta("Goal", result.id, "goal.created", {
    conversationSessionId: ctx.sessionId,
    toolCallInput: args,
  });

  return { success: true, goalId: result.id };
}
