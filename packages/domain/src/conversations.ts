import { assertArtifactInputWriteFence, readableArtifactIds, recordArtifactInputLineage, advanceHumanArtifactInputLineage, currentArtifactInputRoots, captureArtifactInputProof, sealArtifactInputActor, type LineageRoot } from "./source-lineage";
import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { updateRoleOnboardingStatusByConversation } from "./role-onboarding";

export async function createConversationPromptInput(actor: AppActor, params: { workspaceId: string; conversationId: string; content: string;
  tx?: import("@prisma/client").Prisma.TransactionClient }) {
  invariant(actor.kind === "user", 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  const { workspaceId, conversationId, content, tx: suppliedTx } = params;
  const userId = actor.user.id;
  invariant(typeof content === "string", 400, "INVALID_INPUT", "Conversation input must be text.");
  const assertPrincipal = () => invariant(actor.kind === "user" && actor.user.id === userId,
    403, "AUTHORIZATION_CHANGED", "Conversation principal changed.");
  await requireWorkspaceMembership({ actor, workspaceId, tx: suppliedTx });
  assertPrincipal();
  const persist = async (tx: import("@prisma/client").Prisma.TransactionClient) => {
    await assertArtifactInputWriteFence(tx);
    await requireWorkspaceMembership({ actor, workspaceId, tx });
    assertPrincipal();
    const session = await tx.conversationSession.findFirst({ where: { id: conversationId, workspaceId, userId } });
    invariant(session, 404, "NOT_FOUND", "Conversation not found.");
    assertPrincipal();
    await assertArtifactInputWriteFence(tx);
    const prompt = await tx.conversationPromptInput.create({ data: { workspaceId, sessionId: session.id, userId, content } });
    await assertArtifactInputWriteFence(tx);
    assertPrincipal();
    return prompt;
  };
  return suppliedTx ? persist(suppliedTx) : prisma.$transaction(persist);
}

async function redactConversationTurns(actor: AppActor, workspaceId: string, turns: Array<import("@prisma/client").ConversationTurn>) {
  const readable = await readableArtifactIds(actor, workspaceId, "ConversationTurn", turns);
  const originalIds = turns.flatMap((turn) => turn.promptInputId ? [turn.promptInputId] : []);
  const originals = originalIds.length ? await prisma.conversationPromptInput.findMany({ where: { workspaceId, id: { in: originalIds } } }) : [];
  const originalProof = await readableArtifactIds(actor, workspaceId, "ConversationPromptInput", originals);
  const byId = new Map(originals.map((row) => [row.id, row]));
  return turns.flatMap((turn) => {
    if (readable.has(turn.id)) return [{ ...turn, assistantContentWithheld: false }];
    const original = turn.promptInputId ? byId.get(turn.promptInputId) : null;
    if (!original || !originalProof.has(original.id) || original.content !== turn.userMessage) return [];
    return [{ ...turn, assistantMessage: "", contextJson: null, assistantContentWithheld: true }];
  });
}

export async function listConversations(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  skip?: number;
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId });

  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;

  const pageSize = 100;
  const latestReadableTurn = async (conversationId: string) => {
    let cursor: string | undefined;
    let scanned = 0;
    for (;;) {
      const turns = await prisma.conversationTurn.findMany({ where: { conversationId },
        orderBy: [{ sequenceNumber: "desc" }, { id: "desc" }], take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      scanned += turns.length;
      invariant(scanned <= 5000, 503, "INPUT_SCAN_LIMIT", "Conversation history needs a lineage rebuild before listing.");
      const safe = await redactConversationTurns(actor, workspaceId, turns);
      if (safe.length) return safe.slice(0, 1);
      if (turns.length < pageSize) return [];
      cursor = turns[turns.length - 1].id;
    }
  };
  const safeItems = [];
  let total = 0;
  let scanned = 0;
  let cursor: string | undefined;
  for (;;) {
    const items = await prisma.conversationSession.findMany({
      where: { workspaceId, userId },
      include: { roleOnboarding: { include: { role: true } } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    scanned += items.length;
    invariant(scanned <= 5000, 503, "INPUT_SCAN_LIMIT", "Conversation history needs a lineage rebuild before listing.");
    const readableSessions = await readableArtifactIds(actor, workspaceId, "ConversationSession", items);
    for (const item of items) {
      const readableSession = readableSessions.has(item.id);
      const isPageCandidate = total >= skip && total < skip + take;
      // A proved session already qualifies for the total. Read its body only if
      // displayed; unproved sessions require an independently readable prompt.
      const turns = !readableSession || isPageCandidate ? await latestReadableTurn(item.id) : [];
      if (!readableSession && !turns.length) continue;
      const position = total++;
      if (position < skip || position >= skip + take) continue;
      const onboardingRows = item.roleOnboarding ? [item.roleOnboarding] : [];
      const onboardingProof = await readableArtifactIds(actor, workspaceId, "RoleOnboardingSession", onboardingRows);
      const roleProof = await readableArtifactIds(actor, workspaceId, "Role", onboardingRows.map((row) => row.role));
      safeItems.push({ ...item, topic: readableSession ? item.topic : null,
        systemPrompt: null, roleOnboarding: item.roleOnboarding && onboardingProof.has(item.roleOnboarding.id) && roleProof.has(item.roleOnboarding.roleId) ? item.roleOnboarding : null, turns });
    }
    if (items.length < pageSize) break;
    cursor = items[items.length - 1].id;
  }
  return { items: safeItems, total, take, skip };

}

export async function getConversation(actor: AppActor, workspaceId: string, conversationId: string) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId });

  const session = await prisma.conversationSession.findUnique({
    where: { id: conversationId },
    include: {
      roleOnboarding: { include: { role: true } },
      turns: {
        orderBy: { sequenceNumber: "asc" },
      },
    },
  });

  invariant(session && session.workspaceId === workspaceId && session.userId === userId, 404, "NOT_FOUND", "Conversation not found.");
  const readable = await readableArtifactIds(actor, workspaceId, "ConversationSession", [session]);
  const onboardingProof = await readableArtifactIds(actor, workspaceId, "RoleOnboardingSession", session.roleOnboarding ? [session.roleOnboarding] : []);
  const roleProof = await readableArtifactIds(actor, workspaceId, "Role", session.roleOnboarding ? [session.roleOnboarding.role] : []);
  return { ...session, topic: readable.has(session.id) ? session.topic : null,
    systemPrompt: readable.has(session.id) ? session.systemPrompt : null,
    roleOnboarding: session.roleOnboarding && onboardingProof.has(session.roleOnboarding.id) && roleProof.has(session.roleOnboarding.roleId) ? session.roleOnboarding : null, turns: await redactConversationTurns(actor, workspaceId, session.turns) };
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

  return prisma.$transaction(async (tx) => {
    const session = await tx.conversationSession.create({
    data: {
      workspaceId: params.workspaceId,
      userId,
      agentKey: params.agentKey ?? "assistant",
      topic: params.topic ?? null,
      systemPrompt: params.systemPrompt ?? null,
    },
  });
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "ConversationSession", id: session.id }, content: session, origin: "HUMAN_ORIGINAL", inputs: [] });
    return session;
  });
}

