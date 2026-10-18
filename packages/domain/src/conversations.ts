import { captureReadableDigestInputs } from "./digest-lineage";
import { WorkItemReadRelease } from "./work-item-readable-page";
import { assertArtifactInputWriteFence, captureReadableConversationInputs, readableArtifactIds, recordArtifactInputLineage, advanceHumanArtifactInputLineage, currentArtifactInputRoots, captureArtifactInputProof, sealArtifactInputActor, type LineageRoot } from "./source-lineage";
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

async function captureConversationPage<T extends {id: string}>(actor: AppActor, workspaceId: string,
  kind: "ConversationTurn" | "ConversationPromptInput", records: T[]): Promise<{records: T[]; proofs: Map<string,LineageRoot[]>}> {
  if (!records.length) return {records: [], proofs: new Map()};
  if (records.length <= 75) {
    const captured = await captureReadableConversationInputs(actor,workspaceId,kind,records);
    if (captured) return captured;
    if (records.length === 1) return captureReadableDigestInputs({actor,workspaceId,kind,records});
  }
  // Subdivide unsupported/denied closures so one legacy row cannot force the
  // whole history back into serial proof traversal. No content is truncated.
  const split = records.length > 75 ? 75 : Math.ceil(records.length / 2);
  const first = await captureConversationPage(actor,workspaceId,kind,records.slice(0,split));
  const rest = await captureConversationPage(actor,workspaceId,kind,records.slice(split));
  return {records: [...first.records,...rest.records], proofs: new Map([...first.proofs,...rest.proofs])};
}

async function redactConversationTurns(actor: AppActor, workspaceId: string, turns: Array<import("@prisma/client").ConversationTurn>, release?: WorkItemReadRelease, firstOnly = false) {
  // Discovery can omit unknown candidates cheaply; selected content still needs
  // its original full proof and the final shared release.
  const candidateIds = release && firstOnly
    ? await readableArtifactIds(actor, workspaceId, "ConversationTurn", turns) : null;
  const candidates = candidateIds ? turns.filter(turn => candidateIds.has(turn.id)) : turns;
  const admittedTurns = release ? await captureConversationPage(actor, workspaceId, "ConversationTurn", candidates) : null;
  const readable = admittedTurns ? new Set(admittedTurns.records.map(row => row.id)) : await readableArtifactIds(actor, workspaceId, "ConversationTurn", turns);
  const originalIds = turns.flatMap((turn) => turn.promptInputId ? [turn.promptInputId] : []);
  const originals = originalIds.length ? await prisma.conversationPromptInput.findMany({ where: { workspaceId, id: { in: originalIds } } }) : [];
  const admittedPrompts = release ? await captureConversationPage(actor, workspaceId, "ConversationPromptInput", originals) : null;
  const originalProof = admittedPrompts ? new Set(admittedPrompts.records.map(row => row.id)) : await readableArtifactIds(actor, workspaceId, "ConversationPromptInput", originals);
  const byId = new Map(originals.map((row) => [row.id, row]));
  const safe = [];
  for (const turn of turns) {
    if (readable.has(turn.id)) {
      if (release) release.add(admittedTurns!.proofs.get(turn.id)!);
      safe.push({ ...turn, assistantContentWithheld: false });
      if (firstOnly) break;
      continue;
    }
    const original = turn.promptInputId ? byId.get(turn.promptInputId) : null;
    if (!original || !originalProof.has(original.id) || original.content !== turn.userMessage) continue;
    if (release) release.add(admittedPrompts!.proofs.get(original.id)!);
    safe.push({ ...turn, assistantMessage: "", contextJson: null, assistantContentWithheld: true });
    if (firstOnly) break;
  }
  return safe;
}

