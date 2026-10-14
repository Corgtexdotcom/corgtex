import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type {
  AuthenticatedSqlRunReceipt, PreparedSqlKnowledgeAttempt, SqlIngestionAttempt,
  SqlIngestionAttemptPort, SqlKnowledgePublicationPort, SqlPublicationIdentity,
} from "@corgtex/domain/sql-ingestion-contract";

const mocked = vi.hoisted(() => ({ find: vi.fn(), createLog: vi.fn(), failLog: vi.fn() }));
vi.mock("@corgtex/shared", () => ({ prisma: {
  externalDataSource: { findUnique: mocked.find },
  externalDataSyncLog: { create: mocked.createLog, updateMany: mocked.failLog },
} }));

vi.mock("@corgtex/domain", async () => ({
  sqlIngestionConfigurationFingerprint: (await import("../../domain/src/sql-ingestion-attempt")).sqlIngestionConfigurationFingerprint,
}));

import { createSqlIngestionRunner } from "./runner";
import { scanFingerprint } from "./native-scan";

const source = {
  id: "source", workspaceId: "workspace", driverType: "postgres", isActive: true, archivedAt: null,
  connectionStringEnc: "synthetic-encrypted", selectedTables: ["public.rows"], cursorColumn: "seq", lastCursorValue: null,
};
const attempt = {
  attemptId: "attempt", workspaceId: source.workspaceId, sourceId: source.id, generation: "1",
  configurationFingerprint: scanFingerprint(source), logId: "log",
} as SqlIngestionAttempt;
const receipt = { receiptId: "receipt" } as AuthenticatedSqlRunReceipt;
const prepared = { preparationId: "prepared" } as PreparedSqlKnowledgeAttempt;
let identity: SqlPublicationIdentity;
let ports: SqlIngestionAttemptPort & SqlKnowledgePublicationPort;
let updateCheckpoint: ReturnType<typeof vi.fn>;
let completeLog: ReturnType<typeof vi.fn>;
let tx: Prisma.TransactionClient;

beforeEach(() => {
  vi.resetAllMocks();
  mocked.find.mockResolvedValue(source);
  mocked.createLog.mockResolvedValue({ id: "log" });
  mocked.failLog.mockResolvedValue({ count: 1 });
  identity = {
    publicationId: "publication", attemptId: attempt.attemptId, generation: attempt.generation,
    configurationFingerprint: attempt.configurationFingerprint, workspaceId: source.workspaceId,
    sourceId: source.id, rowsProcessed: 1, chunksCreated: 2, nextCursor: "native-cursor",
  };
  updateCheckpoint = vi.fn().mockResolvedValue({ count: 1 });
  completeLog = vi.fn().mockResolvedValue({ id: "log" });
  tx = { externalDataSource: { updateMany: updateCheckpoint }, externalDataSyncLog: { update: completeLog } } as unknown as Prisma.TransactionClient;
  ports = {
    claimSqlIngestionAttempt: vi.fn().mockResolvedValue(attempt),
    renewSqlIngestionAttempt: vi.fn().mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 300_000) }),
    captureSqlIngestionAttempt: vi.fn().mockResolvedValue(receipt),
    failSqlIngestionAttempt: vi.fn().mockResolvedValue(undefined),
    disposeSqlIngestionCapture: vi.fn().mockResolvedValue(undefined),
    prepareSqlKnowledgeAttempt: vi.fn().mockResolvedValue(prepared),
    publishPreparedSqlKnowledgeAttempt: vi.fn<SqlKnowledgePublicationPort["publishPreparedSqlKnowledgeAttempt"]>(async ({ beforePublication, commit }) => {
      await beforePublication?.();
      await commit(tx, identity);
      return { ...identity, committed: true };
    }),
  };
});

