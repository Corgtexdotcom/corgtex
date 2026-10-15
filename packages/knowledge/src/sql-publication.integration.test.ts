import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { serialize, deserialize } from "node:v8";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, getPrismaClient, prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { registerSqlNativeDriver } from "../../domain/src/sql-native-driver";
import { claimSqlIngestionAttempt, failSqlIngestionAttempt, sqlIngestionConfigurationFingerprint } from "../../domain/src/sql-ingestion-attempt";
import { captureSqlIngestionAttempt, loadSqlNativeRunInput } from "../../domain/src/sql-native-input";
import type { AuthenticatedSqlRunReceipt, SqlNativeDefinition, SqlNativePage, SqlNativeRow, SqlPublicationIdentity } from "../../domain/src/sql-ingestion-contract";
import { prepareSqlKnowledgeAttempt, publishPreparedSqlKnowledgeAttempt } from "./sql-publication";
import { countReadableKnowledgeChunks } from "./counts";
import { captureSqlCountPageProof } from "./sql-count-proof";
import { fetchReadableKnowledgeChunk, searchIndexedKnowledge } from "./retrieval";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable,
  isArtifactInputProofPubliclyShareable, recordArtifactInputLineage } from "../../domain/src/source-lineage";
import { prepareArtifactSourceCommit, withArtifactSourceCommit } from "../../domain/src/artifact-source-commit";
import { isArtifactNativeCommitPhase } from "../../domain/src/artifact-native-commit-phase";
import { createDocument } from "../../domain/src/documents";
import { syncDocumentKnowledge } from "./chunks";
import { withArtifactInputSnapshotAllocations } from "../../domain/src/artifact-input-snapshot-allocations";
import type { SourceCommitWriteTarget } from "../../domain/src/source-commit-lock-plan";
import { captureSqlKnowledgeInputProof, isSqlKnowledgeInputProofReadable } from "../../domain/src/sql-knowledge-read-proof";

const models = vi.hoisted(() => ({embed: vi.fn()}));
vi.mock("@corgtex/models", async original => ({...await original<typeof import("@corgtex/models")>(),
  defaultModelGateway: {embed: models.embed, rerank: async ({documents, topK}: {documents: string[]; topK: number}) => ({
    results: documents.slice(0, topK).map((_, index) => ({index, score: 1}))})}}));
const transport = {rows: [] as SqlNativeRow[], pages: undefined as SqlNativePage[] | undefined, fetches: 0, checks: 0, closes: 0, failFinal: false, access: true, accessChecks: 0,
  unproved: false, accessInsideCommit: 0, afterScan: undefined as (() => Promise<void>) | undefined,
  afterAccess: undefined as (() => Promise<void>) | undefined, nextCursor: "synthetic-verified-native-tail" as string | null};
const definition: SqlNativeDefinition = {schema: "public", name: "rows", relationOid: 123,
  cursor: {name: "updated_at", type: "timestamptz", typeOid: 1184, typeModifier: -1, collationOid: 0},
  key: [{name: "id", type: "int4", typeOid: 23, typeModifier: -1, collationOid: 0}],
  columns: [
    {name: "id", type: "int4", typeOid: 23, typeModifier: -1, collationOid: 0, position: 1, isNullable: false, identity: "", generated: ""},
    {name: "updated_at", type: "timestamptz", typeOid: 1184, typeModifier: -1, collationOid: 0, position: 2, isNullable: true, identity: "", generated: ""},
    {name: "description", type: "text", typeOid: 25, typeModifier: -1, collationOid: 100, position: 3, isNullable: true, identity: "", generated: ""},
  ]};
const row = (id: number, description = "Synthetic independently fetched source row"): SqlNativeRow => {
  const native = {id, updated_at: "2026-10-13T00:00:00.000Z", description};
  return {row: native, table: "public.rows", definition, values: [native.updated_at, String(id)], primaryKey: String(id),
    content: Object.entries(native).map(([key, value]) => `${key}: ${value}`).join("\n")};
};
// Deliberately synthetic registered transport. These tests exercise real app PG,
// receipt, staging, serving and transaction rollback. Actual provider/two-process
// PostgreSQL authenticity is the connector owner's additional acceptance gate.
registerSqlNativeDriver("postgres", async ({assertCurrentSource}) => {
  await assertCurrentSource(); transport.fetches++;
  const rows = deserialize(serialize(transport.rows)) as SqlNativeRow[];
  const pages = transport.pages ? deserialize(serialize(transport.pages)) as SqlNativePage[] : Array.from({length: Math.max(1, Math.ceil(rows.length / 1000))}, (_, page) => ({table: "public.rows", definition: rows[0]?.definition ?? definition,
    previous: page ? rows[page * 1000 - 1].values : null, rowCount: rows.slice(page * 1000, (page + 1) * 1000).length,
    tail: rows.slice(page * 1000, (page + 1) * 1000).at(-1)?.values ?? null}));
  let closed = false;
  const dispose = async () => {if (!closed) {closed = true; transport.closes++;}};
  await transport.afterScan?.();
  return {rows, pages, rowsProcessed: rows.length, nextCursor: transport.nextCursor, dispose,
    beforePublication: async () => {transport.checks++; try {
      if (transport.failFinal) throw Object.assign(new Error("Synthetic native DDL changed"), {code: "CURSOR_SCAN_CHANGED"});
      await assertCurrentSource();
    } finally {await dispose();}}};
}, {accessValidator: async ({assertCurrentSource}) => {
  transport.accessChecks++; if (isArtifactNativeCommitPhase()) transport.accessInsideCommit++;
  if (transport.unproved) throw new Error("Synthetic unproved provider access");
  await assertCurrentSource(); await transport.afterAccess?.(); return transport.access;
}});