export async function addConversationTurn(actor: AppActor, params: {
  workspaceId: string;
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
  contextJson?: unknown;
  agentRunId?: string | null;
  promptInputId?: string;
  lineageRoots?: LineageRoot[];
  tx?: import("@prisma/client").Prisma.TransactionClient;
}) {
  sealArtifactInputActor(actor);
  const { tx: suppliedTx, ...submission } = params;
  params = { ...structuredClone(submission), tx: suppliedTx };
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx: params.tx });

  const persist = async (tx: import("@prisma/client").Prisma.TransactionClient) => {
    await assertArtifactInputWriteFence(tx);
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('conversation_turn'), hashtext(${params.conversationId}))
    `;
    const session = await tx.conversationSession.findUnique({
      where: { id: params.conversationId },
      select: { id: true, workspaceId: true, userId: true },
    });
    invariant(session && session.workspaceId === params.workspaceId && session.userId === userId, 404, "NOT_FOUND", "Conversation not found.");

    const prompt = params.promptInputId ? await tx.conversationPromptInput.findFirst({ where: { id: params.promptInputId,
      workspaceId: params.workspaceId, sessionId: session.id, userId, content: params.userMessage } }) : null;
    invariant(prompt && params.lineageRoots?.length, 409, "UNKNOWN_LINEAGE", "Conversation output needs its complete input receipt.");
    const promptRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "ConversationPromptInput", id: prompt.id, snapshot: prompt }], tx);
    const lastTurn = await tx.conversationTurn.findFirst({
      where: { conversationId: params.conversationId },
      orderBy: { sequenceNumber: "desc" },
      select: { sequenceNumber: true },
    });

    const turn = await tx.conversationTurn.create({
      data: {
        conversationId: params.conversationId,
        promptInputId: prompt.id,
        sequenceNumber: (lastTurn?.sequenceNumber ?? 0) + 1,
        userMessage: params.userMessage,
        assistantMessage: params.assistantMessage,
        contextJson: params.contextJson ? toInputJson(params.contextJson) : undefined,
        agentRunId: params.agentRunId ?? null,
      },
    });

    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "ConversationTurn", id: turn.id }, content: turn, origin: "DERIVED", inputs: [],
      inheritedRoots: [...promptRoots, ...params.lineageRoots] });
    await tx.conversationSession.update({
      where: { id: params.conversationId },
      data: { updatedAt: new Date() },
    });

    return turn;
  };
  return params.tx ? persist(params.tx) : prisma.$transaction(persist);
}

export async function closeConversation(actor: AppActor, params: { workspaceId: string; conversationId: string }) {
  invariant(actor.kind === "user", 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.$transaction(async (tx) => {
    const session = await tx.conversationSession.findFirst({ where: { id: params.conversationId, workspaceId: params.workspaceId, userId: actor.user.id } });
    invariant(session, 404, "NOT_FOUND", "Conversation not found.");
    const updated = await tx.conversationSession.update({ where: { id: session.id }, data: { status: "COMPLETED" } });
    await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "ConversationSession", id: session.id }, before: session, after: updated });
    return updated;
  });
}

export async function completeRoleOnboardingConversation(actor: AppActor, params: {
  workspaceId: string;
  conversationId: string;
}) {
  return updateRoleOnboardingStatusByConversation(actor, {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    status: "COMPLETED",
  });
}

export async function renameConversation(actor: AppActor, params: {
  workspaceId: string;
  conversationId: string;
  topic: string;
  lineageRoots?: LineageRoot[];
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const session = await tx.conversationSession.findFirst({ where: { id: params.conversationId, workspaceId: params.workspaceId, userId } });
    invariant(session, 404, "NOT_FOUND", "Conversation not found.");
    const updated = await tx.conversationSession.update({ where: { id: session.id }, data: { topic: params.topic } });
    if (params.lineageRoots?.length) {
      const prior = await currentArtifactInputRoots(tx, params.workspaceId, { kind: "ConversationSession", id: session.id }, session);
      invariant(prior, 409, "UNKNOWN_LINEAGE", "Conversation topic context is unproved.");
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "ConversationSession", id: updated.id }, content: updated,
        origin: "DERIVED", inputs: [], inheritedRoots: [...prior, ...params.lineageRoots] });
    } else await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "ConversationSession", id: session.id }, before: session, after: updated });
    return updated;
  });
}

export async function getUningestedConversations(workspaceId: string, since: Date) {
  const actor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "conversation-batch", workspaceIds: [workspaceId] };
  await requireWorkspaceMembership({ actor, workspaceId });
  const sessions = await prisma.conversationSession.findMany({
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
    },
    take: 5001,
  });
  invariant(sessions.length <= 5000, 503, "SOURCE_READ_SCAN_LIMIT", "Conversation input scan exceeds its supported size.");
  const safe = [];
  for (const session of sessions) {
    const visible = await readableArtifactIds(actor, workspaceId, "ConversationTurn", session.turns);
    if (session.turns.some((turn) => !visible.has(turn.id))) continue;
    const hasTopic = (await readableArtifactIds(actor, workspaceId, "ConversationSession", [session])).has(session.id);
    const lineageRoots = await captureArtifactInputProof(actor, workspaceId, [
      ...session.turns.map((turn) => ({ kind: "ConversationTurn" as const, id: turn.id, snapshot: turn })),
      ...(hasTopic ? [{ kind: "ConversationSession" as const, id: session.id, snapshot: session }] : []),
    ]);
    safe.push({ ...session, topic: hasTopic ? session.topic : null, systemPrompt: null, lineageRoots });
  }
  return safe;
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
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      roleOnboarding: { select: { id: true } },
    },
  });
  invariant(session && session.workspaceId === params.workspaceId && session.userId === userId, 404, "NOT_FOUND", "Conversation not found.");
  if (session.roleOnboarding) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.conversationPendingOperation.deleteMany({
        where: {
          workspaceId: params.workspaceId,
          conversationId: params.conversationId,
          status: { not: "EXECUTING" },
        },
      });
      await tx.roleOnboardingSession.updateMany({
        where: {
          conversationId: params.conversationId,
          status: { in: ["PENDING", "ACTIVE"] },
        },
        data: {
          status: "DISMISSED",
          dismissedAt: now,
        },
      });

      return tx.conversationSession.update({
        where: { id: params.conversationId },
        data: { status: "COMPLETED", updatedAt: now },
      });
    });
  }

  return prisma.$transaction(async (tx) => {
    await tx.conversationPendingOperation.deleteMany({
      where: {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        status: { not: "EXECUTING" },
      },
    });
    return tx.conversationSession.delete({
      where: { id: params.conversationId },
    });
  });
}