describe("typed SQL publication orchestration", () => {
  it("claims before native capture and updates cursor and success log only in the publication transaction", async () => {
    await createSqlIngestionRunner(ports)(source.id);
    expect(ports.claimSqlIngestionAttempt).toHaveBeenCalledExactlyOnceWith({
      workspaceId: source.workspaceId, sourceId: source.id,
      expectedConfigurationFingerprint: scanFingerprint(source), expectedCursor: null, logId: "log",
    });
    expect(vi.mocked(ports.claimSqlIngestionAttempt).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(ports.captureSqlIngestionAttempt).mock.invocationCallOrder[0]);
    expect(ports.captureSqlIngestionAttempt).toHaveBeenCalledExactlyOnceWith(attempt);
    expect(updateCheckpoint).toHaveBeenCalledExactlyOnceWith({
      where: { id: source.id, workspaceId: source.workspaceId, isActive: true, archivedAt: null,
        driverType: "postgres", connectionStringEnc: source.connectionStringEnc, cursorColumn: "seq",
        selectedTables: { equals: source.selectedTables }, lastCursorValue: null },
      data: { lastCursorValue: "native-cursor", lastSyncAt: expect.any(Date), lastSyncError: null },
    });
    expect(completeLog).toHaveBeenCalledExactlyOnceWith({ where: { id: "log", sourceId: source.id },
      data: { rowsProcessed: 1, chunksCreated: 2, completedAt: expect.any(Date), error: null } });
    expect(ports.failSqlIngestionAttempt).not.toHaveBeenCalled();
    expect(ports.disposeSqlIngestionCapture).toHaveBeenCalledExactlyOnceWith(receipt);
  });

  it("never contacts the provider or updates source status when a competing claim wins", async () => {
    const error = new Error("SQL_INGESTION_FENCE_LOST");
    vi.mocked(ports.claimSqlIngestionAttempt).mockRejectedValueOnce(error);
    await expect(createSqlIngestionRunner(ports)(source.id)).rejects.toBe(error);
    expect(ports.captureSqlIngestionAttempt).not.toHaveBeenCalled();
    expect(ports.failSqlIngestionAttempt).not.toHaveBeenCalled();
    expect(updateCheckpoint).not.toHaveBeenCalled();
    expect(mocked.failLog).toHaveBeenCalledOnce();
  });

  it("retains the real fence diagnostic when its own log is already deleted", async () => {
    const error = new Error("SQL_INGESTION_FENCE_LOST");
    vi.mocked(ports.prepareSqlKnowledgeAttempt).mockRejectedValueOnce(error);
    vi.mocked(ports.failSqlIngestionAttempt).mockRejectedValueOnce(new Error("log no longer exists"));
    await expect(createSqlIngestionRunner(ports)(source.id)).rejects.toBe(error);
    expect(ports.disposeSqlIngestionCapture).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(updateCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects numeric zero instead of treating it as a committed publication", async () => {
    vi.mocked(ports.publishPreparedSqlKnowledgeAttempt).mockResolvedValueOnce(0 as never);
    await expect(createSqlIngestionRunner(ports)(source.id)).rejects.toThrow(/acknowledge/);
    expect(updateCheckpoint).not.toHaveBeenCalled();
    expect(ports.failSqlIngestionAttempt).toHaveBeenCalledOnce();
  });

  it("accepts explicit committed acknowledgement of a verified empty native run", async () => {
    identity = { ...identity, rowsProcessed: 0, chunksCreated: 0, nextCursor: null };
    await createSqlIngestionRunner(ports)(source.id);
    expect(updateCheckpoint).toHaveBeenCalledOnce();
    expect(completeLog).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rowsProcessed: 0, chunksCreated: 0 }) }));
    expect(ports.failSqlIngestionAttempt).not.toHaveBeenCalled();
  });

  it("rejects nonempty runs with no planned chunks before changing the cursor", async () => {
    identity = { ...identity, chunksCreated: 0 };
    await expect(createSqlIngestionRunner(ports)(source.id)).rejects.toThrow(/complete committed output/);
    expect(updateCheckpoint).not.toHaveBeenCalled();
  });

  it("rolls callback failure up to the publisher and records a generation-fenced failure", async () => {
    updateCheckpoint.mockResolvedValueOnce({ count: 0 });
    await expect(createSqlIngestionRunner(ports)(source.id)).rejects.toThrow(/FENCE_LOST/);
    expect(completeLog).not.toHaveBeenCalled();
    expect(ports.failSqlIngestionAttempt).toHaveBeenCalledWith({ attempt, logId: "log", error: expect.stringContaining("FENCE_LOST") });
  });
});
