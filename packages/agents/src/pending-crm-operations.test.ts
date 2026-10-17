import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import type { AppActor } from "@corgtex/shared";
import type { LineageKind, LineageRoot } from "../../domain/src/source-lineage";

const fixture = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string }>();
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  let serial = 0;
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    for (const [key, value] of Object.entries(where ?? {})) {
      if (key === "AND") { if (!(value as any[]).every((entry) => matches(row, entry))) return false; }
      else if (key === "OR") { if (!(value as any[]).some((entry) => matches(row, entry))) return false; }
      else if (value instanceof Date) { if (!(row[key] instanceof Date) || row[key].getTime() !== value.getTime()) return false; }
      else if (value && typeof value === "object" && "in" in value) { if (!(value.in as any[]).includes(row[key])) return false; }
      else if (value && typeof value === "object" && "startsWith" in value) { if (!String(row[key]).startsWith(String(value.startsWith))) return false; }
      else if (row[key] !== value) return false;
    }
    return true;
  };
  const project = (row: any, select: any) => select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row);
  const bases = { primary: { $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [] as any[]) },
    tx: { $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [] as any[]) } };
  const boundary = { inTransaction: false };
  function client(clientName: "primary" | "tx"): any { return new Proxy(bases[clientName], { get(target, property) {
    if (clientName === "primary" && boundary.inTransaction) throw new Error(`Global CRM database access inside tx: ${String(property)}`);
    if (property in target) return target[property as keyof typeof target];
    const name = String(property);
    const key = `${clientName}:${name}`;
    if (!delegates.has(key)) {
      const rows = () => [...(tables.get(name)?.values() ?? [])];
      const find = ({ where, select, orderBy, take }: any) => {
        let result = rows().filter((row) => matches(row, where));
        for (const [field, direction] of Object.entries(orderBy ?? {})) result.sort((a, b) => {
          const left = a[field] instanceof Date ? a[field].getTime() : a[field];
          const right = b[field] instanceof Date ? b[field].getTime() : b[field];
          return (left === right ? 0 : left > right ? 1 : -1) * (direction === "desc" ? -1 : 1);
        });
        return result.slice(0, take ?? result.length).map((row) => project(row, select));
      };
      delegates.set(key, {
        findFirst: vi.fn(async (args) => find(args)[0] ?? null), findUnique: vi.fn(async (args) => find(args)[0] ?? null),
        findMany: vi.fn(async (args) => find(args)),
        create: vi.fn(async ({ data }) => {
          const now = new Date();
          const row = { id: `${name}-${++serial}`, createdAt: now, updatedAt: now,
            ...(name === "conversationPendingOperation" ? { status: "PENDING", proposedAt: now, resultJson: null, errorCode: null, errorMessage: null, executedAt: null, canceledAt: null } : {}), ...structuredClone(data) };
          if (!tables.has(name)) tables.set(name, new Map());
          tables.get(name)!.set(row.id, row);
          return structuredClone(row);
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = rows().find((entry) => matches(entry, where));
          if (!row) throw new Error("Synthetic row unavailable");
          Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return structuredClone(row);
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const found = rows().filter((row) => matches(row, where));
          for (const row of found) Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return { count: found.length };
        }),
      });
    }
    return delegates.get(key);
  } }); }
  const prisma = client("primary"); const tx = client("tx"); const base = bases.primary;
  return { tables, memberships, delegates, membership, prisma, tx, base, bases, boundary };
});

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, toInputJson: (value: unknown) => value, env: { MODEL_PROVIDER: "fake", MODEL_REQUEST_TIMEOUT_MS: 1000 } }));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership }));
vi.mock("../../domain/src/finance", () => ({ getFinanceAccessPolicy: vi.fn(async (_actor, _workspaceId, usedTx) => {
  if (fixture.boundary.inTransaction && usedTx !== fixture.tx) throw new Error("Global CRM finance read inside tx");
  return { canRead: false };
}) }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/source-lineage"),
  ...await import("../../domain/src/digest-lineage"),
  AppError: (await import("../../domain/src/errors")).AppError,
  requireWorkspaceMembership: fixture.membership,
}));

import { AppError } from "../../domain/src/errors";
import { advanceHumanArtifactInputLineage, captureArtifactInputProof, captureArtifactInputSnapshotProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint,
  recordArtifactInputLineage, withArtifactInputWriteFence } from "../../domain/src/source-lineage";
import { beginCrmPendingOperationExecution, cancelCrmPendingOperation, createPendingCrmOperation, crmPendingOperationFailedNotice,
  crmPendingOperationIntent, crmPendingOperationNotice, crmPendingOperationResultNotice, findCrmPendingOperationForIntent,
  markCrmPendingOperationExecuted, markCrmPendingOperationFailed, type PendingOperationContext, type PendingOperationRecord } from "./pending-crm-operations";

