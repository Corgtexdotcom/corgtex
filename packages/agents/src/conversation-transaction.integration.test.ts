import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { getPrismaClient } from "../../shared/src/db";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createConversation, createConversationPromptInput, addConversationTurn } from "../../domain/src/conversations";
import { ingestConversationOnDemand, ingestConversationOnDemandInTransaction } from "../../domain/src/conversation-brain";
import { createConversationIngressInput } from "../../domain/src/conversation-ingress";
import { captureArtifactInputProof, isArtifactInputProofReadable, withArtifactInputWriteFence } from "../../domain/src/source-lineage";
import { AppError } from "../../domain/src/errors";

const request = "  Exact synthetic queued conversation request\n";

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic conversation transaction", slug: `conversation-transaction-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `conversation-transaction-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: null } };
  const session = await createConversation(actor, { workspaceId: workspace.id });
  return { workspace, user, actor, session };
}

function forbidPrimaryDatabaseCalls(tx: any) {
  const primaryClient = getPrismaClient();
  const guards: Array<{ mockRestore(): void }> = [];
  const delegates = ["workspace", "user", "member", "workspaceSupportGrant", "workspaceFeatureFlag", "agentCredential",
    "conversationSession", "conversationPromptInput", "conversationIngressInput", "conversationTurn", "brainSource", "auditLog", "event",
    "artifactInputLineage", "artifactInputSnapshot", "sourcePermissionEpoch"] as const;
  const methods = ["findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "findMany", "count", "aggregate",
    "create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"] as const;
  for (const name of delegates) {
    const delegate = (prisma as any)[name];
    for (const method of methods) if (typeof delegate?.[method] === "function") guards.push(vi.spyOn(delegate, method).mockImplementation(() => {
      throw new Error(`Global ${name}.${method} is forbidden in the caller transaction`);
    }));
  }
  // Raw SQL descriptors are shared by Prisma proxies; permit only this exact receiver.
  for (const name of ["$executeRaw", "$queryRaw"] as const) {
    const raw = primaryClient[name] as (...args: any[]) => any;
    guards.push(vi.spyOn(primaryClient, name).mockImplementation(function (this: unknown, ...args: any[]) {
      if (this !== tx) throw new Error(`Global ${name} is forbidden in the caller transaction`);
      return raw.apply(this, args);
    }));
  }
  return () => { for (const guard of guards.reverse()) guard.mockRestore(); };
}

