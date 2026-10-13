import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { runWithSupportOrigin } from "../../shared/src/support-context";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createConversation, createConversationPromptInput } from "../../domain/src/conversations";
import { createActivity, createCrmAccount } from "../../domain/src/crm";
import { captureArtifactInputProof, isArtifactInputProofReadable, withArtifactInputWriteFence } from "../../domain/src/source-lineage";
import { beginCrmPendingOperationExecution, createPendingCrmOperation } from "./pending-crm-operations";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
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
  const args = { title: "Synthetic permitted effect", bodyMd: "Synthetic approved body", accountId: account.id };
  const operation = await createPendingCrmOperation({ ctx, toolName: "record_relationship_activity", args });
  const begin = await beginCrmPendingOperationExecution(ctx, operation);
  if (begin.state !== "ready") throw new Error("Synthetic operation did not obtain an execution capability");
  return { actor, workspace, ctx, args, operation, begin };
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
  afterEach(() => { vi.useRealTimers(); });

  it("blocks actual abandonment until the original effect commits and prevents uncertain replay", async () => runWithSupportOrigin(undefined, async () => {
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
    expect(originalOwnerResult).toHaveProperty("value");
    expect(await refresh).toMatchObject({ error: { code: "CRM_EXECUTION_UNCERTAIN" } });
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id, artifactType: "CrmActivity" } })).toBe(1);
    await expect(createPendingCrmOperation({ ctx: f.ctx, toolName: "record_relationship_activity", args: f.args }))
      .rejects.toMatchObject({ code: "CRM_EXECUTION_UNCERTAIN" });
    expect(await prisma.conversationPendingOperation.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.crmActivity.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
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