const alice = { kind: "user", user: { id: "synthetic-alice", email: "alice@example.test", displayName: null } } as AppActor;
const bob = { kind: "user", user: { id: "synthetic-bob", email: "bob@example.test", displayName: null } } as AppActor;
const workspaceId = "synthetic-ws-a";
const ctx: PendingOperationContext = { workspaceId, actor: alice, sessionId: "session-alice", userId: "synthetic-alice", agentKey: "assistant", userMessage: "Prepare a synthetic follow-up" };
const args = { title: "Synthetic follow up", bodyMd: "Synthetic permitted body", accountId: "account-public" };
const toolName = "record_relationship_activity";
const confirm = (id: string) => ({ kind: "confirm" as const, pendingOperationId: id });
const tx = fixture.tx as any;
let permissionEpochs: ReturnType<typeof installSourcePermissionEpochFixture>;
function insert(delegate: string, value: { id: string; [key: string]: unknown }) {
  const row: { id: string; [key: string]: any } = { createdAt: new Date(), updatedAt: new Date(), ...value };
  if (!fixture.tables.has(delegate)) fixture.tables.set(delegate, new Map());
  fixture.tables.get(delegate)!.set(row.id, row);
  return row;
}
function stored(id: string) { return fixture.tables.get("conversationPendingOperation")!.get(id) as PendingOperationRecord; }
async function original(kind: LineageKind, delegate: string, value: { id: string; [key: string]: unknown }) {
  const row = insert(delegate, value);
  await recordArtifactInputLineage({ tx, actor: alice, workspaceId: String(value.workspaceId ?? workspaceId), artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
  return row;
}
async function derived(kind: LineageKind, delegate: string, value: { id: string; [key: string]: unknown }, roots: LineageRoot[]) {
  const row = insert(delegate, value);
  await recordArtifactInputLineage({ tx, actor: alice, workspaceId: String(value.workspaceId ?? workspaceId), artifact: { kind, id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  return row;
}
async function context(extra: LineageRoot[] = []): Promise<PendingOperationContext> {
  const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationPromptInput", id: "prompt-alice" }], tx);
  return { ...ctx, lineageRoots: [...roots, ...extra] };
}
async function propose(current?: PendingOperationContext, approved: Record<string, unknown> = args, tool = toolName) {
  return createPendingCrmOperation({ ctx: current ?? await context(), toolName: tool, args: approved });
}
async function ready(current: PendingOperationContext, operation: PendingOperationRecord) {
  const begin = await beginCrmPendingOperationExecution(current, operation);
  expect(begin.state).toBe("ready");
  if (begin.state !== "ready") throw new Error("Synthetic execution unavailable");
  return begin;
}
function activityResult(row: any) { return { success: true, activity: { id: row.id, title: row.title, type: row.type, accountId: row.accountId ?? null,
  dueAt: row.dueAt ?? null, completedAt: row.completedAt ?? null, webUrl: row.accountId ? `/workspaces/${workspaceId}/leads/accounts/${row.accountId}?view=activity` : `/workspaces/${workspaceId}/leads/activity` } }; }
async function resultFor(begin: Awaited<ReturnType<typeof ready>>, current: PendingOperationContext, overrides: Record<string, unknown> = {}) {
  const row = await derived("CrmActivity", "crmActivity", { id: `result-${begin.operation.id}`, workspaceId, title: args.title, bodyMd: args.bodyMd,
    accountId: args.accountId, contactId: null, dealId: null, type: "NOTE", actorUserId: "synthetic-alice", source: "workspace-chat", dueAt: null, completedAt: null, archivedAt: null, ...overrides }, begin.lineageRoots);
  return { row, result: activityResult(row), current: { ...current, lineageRoots: begin.lineageRoots } };
}

beforeEach(async () => {
  vi.clearAllMocks(); fixture.tables.clear(); fixture.memberships.clear(); fixture.boundary.inTransaction = false;
  fixture.memberships.set(`${workspaceId}:synthetic-alice`, { id: "member-alice", role: "CONTRIBUTOR" });
  fixture.memberships.set(`${workspaceId}:synthetic-bob`, { id: "member-bob", role: "CONTRIBUTOR" });
  fixture.memberships.set("synthetic-ws-b:synthetic-bob", { id: "member-bob-b", role: "CONTRIBUTOR" });
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws, tx: usedTx }) => {
    if (fixture.boundary.inTransaction && usedTx !== fixture.tx) throw new Error("Global CRM membership read inside tx");
    const membership = fixture.memberships.get(`${ws}:${actor.kind === "user" ? actor.user.id : "agent"}`);
    if (!membership) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable");
    return membership;
  });
  fixture.base.$transaction.mockImplementation(async (callback) => {
    const prior = structuredClone(fixture.tables);
    fixture.boundary.inTransaction = true;
    try { return await callback(tx); } catch (error) {
      fixture.tables.clear(); for (const [key, rows] of prior) fixture.tables.set(key, rows);
      throw error;
    } finally { fixture.boundary.inTransaction = false; }
  });
  insert("conversationSession", { id: ctx.sessionId, workspaceId, userId: ctx.userId, agentKey: ctx.agentKey });
  insert("conversationSession", { id: "session-bob", workspaceId, userId: "synthetic-bob", agentKey: ctx.agentKey });
  insert("conversationSession", { id: "session-bob-b", workspaceId: "synthetic-ws-b", userId: "synthetic-bob", agentKey: ctx.agentKey });
  insert("conversationPromptInput", { id: "prompt-alice", workspaceId, sessionId: ctx.sessionId, userId: ctx.userId, content: ctx.userMessage });
  fixture.bases.tx.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.bases.tx.$queryRaw.mockReset().mockResolvedValue([]);
  permissionEpochs = installSourcePermissionEpochFixture(tx);
  fixture.base.$executeRaw.mockImplementation((...args) => fixture.bases.tx.$executeRaw(...args));
  fixture.base.$queryRaw.mockImplementation((...args) => fixture.bases.tx.$queryRaw(...args));
  await original("CrmAccount", "crmAccount", { id: "account-public", workspaceId, name: "Synthetic public account", archivedAt: null });
});

describe("pending CRM operation permission receipts and execution capabilities", () => {
  it("requires explicit confirm/cancel IDs and rejects conversational mentions", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(crmPendingOperationIntent(`confirm ${id}`)).toEqual(confirm(id));
    expect(crmPendingOperationIntent(`cancel ${id}`)).toEqual({ kind: "cancel", pendingOperationId: id });
    for (const message of ["what changed today?", `what if I confirm ${id}?`, `don't confirm ${id}`, `yes ${id}`]) expect(crmPendingOperationIntent(message)).toBeNull();
  });

  it("persists every model input and all referenced CRM records before displaying exact committed arguments", async () => {
    const privateSource = await original("BrainArticle", "brainArticle", { id: "private", workspaceId, title: "Private contributor", bodyMd: "Synthetic private context", isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
    const sourceRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: privateSource.id }], tx);
    for (const [kind, delegate, id] of [["CrmContact", "crmContact", "contact"], ["CrmDeal", "crmDeal", "deal"], ["CrmActivity", "crmActivity", "activity"]] as const) {
      await original(kind, delegate, { id, workspaceId, accountId: args.accountId, archivedAt: null, ...(kind === "CrmDeal" ? { contactId: "contact" } : {}) });
    }
    const current = await context(sourceRoots);
    const approved = { ...args, contactId: "contact", dealId: "deal", activityId: "activity" };
    const operation = await propose(current, approved);
    const manifest = [...fixture.tables.get("artifactInputLineage")!.values()].find((row) => row.artifactId === operation.id);
    expect(manifest.origin).toBe("DERIVED");
    expect(manifest.rootsJson.map((root: LineageRoot) => root.id)).toEqual(expect.arrayContaining(["prompt-alice", "private", "account-public", "contact", "deal", "activity"]));
    expect(await crmPendingOperationNotice(current, operation)).toContain(`Stored args: {"accountId":"account-public","activityId":"activity","bodyMd":"Synthetic permitted body","contactId":"contact","dealId":"deal","title":"Synthetic follow up"}`);
    expect(Object.isFrozen(operation.argsJson)).toBe(true);
  });

  it("rejects missing, stale or foreign context/dependency proof before insertion", async () => {
    await expect(propose(ctx)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    const current = await context();
    fixture.tables.get("conversationPromptInput")!.get("prompt-alice").content = "Changed prompt";
    await expect(propose(current)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const fresh = await context();
    insert("crmAccount", { id: "account-foreign", workspaceId: "synthetic-ws-b", name: "Foreign", archivedAt: null });
    await expect(propose(fresh, { ...args, accountId: "account-foreign" })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.get("conversationPendingOperation")?.size ?? 0).toBe(0);
  });

  it("gates owned sessions, current membership and tenant scope on every lookup and confirmation", async () => {
    const current = await context(); const operation = await propose(current);
    const other = { ...current, actor: bob, userId: "synthetic-bob", sessionId: "session-bob" };
    expect(await findCrmPendingOperationForIntent(other, confirm(operation.id))).toBeNull();
    await expect(beginCrmPendingOperationExecution(other, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(findCrmPendingOperationForIntent({ ...other, workspaceId: "synthetic-ws-b", sessionId: "session-bob-b" }, confirm(operation.id))).resolves.toBeNull();
    await expect(findCrmPendingOperationForIntent({ ...current, userId: "synthetic-bob" }, confirm(operation.id))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    fixture.memberships.delete(`${workspaceId}:synthetic-alice`);
    await expect(findCrmPendingOperationForIntent(current, confirm(operation.id))).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await expect(crmPendingOperationNotice(current, operation)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("withholds uncited private source changes from reads, notices, execution and old cache objects", async () => {
    const source = await original("BrainArticle", "brainArticle", { id: "private", workspaceId, title: "Private contributor", bodyMd: "Synthetic secret", isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
    const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: source.id }], tx);
    const current = await context(roots); const operation = await propose(current);
    source.ownerMemberId = "member-bob";
    expect(await findCrmPendingOperationForIntent(current, confirm(operation.id))).toEqual({ id: operation.id, status: "PENDING", contentWithheld: true });
    const notice = await crmPendingOperationNotice(current, operation);
    expect(notice).not.toContain(args.title); expect(notice).not.toContain("Stored args");
    expect(await beginCrmPendingOperationExecution(current, operation)).toMatchObject({ state: "withheld" });
    expect(stored(operation.id).status).toBe("PENDING");
  });

  it("never executes UNKNOWN legacy lineage or tampered arguments and still permits safe cancellation", async () => {
    const current = await context(); const operation = await propose(current);
    const manifest = [...fixture.tables.get("artifactInputLineage")!.values()].find((row) => row.artifactId === operation.id);
    manifest.origin = "UNKNOWN"; manifest.rootsJson = null;
    expect(await beginCrmPendingOperationExecution(current, operation)).toMatchObject({ state: "withheld" });
    expect(await cancelCrmPendingOperation(current, operation)).toEqual({ id: operation.id, status: "CANCELED", contentWithheld: true });
    const another = await propose({ ...current, userMessage: "Another request" });
    stored(another.id).argsJson = { ...args, bodyMd: "Unrecorded provider text" };
    expect(await findCrmPendingOperationForIntent(current, confirm(another.id))).toMatchObject({ contentWithheld: true });
    expect(await beginCrmPendingOperationExecution(current, another)).toMatchObject({ state: "withheld" });
  });

  it("reuses readable pending proposals and creates an independent retry after canceled or changed lineage", async () => {
    const current = await context(); const operation = await propose(current);
    expect((await propose(current)).id).toBe(operation.id);
    await cancelCrmPendingOperation(current, operation);
    const retry = await propose(current); expect(retry.id).not.toBe(operation.id); expect(retry.idempotencyKey).toContain(":retry:1");
    fixture.tables.get("crmAccount")!.get(args.accountId).name = "Changed current public account";
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "CrmAccount", id: args.accountId }, content: fixture.tables.get("crmAccount")!.get(args.accountId), origin: "HUMAN_ORIGINAL", inputs: [] });
    const next = await propose(current); expect(next.id).not.toBe(retry.id);
    expect(await beginCrmPendingOperationExecution(current, retry)).toMatchObject({ state: "withheld" });
    expect(stored(operation.id).status).toBe("CANCELED");
  });

  it("expires stable proposal content without reviving old confirmation", async () => {
    const current = await context(); const operation = await propose(current);
    stored(operation.id).expiresAt = new Date(Date.now() - 1);
    expect(await beginCrmPendingOperationExecution(current, operation)).toMatchObject({ state: "expired", operation: { status: "EXPIRED" } });
    expect((await propose(current)).id).not.toBe(operation.id);
  });

  it("mints one execution capability and rejects cloned capabilities and stale lease/session ownership", async () => {
    const current = await context(); const operation = await propose(current); const begin = await ready(current, operation);
    expect(Object.isFrozen(begin.lineageRoots)).toBe(true);
    expect(begin.lineageRoots.every((root) => Object.isFrozen(root))).toBe(true);
    expect(await beginCrmPendingOperationExecution(current, operation)).toMatchObject({ state: "unavailable" });
    await expect(markCrmPendingOperationFailed(current, structuredClone(begin.operation), new Error("secret"))).rejects.toMatchObject({ code: "CRM_EXECUTION_STALE" });
    stored(operation.id).updatedAt = new Date(begin.operation.updatedAt.getTime() + 1);
    await expect(begin.executionFence(tx)).rejects.toMatchObject({ code: "CRM_EXECUTION_STALE" });
    stored(operation.id).updatedAt = begin.operation.updatedAt;
    fixture.tables.get("conversationSession")!.get(ctx.sessionId).userId = "synthetic-bob";
    await expect(begin.executionFence(tx)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("freezes nested immutable input ancestry before its own CRM update and preserves approval history", async () => {
    const accountRoot = await captureArtifactInputProof(alice, workspaceId, [{ kind: "CrmAccount", id: args.accountId }], tx);
    const activity = await derived("CrmActivity", "crmActivity", { id: "activity-to-complete", workspaceId, accountId: args.accountId, title: "Original activity", bodyMd: "Original body", type: "TASK", dueAt: null, completedAt: null, archivedAt: null }, accountRoot);
    const activityRoot = await captureArtifactInputProof(alice, workspaceId, [{ kind: "CrmActivity", id: activity.id }], tx);
    await derived("AgentMemory", "agentMemory", { id: "derived-memory", workspaceId, userId: ctx.userId, content: "Prior context copied from activity" }, activityRoot);
    const memorySnapshot = await captureArtifactInputSnapshotProof(alice, workspaceId, { kind: "AgentMemory", id: "derived-memory" }, tx);
    const current = await context(memorySnapshot); const operation = await propose(current, { activityId: activity.id }, "complete_relationship_activity");
    const begin = await ready(current, operation);
    const savedBefore = structuredClone([...fixture.tables.get("artifactInputSnapshot")!.values()]);
    const updated = await tx.crmActivity.update({ where: { id: activity.id }, data: { completedAt: new Date(), completedByUserId: ctx.userId } });
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "CrmActivity", id: activity.id }, content: updated, origin: "DERIVED", inputs: [], inheritedRoots: begin.lineageRoots });
    expect(await isArtifactInputProofReadable(alice, workspaceId, begin.lineageRoots, tx)).toBe(true);
    await begin.executionFence(tx);
    const executed = await markCrmPendingOperationExecuted({ ...current, lineageRoots: begin.lineageRoots }, begin.operation, activityResult(updated));
    expect(executed.status).toBe("EXECUTED");
    for (const snapshot of savedBefore) expect(fixture.tables.get("artifactInputSnapshot")!.get(snapshot.id)).toEqual(snapshot);
    expect(await crmPendingOperationResultNotice(current, executed)).toContain(`Activity ID: ${activity.id}`);
  });

  it("freezes an existing KnowledgeChunk snapshot's canonical parent while still enforcing live privacy and deletion", async () => {
    const article = await original("BrainArticle", "brainArticle", { id: "chunk-parent", workspaceId, title: "Synthetic parent", bodyMd: "Original parent bytes", isPrivate: false, ownerMemberId: null, archivedAt: null });
    const chunk = insert("knowledgeChunk", { id: "canonical-chunk", workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: article.id, sourceTitle: article.title,
      chunkIndex: 0, content: "Original extracted bytes", accessDomain: "WORKSPACE", sensitivity: "INTERNAL", metadata: { sourceContentHash: lineageContentFingerprint("BrainArticle", article) } });
    delete chunk.updatedAt; // KnowledgeChunk has no mutable updatedAt column.
    const parentRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: article.id }], tx);
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "KnowledgeChunk", id: chunk.id },
      content: chunk, origin: "DERIVED", inputs: [], inheritedRoots: parentRoots });
    const chunkReceipt = await captureArtifactInputSnapshotProof(alice, workspaceId, { kind: "KnowledgeChunk", id: chunk.id }, tx);
    const originals = structuredClone([...fixture.tables.get("artifactInputSnapshot")!.values()]);
    const frozen = await captureImmutableArtifactInputProof(alice, workspaceId, chunkReceipt, tx);
    expect(frozen.every((root) => root.kind === "ArtifactInputSnapshot")).toBe(true);
    const preserved = structuredClone([...fixture.tables.get("artifactInputSnapshot")!.values()]);
    expect(preserved.some((row) => row.sourceKind === "KnowledgeChunk" && row.origin === "DERIVED" && row.contentJson.content === "Original extracted bytes")).toBe(true);
    expect(preserved.some((row) => row.sourceKind === "BrainArticle" && row.contentJson.bodyMd === "Original parent bytes")).toBe(true);
    article.bodyMd = "Current edited parent bytes"; article.updatedAt = new Date(article.updatedAt.getTime() + 1);
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "HUMAN_ORIGINAL", inputs: [] });
    await expect(captureArtifactInputProof(alice, workspaceId, [{ kind: "KnowledgeChunk", id: chunk.id }], tx)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(await isArtifactInputProofReadable(alice, workspaceId, frozen, tx)).toBe(true);
    expect(await isArtifactInputProofReadable(bob, workspaceId, frozen, tx)).toBe(true);
    for (const snapshot of originals) expect(fixture.tables.get("artifactInputSnapshot")!.get(snapshot.id)).toEqual(snapshot);
    const beforePrivacy = structuredClone(article);
    article.isPrivate = true; article.ownerMemberId = "member-bob";
    // In-memory DML must model the real SQL privacy governor transition.
    permissionEpochs.bump(workspaceId, "BrainArticle", article.id);
    expect(await isArtifactInputProofReadable(alice, workspaceId, frozen, tx)).toBe(false);
    expect(await isArtifactInputProofReadable(bob, workspaceId, frozen, tx)).toBe(false);
    await advanceHumanArtifactInputLineage({tx, actor: alice, workspaceId,
      artifact: {kind: "BrainArticle", id: article.id}, before: beforePrivacy, after: article});
    // Its independent current original remains readable to the new owner. This
    // fresh capture never repairs the older generated chunk or its snapshots.
    const freshOriginal = await captureArtifactInputProof(bob, workspaceId, [{kind: "BrainArticle", id: article.id}], tx);
    expect(await isArtifactInputProofReadable(bob, workspaceId, freshOriginal, tx)).toBe(true);
    expect(await isArtifactInputProofReadable(alice, workspaceId, freshOriginal, tx)).toBe(false);
    expect(article.bodyMd).toBe("Current edited parent bytes");
    for (const snapshot of preserved) expect(fixture.tables.get("artifactInputSnapshot")!.get(snapshot.id)).toEqual(snapshot);
    expect(await isArtifactInputProofReadable(bob, workspaceId, frozen, tx)).toBe(false);
    fixture.tables.get("brainArticle")!.delete(article.id);
    expect(await isArtifactInputProofReadable(bob, workspaceId, frozen, tx)).toBe(false);
  });

  it("binds successful creation to native result content, approved arguments and the execution receipt", async () => {
    const current = await context(); const begin = await ready(current, await propose(current));
    const valid = await resultFor(begin, current);
    await expect(markCrmPendingOperationExecuted(valid.current, begin.operation, { ...valid.result, providerText: "Unproven secret" })).rejects.toMatchObject({ code: "CRM_RESULT_UNPROVEN" });
    const unrelated = await original("CrmActivity", "crmActivity", { ...valid.row, id: "unrelated-human-activity" });
    await expect(markCrmPendingOperationExecuted(valid.current, begin.operation, activityResult(unrelated))).rejects.toMatchObject({ code: "CRM_RESULT_UNPROVEN" });
    const wrong = await resultFor(begin, current, { id: "wrong-body", bodyMd: "Not the approved body" });
    await expect(markCrmPendingOperationExecuted(wrong.current, begin.operation, wrong.result)).rejects.toMatchObject({ code: "CRM_RESULT_UNPROVEN" });
    const executed = await markCrmPendingOperationExecuted(valid.current, begin.operation, valid.result);
    expect(executed.status).toBe("EXECUTED");
    expect((await propose(current)).id).toBe(executed.id);
    expect(fixture.tables.get("conversationPendingOperation")!.size).toBe(1);
    await expect(markCrmPendingOperationExecuted(valid.current, begin.operation, valid.result)).rejects.toMatchObject({ code: "CRM_EXECUTION_STALE" });
  });

  it("withholds completed result on source revocation and blocks duplicate effect replay", async () => {
    const source = await original("BrainArticle", "brainArticle", { id: "revoked-contributor", workspaceId, title: "Synthetic public contributor", bodyMd: "Synthetic body", isPrivate: false, ownerMemberId: null, archivedAt: null });
    const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: source.id }], tx);
    const current = await context(roots); const begin = await ready(current, await propose(current)); const valid = await resultFor(begin, current);
    const executed = await markCrmPendingOperationExecuted(valid.current, begin.operation, valid.result);
    source.isPrivate = true; source.ownerMemberId = "member-bob";
    expect(await crmPendingOperationResultNotice(current, executed)).toContain("result is withheld");
    await expect(propose(await context())).rejects.toMatchObject({ code: "CRM_EXECUTION_UNCERTAIN" });
  });

  it("verifies communication suggestion SQL fields and approved channel without delivering a message", async () => {
    const current = await context();
    const approved = { ...args, subject: "Synthetic subject", channel: "EMAIL", recipientEmail: "synthetic@example.test", recipientName: "Synthetic Person" };
    const begin = await ready(current, await propose(current, approved, "create_communication_suggestion"));
    let suggestion = await derived("CrmCommunicationSuggestion", "crmCommunicationSuggestion", { id: "suggestion-result", workspaceId, ...approved,
      contactId: null, dealId: null, activityId: null, actorUserId: ctx.userId, source: "workspace-chat", status: "SUGGESTED" }, begin.lineageRoots);
    const result = { success: true, emailSent: false, suggestion: { id: suggestion.id, title: suggestion.title, status: suggestion.status, accountId: args.accountId,
      webUrl: `/workspaces/${workspaceId}/leads/accounts/${args.accountId}?view=suggestions` } };
    const resultCtx = { ...current, lineageRoots: begin.lineageRoots };
    await expect(markCrmPendingOperationExecuted(resultCtx, begin.operation, { ...result, emailSent: true })).rejects.toMatchObject({ code: "CRM_RESULT_UNPROVEN" });
    suggestion = fixture.tables.get("crmCommunicationSuggestion")!.get(suggestion.id);
    suggestion.channel = "SMS";
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "CrmCommunicationSuggestion", id: suggestion.id }, content: suggestion, origin: "DERIVED", inputs: [], inheritedRoots: begin.lineageRoots });
    await expect(markCrmPendingOperationExecuted(resultCtx, begin.operation, result)).rejects.toMatchObject({ code: "CRM_RESULT_UNPROVEN" });
    suggestion = fixture.tables.get("crmCommunicationSuggestion")!.get(suggestion.id);
    suggestion.channel = "EMAIL";
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "CrmCommunicationSuggestion", id: suggestion.id }, content: suggestion, origin: "DERIVED", inputs: [], inheritedRoots: begin.lineageRoots });
    const executed = await markCrmPendingOperationExecuted(resultCtx, begin.operation, result);
    expect(await crmPendingOperationResultNotice(current, executed)).toContain(`Suggestion ID: ${suggestion.id}`);
  });

  it("rechecks privacy, deletion and membership during the minted effect fence", async () => {
    const privateSource = await original("BrainArticle", "brainArticle", { id: "private", workspaceId, title: "Synthetic contributor", bodyMd: "Synthetic body", isPrivate: false, ownerMemberId: null, archivedAt: null });
    const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: privateSource.id }], tx);
    const current = await context(roots); const begin = await ready(current, await propose(current));
    privateSource.isPrivate = true; privateSource.ownerMemberId = "member-bob";
    await expect(begin.executionFence(tx)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    privateSource.isPrivate = false; privateSource.ownerMemberId = null; privateSource.archivedAt = new Date();
    await expect(begin.executionFence(tx)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    privateSource.archivedAt = null;
    fixture.memberships.delete(`${workspaceId}:synthetic-alice`);
    await expect(begin.executionFence(tx)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("locks the exact pending authority row after the worker fence and before lease reads", async () => {
    const current = await context(); const begin = await ready(current, await propose(current));
    const order: string[] = [];
    const query = fixture.bases.tx.$queryRaw.getMockImplementation()! as (...args: any[]) => Promise<any[]>;
    fixture.bases.tx.$queryRaw.mockImplementation(async (...parameters: any[]) => {
      const text = Array.isArray(parameters[0]) ? parameters[0].join("?") : parameters[0]?.sql ?? "";
      if (text.includes('FROM "ConversationPendingOperation"') && text.includes("FOR UPDATE")) {
        order.push("pending-lock");
        expect(parameters.slice(1)).toEqual([begin.operation.id, workspaceId, current.sessionId, current.userId, current.agentKey]);
      }
      return query(...parameters);
    });
    const find = fixture.tx.conversationPendingOperation.findFirst.getMockImplementation()!;
    fixture.tx.conversationPendingOperation.findFirst.mockImplementation(async (...parameters: any[]) => {
      order.push("lease-read"); return find(...parameters);
    });
    const composed = async (mutationTx: any) => {
      expect(mutationTx).toBe(tx); order.push("worker-fence"); await begin.executionFence(mutationTx);
    };
    await composed(tx);
    expect(order.slice(0, 3)).toEqual(["worker-fence", "pending-lock", "lease-read"]);
  });

  it("composes the minted lease fence through final result and receipt writes", async () => {
    const current = await context(); const begin = await ready(current, await propose(current)); const valid = await resultFor(begin, current);
    const fenced = { ...valid.current, persistenceFence: begin.executionFence };
    const executed = await withArtifactInputWriteFence(begin.executionFence, () => markCrmPendingOperationExecuted(fenced, begin.operation, valid.result));
    expect(executed.status).toBe("EXECUTED");
    expect(await crmPendingOperationResultNotice(current, executed)).toContain(`Activity ID: ${valid.row.id}`);
  });

  it("records only generic failure and blocks uncertain retries while explicit no-effects permits a fresh proposal", async () => {
    const current = await context(); const begin = await ready(current, await propose(current));
    const failed = await markCrmPendingOperationFailed(current, begin.operation, new Error("Provider restricted source body"));
    expect(crmPendingOperationFailedNotice(failed)).not.toContain("Provider"); expect(stored(begin.operation.id).errorMessage).not.toContain("Provider");
    await expect(propose(current)).rejects.toMatchObject({ code: "CRM_EXECUTION_UNCERTAIN" });
    const anotherCtx = { ...current, userMessage: "Different synthetic request" }; const another = await ready(anotherCtx, await propose(anotherCtx));
    await markCrmPendingOperationFailed(anotherCtx, another.operation, new Error("Hidden context"), { noEffects: true });
    expect((await propose(anotherCtx)).id).not.toBe(another.operation.id);
  });

  it("does not retry an abandoned lease whose prior effect is unknown", async () => {
    const current = await context(); const operation = await propose(current); await ready(current, operation);
    stored(operation.id).updatedAt = new Date(Date.now() - 6 * 60 * 1000);
    await expect(propose(current)).rejects.toMatchObject({ code: "CRM_EXECUTION_UNCERTAIN" });
    expect(stored(operation.id).status).toBe("EXECUTING"); // rejected transaction rolls the abandonment marker back
  });

  it("checks caller and global owner fences before proposal/lease writes and rolls back effects at a stale execution fence", async () => {
    const current = await context();
    const reject = async () => { throw new AppError(409, "OWNER_STALE", "Synthetic lease revoked"); };
    await expect(propose({ ...current, persistenceFence: reject })).rejects.toMatchObject({ code: "OWNER_STALE" });
    expect(fixture.tables.get("conversationPendingOperation")?.size ?? 0).toBe(0);
    const operation = await propose(current);
    await expect(withArtifactInputWriteFence(reject, () => beginCrmPendingOperationExecution(current, operation))).rejects.toMatchObject({ code: "OWNER_STALE" });
    expect(stored(operation.id).status).toBe("PENDING");
    const begin = await ready(current, operation);
    const prior = stored(operation.id).updatedAt;
    stored(operation.id).updatedAt = new Date(prior.getTime() + 1);
    await expect(withArtifactInputWriteFence(begin.executionFence, () => fixture.prisma.$transaction(async (mutationTx: any) => {
      const row = await mutationTx.crmActivity.create({ data: { workspaceId, title: args.title, bodyMd: args.bodyMd, accountId: args.accountId } });
      await recordArtifactInputLineage({ tx: mutationTx, actor: alice, workspaceId, artifact: { kind: "CrmActivity", id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: begin.lineageRoots });
    }))).rejects.toMatchObject({ code: "CRM_EXECUTION_STALE" });
    expect(fixture.tables.get("crmActivity")?.size ?? 0).toBe(0);
  });

  it("rolls back result/receipt failures and preserves the capability for retry", async () => {
    const current = await context(); const begin = await ready(current, await propose(current)); const valid = await resultFor(begin, current);
    const createManifest = fixture.delegates.get("tx:artifactInputLineage").create;
    createManifest.mockRejectedValueOnce(new Error("Synthetic receipt write failure"));
    await expect(markCrmPendingOperationExecuted(valid.current, begin.operation, valid.result)).rejects.toThrow("Synthetic receipt write failure");
    expect(stored(begin.operation.id).status).toBe("EXECUTING"); expect(stored(begin.operation.id).resultJson).toBeNull();
    await begin.executionFence(tx);
    expect((await markCrmPendingOperationExecuted(valid.current, begin.operation, valid.result)).status).toBe("EXECUTED");
  });

  it.each(["committed", "rolled-back"] as const)("blocks repeat effects after result marker commit failure and %s failure marker", async (failureMarker) => {
    expect(fixture.prisma).not.toBe(tx);
    const current = await context(); const begin = await ready(current, await propose(current));
    const effect = vi.fn(async () => resultFor(begin, current));
    const valid = await effect();
    // The native CRM result committed before its terminal pending-operation marker.
    expect(fixture.tables.get("crmActivity")!.size).toBe(1);
    const rejectCommit = async (callback: (mutationTx: any) => Promise<unknown>) => {
      const committed = structuredClone(fixture.tables);
      fixture.boundary.inTransaction = true;
      try { await callback(tx); } finally {
        fixture.boundary.inTransaction = false;
        fixture.tables.clear(); for (const [key, rows] of committed) fixture.tables.set(key, rows);
      }
      throw new Error("Synthetic terminal marker commit rejected");
    };
    fixture.base.$transaction.mockImplementationOnce(rejectCommit);
    await expect(markCrmPendingOperationExecuted(valid.current, begin.operation, valid.result)).rejects.toThrow("Synthetic terminal marker commit rejected");
    expect(stored(begin.operation.id)).toMatchObject({ status: "EXECUTING", resultJson: null });
    expect(fixture.tables.get("crmActivity")!.size).toBe(1);
    if (failureMarker === "rolled-back") {
      fixture.base.$transaction.mockImplementationOnce(rejectCommit);
      await expect(markCrmPendingOperationFailed(current, begin.operation, new Error("Synthetic result marker failure"))).rejects.toThrow("Synthetic terminal marker commit rejected");
      expect(stored(begin.operation.id).status).toBe("EXECUTING");
    } else {
      const failed = await markCrmPendingOperationFailed(current, begin.operation, new Error("Synthetic result marker failure"));
      expect(failed.status).toBe("FAILED");
      expect(stored(begin.operation.id).errorCode).not.toBe("CRM_PENDING_OPERATION_NO_EFFECTS");
    }
    await expect(propose(current)).rejects.toMatchObject({ code: "CRM_EXECUTION_UNCERTAIN" });
    expect((await beginCrmPendingOperationExecution(current, stored(begin.operation.id))).state).not.toBe("ready");
    expect(effect).toHaveBeenCalledTimes(1);
    expect(fixture.tables.get("crmActivity")!.size).toBe(1);
    expect(fixture.tables.get("conversationPendingOperation")!.size).toBe(1);
  });

  it("retains the failure capability across rollback and withholds unrestricted old error strings", async () => {
    const current = await context(); const begin = await ready(current, await propose(current));
    fixture.base.$transaction.mockImplementationOnce(async (callback) => {
      const prior = structuredClone(fixture.tables);
      await callback(tx);
      fixture.tables.clear(); for (const [key, rows] of prior) fixture.tables.set(key, rows);
      throw new Error("Synthetic commit failure");
    });
    await expect(markCrmPendingOperationFailed(current, begin.operation, new Error("Restricted raw provider body"))).rejects.toThrow("Synthetic commit failure");
    expect(stored(begin.operation.id).status).toBe("EXECUTING");
    const failed = await markCrmPendingOperationFailed(current, begin.operation, new Error("Restricted raw provider body"));
    stored(begin.operation.id).errorMessage = "Legacy unrestricted error body";
    expect(crmPendingOperationFailedNotice(failed)).not.toContain("Legacy");
  });
});
