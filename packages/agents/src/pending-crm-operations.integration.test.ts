import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { getPrismaClient } from "../../shared/src/db";
import { runWithSupportOrigin } from "../../shared/src/support-context";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createConversation, createConversationPromptInput } from "../../domain/src/conversations";
import { createActivity, createCrmAccount } from "../../domain/src/crm";
import { captureArtifactInputProof, isArtifactInputProofReadable, withArtifactInputWriteFence } from "../../domain/src/source-lineage";
import { beginCrmPendingOperationExecution, createPendingCrmOperation,
  markCrmPendingOperationExecuted, markCrmPendingOperationFailed,
  commitCrmPendingOperationExecution } from "./pending-crm-operations";
import { recordRelationshipActivityAction, completeRelationshipActivityAction, createCommunicationSuggestionAction } from "./tools/crm";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(toolName = "record_relationship_activity") {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic pending CRM fence", slug: `pending-crm-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `pending-crm-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  // Persist explicit current authority rows so both real Finance proofs share
  // locks; the race must reach pending ownership, not a missing-edge Workspace lock.
  await prisma.workspaceFeatureFlag.create({ data: { workspaceId: workspace.id, flag: "FINANCE", enabled: false } });
  await prisma.workspaceSupportGrant.create({ data: { workspaceId: workspace.id, userId: user.id, grantedByUserId: user.id, role: "FULL", isActive: true } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: null } };
  const session = await createConversation(actor, { workspaceId: workspace.id });
  const userMessage = "Record the synthetic approved follow-up.";
  const prompt = await createConversationPromptInput(actor, { workspaceId: workspace.id, conversationId: session.id, content: userMessage });
  const account = await createCrmAccount(actor, { workspaceId: workspace.id, name: "Synthetic account" });
  const lineageRoots = await captureArtifactInputProof(actor, workspace.id, [{ kind: "ConversationPromptInput", id: prompt.id }]);
  const ctx = { actor, workspaceId: workspace.id, sessionId: session.id, userId: user.id, agentKey: "assistant", userMessage, lineageRoots };
  const activity = toolName === "complete_relationship_activity" ? await createActivity(actor, {
    workspaceId: workspace.id, title: "Synthetic original activity", bodyMd: "Synthetic original body", accountId: account.id,
  }) : null;
  const args: any = activity ? { activityId: activity.id } : { title: "Synthetic permitted effect", bodyMd: "Synthetic approved body", accountId: account.id };
  const operation = await createPendingCrmOperation({ ctx, toolName, args });
  const begin = await beginCrmPendingOperationExecution(ctx, operation);
  if (begin.state !== "ready") throw new Error("Synthetic operation did not obtain an execution capability");
  return { actor, workspace, ctx, args, operation, begin, activity };
}

async function heldEffect(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = deferred(); const release = deferred();
  let holderPid = 0; let first = true;
  const order: string[] = [];
  const persistenceFence = async (tx: any) => {
    expect(tx === prisma).toBe(false);
    order.push("worker-fence");
    const [identity] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
    holderPid = identity.pid;
    await f.begin.executionFence(tx);
    order.push("pending-fence");
    if (first) { first = false; entered.resolve(); await release.promise; }
  };
  const result = withArtifactInputWriteFence(persistenceFence, () => createActivity(f.actor, {
    workspaceId: f.workspace.id, ...f.args, source: "workspace-chat", lineageRoots: f.begin.lineageRoots,
  })).then(value => ({ value }), error => ({ error }));
  await Promise.race([entered.promise, result.then(outcome => {
    if ("error" in outcome) throw outcome.error;
    throw new Error("Synthetic effect bypassed its execution fence");
  })]);
  expect(order.slice(0, 2)).toEqual(["worker-fence", "pending-fence"]);
  return { result, release, holderPid };
}

async function waitForPendingRowWait(holderPid: number, queryKind: "UPDATE" | "SELECT") {
  // Real async timers stay enabled even when only the Date clock is advanced.
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock' AND query LIKE '%ConversationPendingOperation%'
      AND query LIKE ${`%${queryKind}%`} AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
    if (waiting.length) return;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error("Synthetic contender did not block on the pending authority row");
}

