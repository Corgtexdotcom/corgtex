import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export async function listConversations(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  skip?: number;
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId });

  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;

  const [items, total] = await Promise.all([
    prisma.conversationSession.findMany({
      where: { workspaceId, userId },
      include: {
        turns: {
          orderBy: { sequenceNumber: "desc" },
          take: 1,
          select: {
            userMessage: true,
            assistantMessage: true,
            createdAt: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    }),
    prisma.conversationSession.count({ where: { workspaceId, userId } }),
  ]);

  return { items, total, take, skip };
}

export async function getConversation(actor: AppActor, workspaceId: string, conversationId: string) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId });

  const session = await prisma.conversationSession.findUnique({
    where: { id: conversationId },
    include: {
      turns: {
        orderBy: { sequenceNumber: "asc" },
      },
    },
  });

  invariant(session && session.workspaceId === workspaceId && session.userId === userId, 404, "NOT_FOUND", "Conversation not found.");
  return session;
}

export async function createConversation(actor: AppActor, params: {
  workspaceId: string;
  agentKey?: string;
  topic?: string | null;
  systemPrompt?: string | null;
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.conversationSession.create({
    data: {
      workspaceId: params.workspaceId,
      userId,
      agentKey: params.agentKey ?? "assistant",
      topic: params.topic ?? null,
      systemPrompt: params.systemPrompt ?? null,
    },
  });
}

export async function addConversationTurn(actor: AppActor, params: {
  workspaceId: string;
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
  contextJson?: unknown;
  agentRunId?: string | null;
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const session = await prisma.conversationSession.findUnique({
    where: { id: params.conversationId },
    select: { id: true, workspaceId: true, userId: true },
  });
  invariant(session && session.workspaceId === params.workspaceId && session.userId === userId, 404, "NOT_FOUND", "Conversation not found.");

  const lastTurn = await prisma.conversationTurn.findFirst({
    where: { conversationId: params.conversationId },
    orderBy: { sequenceNumber: "desc" },
    select: { sequenceNumber: true },
  });

  const turn = await prisma.conversationTurn.create({
    data: {
      conversationId: params.conversationId,
      sequenceNumber: (lastTurn?.sequenceNumber ?? 0) + 1,
      userMessage: params.userMessage,
      assistantMessage: params.assistantMessage,
      contextJson: params.contextJson ? toInputJson(params.contextJson) : undefined,
      agentRunId: params.agentRunId ?? null,
    },
  });

  await prisma.conversationSession.update({
    where: { id: params.conversationId },
    data: { updatedAt: new Date() },
  });

  return turn;
}

export async function closeConversation(actor: AppActor, params: {
  workspaceId: string;
  conversationId: string;
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const session = await prisma.conversationSession.findUnique({
    where: { id: params.conversationId },
    select: { id: true, workspaceId: true, userId: true },
  });
  invariant(session && session.workspaceId === params.workspaceId && session.userId === userId, 404, "NOT_FOUND", "Conversation not found.");

  return prisma.conversationSession.update({
    where: { id: params.conversationId },
    data: { status: "COMPLETED" },
  });
}

export async function renameConversation(actor: AppActor, params: {
  workspaceId: string;
  conversationId: string;
  topic: string;
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const session = await prisma.conversationSession.findUnique({
    where: { id: params.conversationId },
    select: { id: true, workspaceId: true, userId: true },
  });
  invariant(session && session.workspaceId === params.workspaceId && session.userId === userId, 404, "NOT_FOUND", "Conversation not found.");

  return prisma.conversationSession.update({
    where: { id: params.conversationId },
    data: { topic: params.topic },
  });
}

export async function getUningestedConversations(workspaceId: string, since: Date) {
  return prisma.conversationSession.findMany({
    where: {
      workspaceId,
      updatedAt: { gte: since },
      turns: { some: { createdAt: { gte: since } } }
    },
    include: {
      turns: {
        where: { createdAt: { gte: since } },
        orderBy: { sequenceNumber: "asc" }
      },
      user: {
        select: { id: true, email: true, displayName: true }
      }
    }
  });
}

export async function deleteConversation(actor: AppActor, params: {
  workspaceId: string;
  conversationId: string;
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const session = await prisma.conversationSession.findUnique({
    where: { id: params.conversationId },
    select: { id: true, workspaceId: true, userId: true },
  });
  invariant(session && session.workspaceId === params.workspaceId && session.userId === userId, 404, "NOT_FOUND", "Conversation not found.");

  return prisma.conversationSession.delete({
    where: { id: params.conversationId },
  });
}