describe("native conversation transactions on the explicitly disposable local database", () => {
  beforeEach(async () => {
    // Truncation is permitted only for the repository's disposable local test
    // database. The actual approved run additionally fixes its host port.
    const target = new URL(process.env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
      || target.pathname !== "/corgtex_test" || target.searchParams.get("schema") !== "public") {
      throw new Error("This suite requires a disposable local test database.");
    }
    await truncateAllTables();
  });

  it("uses only the distinct caller transaction while global native, membership and proof delegates throw", async () => {
    const f = await fixture();
    const primaryClient = getPrismaClient();
    await prisma.$transaction(async (tx) => {
      expect(tx === prisma || tx === primaryClient).toBe(false);
      expect(tx.conversationPromptInput === prisma.conversationPromptInput).toBe(false);
      expect(tx.member === prisma.member).toBe(false);
      const restore = forbidPrimaryDatabaseCalls(tx);
      try {
        const prompt = await createConversationPromptInput(f.actor, { workspaceId: f.workspace.id, conversationId: f.session.id, content: request, tx });
        const ingress = await createConversationIngressInput(f.actor, { workspaceId: f.workspace.id, content: request, tx });
        const lineageRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [
          { kind: "ConversationPromptInput", id: prompt.id }, { kind: "ConversationIngressInput", id: ingress.id },
        ], tx);
        const turn = await addConversationTurn(f.actor, { workspaceId: f.workspace.id, conversationId: f.session.id,
          promptInputId: prompt.id, userMessage: request, assistantMessage: "Synthetic transaction-bound answer", lineageRoots, tx });
        const turnRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ConversationTurn", id: turn.id }], tx);
        expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, turnRoots, tx)).toBe(true);
        expect(turn.userMessage).toBe(request);
      } finally { restore(); }
    });
    expect(await prisma.conversationPromptInput.count()).toBe(1);
    expect(await prisma.conversationIngressInput.count()).toBe(1);
    expect(await prisma.conversationTurn.count()).toBe(1);
  });

  it.each(["primitive", "wrapper"] as const)("rejects unconsented %s publication even with complete private roots and the caller transaction", async (entry) => {
    const f = await fixture();
    const prompt = await createConversationPromptInput(f.actor, { workspaceId: f.workspace.id, conversationId: f.session.id, content: request });
    const lineageRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ConversationPromptInput", id: prompt.id }]);
    await expect(prisma.$transaction(async (tx) => {
      expect(tx === getPrismaClient()).toBe(false);
      const restore = forbidPrimaryDatabaseCalls(tx);
      try {
        const params = { workspaceId: f.workspace.id, title: "Synthetic unconsented publication", content: "Synthetic private conversation body", lineageRoots };
        return entry === "primitive" ? await ingestConversationOnDemandInTransaction(tx, f.actor, params)
          : await ingestConversationOnDemand(f.actor, { ...params, tx });
      } finally { restore(); }
    })).rejects.toMatchObject({ code: "BRAIN_CONSENT_REQUIRED" });
    expect(await prisma.brainSource.count()).toBe(0);
    expect(await prisma.artifactInputLineage.count({ where: { artifactType: "BrainSource" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityType: "BrainSource" } })).toBe(0);
    expect(await prisma.event.count({ where: { type: "brain-source.created" } })).toBe(0);
    expect(await prisma.conversationPromptInput.count()).toBe(1);
  });

  it.each(["live", "stale"] as const)("withholds unconsented publication under a %s owner fence and rolls back prior transaction markers", async (owner) => {
    const f = await fixture();
    const prompt = await createConversationPromptInput(f.actor, { workspaceId: f.workspace.id, conversationId: f.session.id, content: request });
    const lineageRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ConversationPromptInput", id: prompt.id }]);
    const fence = vi.fn(async () => {
      if (owner === "stale") throw new AppError(409, "OWNER_STALE", "Synthetic publication owner expired");
    });
    await expect(prisma.$transaction(async (tx) => {
      await tx.event.create({ data: { workspaceId: f.workspace.id, type: "synthetic.publication-marker", aggregateId: f.session.id, payload: { recorded: true } } });
      const restore = forbidPrimaryDatabaseCalls(tx);
      try {
        await withArtifactInputWriteFence(fence, () => ingestConversationOnDemandInTransaction(tx, f.actor, {
          workspaceId: f.workspace.id, title: "Unconsented publication", content: "Unconsented body", lineageRoots,
        }));
      } finally { restore(); }
    })).rejects.toMatchObject({ code: "BRAIN_CONSENT_REQUIRED" });
    expect(fence).not.toHaveBeenCalled();
    expect(await prisma.brainSource.count()).toBe(0);
    expect(await prisma.artifactInputLineage.count({ where: { artifactType: "BrainSource" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityType: "BrainSource" } })).toBe(0);
    expect(await prisma.event.count({ where: { type: { in: ["brain-source.created", "synthetic.publication-marker"] } } })).toBe(0);
    expect(await prisma.conversationPromptInput.count()).toBe(1);
  });

  it.each(["web", "mcp"] as const)("rolls back the exact %s native input together with its request and queued job", async (source) => {
    const f = await fixture();
    await expect(prisma.$transaction(async (tx) => {
      const input = source === "web"
        ? await createConversationPromptInput(f.actor, { workspaceId: f.workspace.id, conversationId: f.session.id, content: request, tx })
        : await createConversationIngressInput(f.actor, { workspaceId: f.workspace.id, content: request, tx });
      const nativeRequest = await tx.agentRequestInput.create({ data: { workspaceId: f.workspace.id, userId: f.user.id, agentKey: "synthetic-conversation", prompt: request } });
      await tx.workflowJob.create({ data: { workspaceId: f.workspace.id, type: "synthetic.conversation", payload: { sessionId: f.session.id, inputId: input.id, requestInputId: nativeRequest.id } } });
      expect(input.content).toBe(request);
      throw new Error("Synthetic enqueue transaction rejected");
    })).rejects.toThrow("Synthetic enqueue transaction rejected");
    expect(await prisma.conversationPromptInput.count()).toBe(0); expect(await prisma.conversationIngressInput.count()).toBe(0);
    expect(await prisma.agentRequestInput.count()).toBe(0); expect(await prisma.workflowJob.count()).toBe(0);
    expect(await prisma.conversationSession.count()).toBe(1);
  });

  it("commits one native prompt and complete assistant turn with generic job completion in the caller's transaction", async () => {
    const f = await fixture();
    const admitted = await prisma.$transaction(async (tx) => {
      const prompt = await createConversationPromptInput(f.actor, { workspaceId: f.workspace.id, conversationId: f.session.id, content: request, tx });
      const nativeRequest = await tx.agentRequestInput.create({ data: { workspaceId: f.workspace.id, userId: f.user.id, agentKey: "synthetic-conversation", prompt: request } });
      const job = await tx.workflowJob.create({ data: { workspaceId: f.workspace.id, type: "synthetic.conversation", payload: { promptInputId: prompt.id, requestInputId: nativeRequest.id }, status: "RUNNING" } });
      return { prompt, nativeRequest, job };
    });
    const lineageRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [
      { kind: "ConversationPromptInput", id: admitted.prompt.id }, { kind: "AgentRequestInput", id: admitted.nativeRequest.id },
    ]);
    const turn = await prisma.$transaction(async (tx) => {
      const value = await addConversationTurn(f.actor, { workspaceId: f.workspace.id, conversationId: f.session.id, promptInputId: admitted.prompt.id,
        userMessage: request, assistantMessage: "Synthetic completed answer", contextJson: { source: "synthetic" }, lineageRoots, tx });
      await tx.workflowJob.update({ where: { id: admitted.job.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      return value;
    });
    expect(turn.promptInputId).toBe(admitted.prompt.id); expect(turn.userMessage).toBe(request); expect(turn.sequenceNumber).toBe(1);
    expect(await prisma.conversationPromptInput.count()).toBe(1); expect(await prisma.conversationTurn.count()).toBe(1);
    expect((await prisma.workflowJob.findUniqueOrThrow({ where: { id: admitted.job.id } })).status).toBe("COMPLETED");
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ConversationTurn", id: turn.id }]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    expect(roots).toEqual(expect.arrayContaining(lineageRoots));
  });

  it.each(["completion", "owner"] as const)("rolls back the final turn and complete receipt on %s failure", async (failure) => {
    const f = await fixture();
    const prompt = await createConversationPromptInput(f.actor, { workspaceId: f.workspace.id, conversationId: f.session.id, content: request });
    const lineageRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ConversationPromptInput", id: prompt.id }]);
    const job = await prisma.workflowJob.create({ data: { workspaceId: f.workspace.id, type: "synthetic.conversation", payload: { promptInputId: prompt.id }, status: "RUNNING" } });
    await expect(prisma.$transaction(async (tx) => {
      await withArtifactInputWriteFence(async (usedTx) => {
        expect(usedTx).toBe(tx);
        if (failure === "owner" && await tx.conversationTurn.count({ where: { conversationId: f.session.id } })) {
          throw new AppError(409, "OWNER_STALE", "Synthetic owner expired");
        }
      }, async () => {
        await addConversationTurn(f.actor, { workspaceId: f.workspace.id, conversationId: f.session.id, promptInputId: prompt.id,
          userMessage: request, assistantMessage: "Uncommitted synthetic answer", lineageRoots, tx });
        await tx.workflowJob.update({ where: { id: job.id }, data: { status: "COMPLETED", completedAt: new Date() } });
        throw new Error("Synthetic completion rejected");
      });
    })).rejects.toThrow(failure === "owner" ? "Synthetic owner expired" : "Synthetic completion rejected");
    expect(await prisma.conversationTurn.count()).toBe(0);
    expect(await prisma.artifactInputLineage.count({ where: { artifactType: "ConversationTurn" } })).toBe(0);
    const current = await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } }); expect(current.status).toBe("RUNNING"); expect(current.completedAt).toBeNull();
    expect(await prisma.conversationPromptInput.count()).toBe(1);
  });
});