async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic SQL output", slug: `sql-output-${randomUUID()}`}});
  const other = await prisma.workspace.create({data: {name: "Other workspace", slug: `sql-other-${randomUUID()}`}});
  const alice = await prisma.user.create({data: {email: `sql-alice-${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Alice"}});
  const bob = await prisma.user.create({data: {email: `sql-bob-${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Bob"}});
  const members = await Promise.all([alice, bob].map(user => prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}})));
  await prisma.member.create({data: {workspaceId: other.id, userId: alice.id, role: "ADMIN"}});
  const source = await prisma.externalDataSource.create({data: {workspaceId: workspace.id, label: "Synthetic SQL source",
    connectionStringEnc: "synthetic-registered-driver", selectedTables: ["public.rows"]}});
  const aliceActor: AppActor = {kind: "user", user: alice}, bobActor: AppActor = {kind: "user", user: bob};
  const claim = async () => {
    const current = await prisma.externalDataSource.findUniqueOrThrow({where: {id: source.id}});
    const log = await prisma.externalDataSyncLog.create({data: {sourceId: source.id}});
    return claimSqlIngestionAttempt({workspaceId: workspace.id, sourceId: source.id, logId: log.id,
      expectedConfigurationFingerprint: sqlIngestionConfigurationFingerprint(current), expectedCursor: current.lastCursorValue});
  };
  const prepare = async () => {
    const attempt = await claim(), receipt = await captureSqlIngestionAttempt(attempt);
    return {attempt, receipt, prepared: await prepareSqlKnowledgeAttempt({attempt, receipt})};
  };
  const commit = async (tx: Parameters<Parameters<typeof publishPreparedSqlKnowledgeAttempt>[0]["commit"]>[0], identity: SqlPublicationIdentity) => {
    const changed = await tx.externalDataSource.updateMany({where: {id: source.id, workspaceId: workspace.id},
      data: {lastCursorValue: identity.nextCursor, lastSyncAt: new Date(), lastSyncError: null}});
    expect(changed.count).toBe(1);
    const completed = await tx.externalDataSyncLog.updateMany({where: {id:
      (await tx.sqlIngestionAttempt.findUniqueOrThrow({where: {id: identity.attemptId}})).logId,
      sqlAttemptId: identity.attemptId, completedAt: null}, data: {completedAt: new Date(), error: null,
        rowsProcessed: identity.rowsProcessed, chunksCreated: identity.chunksCreated}});
    expect(completed.count).toBe(1);
  };
  return {workspace, other, aliceActor, bobActor, members, source, claim, prepare, commit};
}

