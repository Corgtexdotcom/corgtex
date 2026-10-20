import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  source: { id: "source-1", workspaceId: "workspace-1", isActive: true, driverType: "postgres",
    connectionStringEnc: "synthetic-encrypted", selectedTables: ["public.synthetic"], cursorColumn: "updated_at",
    lastCursorValue: '{"public.synthetic":"2025-01-01"}', lastSyncAt: new Date("2025-01-01") },
  attempt: { attemptId: "attempt-1", sourceId: "source-1", workspaceId: "workspace-1", generation: "1", logId: "log-1" },
  receipt: { receiptId: "unregistered-receipt" },
  findUnique: vi.fn(), updateSource: vi.fn(), createLog: vi.fn(), updateLog: vi.fn(),
  claim: vi.fn(), capture: vi.fn(), renew: vi.fn(), fail: vi.fn(), dispose: vi.fn(), publish: vi.fn(), embed: vi.fn(),
}));
vi.mock("@corgtex/shared", async original => ({ ...await original<typeof import("@corgtex/shared")>(),
  prisma: { externalDataSource: { findUnique: fixture.findUnique, update: fixture.updateSource, updateMany: fixture.updateSource },
    externalDataSyncLog: { create: fixture.createLog, update: fixture.updateLog, updateMany: fixture.updateLog } },
}));
vi.mock("@corgtex/domain", async original => ({ ...await original<typeof import("@corgtex/domain")>(),
  claimSqlIngestionAttempt: fixture.claim, captureSqlIngestionAttempt: fixture.capture,
  renewSqlIngestionAttempt: fixture.renew, failSqlIngestionAttempt: fixture.fail, disposeSqlIngestionCapture: fixture.dispose,
}));
vi.mock("@corgtex/knowledge", async () => ({
  // Exercise the actual publisher's opaque native-receipt rejection, rather
  // than mocking the expected error or reviving the removed legacy puller.
  prepareSqlKnowledgeAttempt: (await import("../../knowledge/src/sql-publication")).prepareSqlKnowledgeAttempt,
  publishPreparedSqlKnowledgeAttempt: fixture.publish,
}));
vi.mock("../../knowledge/src/retrieval", () => ({ invalidateKnowledgeCache: vi.fn() }));
vi.mock("@corgtex/models", async original => ({ ...await original<typeof import("@corgtex/models")>(),
  defaultModelGateway: { embed: fixture.embed },
}));
import { syncKnowledgeForSource } from "../../knowledge/src/chunks";
import { syncExternalDataSource } from "./puller";

beforeEach(() => {
  vi.resetAllMocks();
  fixture.findUnique.mockImplementation(async () => structuredClone(fixture.source));
  fixture.createLog.mockResolvedValue({ id: "log-1" });
  fixture.claim.mockResolvedValue(fixture.attempt);
  fixture.capture.mockResolvedValue(fixture.receipt);
  fixture.fail.mockResolvedValue(undefined);
  fixture.dispose.mockResolvedValue(undefined);
});

describe("SQL connector cannot acknowledge unproved publication", () => {
  it("keeps the actual generic knowledge guard closed to arbitrary fetched database rows", async () => {
    await expect(syncKnowledgeForSource({ workspaceId: fixture.source.workspaceId, sourceType: "EXTERNAL_DATABASE",
      accessDomain: "WORKSPACE", sourceId: "unproved-row", content: "private row canary" }))
      .rejects.toMatchObject({ code: "SQL_NATIVE_PUBLICATION_REQUIRED" });
    expect(fixture.embed).not.toHaveBeenCalled();
    expect(fixture.updateSource).not.toHaveBeenCalled();
    expect(fixture.updateLog).not.toHaveBeenCalled();
  });

  it("rejects an unregistered native receipt without advancing cursor or success metadata", async () => {
    const prior = structuredClone(fixture.source);
    await expect(syncExternalDataSource(prior.id)).rejects.toMatchObject({ code: "SQL_NATIVE_RECEIPT_INVALID" });
    expect(fixture.claim).toHaveBeenCalledExactlyOnceWith({ workspaceId: prior.workspaceId, sourceId: prior.id,
      expectedConfigurationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), expectedCursor: prior.lastCursorValue, logId: "log-1" });
    expect(fixture.capture).toHaveBeenCalledExactlyOnceWith(fixture.attempt);
    expect(fixture.fail).toHaveBeenCalledExactlyOnceWith({ attempt: fixture.attempt, logId: "log-1",
      error: expect.stringContaining("exact authenticated native capture") });
    expect(fixture.dispose).toHaveBeenCalledExactlyOnceWith(fixture.receipt);
    expect(fixture.embed).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.updateSource).not.toHaveBeenCalled();
    expect(fixture.updateLog).not.toHaveBeenCalled();
    expect(fixture.source).toEqual(prior);
  });

  it("preserves the same checkpoint when unproved capture is retried", async () => {
    const prior = structuredClone(fixture.source);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(syncExternalDataSource(prior.id)).rejects.toMatchObject({ code: "SQL_NATIVE_RECEIPT_INVALID" });
    }
    expect(fixture.claim.mock.calls.map(([args]) => args.expectedCursor)).toEqual([prior.lastCursorValue, prior.lastCursorValue]);
    expect(fixture.fail).toHaveBeenCalledTimes(2);
    expect(fixture.dispose).toHaveBeenCalledTimes(2);
    expect(fixture.updateSource).not.toHaveBeenCalled();
    expect(fixture.updateLog).not.toHaveBeenCalled();
    expect(fixture.embed).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.source).toEqual(prior);
  });
});
