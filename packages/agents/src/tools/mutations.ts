import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { ModelTool } from "@corgtex/models";
import { createTension, updateTension, createAction, updateAction, createProposal } from "@corgtex/domain";
import type { TensionStatus, ActionStatus, Prisma } from "@prisma/client";

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
    description: "Update an existing action (e.g. mark it as COMPLETED).",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string" },
        status: { type: "string", description: "DRAFT, OPEN, IN_PROGRESS, or COMPLETED" },
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
    description: "Draft and create a new governance proposal.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        bodyMd: { type: "string", description: "The full proposal text in Markdown" },
        circleId: { type: "string" },
      },
      required: ["title", "summary", "bodyMd"],
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
  });

  await appendAuditMeta("Action", result.id, "action.updated", {
    conversationSessionId: ctx.sessionId,
    toolCallInput: args,
  });

  return { success: true, actionId: result.id };
}

export async function createProposalAction(actor: AppActor, ctx: any, args: any) {
  const result = await createProposal(actor, {
    workspaceId: ctx.workspaceId,
    title: args.title,
    summary: args.summary,
    bodyMd: args.bodyMd,
    circleId: args.circleId,
  });

  await appendAuditMeta("Proposal", result.id, "proposal.created", {
    conversationSessionId: ctx.sessionId,
    toolCallInput: args,
  });

  return { success: true, proposalId: result.id };
}