describe("authenticated SQL Knowledge publication on real application PostgreSQL", () => {
  beforeEach(async () => {
    await truncateAllTables(); transport.rows = [row(1)]; transport.fetches = 0; transport.checks = 0;
    transport.closes = 0; transport.failFinal = false;
    transport.access = true; transport.accessChecks = 0;
    transport.unproved = false; transport.accessInsideCommit = 0;
    transport.afterScan = undefined; transport.afterAccess = undefined; transport.pages = undefined;
    transport.nextCursor = "synthetic-verified-native-tail";
    models.embed.mockReset().mockImplementation(async ({input}) => ({embeddings: (typeof input === "string" ? [input] : input)
      .map(() => [1, 0]), usage: {model: "synthetic-sql-embedding"}}));
  });
  it("accepts only an exact native receipt and withholds staged output until the real commit", async () => {
    const f = await fixture(), attempt = await f.claim(), receipt = await captureSqlIngestionAttempt(attempt);
    await expect(prepareSqlKnowledgeAttempt({attempt, receipt: {...receipt} as AuthenticatedSqlRunReceipt})).rejects.toMatchObject({code: "SQL_NATIVE_RECEIPT_INVALID"});
    const prepared = await prepareSqlKnowledgeAttempt({attempt, receipt});
    expect(await prisma.knowledgeChunk.count()).toBe(0);
    expect(await countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(0);
    const result = await publishPreparedSqlKnowledgeAttempt({attempt, prepared, commit: f.commit});
    expect(result).toMatchObject({committed: true, rowsProcessed: 1, chunksCreated: 1, attemptId: attempt.attemptId});
    expect(transport).toMatchObject({fetches: 1, checks: 1, closes: 1});
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow();
    expect(await fetchReadableKnowledgeChunk(f.bobActor, f.workspace.id, chunk.id)).toMatchObject({id: chunk.id});
    expect(await countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(1);
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.other.id, chunk.id)).toBeNull();
    const roots = await captureArtifactInputProof(f.aliceActor, f.workspace.id, [{kind: "KnowledgeChunk", id: chunk.id}]);
    expect(await isArtifactInputProofPubliclyShareable(f.aliceActor, f.workspace.id, roots)).toBe(false);
    expect((await searchIndexedKnowledge({actor: f.bobActor, workspaceId: f.workspace.id, query: "independently fetched", sourceTypes: ["EXTERNAL_DATABASE"]})).length).toBeGreaterThan(0);
  });
  it("distinct native table/key tuples retain independent chunks and original read proofs across replacement and an empty incremental run", async () => {
    const textRow = (tableName: string, primaryKey: string, description: string): SqlNativeRow => {
      const native = {id: primaryKey, updated_at: "2026-10-13T00:00:00.000Z", description};
      const textKey = {...definition.key[0], type: "text", typeOid: 25, collationOid: 100};
      return {row: native, table: `public.${tableName}`, primaryKey, values: [native.updated_at, primaryKey],
        definition: {...definition, name: tableName, relationOid: tableName === "a:b" ? 124 : 125,
          key: [textKey], columns: [{...definition.columns[0], ...textKey}, ...definition.columns.slice(1)]},
        content: Object.entries(native).map(([key, value]) => `${key}: ${value}`).join("\n")};
    };
    const setRows = (rows: SqlNativeRow[]) => {
      transport.rows = rows;
      transport.pages = rows.map(native => ({table: native.table, definition: native.definition,
        previous: null, rowCount: 1, tail: native.values}));
    };
    const first = textRow("a:b", "c", "Synthetic first tuple"), second = textRow("a", "b:c", "Synthetic second tuple");
    const f = await fixture();
    await prisma.externalDataSource.update({where: {id: f.source.id}, data: {selectedTables: [first.table, second.table]}});
    setRows([first, second]);
    const initial = await f.prepare();
    expect(await publishPreparedSqlKnowledgeAttempt({...initial, commit: f.commit})).toMatchObject({rowsProcessed: 2, chunksCreated: 2});
    const chunks = await prisma.knowledgeChunk.findMany({where: {workspaceId: f.workspace.id}});
    const originalFirst = chunks.find(chunk => (chunk.metadata as Prisma.JsonObject).table === first.table)!;
    const retained = chunks.find(chunk => (chunk.metadata as Prisma.JsonObject).table === second.table)!;
    expect.soft(originalFirst.sourceId).not.toBe(retained.sourceId);
    const manifest = await prisma.artifactInputLineage.findMany({where: {artifactId: retained.id}});
    const proof = (await captureSqlKnowledgeInputProof(f.aliceActor, f.workspace.id, [retained]))!;
    expect(proof).toBeTruthy();
    expect(await isSqlKnowledgeInputProofReadable(f.aliceActor, f.workspace.id, proof)).toBe(true);
    setRows([textRow("a:b", "c", "Synthetic updated first tuple")]);
    transport.nextCursor = "synthetic-updated-native-tail";
    const update = await f.prepare();
    expect(await publishPreparedSqlKnowledgeAttempt({...update, commit: f.commit})).toMatchObject({rowsProcessed: 1, chunksCreated: 1});
    expect.soft(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(2);
    expect.soft(await prisma.knowledgeChunk.findUnique({where: {id: retained.id}})).toEqual(retained);
    expect(await prisma.knowledgeChunk.findUnique({where: {id: originalFirst.id}})).toBeNull();
    const replacement = await prisma.knowledgeChunk.findFirstOrThrow({where: {sourceId: originalFirst.sourceId}});
    expect(replacement.content).toContain("Synthetic updated first tuple");
    expect(await prisma.artifactInputLineage.findMany({where: {artifactId: retained.id}})).toEqual(manifest);
    expect.soft(await isSqlKnowledgeInputProofReadable(f.aliceActor, f.workspace.id, proof)).toBe(true);
    expect.soft(await fetchReadableKnowledgeChunk(f.bobActor, f.workspace.id, retained.id)).toMatchObject({id: retained.id});
    transport.rows = [];
    transport.pages = [{table: first.table, definition: first.definition, previous: null, rowCount: 0, tail: null}];
    const empty = await f.prepare();
    expect(await publishPreparedSqlKnowledgeAttempt({...empty, commit: f.commit})).toMatchObject({rowsProcessed: 0, chunksCreated: 0,
      nextCursor: "synthetic-updated-native-tail"});
    expect(await countReadableKnowledgeChunks(f.aliceActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(2);
    expect(await isSqlKnowledgeInputProofReadable(f.aliceActor, f.workspace.id, proof)).toBe(true);
    expect(await prisma.knowledgeChunk.findUnique({where: {id: replacement.id}})).toEqual(replacement);
  });
  it("issuer rejects ownership loss across the native await and disposes before mint/model admission", async () => {
    const f = await fixture(), attempt = await f.claim();
    transport.afterScan = () => prisma.externalDataSource.update({where: {id: f.source.id},
      data: {connectionStringEnc: "synthetic-new-credential"}}).then(() => undefined);
    await expect(captureSqlIngestionAttempt(attempt)).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
    expect(transport.closes).toBe(1); expect(models.embed).not.toHaveBeenCalled();
    expect(await prisma.sqlNativeRunInput.count()).toBe(0);
  });
  it("raw integer-like payload column names use a complete key set while sealed native columns retain SELECT order", async () => {
    const native = {...row(1).row, "2": "second", "1": "first"};
    const columns = [...definition.columns, ...["2", "1"].map((name, index) => ({
      ...definition.columns[2], name, position: index + 4}))];
    expect(Object.keys(native).slice(0, 2)).toEqual(["1", "2"]);
    transport.rows = [{...row(1), row: native, definition: {...definition, columns},
      content: Object.entries(native).map(([key, value]) => `${key}: ${value}`).join("\n")}];
    const f = await fixture(), p = await f.prepare();
    expect(await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit})).toMatchObject({committed: true, chunksCreated: 1});
  });
  it("incomplete captured payload columns cannot mint a receipt", async () => {
    transport.rows = [{...row(1), definition: {...definition, columns: definition.columns.slice(0, 2)}}];
    const f = await fixture(), attempt = await f.claim();
    await expect(captureSqlIngestionAttempt(attempt)).rejects.toMatchObject({code: "SQL_NATIVE_RECEIPT_INVALID"});
    expect(await prisma.sqlNativeRunInput.count()).toBe(0); expect(transport.closes).toBe(1);
  });
  it("native Buffer payload survives capture and preparation without changing its rendered original", async () => {
    const native = {...row(1).row, payload: Buffer.from("Synthetic bytea")};
    transport.rows = [{...row(1), row: native, definition: {...definition, columns: [...definition.columns,
      {...definition.columns[2], name: "payload", type: "bytea", typeOid: 17, collationOid: 0, position: 4}]},
      content: Object.entries(native).map(([key, value]) => `${key}: ${value}`).join("\n")}];
    const f = await fixture(), p = await f.prepare();
    await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow();
    expect(chunk.content).toContain(`payload: bytea(base64):${Buffer.from("Synthetic bytea").toString("base64")}`);
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, chunk.id)).not.toBeNull();
  });
  it("already-decoded temporal Date cells cannot mint a purported exact PostgreSQL receipt", async () => {
    transport.rows = [{...row(1), row: {...row(1).row, updated_at: new Date("2026-10-14T00:00:00Z")}}];
    const f = await fixture(), attempt = await f.claim();
    await expect(captureSqlIngestionAttempt(attempt)).rejects.toMatchObject({code: "SQL_NATIVE_RECEIPT_INVALID"});
    expect(await prisma.sqlNativeRunInput.count()).toBe(0); expect(transport.closes).toBe(1);
  });
  it("checkpoint callback failure rolls back chunks, lineage, cursor, status, receipt and cache", async () => {
    const f = await fixture(), p = await f.prepare();
    const beforeCache = await prisma.sharedCacheVersion.findMany();
    await expect(publishPreparedSqlKnowledgeAttempt({...p, commit: async (tx, identity) => {
      await f.commit(tx, identity); throw new Error("Synthetic completion log failure");
    }})).rejects.toThrow("Synthetic completion log failure");
    expect(await prisma.knowledgeChunk.count()).toBe(0); expect(await prisma.artifactInputLineage.count()).toBe(0);
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastCursorValue).toBeNull();
    expect((await prisma.externalDataSyncLog.findUniqueOrThrow({where: {id: p.attempt.logId}})).completedAt).toBeNull();
    expect((await prisma.sqlIngestionAttempt.findUniqueOrThrow({where: {id: p.attempt.attemptId}})).status).toBe("RUNNING");
    expect((await prisma.sqlKnowledgePublication.findUniqueOrThrow({where: {id: p.prepared.preparationId}})).status).toBe("PREPARED");
    expect(await prisma.sharedCacheVersion.findMany()).toEqual(beforeCache);
    expect(await prisma.sqlNativeRunInput.count()).toBe(1); // Preserve the original native receipt.
    await failSqlIngestionAttempt({attempt: p.attempt, logId: p.attempt.logId, error: "Synthetic completion log failure"});
  });
  it("a later model batch failure preserves non-serving staging and a fresh independent retry publishes the complete run", async () => {
    transport.rows = Array.from({length: 600}, (_, index) => row(index + 1));
    const f = await fixture(), attempt = await f.claim(), receipt = await captureSqlIngestionAttempt(attempt);
    const embed = async ({input}: {input: string[]}) => ({embeddings: input
      .map(() => Array.from({length: 1536}, (_, index) => ((index % 31) - 15) / 100)), usage: {model: "synthetic-sql-embedding"}});
    models.embed.mockImplementation(embed).mockImplementationOnce(embed)
      .mockRejectedValueOnce(new Error("Synthetic second model batch failed"));
    const beforeCache = await prisma.sharedCacheVersion.findMany();
    await expect(prepareSqlKnowledgeAttempt({attempt, receipt})).rejects.toThrow("Synthetic second model batch failed");
    const incomplete = await prisma.sqlKnowledgePublication.findFirstOrThrow({where: {attemptId: attempt.attemptId}});
    expect(incomplete).toMatchObject({status: "PREPARING", chunksCreated: 600, outputSetHash: ""});
    const stagedCount = await prisma.sqlKnowledgeStagedChunk.count({where: {publicationId: incomplete.id}});
    expect(stagedCount).toBe(models.embed.mock.calls[0][0].input.length);
    expect(stagedCount).toBeGreaterThan(0); expect(stagedCount).toBeLessThan(600);
    expect(await prisma.knowledgeChunk.count()).toBe(0);
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastCursorValue).toBeNull();
    expect((await prisma.externalDataSyncLog.findUniqueOrThrow({where: {id: attempt.logId}})).completedAt).toBeNull();
    expect((await prisma.sqlIngestionAttempt.findUniqueOrThrow({where: {id: attempt.attemptId}})).status).toBe("RUNNING");
    expect(await prisma.artifactInputLineage.count()).toBe(0);
    expect(await prisma.sharedCacheVersion.findMany()).toEqual(beforeCache);
    await failSqlIngestionAttempt({attempt, error: "Synthetic second model batch failed", logId: attempt.logId});
    const retry = await f.prepare();
    expect(await publishPreparedSqlKnowledgeAttempt({...retry, commit: f.commit})).toMatchObject({committed: true, chunksCreated: 600});
    expect(await countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(600);
    expect(await prisma.sqlKnowledgeStagedChunk.count({where: {publicationId: incomplete.id}})).toBe(stagedCount);
    expect(await prisma.sqlKnowledgeStagedChunk.count({where: {publicationId: retry.prepared.preparationId}})).toBe(600);
    expect((await prisma.knowledgeChunk.findFirstOrThrow()).embedding).toHaveLength(1536);
    expect(Math.max(...models.embed.mock.calls.map(([request]) => request.input.length))).toBeLessThanOrEqual(128);
    await expect(prisma.sqlKnowledgePublication.update({where: {id: retry.prepared.preparationId}, data: {outputSetHash: ""}})).rejects.toThrow();
  });
  it("immutable ciphertext cannot update and same-id native replacement cannot reuse the original publisher epoch", async () => {
    const f = await fixture(), p = await f.prepare();
    const original = await prisma.sqlNativeRunInput.findUniqueOrThrow({where: {id: p.receipt.receiptId}});
    await expect(prisma.sqlNativeRunInput.update({where: {id: original.id}, data: {encryptedPayload: "synthetic tampered ciphertext"}})).rejects.toThrow();
    expect((await prisma.sqlNativeRunInput.findUniqueOrThrow({where: {id: original.id}})).encryptedPayload).toBe(original.encryptedPayload);
    await prisma.sqlNativeRunInput.delete({where: {id: original.id}});
    await prisma.sqlNativeRunInput.create({data: {...original, permissionEpochsJson: original.permissionEpochsJson as Prisma.InputJsonValue,
      encryptedPayload: "synthetic replacement ciphertext"}});
    const commit = vi.fn(f.commit);
    await expect(publishPreparedSqlKnowledgeAttempt({...p, commit})).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
    expect(commit).not.toHaveBeenCalled(); expect(await prisma.knowledgeChunk.count()).toBe(0);
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastCursorValue).toBeNull();
    expect((await prisma.externalDataSyncLog.findUniqueOrThrow({where: {id: p.attempt.logId}})).completedAt).toBeNull();
  });
  it("mandatory post-model native DDL check cannot be replaced by a caller hook", async () => {
    const f = await fixture(), p = await f.prepare(); transport.failFinal = true;
    const hook = vi.fn(async () => undefined), commit = vi.fn(f.commit);
    await expect(publishPreparedSqlKnowledgeAttempt({...p, beforePublication: hook, commit})).rejects.toMatchObject({code: "CURSOR_SCAN_CHANGED"});
    expect(hook).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled();
    expect(models.embed).toHaveBeenCalledOnce(); expect(transport.closes).toBe(1);
    expect(await prisma.knowledgeChunk.count()).toBe(0);
  });
  it("category change before publication rejects old preparation without status or cursor effects", async () => {
    const f = await fixture(), p = await f.prepare();
    await prisma.informationCategoryPolicy.create({data: {workspaceId: f.workspace.id, category: "GENERAL", isRestricted: true}});
    await expect(publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit})).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
    expect(await prisma.knowledgeChunk.count()).toBe(0);
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastCursorValue).toBeNull();
  });
  it("company role restriction binds administrators and cached/search/count reads, and restoration cannot recertify old inputs", async () => {
    const f = await fixture(), p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow();
    expect(await fetchReadableKnowledgeChunk(f.bobActor, f.workspace.id, chunk.id)).not.toBeNull();
    const circle = await prisma.circle.create({data: {workspaceId: f.workspace.id, name: "Synthetic restricted circle"}});
    const role = await prisma.role.create({data: {circleId: circle.id, name: "Selected reader", accountabilities: [], artifacts: []}});
    await prisma.roleAssignment.create({data: {roleId: role.id, memberId: f.members[0].id}});
    const policy = await prisma.informationCategoryPolicy.create({data: {workspaceId: f.workspace.id, category: "GENERAL",
      isRestricted: true, allowedRoleIds: [role.id]}});
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, chunk.id)).toBeNull();
    expect(await fetchReadableKnowledgeChunk(f.bobActor, f.workspace.id, chunk.id)).toBeNull();
    expect(await countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(0);
    expect(await searchIndexedKnowledge({actor: f.bobActor, workspaceId: f.workspace.id, query: "independently fetched", sourceTypes: ["EXTERNAL_DATABASE"]})).toEqual([]);
    // A fresh authenticated independent scan creates current, correctly scoped inputs.
    const rebuilt = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...rebuilt, commit: f.commit});
    const current = await prisma.knowledgeChunk.findFirstOrThrow();
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, current.id)).not.toBeNull();
    expect(await fetchReadableKnowledgeChunk(f.bobActor, f.workspace.id, current.id)).toBeNull();
    await prisma.informationCategoryPolicy.update({where: {id: policy.id}, data: {isRestricted: false}});
    expect(await fetchReadableKnowledgeChunk(f.bobActor, f.workspace.id, current.id)).toBeNull();
    expect(await prisma.sqlNativeRunInput.count()).toBe(2);
  });
  it.each(["synthetic-verified-native-tail", null])("a genuine native empty page preserves %s cursor and returns positive zero only after its own log commit", async nextCursor => {
    transport.rows = []; transport.nextCursor = nextCursor; const f = await fixture(), p = await f.prepare();
    const result = await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    expect(result).toMatchObject({committed: true, chunksCreated: 0, rowsProcessed: 0});
    expect(await prisma.knowledgeChunk.count()).toBe(0);
    expect((await prisma.externalDataSyncLog.findUniqueOrThrow({where: {id: p.attempt.logId}})).completedAt).not.toBeNull();
  });
  it("publishes all 10,000 native rows and admits the ordinary search window by native run rather than row count", async () => {
    transport.rows = Array.from({length: 10_000}, (_, index) => row(index + 1));
    const f = await fixture(), start = performance.now(), p = await f.prepare(), preparedAt = performance.now();
    const result = await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const committedAt = performance.now();
    console.info("Synthetic registered native 10k run / real app PG publication timings", {
      prepareMs: Math.round(preparedAt - start), publishMs: Math.round(committedAt - preparedAt)});
    expect(result).toMatchObject({committed: true, rowsProcessed: 10_000, chunksCreated: 10_000});
    expect(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(10_000);
    expect(await prisma.artifactInputLineage.count({where: {workspaceId: f.workspace.id, artifactType: "KnowledgeChunk"}})).toBe(10_000);
    const results = await searchIndexedKnowledge({actor: f.bobActor, workspaceId: f.workspace.id,
      query: "independently fetched", sourceTypes: ["EXTERNAL_DATABASE"], limit: 5});
    expect(results).toHaveLength(5);
    expect(transport.accessInsideCommit).toBe(0);
    console.info("Synthetic registered native 10k run / real app PG timings", {
      prepareMs: Math.round(preparedAt - start), publishMs: Math.round(committedAt - preparedAt),
      searchMs: Math.round(performance.now() - committedAt)});
  });
  it("does not mint a native receipt after owner loss at the capture transaction boundary", async () => {
    const f = await fixture(), attempt = await f.claim();
    const client = getPrismaClient(), original = client.$transaction.bind(client);
    const transaction = vi.spyOn(client, "$transaction").mockImplementation((async (...args: unknown[]) => {
      const result = await Reflect.apply(original, client, args);
      if (result && typeof result === "object" && "encryptedPayload" in result) {
        await prisma.externalDataSource.update({where: {id: f.source.id}, data: {isRestricted: true, allowedRoleIds: []}});
      }
      return result;
    }) as typeof client.$transaction);
    try {
      await expect(captureSqlIngestionAttempt(attempt)).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
      expect(await prisma.sqlNativeRunInput.count({where: {workspaceId: f.workspace.id}})).toBe(1);
      expect(await prisma.sqlNativeCapturePart.count()).toBe(0);
      expect(models.embed).not.toHaveBeenCalled();
      expect(transport.closes).toBe(1);
    } finally {transaction.mockRestore();}
  });
  it("stores the complete original across multiple bounded ciphertext batches without retaining parts", async () => {
    transport.rows = [row(1, "synthetic ".repeat(80_000))];
    const f = await fixture(), attempt = await f.claim(), receipt = await captureSqlIngestionAttempt(attempt);
    const original = await prisma.sqlNativeRunInput.findUniqueOrThrow({where: {id: receipt.receiptId}});
    expect(original.encryptedPayload.length).toBeGreaterThan(2 * 1024 * 1024);
    const bytes = Buffer.from(decryptSecret(original.encryptedPayload), "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(original.payloadHash);
    expect((deserialize(bytes) as {rows: SqlNativeRow[]}).rows[0].row).toEqual(transport.rows[0].row);
    expect(await prisma.sqlNativeCapturePart.count()).toBe(0);
    expect(models.embed).not.toHaveBeenCalled();
  });
  it.each(["part", "header"])("bounded native custody reads reject substituted %s without granting access", async target => {
    transport.rows = [row(1, "synthetic ".repeat(60_000))];
    const f = await fixture(), attempt = await f.claim(), receipt = await captureSqlIngestionAttempt(attempt);
    const originalInput = await prisma.sqlNativeRunInput.findUniqueOrThrow({where: {id: receipt.receiptId}});
    expect(await loadSqlNativeRunInput(f.workspace.id, receipt.receiptId)).toEqual(originalInput);
    const client = getPrismaClient(), original = client.$queryRaw.bind(client);
    let parts = 0, headers = 0;
    const read = vi.spyOn(client, "$queryRaw").mockImplementation((async (...args: unknown[]) => {
      const result = await Reflect.apply(original, client, args);
      const query = args[0] as {strings?: readonly string[]};
      const text = query.strings?.join("") ?? "";
      if (!Array.isArray(result) || !result[0]) return result;
      if (text.includes('AS "ciphertextPart"')) {
        parts++;
        expect(result[0].ciphertextPart.length + result[0].nextCiphertextPart.length).toBeLessThanOrEqual(2 * 512 * 1024);
        if (target === "part" && parts === 2) return [{...result[0], ciphertextPart:
          (result[0].ciphertextPart[0] === "X" ? "Y" : "X") + result[0].ciphertextPart.slice(1)}];
      }
      if (text.includes('AS "ciphertextHash"') && ++headers === 2 && target === "header") {
        return [{...result[0], nextCursor: "synthetic substituted header"}];
      }
      return result;
    }) as typeof client.$queryRaw);
    try {
      expect(await loadSqlNativeRunInput(f.workspace.id, receipt.receiptId)).toBeNull();
      expect(parts).toBeGreaterThan(1);
      expect(models.embed).not.toHaveBeenCalled(); expect(transport.accessChecks).toBe(0);
      expect(await prisma.knowledgeChunk.count()).toBe(0);
    } finally {read.mockRestore();}
    expect(await prisma.sqlNativeRunInput.findUniqueOrThrow({where: {id: receipt.receiptId}})).toEqual(originalInput);
  });
  it.each(["failure", "substitution"])("rolls back partial cipher transport on %s and permits a fresh authenticated retry", async target => {
    transport.rows = [row(1, "synthetic ".repeat(80_000))];
    const f = await fixture(), attempt = await f.claim();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION pun68_synthetic_part_substitution() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${target === "failure" ? "IF NEW.ordinal=2 THEN RAISE EXCEPTION 'synthetic partial transport failure' USING ERRCODE='23514'; END IF;"
        : 'IF NEW.ordinal=1 THEN NEW."ciphertextPart" := (CASE WHEN left(NEW."ciphertextPart",1)=\'X\' THEN \'Y\' ELSE \'X\' END) || substring(NEW."ciphertextPart" FROM 2); END IF;'} RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER pun68_synthetic_part_substitution BEFORE INSERT ON "SqlNativeCapturePart"
      FOR EACH ROW EXECUTE FUNCTION pun68_synthetic_part_substitution()`);
    try {
      if (target === "failure") await expect(captureSqlIngestionAttempt(attempt)).rejects.toThrow(/synthetic partial transport failure/);
      else await expect(captureSqlIngestionAttempt(attempt)).rejects.toMatchObject({code: "SQL_NATIVE_RECEIPT_INVALID"});
      expect(await prisma.sqlNativeCapturePart.count()).toBe(0);
      expect(await prisma.sqlNativeRunInput.count({where: {workspaceId: f.workspace.id}})).toBe(0);
      expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastCursorValue).toBeNull();
      expect(models.embed).not.toHaveBeenCalled();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS pun68_synthetic_part_substitution ON "SqlNativeCapturePart"');
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS pun68_synthetic_part_substitution()");
    }
    await captureSqlIngestionAttempt(attempt);
    expect(await prisma.sqlNativeRunInput.count({where: {workspaceId: f.workspace.id}})).toBe(1);
    expect(await prisma.sqlNativeCapturePart.count()).toBe(0);
  });
  it.each(["cipher", "header"])("rolls back a native issuer when an insert trigger substitutes its authenticated %s", async target => {
    const f = await fixture(), attempt = await f.claim();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION pun68_synthetic_native_substitution() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${target === "cipher" ? 'NEW."encryptedPayload" := NEW."encryptedPayload" || \'changed\';'
        : 'NEW."nextCursor" := \'changed synthetic header\';'} RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER pun68_synthetic_native_substitution BEFORE INSERT ON "SqlNativeRunInput"
      FOR EACH ROW EXECUTE FUNCTION pun68_synthetic_native_substitution()`);
    try {
      await expect(captureSqlIngestionAttempt(attempt)).rejects.toMatchObject({code: "SQL_NATIVE_RECEIPT_INVALID"});
      expect(await prisma.sqlNativeRunInput.count({where: {workspaceId: f.workspace.id}})).toBe(0);
      expect(await prisma.sqlNativeCapturePart.count()).toBe(0);
      expect(models.embed).not.toHaveBeenCalled();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS pun68_synthetic_native_substitution ON "SqlNativeRunInput"');
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS pun68_synthetic_native_substitution()");
    }
  });
  it("counts immutable staged timestamps in a non-UTC application database session", async () => {
    models.embed.mockImplementation(async ({input}) => ({embeddings: (typeof input === "string" ? [input] : input)
      .map(() => Array.from({length: 1536}, (_, index) => ((index % 31) - 15) / 100)), usage: {model: "synthetic-sql-embedding"}}));
    const f = await fixture(), p = await f.prepare();
    await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const chunks = await prisma.knowledgeChunk.findMany({where: {workspaceId: f.workspace.id}});
    const native = await prisma.sqlNativeRunInput.findUniqueOrThrow({where: {id: p.receipt.receiptId}});
    const roots = await captureArtifactInputProof(f.bobActor, f.workspace.id,
      [{kind: "SqlNativeRunInput", id: native.id, snapshot: native}]);
    const proof = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/New_York'");
      return captureSqlCountPageProof(f.workspace.id, chunks.map(chunk => chunk.id), roots, tx);
    });
    expect(proof).toHaveLength(1);
  });
  it("counts the complete 4,000-row publication with at least 8,000 chunks beyond the search scan limit", async () => {
    transport.rows = Array.from({length: 4_000}, (_, index) => row(index + 1, "synthetic ".repeat(180)));
    const f = await fixture(), start = performance.now(), p = await f.prepare();
    const result = await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit}), committedAt = performance.now();
    process.stdout.write(`Complete SQL capacity publication ${JSON.stringify({chunks: result.chunksCreated, publicationMs: Math.round(committedAt - start)})}\n`);
    expect(result.chunksCreated).toBeGreaterThanOrEqual(8_000);
    expect(await prisma.knowledgeChunk.findMany({where: {workspaceId: f.workspace.id}, select: {sourceId: true}, distinct: ["sourceId"]})).toHaveLength(4_000);
    expect(await countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(result.chunksCreated);
    expect(transport.accessInsideCommit).toBe(0);
    console.info("Complete synthetic SQL count / real app PG", {chunks: result.chunksCreated,
      publicationMs: Math.round(committedAt - start), countMs: Math.round(performance.now() - committedAt),
      rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024)});
  });
  it.each(["epoch", "manifest", "content"])("count rejects an earlier page %s change during final-page native replay", async target => {
    transport.rows = Array.from({length: 600}, (_, index) => row(index + 1));
    const f = await fixture(), p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const first = await prisma.knowledgeChunk.findFirstOrThrow({orderBy: [{createdAt: "desc"}, {chunkIndex: "asc"}, {id: "asc"}]});
    let scans = 0, changed = false;
    const original = prisma.knowledgeChunk.findMany.bind(prisma.knowledgeChunk);
    const spy = vi.spyOn(prisma.knowledgeChunk, "findMany").mockImplementation((async args => {
      if (args?.take === 500) scans++;
      return original(args);
    }) as typeof prisma.knowledgeChunk.findMany);
    transport.afterAccess = async () => {
      if (scans !== 2 || changed) return;
      changed = true;
      if (target === "manifest") await prisma.artifactInputLineage.updateMany({where: {artifactType: "KnowledgeChunk", artifactId: first.id}, data: {rootsJson: []}});
      else await prisma.knowledgeChunk.update({where: {id: first.id}, data: target === "epoch" ? {accessDomain: "FINANCE"} : {content: "Synthetic changed original"}});
    };
    try {
      await expect(countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).rejects.toMatchObject({code: "SOURCE_CHANGED"});
      expect(changed).toBe(true);
    } finally {spy.mockRestore(); transport.afterAccess = undefined;}
  });
  it.each(["manifest", "document", "empty"])("mixed count fences %s changes across SQL provider awaits", async target => {
    const f = await fixture(), p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const document = await createDocument(f.aliceActor, {workspaceId: f.workspace.id, title: "Synthetic mixed count document",
      source: "upload", storageKey: `synthetic/${randomUUID()}`, textContent: "Synthetic independent document content"});
    expect(await syncDocumentKnowledge({workspaceId: f.workspace.id, documentId: document.id, lineageActor: f.aliceActor})).toBeGreaterThan(0);
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow({where: {sourceType: "DOCUMENT", sourceId: document.id}});
    let checks = 0, changed = false;
    transport.afterAccess = async () => {
      checks++;
      // Empty source admission changes other inputs immediately; otherwise
      // mutate only during final replay after complete local SQL page admission.
      if (changed || (target !== "empty" && checks < 3)) return;
      changed = true;
      if (target === "document") await prisma.document.update({where: {id: document.id}, data: {textContent: "Synthetic changed source"}});
      else await prisma.artifactInputLineage.updateMany({where: {artifactType: "KnowledgeChunk", artifactId: chunk.id}, data: {origin: "UNKNOWN", rootsJson: []}});
      if (target === "empty") transport.access = false;
    };
    try {
      await expect(countReadableKnowledgeChunks(f.bobActor, f.workspace.id)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
      expect(changed).toBe(true);
    } finally {transport.afterAccess = undefined;}
  });
  it("count withholds one unknown child independently and never treats restored own epochs as fresh lineage", async () => {
    transport.rows = [row(1), row(2), row(3)]; const f = await fixture(), p = await f.prepare();
    await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const children = await prisma.knowledgeChunk.findMany({orderBy: {id: "asc"}});
    await prisma.artifactInputLineage.updateMany({where: {artifactId: children[0].id}, data: {origin: "UNKNOWN", rootsJson: []}});
    await prisma.knowledgeChunk.update({where: {id: children[1].id}, data: {accessDomain: "FINANCE"}});
    await prisma.knowledgeChunk.update({where: {id: children[1].id}, data: {accessDomain: "WORKSPACE"}});
    expect(await countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(1);
  });
  it("final count snapshot rejects a selected role expiring after native replay without an epoch change", async () => {
    const f = await fixture();
    const circle = await prisma.circle.create({data: {workspaceId: f.workspace.id, name: "Synthetic expiry circle"}});
    const role = await prisma.role.create({data: {circleId: circle.id, name: "Expiring reader", accountabilities: [], artifacts: []}});
    const expiresAt = new Date(Date.now() + 10_000);
    await prisma.roleAssignment.create({data: {roleId: role.id, memberId: f.members[1].id, expiresAt}});
    await prisma.externalDataSource.update({where: {id: f.source.id}, data: {isRestricted: true, allowedRoleIds: [role.id]}});
    const p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    let delayed = false;
    const client = getPrismaClient(), original = client.$transaction.bind(client);
    const spy = vi.spyOn(client, "$transaction").mockImplementation((async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: {isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number; maxWait?: number}) => {
      if (options?.isolationLevel === "RepeatableRead") {
        expect(Date.now()).toBeLessThan(expiresAt.getTime()); delayed = true;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 50)));
      }
      return original(callback, options);
    }) as typeof prisma.$transaction);
    try {
      await expect(countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).rejects.toMatchObject({code: "SOURCE_CHANGED"});
      expect(delayed).toBe(true);
    } finally {spy.mockRestore();}
  });
  it("empty native admission rejects a new independent source committed during its provider await", async () => {
    const f = await fixture(), p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    let added = false;
    transport.afterAccess = async () => {
      if (added) return; added = true; transport.afterAccess = undefined;
      const source = await prisma.externalDataSource.create({data: {workspaceId: f.workspace.id, label: "Synthetic newly added source",
        connectionStringEnc: "synthetic-registered-driver", selectedTables: ["public.rows"]}});
      const log = await prisma.externalDataSyncLog.create({data: {sourceId: source.id}});
      const attempt = await claimSqlIngestionAttempt({workspaceId: f.workspace.id, sourceId: source.id, logId: log.id,
        expectedConfigurationFingerprint: sqlIngestionConfigurationFingerprint(source), expectedCursor: null});
      const receipt = await captureSqlIngestionAttempt(attempt), prepared = await prepareSqlKnowledgeAttempt({attempt, receipt});
      await publishPreparedSqlKnowledgeAttempt({attempt, prepared, commit: async (tx, identity) => {
        await tx.externalDataSource.update({where: {id: source.id}, data: {lastCursorValue: identity.nextCursor}});
        await tx.externalDataSyncLog.update({where: {id: log.id}, data: {completedAt: new Date(), error: null,
          rowsProcessed: identity.rowsProcessed, chunksCreated: identity.chunksCreated}});
      }});
      transport.access = false;
    };
    try {
      await expect(countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).rejects.toMatchObject({code: "SOURCE_CHANGED"});
      expect(added).toBe(true);
      transport.access = true;
      expect(await countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(1);
    } finally {transport.afterAccess = undefined; transport.access = true;}
  });
  it.each(["chunk", "manifest"])("callback final-batch %s mutation invalidates the complete set and rolls everything back", async target => {
    transport.rows = Array.from({length: 257}, (_, index) => row(index + 1));
    const f = await fixture(), p = await f.prepare();
    const beforeCache = await prisma.sharedCacheVersion.findMany();
    await expect(publishPreparedSqlKnowledgeAttempt({...p, commit: async (tx, identity) => {
      await f.commit(tx, identity);
      const last = await tx.sqlKnowledgeStagedChunk.findFirstOrThrow({where: {publicationId: identity.publicationId},
        orderBy: {ordinal: "desc"}, select: {id: true, ordinal: true}});
      expect(last.ordinal).toBe(256);
      if (target === "chunk") await tx.knowledgeChunk.delete({where: {id: last.id}});
      else await tx.artifactInputLineage.updateMany({where: {workspaceId: f.workspace.id, artifactType: "KnowledgeChunk",
        artifactId: last.id}, data: {rootsJson: []}});
    }})).rejects.toMatchObject({code: "SQL_PUBLICATION_SET_CHANGED"});
    expect(await prisma.knowledgeChunk.count()).toBe(0); expect(await prisma.artifactInputLineage.count()).toBe(0);
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastCursorValue).toBeNull();
    expect((await prisma.externalDataSyncLog.findUniqueOrThrow({where: {id: p.attempt.logId}})).completedAt).toBeNull();
    expect((await prisma.sqlKnowledgePublication.findUniqueOrThrow({where: {id: p.prepared.preparationId}})).status).toBe("PREPARED");
    expect((await prisma.sqlIngestionAttempt.findUniqueOrThrow({where: {id: p.attempt.attemptId}})).status).toBe("RUNNING");
    expect(await prisma.sharedCacheVersion.findMany()).toEqual(beforeCache);
    expect(await prisma.sqlNativeRunInput.count()).toBe(1);
  });
  it("post-model provider denial cannot publish or advance a cursor", async () => {
    const f = await fixture(), p = await f.prepare(); transport.access = false;
    await expect(publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit})).rejects.toMatchObject({code: "SQL_NATIVE_CAPTURE_ACCESS_REVOKED"});
    expect(await prisma.knowledgeChunk.count()).toBe(0);
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastCursorValue).toBeNull();
  });
  it("provider denial survives restoration; unproved/network access never uses local fallback", async () => {
    const f = await fixture(), p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow();
    transport.unproved = true;
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, chunk.id)).toBeNull();
    transport.unproved = false;
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, chunk.id)).not.toBeNull();
    transport.access = false;
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, chunk.id)).toBeNull();
    transport.access = true;
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, chunk.id)).toBeNull();
    expect(await countReadableKnowledgeChunks(f.aliceActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(0);
    expect(await prisma.sqlNativeRunInput.count()).toBe(1);
    expect(await prisma.knowledgeChunk.count()).toBe(1); // Preserve old output; its original epoch is invalid.
  });
  it("selected role's governing circle revocation/restoration cannot revive an old receipt", async () => {
    const f = await fixture();
    const circle = await prisma.circle.create({data: {workspaceId: f.workspace.id, name: "Original selected circle"}});
    const role = await prisma.role.create({data: {circleId: circle.id, name: "Original selected role", accountabilities: [], artifacts: []}});
    await prisma.roleAssignment.create({data: {roleId: role.id, memberId: f.members[0].id}});
    await prisma.externalDataSource.update({where: {id: f.source.id}, data: {isRestricted: true, allowedRoleIds: [role.id]}});
    const p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow();
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, chunk.id)).not.toBeNull();
    await prisma.circle.update({where: {id: circle.id}, data: {archivedAt: new Date()}});
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, chunk.id)).toBeNull();
    await prisma.circle.update({where: {id: circle.id}, data: {archivedAt: null}});
    expect(await fetchReadableKnowledgeChunk(f.aliceActor, f.workspace.id, chunk.id)).toBeNull();
  });
  it("SQL collection capture retains the consuming member's loss-and-restore history without rewriting native originals", async () => {
    const f = await fixture(), p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow();
    const original = (await prisma.sqlNativeRunInput.findFirstOrThrow()).permissionEpochsJson;
    const roots = await captureArtifactInputProof(f.aliceActor, f.workspace.id, [{kind: "KnowledgeChunk", id: chunk.id, snapshot: chunk}]);
    expect(roots.find(root => root.kind === "KnowledgeChunk")!.permissionEpochs!.entries).toContainEqual(expect.objectContaining({
      kind: "MemberUserPolicy", id: f.aliceActor.kind === "user" ? f.aliceActor.user.id : ""}));
    await prisma.member.update({where: {id: f.members[0].id}, data: {isActive: false}});
    await prisma.member.update({where: {id: f.members[0].id}, data: {isActive: true}});
    expect(await isArtifactInputProofReadable(f.aliceActor, f.workspace.id, roots)).toBe(false);
    expect((await prisma.sqlNativeRunInput.findFirstOrThrow()).permissionEpochsJson).toEqual(original);
    // Fresh authorized reading remains valid for the unchanged company source.
    expect(await fetchReadableKnowledgeChunk(f.bobActor, f.workspace.id, chunk.id)).not.toBeNull();
  });
  it.each(["manifest", "member restore"])("bulk collection proof rejects %s changes after native validation without weakening the native originals", async change => {
    const f = await fixture(), p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow();
    const roots = (await captureSqlKnowledgeInputProof(f.aliceActor, f.workspace.id, [chunk]))!;
    const original = (await prisma.sqlNativeRunInput.findFirstOrThrow()).permissionEpochsJson;
    transport.afterAccess = async () => {
      transport.afterAccess = undefined;
      if (change === "manifest") await prisma.artifactInputLineage.updateMany({where: {
        workspaceId: f.workspace.id, artifactType: "KnowledgeChunk"}, data: {rootsJson: []}});
      else {
        await prisma.member.update({where: {id: f.members[0].id}, data: {isActive: false}});
        await prisma.member.update({where: {id: f.members[0].id}, data: {isActive: true}});
      }
    };
    expect(await isSqlKnowledgeInputProofReadable(f.aliceActor, f.workspace.id, roots)).toBe(false);
    expect((await prisma.sqlNativeRunInput.findFirstOrThrow()).permissionEpochsJson).toEqual(original);
  });
  it("one unproved child does not hide a separately published readable child in counts or search", async () => {
    transport.rows = [row(1, "Synthetic withheld first input"), row(2, "Synthetic independently readable second input")];
    const f = await fixture(), p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const first = await prisma.knowledgeChunk.findFirstOrThrow({where: {workspaceId: f.workspace.id, metadata: {path: ["nativeRowIndex"], equals: 0}}});
    const second = await prisma.knowledgeChunk.findFirstOrThrow({where: {workspaceId: f.workspace.id, metadata: {path: ["nativeRowIndex"], equals: 1}}});
    await prisma.artifactInputLineage.updateMany({where: {workspaceId: f.workspace.id, artifactId: first.id}, data: {rootsJson: []}});
    expect(await fetchReadableKnowledgeChunk(f.bobActor, f.workspace.id, first.id)).toBeNull();
    expect(await fetchReadableKnowledgeChunk(f.bobActor, f.workspace.id, second.id)).not.toBeNull();
    expect(await countReadableKnowledgeChunks(f.bobActor, f.workspace.id, ["EXTERNAL_DATABASE"])).toBe(1);
    const results = await searchIndexedKnowledge({actor: f.bobActor, workspaceId: f.workspace.id,
      query: "independently readable second", sourceTypes: ["EXTERNAL_DATABASE"]});
    expect(results.map(result => result.chunkId)).toEqual([second.id]);
  });
  it("a downstream source commit consumes a SQL chunk with immutable native proof and no provider in SQL", async () => {
    const f = await fixture(), p = await f.prepare(); await publishPreparedSqlKnowledgeAttempt({...p, commit: f.commit});
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow();
    const roots = await captureArtifactInputProof(f.aliceActor, f.workspace.id, [{kind: "KnowledgeChunk", id: chunk.id, snapshot: chunk}]);
    const id = randomUUID(), snapshotId = randomUUID(), binding = {kind: "HUMAN_REQUEST" as const, id: randomUUID(), generation: 1};
    const input = roots.find(root => root.kind === "KnowledgeChunk" && root.id === chunk.id)!;
    const articleData = {isPrivate: false, sourceIds: [], title: "Synthetic SQL-derived article",
      bodyMd: chunk.content, slug: `sql-derived-${id}`, type: "STRATEGY" as const, authority: "REFERENCE" as const};
    const targets: SourceCommitWriteTarget[] = [{kind: "BrainArticle", id, projectedAuthority: articleData},
      {kind: "ArtifactInputSnapshot", id: snapshotId, snapshotInput: input,
        projectedAuthority: {sourceKind: input.kind, sourceId: input.id, sourceFingerprint: input.fingerprint}}];
    const options = {writeTargets: targets, ownerBinding: binding};
    const preflight = await prepareArtifactSourceCommit(f.aliceActor, f.workspace.id, roots, options);
    await prisma.$transaction(async tx => withArtifactSourceCommit(f.aliceActor, f.workspace.id, tx, roots, options, preflight,
      async connection => {expect(connection).toBe(tx);}, () => withArtifactInputSnapshotAllocations(f.aliceActor, f.workspace.id, tx,
        [{id: snapshotId, input}], async () => {
        const frozen = await captureImmutableArtifactInputProof(f.aliceActor, f.workspace.id, roots, tx);
        const article = await tx.brainArticle.create({data: {id, workspaceId: f.workspace.id, ...articleData}});
        await recordArtifactInputLineage({tx, actor: f.aliceActor, workspaceId: f.workspace.id, artifact: {kind: "BrainArticle", id},
          content: article, origin: "DERIVED", inputs: [], inheritedRoots: frozen});
      })), {timeout: 20_000});
    const proof = await captureArtifactInputProof(f.aliceActor, f.workspace.id, [{kind: "BrainArticle", id}]);
    expect(await isArtifactInputProofReadable(f.aliceActor, f.workspace.id, proof)).toBe(true);
    expect(transport.accessInsideCommit).toBe(0);
  });
});
