import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  source: { id: "source-1", workspaceId: "workspace-1", isActive: true, driverType: "postgres",
    connectionStringEnc: "synthetic-encrypted", selectedTables: ["public.synthetic"], cursorColumn: "updated_at",
    lastCursorValue: '{"public.synthetic":"2025-01-01"}', lastSyncAt: new Date("2025-01-01") },
  findUnique: vi.fn(), updateSource: vi.fn(), createLog: vi.fn(), updateLog: vi.fn(),
  decrypt: vi.fn(), connect: vi.fn(), pullRows: vi.fn(), end: vi.fn(), embed: vi.fn(),
}));
vi.mock("@corgtex/shared", async original => ({ ...await original<typeof import("@corgtex/shared")>(),
  prisma: { externalDataSource: { findUnique: fixture.findUnique, update: fixture.updateSource },
    externalDataSyncLog: { create: fixture.createLog, update: fixture.updateLog } },
}));
vi.mock("@corgtex/knowledge", async () => ({
  syncKnowledgeForSource: (await import("../../knowledge/src/chunks")).syncKnowledgeForSource,
}));
vi.mock("../../knowledge/src/retrieval", () => ({ invalidateKnowledgeCache: vi.fn() }));
vi.mock("@corgtex/models", async original => ({ ...await original<typeof import("@corgtex/models")>(),
  defaultModelGateway: { embed: fixture.embed },
}));
vi.mock("./encryption", () => ({ decrypt: fixture.decrypt }));
vi.mock("./postgres", () => ({ connectReadOnly: fixture.connect, pullRows: fixture.pullRows }));
import { syncExternalDataSource } from "./puller";

beforeEach(() => {
  vi.resetAllMocks();
  fixture.findUnique.mockImplementation(async () => structuredClone(fixture.source));
  fixture.createLog.mockResolvedValue({ id: "log-1" });
  fixture.decrypt.mockReturnValue("synthetic-connection");
  fixture.connect.mockResolvedValue({ end: fixture.end });
  fixture.pullRows.mockResolvedValue([{ id: "row-1", updated_at: "2026-01-01", content: "private row canary" }]);
});

describe("legacy SQL connector cannot acknowledge unproved publication", () => {
  it("rejects a fetched row through the actual knowledge guard without advancing cursor or success metadata", async () => {
    const prior = structuredClone(fixture.source);
    await expect(syncExternalDataSource(prior.id)).rejects.toMatchObject({ code: "SQL_NATIVE_PUBLICATION_REQUIRED" });
    expect(fixture.pullRows).toHaveBeenCalledExactlyOnceWith(expect.anything(), "public.synthetic", "updated_at", "2025-01-01", 1000);
    expect(fixture.embed).not.toHaveBeenCalled();
    expect(fixture.updateLog).toHaveBeenCalledExactlyOnceWith({ where: { id: "log-1" },
      data: { error: expect.stringContaining("native SQL publisher"), completedAt: expect.any(Date) } });
    expect(fixture.updateSource).toHaveBeenCalledExactlyOnceWith({ where: { id: prior.id },
      data: { lastSyncError: expect.stringContaining("native SQL publisher") } });
    expect(fixture.source).toEqual(prior);
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it("preserves the same checkpoint when the failed job is retried", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(syncExternalDataSource(fixture.source.id)).rejects.toMatchObject({ code: "SQL_NATIVE_PUBLICATION_REQUIRED" });
    }
    expect(fixture.pullRows.mock.calls.map(call => call[3])).toEqual(["2025-01-01", "2025-01-01"]);
    expect(fixture.updateSource.mock.calls.every(([args]) => Object.keys(args.data).join() === "lastSyncError")).toBe(true);
    expect(fixture.updateLog.mock.calls.every(([args]) => !Object.hasOwn(args.data, "rowsProcessed") && !Object.hasOwn(args.data, "chunksCreated"))).toBe(true);
    expect(fixture.embed).not.toHaveBeenCalled();
    expect(fixture.end).toHaveBeenCalledTimes(2);
  });
});
