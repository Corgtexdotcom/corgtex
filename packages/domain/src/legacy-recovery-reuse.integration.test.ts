import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma as db, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { LEGACY_RECOVERY_OPERATION, legacyRecoveryFileBinding, recoverLegacyArtifact } from "./legacy-recovery";
import { lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";
import { rebuildRecoveredHistory } from "../../../apps/web/lib/legacy-recovery-projection";

const storage = vi.hoisted(() => ({ getStream: vi.fn() }));
vi.mock("@corgtex/storage", () => ({ defaultStorage: storage }));
beforeEach(async () => { await truncateAllTables(); storage.getStream.mockReset(); });
afterEach(() => vi.restoreAllMocks());

async function fixture(file = false) {
  const workspace = await db.workspace.create({ data: { name: "Recovery reuse", slug: randomUUID(), plan: "PAYG_AI" } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@recovery.test`, passwordHash: "synthetic" } });
  const member = await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const bytes = Buffer.from("Synthetic original file bytes");
  storage.getStream.mockImplementation(async () => ({ body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }));
  const document = file ? await db.document.create({ data: { workspaceId: workspace.id, title: "Original upload", source: "upload",
    storageKey: `workspaces/${workspace.id}/uploads/${randomUUID()}/original.txt`, mimeType: "text/plain", metadata: { size: bytes.length } } }) : null;
  if (document) await db.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "Document", id: document.id }, content: document, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const source = await db.brainSource.create({ data: { workspaceId: workspace.id, sourceType: file ? "FILE_UPLOAD" : "RESEARCH", tier: 2,
    title: "Original source", content: "Preserved company source facts.", ...(document ? { metadata: { documentId: document.id }, fileStorageKey: document.storageKey, fileSizeBytes: bytes.length, fileMimeType: "text/plain" } : {}) } });
  const request = { workspaceId: workspace.id, kind: "BrainSource" as const, id: source.id, expectedFingerprint: lineageContentFingerprint("BrainSource", source), requestId: randomUUID(), consent: "RESTORE_SELECTED_HISTORY" as const };
  const invalidReceipts = (count: number) => db.conversationOperationOutcome.createMany({ data: Array.from({ length: count }, (_, index) => ({
    workspaceId: workspace.id, actorKind: "user", userId: user.id, operation: LEGACY_RECOVERY_OPERATION,
    requestKey: randomUUID(), requiredScopes: [], controlJson: { version: 0, targetId: source.id }, createdAt: new Date(Date.now() + 60_000 + index),
  })) });
  return { workspace, actor, member, source, request, bytes, invalidReceipts };
}

function models() {
  vi.spyOn(defaultModelGateway, "rerank").mockImplementation(async ({ documents, topK }) => ({ results: documents.slice(0, topK).map((_, index) => ({ index, score: 1 })) }) as never);
  vi.spyOn(defaultModelGateway, "extract").mockResolvedValue({ output: { articleType: "PROCESS", createNew: { title: "Recovered fact", slug: "recovered-fact" }, summary: "Company source" } } as never);
  vi.spyOn(defaultModelGateway, "chat").mockResolvedValue({ content: "Fresh proposed summary preserving the original company facts." } as never);
  vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({ input }) => ({ embeddings: (Array.isArray(input) ? input : [input]).map(() => Array(1536).fill(0.01)),
    usage: { provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 0, latencyMs: 0, estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0" } }));
}

describe("bounded recovery receipts and stable Brain projection", () => {
  it("refuses a 5001 unusable receipt history before returning absent file authority", async () => {
    const f = await fixture(true);
    await f.invalidReceipts(5001);
    const read = db.conversationOperationOutcome.findMany.bind(db.conversationOperationOutcome);
    const takes: number[] = [];
    vi.spyOn(db.conversationOperationOutcome, "findMany").mockImplementation((async args => { takes.push(args!.take!); return read(args); }) as typeof db.conversationOperationOutcome.findMany);
    await expect(legacyRecoveryFileBinding(f.actor, f.workspace.id, f.source.id)).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_LIMIT" });
    expect(takes).toEqual([...Array<number>(50).fill(100), 1]);
    expect(storage.getStream).not.toHaveBeenCalled();
  });

  it("proves absence at exactly 5000 unusable receipts", async () => {
    const f = await fixture(true);
    await f.invalidReceipts(5000);
    expect(await legacyRecoveryFileBinding(f.actor, f.workspace.id, f.source.id)).toBeNull();
    expect(storage.getStream).not.toHaveBeenCalled();
  });

  it("finds a current binding in candidate5000 but never authorizes candidate5001", async () => {
    const f = await fixture(true);
    await recoverLegacyArtifact(f.actor, f.request);
    await f.invalidReceipts(4999);
    expect(await legacyRecoveryFileBinding(f.actor, f.workspace.id, f.source.id)).toMatchObject({ storageKey: f.source.fileStorageKey, sizeBytes: f.bytes.length });
    await f.invalidReceipts(1);
    await expect(legacyRecoveryFileBinding(f.actor, f.workspace.id, f.source.id)).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_LIMIT" });
  });

  it("reuses current recovery for a fresh request ID without another generated article", async () => {
    const f = await fixture(); models();
    const first = await recoverLegacyArtifact(f.actor, f.request);
    expect(await rebuildRecoveredHistory(f.actor, f.workspace.id, first)).toMatchObject({ status: "COMPLETED" });
    const articles = await db.brainArticle.findMany({ where: { workspaceId: f.workspace.id } });
    expect(articles).toHaveLength(1);
    const freshRequest = { ...f.request, requestId: randomUUID() };
    const second = await recoverLegacyArtifact(f.actor, freshRequest);
    expect(await rebuildRecoveredHistory(f.actor, f.workspace.id, second)).toMatchObject({ status: "COMPLETED" });
    expect(await db.brainArticle.findMany({ where: { workspaceId: f.workspace.id } })).toEqual(articles);
    expect(second).toEqual(first);
    expect(await recoverLegacyArtifact(f.actor, freshRequest)).toEqual(first);
    expect(await db.conversationOperationOutcome.count({ where: { operation: LEGACY_RECOVERY_OPERATION } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "legacy-history.recovered" } })).toBe(1);
    expect(await db.knowledgeChunk.count({ where: { workspaceId: f.workspace.id, sourceId: articles[0].id } })).toBeGreaterThan(0);
    const other = await db.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "RESEARCH", tier: 2, content: "Different target" } });
    await expect(recoverLegacyArtifact(f.actor, { ...freshRequest, id: other.id, expectedFingerprint: lineageContentFingerprint("BrainSource", other) })).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" });
  }, 120_000);

  it("converges concurrent fresh requests and concurrent projections on one published article", async () => {
    const f = await fixture(); models();
    const [first, second] = await Promise.all([recoverLegacyArtifact(f.actor, f.request), recoverLegacyArtifact(f.actor, { ...f.request, requestId: randomUUID() })]);
    expect(second).toEqual(first);
    const find = db.agentRun.findFirst.bind(db.agentRun);
    let arrivals = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(db.agentRun, "findFirst").mockImplementation((async args => {
      const existing = await find(args);
      if (args?.where?.agentKey === "brain-absorb" && args.where.triggerRef === `legacy-recovery:${first.receiptId}`) {
        arrivals++;
        if (arrivals === 2) release();
        await bothChecked;
      }
      return existing;
    }) as typeof db.agentRun.findFirst);
    await Promise.all([rebuildRecoveredHistory(f.actor, f.workspace.id, first), rebuildRecoveredHistory(f.actor, f.workspace.id, second)]);
    expect(arrivals).toBe(2);
    expect(await db.brainArticle.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await db.conversationOperationOutcome.count({ where: { operation: LEGACY_RECOVERY_OPERATION } })).toBe(1);
    expect(await db.knowledgeChunk.count({ where: { workspaceId: f.workspace.id } })).toBeGreaterThan(0);
  }, 120_000);

  it.each(["operator", "source", "other-admin"] as const)("does not reuse or replace current receipt after %s authority changes", async change => {
    const f = await fixture();
    await recoverLegacyArtifact(f.actor, f.request);
    let actor = f.actor;
    if (change === "operator") {
      await db.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      await db.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    } else if (change === "source") {
      await db.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
      await db.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: null } });
    } else {
      const user = await db.user.create({ data: { email: `${randomUUID()}@recovery.test`, passwordHash: "synthetic" } });
      await db.member.create({ data: { workspaceId: f.workspace.id, userId: user.id, role: "ADMIN" } });
      actor = { kind: "user", user };
    }
    await expect(recoverLegacyArtifact(actor, { ...f.request, requestId: randomUUID() })).rejects.toThrow();
    expect(await db.conversationOperationOutcome.count({ where: { operation: LEGACY_RECOVERY_OPERATION } })).toBe(1);
  });

  it("rechecks actual file bytes before reusing a matching source fingerprint", async () => {
    const f = await fixture(true);
    await recoverLegacyArtifact(f.actor, f.request);
    const changed = Buffer.alloc(f.bytes.length, 120);
    storage.getStream.mockImplementation(async () => ({ body: new ReadableStream({ start(controller) { controller.enqueue(changed); controller.close(); } }) }));
    await expect(recoverLegacyArtifact(f.actor, { ...f.request, requestId: randomUUID() })).rejects.toThrow();
    expect(await db.conversationOperationOutcome.count({ where: { operation: LEGACY_RECOVERY_OPERATION } })).toBe(1);
  });

  it("never adopts a historical receipt after a same-body lineage head replacement", async () => {
    const f = await fixture();
    const original = await recoverLegacyArtifact(f.actor, f.request);
    const aliasRequest = { ...f.request, requestId: randomUUID() };
    expect(await recoverLegacyArtifact(f.actor, aliasRequest)).toEqual(original);
    await db.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "BrainSource", id: f.source.id }, content: f.source, origin: "HUMAN_ORIGINAL", inputs: [] }));
    await expect(recoverLegacyArtifact(f.actor, aliasRequest)).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" });
    await expect(recoverLegacyArtifact(f.actor, f.request)).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" });
    const fresh = await recoverLegacyArtifact(f.actor, { ...f.request, requestId: randomUUID() });
    expect(fresh.receiptId).not.toBe(original.receiptId);
  });
});