export async function listConversations(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  skip?: number;
}) {
  sealArtifactInputActor(actor);
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId });

  const release = new WorkItemReadRelease(actor, workspaceId);
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  invariant(Number.isSafeInteger(take) && take >= 0 && take <= 5000 && Number.isSafeInteger(skip) && skip >= 0,
    400, "INVALID_INPUT", "Conversation pagination is invalid.");

  const pageSize = 100;
  const latestReadableTurn = async (conversationId: string) => {
    let after: { id: string; sequenceNumber: number } | undefined;
    for (;;) {
      const turns = await prisma.conversationTurn.findMany({ where: { conversationId,
        ...(after ? { OR: [{ sequenceNumber: { lt: after.sequenceNumber } },
          { sequenceNumber: after.sequenceNumber, id: { lt: after.id } }] } : {}),
      },
        orderBy: [{ sequenceNumber: "desc" }, { id: "desc" }], take: pageSize,
      });
      invariant(turns.length <= pageSize && (!turns.length || turns.at(-1)!.id !== after?.id),
        503, "SOURCE_READ_SCAN_CHANGED", "Conversation turn page changed; retry.");
      const next = turns.length ? { id: turns.at(-1)!.id, sequenceNumber: turns.at(-1)!.sequenceNumber } : undefined;
      const safe = await release.observeRead(() => redactConversationTurns(actor, workspaceId, turns, release, true));
      if (safe.length) return safe.slice(0, 1);
      if (turns.length < pageSize) return [];
      after = next;
    }
  };
  const safeItems = [];
  let total = 0;
  let after: {id: string; updatedAt: Date} | undefined;
  for (;;) {
    const items = await prisma.conversationSession.findMany({
      where: { workspaceId, userId,
        ...(after ? {OR:[{updatedAt:{lt:after.updatedAt}},{updatedAt:after.updatedAt,id:{lt:after.id}}]} : {}),
      },
      include: { roleOnboarding: { include: { role: true } } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: pageSize,
    });
    invariant(items.length <= pageSize && (!items.length || items.at(-1)!.id !== after?.id),
      503, "SOURCE_READ_SCAN_CHANGED", "Conversation page changed; retry.");
    const readableSessions = await release.observeRead(async () => {
      const admitted = await captureReadableDigestInputs({actor,workspaceId,kind:"ConversationSession",records:items});
      release.add(admitted.roots);
      return new Set(admitted.records.map(row => row.id));
    });
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
      const onboarding = await release.observeRead(() => captureReadableDigestInputs({actor,workspaceId,kind:"RoleOnboardingSession",records:onboardingRows,
        additionalInputs: row => [{kind:"Role",id:row.role.id,snapshot:row.role}],
      }));
      release.add(onboarding.roots);
      safeItems.push({ ...item, topic: readableSession ? item.topic : null,
        systemPrompt: null, roleOnboarding: onboarding.records[0] ?? null, turns });
    }
    if (items.length < pageSize) break;
    after = { id: items.at(-1)!.id, updatedAt: items.at(-1)!.updatedAt };
  }
  await requireWorkspaceMembership({ actor, workspaceId });
  return release.finish({ items: safeItems, total, take, skip });

}

/** Shell history: bounded discovery and one shared preview budget, without an
 * exact total. Full list/detail callers retain their existing contracts. */
