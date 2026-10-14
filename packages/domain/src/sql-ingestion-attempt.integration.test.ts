import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { assertSqlIngestionAttemptCurrent, claimSqlIngestionAttempt, failSqlIngestionAttempt,
  renewSqlIngestionAttempt, sqlIngestionConfigurationFingerprint, sqlIngestionSourceForCapture } from "./sql-ingestion-attempt";
import type { SqlIngestionAttempt } from "./sql-ingestion-contract";

async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic SQL claim", slug: `sql-claim-${randomUUID()}`}});
  const source = await prisma.externalDataSource.create({data: {workspaceId: workspace.id, label: "Synthetic source",
    connectionStringEnc: "synthetic-not-decrypted", selectedTables: ["public.rows"], cursorColumn: "updated_at"}});
  const request = async () => ({workspaceId: workspace.id, sourceId: source.id,
    expectedConfigurationFingerprint: sqlIngestionConfigurationFingerprint(source), expectedCursor: null,
    logId: (await prisma.externalDataSyncLog.create({data: {sourceId: source.id}})).id});
  return {workspace, source, request};
}

describe("durable SQL ingestion source claims (no provider/model/publication)", () => {
  beforeEach(truncateAllTables);
  it("matches compatible v1 fingerprint, binds one log and renews the same generation", async () => {
    const f = await fixture();
    expect(sqlIngestionConfigurationFingerprint(f.source)).toBe(createHash("sha256").update(JSON.stringify({
      sourceId: f.source.id, workspaceId: f.source.workspaceId, driverType: f.source.driverType,
      connectionStringEnc: f.source.connectionStringEnc, cursorColumn: f.source.cursorColumn,
      selectedTables: f.source.selectedTables})).digest("hex"));
    const attempt = await claimSqlIngestionAttempt(await f.request());
    const before = await prisma.sqlIngestionAttempt.findUniqueOrThrow({where: {id: attempt.attemptId}});
    await renewSqlIngestionAttempt(attempt);
    const after = await prisma.sqlIngestionAttempt.findUniqueOrThrow({where: {id: attempt.attemptId}});
    expect(after).toMatchObject({generation: before.generation, ownerNonce: before.ownerNonce,
      configurationFingerprint: before.configurationFingerprint, sourcePermissionEpoch: before.sourcePermissionEpoch});
    expect(after.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before.leaseExpiresAt.getTime());
    expect((await prisma.externalDataSyncLog.findUniqueOrThrow({where: {id: attempt.logId}})).sqlAttemptId).toBe(attempt.attemptId);
    await expect(assertSqlIngestionAttemptCurrent(attempt)).resolves.toBeUndefined();
    await expect(claimSqlIngestionAttempt(await f.request())).rejects.toMatchObject({code: "SQL_INGESTION_ATTEMPT_CONFLICT"});
    expect(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  });
  it("rejects forged process tokens and wrong workspace/configuration before native access", async () => {
    const f = await fixture(), attempt = await claimSqlIngestionAttempt(await f.request());
    await expect(sqlIngestionSourceForCapture({...attempt} as SqlIngestionAttempt)).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
    const other = await prisma.workspace.create({data: {slug: `sql-other-${randomUUID()}`, name: "Other tenant"}});
    await expect(claimSqlIngestionAttempt({...await f.request(), workspaceId: other.id})).rejects.toMatchObject({code: "SQL_INGESTION_ATTEMPT_CONFLICT"});
    await expect(claimSqlIngestionAttempt({...await f.request(), expectedConfigurationFingerprint: "0".repeat(64)})).rejects.toMatchObject({code: "SQL_INGESTION_ATTEMPT_CONFLICT"});
  });
  it("another actual connection reclaims an expired generation with identical cursor text", async () => {
    const f = await fixture(), old = await claimSqlIngestionAttempt(await f.request());
    const second = new PrismaClient({datasources: {db: {url: process.env.DATABASE_URL}}});
    try {
      const expired = new Date("2020-01-01Z");
      await second.$transaction(async tx => {
        await tx.sqlIngestionSourceClaim.update({where: {workspaceId_sourceId: {workspaceId: f.workspace.id, sourceId: f.source.id}}, data: {leaseExpiresAt: expired}});
        await tx.sqlIngestionAttempt.update({where: {id: old.attemptId}, data: {leaseExpiresAt: expired}});
      });
      const current = await claimSqlIngestionAttempt(await f.request());
      expect(BigInt(current.generation)).toBeGreaterThan(BigInt(old.generation));
      await expect(renewSqlIngestionAttempt(old)).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
      await prisma.externalDataSource.update({where: {id: f.source.id}, data: {lastSyncError: "New attempt owns this status"}});
      await failSqlIngestionAttempt({attempt: old, logId: old.logId, error: "Obsolete failure"});
      expect((await second.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastSyncError).toBe("New attempt owns this status");
      await expect(assertSqlIngestionAttemptCurrent(current)).resolves.toBeUndefined();
    } finally {await second.$disconnect();}
  });
  it("credential/config changes revoke an active generation without changing cursor text", async () => {
    const f = await fixture(), old = await claimSqlIngestionAttempt(await f.request());
    await prisma.externalDataSource.update({where: {id: f.source.id}, data: {connectionStringEnc: "different-synthetic-credential"}});
    await expect(assertSqlIngestionAttemptCurrent(old)).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
    const source = await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}});
    const fresh = await claimSqlIngestionAttempt({...await f.request(), expectedConfigurationFingerprint: sqlIngestionConfigurationFingerprint(source)});
    expect(BigInt(fresh.generation)).toBeGreaterThan(BigInt(old.generation));
    await failSqlIngestionAttempt({attempt: old, logId: old.logId, error: "Old configuration failed"});
    await expect(assertSqlIngestionAttemptCurrent(fresh)).resolves.toBeUndefined();
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastSyncError).toBeNull();
  });
  it("same-id deletion/recreation retains tombstone and tolerates a cascaded old log", async () => {
    const f = await fixture(), old = await claimSqlIngestionAttempt(await f.request());
    await prisma.externalDataSource.delete({where: {id: f.source.id}});
    expect(await prisma.externalDataSyncLog.findUnique({where: {id: old.logId}})).toBeNull();
    await prisma.externalDataSource.create({data: {id: f.source.id, workspaceId: f.workspace.id, label: f.source.label,
      connectionStringEnc: f.source.connectionStringEnc, selectedTables: f.source.selectedTables, cursorColumn: f.source.cursorColumn}});
    const fresh = await claimSqlIngestionAttempt(await f.request());
    expect(BigInt(fresh.generation)).toBeGreaterThan(BigInt(old.generation));
    await expect(failSqlIngestionAttempt({attempt: old, logId: old.logId, error: "Original failure"})).resolves.toBeUndefined();
    await expect(sqlIngestionSourceForCapture(old)).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
    await expect(assertSqlIngestionAttemptCurrent(fresh)).resolves.toBeUndefined();
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastSyncError).toBeNull();
  });
  it("current failure releases only its own claim and terminal attempts cannot revive", async () => {
    const f = await fixture(), attempt = await claimSqlIngestionAttempt(await f.request());
    await failSqlIngestionAttempt({attempt, logId: attempt.logId, error: "Synthetic native preparation failed"});
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastSyncError).toBe("Synthetic native preparation failed");
    expect((await prisma.sqlIngestionAttempt.findUniqueOrThrow({where: {id: attempt.attemptId}})).status).toBe("FAILED");
    await failSqlIngestionAttempt({attempt, logId: attempt.logId, error: "Duplicate cleanup must not replace the original failure"});
    expect((await prisma.externalDataSyncLog.findUniqueOrThrow({where: {id: attempt.logId}})).error).toBe("Synthetic native preparation failed");
    await expect(renewSqlIngestionAttempt(attempt)).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
    await expect(prisma.sqlIngestionAttempt.update({where: {id: attempt.attemptId}, data: {status: "RUNNING"}})).rejects.toThrow();
    await expect(prisma.sqlIngestionAttempt.update({where: {id: attempt.attemptId}, data: {logId: "forged-log"}})).rejects.toThrow();
    const fresh = await claimSqlIngestionAttempt(await f.request());
    await expect(prisma.sqlIngestionSourceClaim.update({where: {workspaceId_sourceId: {workspaceId: f.workspace.id, sourceId: f.source.id}}, data: {generation: 0n}})).rejects.toThrow();
    await expect(assertSqlIngestionAttemptCurrent(fresh)).resolves.toBeUndefined();
  });
  it.each(["epoch", "stored lease"])("failure after %s loss records its own error without changing source status", async reason => {
    const f = await fixture(), attempt = await claimSqlIngestionAttempt(await f.request());
    await prisma.externalDataSource.update({where: {id: f.source.id}, data: {lastSyncError: "Authoritative source status"}});
    if (reason === "epoch") {
      await prisma.sourcePermissionEpoch.update({where: {workspaceId_sourceKind_sourceId: {
        workspaceId: f.workspace.id, sourceKind: "ExternalDataSource", sourceId: f.source.id}}, data: {epoch: {increment: 1n}}});
    } else {
      await prisma.sqlIngestionAttempt.update({where: {id: attempt.attemptId}, data: {leaseExpiresAt: new Date("2020-01-01Z")}});
    }
    await expect(assertSqlIngestionAttemptCurrent(attempt)).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
    await failSqlIngestionAttempt({attempt, logId: attempt.logId, error: "Original preparation failure"});
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: f.source.id}})).lastSyncError).toBe("Authoritative source status");
    expect((await prisma.sqlIngestionAttempt.findUniqueOrThrow({where: {id: attempt.attemptId}})).error).toBe("Original preparation failure");
    expect((await prisma.externalDataSyncLog.findUniqueOrThrow({where: {id: attempt.logId}})).error).toBe("Original preparation failure");
  });
  it("workspace cascade does not recreate a source tombstone for a removed workspace", async () => {
    const f = await fixture();
    // A source created before the additive migration can have no claim row.
    await prisma.sqlIngestionSourceClaim.deleteMany({where: {workspaceId: f.workspace.id}});
    await prisma.workspace.delete({where: {id: f.workspace.id}});
    expect(await prisma.externalDataSource.findUnique({where: {id: f.source.id}})).toBeNull();
    expect(await prisma.sqlIngestionSourceClaim.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  });
});