describe("pending CRM effect transactions on the assigned disposable database", () => {
  beforeEach(async () => {
    const target = new URL(process.env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.pathname !== "/corgtex_test" || target.searchParams.get("schema") !== "public") {
      throw new Error("This suite requires the disposable local test database.");
    }
    await truncateAllTables();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([
    ["complete_relationship_activity", completeRelationshipActivityAction, "CrmActivity", "crm.activity.completed"],
    ["create_communication_suggestion", createCommunicationSuggestionAction, "CrmCommunicationSuggestion", "crm.communication_suggestion.created"],
  ] as const)("commits the native %s effect, complete receipt and applicable audit atomically", async (toolName, handler, kind, action) => runWithSupportOrigin(undefined, async () => {
    const f = await fixture(toolName);
    const committed = await commitCrmPendingOperationExecution(f.ctx, f.begin.operation, ({ tx, lineageRoots }) =>
      handler(f.actor, { workspaceId: f.workspace.id, tx, lineageRoots: [...lineageRoots] }, f.args));
    const effect = kind === "CrmActivity" ? await prisma.crmActivity.findUniqueOrThrow({ where: { id: f.activity!.id } })
      : await prisma.crmCommunicationSuggestion.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    expect(committed.operation).toMatchObject({ status: "EXECUTED", resultJson: JSON.parse(JSON.stringify(committed.result)) });
    expect(committed.result).toMatchObject(kind === "CrmActivity" ? { success: true, activity: { id: effect.id } }
      : { success: true, emailSent: false, suggestion: { id: effect.id } });
    if (kind === "CrmActivity") expect((effect as any).completedAt).toBeInstanceOf(Date);
    const audit = await prisma.auditLog.findMany({ where: { workspaceId: f.workspace.id, action, entityId: effect.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: f.ctx.userId, entityType: kind });
    for (const artifact of [{ kind, id: effect.id }, { kind: "ConversationPendingOperation" as const, id: committed.operation.id }]) {
      const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [artifact]);
      expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    }
    await expect(commitCrmPendingOperationExecution(f.ctx, f.begin.operation, async () => { throw Error("Replayed effect"); }))
      .rejects.toMatchObject({ code: "CRM_EXECUTION_STALE" });
    expect(await prisma.auditLog.count({ where: { workspaceId: f.workspace.id, action, entityId: effect.id } })).toBe(1);
  }));

  it.each([
    ["complete_relationship_activity", completeRelationshipActivityAction, "CrmActivity", "crm.activity.completed"],
    ["create_communication_suggestion", createCommunicationSuggestionAction, "CrmCommunicationSuggestion", "crm.communication_suggestion.created"],
  ] as const)("rolls native %s effect, lineage and audit back when canonical publication fails", async (toolName, handler, kind, action) => runWithSupportOrigin(undefined, async () => {
    const f = await fixture(toolName);
    const before = await prisma.artifactInputLineage.findMany({ where: { workspaceId: f.workspace.id, artifactType: kind }, orderBy: { id: "asc" } });
    const client = getPrismaClient(); const original = client.$transaction.bind(client);
    vi.spyOn(client, "$transaction").mockImplementation(((callback: any, options: any) => original(async tx => callback(new Proxy(tx, {
      get(target, property) {
        if (property !== "conversationPendingOperation") return Reflect.get(target, property);
        return new Proxy(target.conversationPendingOperation, { get(delegate, method) {
          if (method !== "update") return Reflect.get(delegate, method);
          return async (args: any) => {
            if (args.data.status === "EXECUTED") throw Error("Synthetic canonical terminal write failed");
            return delegate.update(args);
          };
        } });
      },
    })), options)) as any);
    await expect(commitCrmPendingOperationExecution(f.ctx, f.begin.operation, ({ tx, lineageRoots }) =>
      handler(f.actor, { workspaceId: f.workspace.id, tx, lineageRoots: [...lineageRoots] }, f.args))).rejects.toThrow("Synthetic canonical terminal write failed");
    if (kind === "CrmActivity") expect((await prisma.crmActivity.findUniqueOrThrow({ where: { id: f.activity!.id } })).completedAt).toBeNull();
    else expect(await prisma.crmCommunicationSuggestion.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { workspaceId: f.workspace.id, action } })).toBe(0);
    expect(await prisma.artifactInputLineage.findMany({ where: { workspaceId: f.workspace.id, artifactType: kind }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.conversationPendingOperation.findUniqueOrThrow({ where: { id: f.begin.operation.id } }))
      .toMatchObject({ status: "EXECUTING", resultJson: null, executedAt: null });
  }));

  it("commits the actual tool effect, complete lineage and canonical EXECUTED receipt on one transaction", async () => runWithSupportOrigin(undefined, async () => {
    const f = await fixture();
    const committed = await commitCrmPendingOperationExecution(f.ctx, f.begin.operation, ({ tx, lineageRoots }) =>
      recordRelationshipActivityAction(f.actor, { workspaceId: f.workspace.id, tx, lineageRoots: [...lineageRoots] }, f.args));
    expect(committed.operation.status).toBe("EXECUTED");
    const activity = await prisma.crmActivity.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    expect(committed.operation.resultJson).toEqual(committed.result);
    expect(committed.operation.resultJson).toMatchObject({ success: true, activity: { id: activity.id } });
    expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id, artifactType: "CrmActivity", artifactId: activity.id } })).toBe(1);
    expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id, artifactType: "ConversationPendingOperation", artifactId: f.begin.operation.id } })).toBeGreaterThan(1);
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ConversationPendingOperation", id: committed.operation.id }]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    await expect(commitCrmPendingOperationExecution(f.ctx, f.begin.operation, async () => { throw new Error("Replayed callback"); }))
      .rejects.toMatchObject({ code: "CRM_EXECUTION_STALE" });
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
  }));

  it("rolls the actual effect and all receipts back when terminal publication fails", async () => runWithSupportOrigin(undefined, async () => {
    const f = await fixture(); const client = getPrismaClient(); const original = client.$transaction.bind(client);
    vi.spyOn(client, "$transaction").mockImplementation(((callback: any, options: any) => original(async tx => callback(new Proxy(tx, {
      get(target, property) {
        if (property !== "conversationPendingOperation") return Reflect.get(target, property);
        return new Proxy(target.conversationPendingOperation, { get(delegate, method) {
          if (method !== "update") return Reflect.get(delegate, method);
          return async (args: any) => {
            if (args.data.status === "EXECUTED") throw new Error("Synthetic canonical terminal write failed");
            return delegate.update(args);
          };
        } });
      },
    })), options)) as any);
    await expect(commitCrmPendingOperationExecution(f.ctx, f.begin.operation, ({ tx, lineageRoots }) =>
      recordRelationshipActivityAction(f.actor, { workspaceId: f.workspace.id, tx, lineageRoots: [...lineageRoots] }, f.args)))
      .rejects.toThrow("Synthetic canonical terminal write failed");
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id, artifactType: "CrmActivity" } })).toBe(0);
    expect(await prisma.conversationPendingOperation.findUniqueOrThrow({ where: { id: f.begin.operation.id } }))
      .toMatchObject({ status: "EXECUTING", resultJson: null, executedAt: null });
  }));

  it("rejects a tool effect that starts another transaction and rolls it back", async () => runWithSupportOrigin(undefined, async () => {
    const f = await fixture();
    await expect(commitCrmPendingOperationExecution(f.ctx, f.begin.operation, () =>
      recordRelationshipActivityAction(f.actor, { workspaceId: f.workspace.id, lineageRoots: [...f.begin.lineageRoots] }, f.args)))
      .rejects.toMatchObject({ code: "CRM_TRANSACTION_REQUIRED" });
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.conversationPendingOperation.findUniqueOrThrow({ where: { id: f.begin.operation.id } }))
      .toMatchObject({ status: "EXECUTING", resultJson: null });
  }));

  it.each(["EXECUTED", "FAILED"] as const)("serializes standalone terminal finalizers when %s acquires the authority row first", async firstStatus => runWithSupportOrigin(undefined, async () => {
    const f = await fixture();
    const activity = await withArtifactInputWriteFence(f.begin.executionFence, () => createActivity(f.actor, {
      workspaceId: f.workspace.id, ...f.args, source: "workspace-chat", lineageRoots: f.begin.lineageRoots,
    }));
    const result = { success: true, activity: { id: activity.id, title: activity.title, type: activity.type,
      accountId: activity.accountId ?? null, dueAt: activity.dueAt ?? null, completedAt: activity.completedAt ?? null,
      webUrl: `/workspaces/${f.workspace.id}/leads/accounts/${activity.accountId}?view=activity` } };
    const entered = deferred(); const release = deferred();
    let holderPid = 0; let holdFirst = true;
    const client = getPrismaClient();
    const originalTransaction = client.$transaction.bind(client);
    vi.spyOn(client, "$transaction").mockImplementation(((callback: any, options: any) => originalTransaction(async tx => {
      const wrapped = new Proxy(tx, { get(target, property) {
        if (property !== "conversationPendingOperation") return Reflect.get(target, property);
        return new Proxy(target.conversationPendingOperation, { get(delegate, method) {
          if (method !== "update") return Reflect.get(delegate, method);
          return async (args: any) => {
            if (holdFirst && args.data.status === firstStatus) {
              holdFirst = false;
              const [identity] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
              holderPid = identity!.pid; entered.resolve(); await release.promise;
            }
            return delegate.update(args);
          };
        } });
      } });
      return callback(wrapped);
    }, { ...options, timeout: 15000 })) as any);
    const finalize = (status: typeof firstStatus) => status === "EXECUTED"
      ? markCrmPendingOperationExecuted(f.ctx, f.begin.operation, result)
      : markCrmPendingOperationFailed(f.ctx, f.begin.operation, new Error("Synthetic terminal race"));
    const first = finalize(firstStatus).then(value => ({ value }), error => ({ error }));
    await Promise.race([entered.promise, first.then(outcome => {
      if ("error" in outcome) throw outcome.error;
      throw new Error("Synthetic terminal finalizer missed its held write");
    })]);
    const second = finalize(firstStatus === "EXECUTED" ? "FAILED" : "EXECUTED")
      .then(value => ({ value }), error => ({ error }));
    let lockError: unknown;
    try { await waitForPendingRowWait(holderPid, "SELECT"); } catch (error) { lockError = error; } finally { release.resolve(); }
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome).toMatchObject({ value: { status: firstStatus } });
    expect(secondOutcome).toMatchObject({ error: { code: "CRM_EXECUTION_STALE" } });
    expect(await prisma.conversationPendingOperation.findUniqueOrThrow({ where: { id: f.begin.operation.id } }))
      .toMatchObject({ status: firstStatus });
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    if (lockError) throw lockError;
  }));

  it("blocks abandonment behind the owner lock and rolls an expired effect back before uncertain replay", async () => runWithSupportOrigin(undefined, async () => {
    const f = await fixture(); const effect = await heldEffect(f);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.begin.operation.updatedAt.getTime() + 6 * 60 * 1000);
    const refresh = createPendingCrmOperation({ ctx: f.ctx, toolName: "record_relationship_activity", args: f.args })
      .then(value => ({ value }), error => ({ error }));
    try {
      await waitForPendingRowWait(effect.holderPid, "UPDATE");
      // The uncommitted activity is private to the held producer transaction.
      expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { effect.release.resolve(); }
    const originalOwnerResult = await effect.result;
    expect(originalOwnerResult).toMatchObject({ error: { code: "CRM_EXECUTION_STALE" } });
    expect(await refresh).toMatchObject({ error: { code: "CRM_EXECUTION_UNCERTAIN" } });
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id, artifactType: "CrmActivity" } })).toBe(0);
    await expect(createPendingCrmOperation({ ctx: f.ctx, toolName: "record_relationship_activity", args: f.args }))
      .rejects.toMatchObject({ code: "CRM_EXECUTION_UNCERTAIN" });
    expect(await prisma.conversationPendingOperation.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  }));

  it("excludes a competing owner until the permitted effect and its complete receipt commit", async () => runWithSupportOrigin(undefined, async () => {
    const f = await fixture(); const effect = await heldEffect(f);
    const contender = beginCrmPendingOperationExecution(f.ctx, f.operation).then(value => ({ value }), error => ({ error }));
    try { await waitForPendingRowWait(effect.holderPid, "SELECT"); } finally { effect.release.resolve(); }
    const outcome = await effect.result;
    if (!("value" in outcome)) throw outcome.error;
    expect(await contender).toMatchObject({ value: { state: "unavailable" } });
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "CrmActivity", id: outcome.value.id }]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    await expect(createPendingCrmOperation({ ctx: f.ctx, toolName: "record_relationship_activity", args: f.args }))
      .rejects.toMatchObject({ code: "CRM_EXECUTION_UNCERTAIN" });
  }));

  it("rolls back the actual CRM producer when the previous lease expired before its execution fence", async () => runWithSupportOrigin(undefined, async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.begin.operation.updatedAt.getTime() + 6 * 60 * 1000);
    await expect(withArtifactInputWriteFence(f.begin.executionFence, () => createActivity(f.actor, {
      workspaceId: f.workspace.id, ...f.args, source: "workspace-chat", lineageRoots: f.begin.lineageRoots,
    }))).rejects.toMatchObject({ code: "CRM_EXECUTION_STALE" });
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id, artifactType: "CrmActivity" } })).toBe(0);
    await expect(createPendingCrmOperation({ ctx: f.ctx, toolName: "record_relationship_activity", args: f.args }))
      .rejects.toMatchObject({ code: "CRM_EXECUTION_UNCERTAIN" });
  }));
});