export async function listRecentConversations(actor: AppActor, workspaceId: string, opts?: { take?: number }) {
  sealArtifactInputActor(actor);
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Conversations require a user actor.");
  const take = opts?.take ?? 20;
  invariant(Number.isSafeInteger(take) && take >= 0 && take <= 30,
    400, "INVALID_INPUT", "Recent conversation limit is invalid.");
  await requireWorkspaceMembership({ actor, workspaceId });
  const release = new WorkItemReadRelease(actor, workspaceId);
  const items: Awaited<ReturnType<typeof listConversations>>["items"] = [];
  let examinedSessions = 0;
  let examinedTurns = 0;
  let previewIncomplete = false;
  let sessionsComplete = false;
  let after: { id: string; updatedAt: Date } | undefined;
  const preview = async (conversationId: string) => {
    let turnAfter: { id: string; sequenceNumber: number } | undefined;
    while (examinedTurns < 200) {
      const pageSize = turnAfter ? Math.min(100, 200 - examinedTurns) : 1;
      const page = await release.observeRead(async () => {
        const turns = await prisma.conversationTurn.findMany({ where: { conversationId,
          ...(turnAfter ? { OR: [{ sequenceNumber: { lt: turnAfter.sequenceNumber } },
            { sequenceNumber: turnAfter.sequenceNumber, id: { lt: turnAfter.id } }] } : {}),
        }, orderBy: [{ sequenceNumber: "desc" }, { id: "desc" }], take: pageSize });
        invariant(turns.length <= pageSize && (!turns.length || turns.at(-1)!.id !== turnAfter?.id),
          503, "SOURCE_READ_SCAN_CHANGED", "Conversation turn page changed; retry.");
        return { turns, safe: await redactConversationTurns(actor, workspaceId, turns, release, true) };
      });
      examinedTurns += page.turns.length;
      if (page.safe.length) return page.safe.slice(0, 1);
      if (page.turns.length < pageSize) return [];
      const last = page.turns.at(-1)!;
      turnAfter = { id: last.id, sequenceNumber: last.sequenceNumber };
    }
    previewIncomplete = true;
    return [];
  };
  while (items.length < take && examinedSessions < 200) {
    const pageSize = Math.min(30, 200 - examinedSessions);
    const page = await release.observeRead(async () => {
      const rows = await prisma.conversationSession.findMany({ where: { workspaceId, userId,
        ...(after ? { OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { lt: after.id } }] } : {}),
      }, include: { roleOnboarding: { include: { role: true } } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: pageSize });
      invariant(rows.length <= pageSize && (!rows.length || rows.at(-1)!.id !== after?.id),
        503, "SOURCE_READ_SCAN_CHANGED", "Conversation page changed; retry.");
      const admitted = await captureReadableDigestInputs({ actor, workspaceId, kind: "ConversationSession", records: rows });
      return { rows, admitted };
    });
    examinedSessions += page.rows.length;
    let processed = 0;
    for (const row of page.rows) {
      processed++;
      const sessionProof = page.admitted.proofs.get(row.id);
      const turns = await preview(row.id);
      if (!sessionProof && !turns.length) continue;
      if (sessionProof) release.add(sessionProof);
      const onboarding = await release.observeRead(() => captureReadableDigestInputs({ actor, workspaceId,
        kind: "RoleOnboardingSession", records: row.roleOnboarding ? [row.roleOnboarding] : [],
        additionalInputs: record => [{ kind: "Role", id: record.role.id, snapshot: record.role }],
      }));
      release.add(onboarding.roots);
      items.push({ ...row, topic: sessionProof ? row.topic : null, systemPrompt: null,
        roleOnboarding: onboarding.records[0] ?? null, turns });
      if (items.length === take) break;
    }
    if (processed === page.rows.length && page.rows.length < pageSize) { sessionsComplete = true; break; }
    const last = page.rows.at(-1);
    if (!last) break;
    after = { id: last.id, updatedAt: last.updatedAt };
  }
  return release.finish({ items, complete: sessionsComplete && !previewIncomplete });
}

export async function getConversation(actor: AppActor, workspaceId: string, conversationId: string) {
  sealArtifactInputActor(actor);
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
  const release = new WorkItemReadRelease(actor, workspaceId);
  const admittedSession = await release.observeRead(() => captureReadableDigestInputs({
    actor, workspaceId, kind: "ConversationSession", records: [session],
  }));
  release.add(admittedSession.roots);
  const readable = admittedSession.records.length > 0;
  const onboarding = await release.observeRead(() => captureReadableDigestInputs({
    actor, workspaceId, kind: "RoleOnboardingSession", records: session.roleOnboarding ? [session.roleOnboarding] : [],
    additionalInputs: row => [{ kind: "Role", id: row.role.id, snapshot: row.role }],
  }));
  release.add(onboarding.roots);
  const turns = await release.observeRead(() => redactConversationTurns(actor, workspaceId, session.turns, release));
  return release.finish({ ...session, topic: readable ? session.topic : null,
    systemPrompt: readable ? session.systemPrompt : null, roleOnboarding: onboarding.records[0] ?? null, turns });
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
