import { beforeEach, describe, expect, it, vi } from "vitest";
const { tx, prismaMock, enqueueJobMock } = vi.hoisted(() => ({
  tx: { event: { findFirst: vi.fn() } }, prismaMock: { $transaction: vi.fn() }, enqueueJobMock: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../domain/src/source-lineage-rebuild"),
  ...await import("../../../domain/src/errors"),
}));
vi.mock("../outbox", () => ({ enqueueJob: enqueueJobMock }));

import { handleSourceLineageRebuild } from "./source-lineage-rebuild";
describe("source lineage rebuild handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(tx));
    tx.event.findFirst.mockResolvedValue({ id: "event-1", workspaceId: "ws-1", type: "source-lineage.changed", createdAt: new Date("2026-10-12T10:00:00Z") });
  });
  it("loads the tenant-scoped event and enqueues only fresh recipes atomically", async () => {
    await expect(handleSourceLineageRebuild("job-1", { eventId: "event-1", ...{ dateISO: "fake", oldBody: "secret" } }, "ws-1")).resolves.toEqual({ enqueued: 4 });
    expect(tx.event.findFirst).toHaveBeenCalledWith({ where: { id: "event-1", workspaceId: "ws-1" }, select: { id: true, workspaceId: true, type: true, createdAt: true } });
    expect(enqueueJobMock).toHaveBeenCalledTimes(4);
    expect(enqueueJobMock.mock.calls.every(([client]) => client === tx)).toBe(true);
    expect(JSON.stringify(enqueueJobMock.mock.calls)).not.toContain("secret");
    expect(enqueueJobMock).toHaveBeenCalledWith(tx, expect.objectContaining({ type: "brain.daily-digest", payload: expect.objectContaining({ regenerationOnly: true, dateISO: "2026-10-12T10:00:00.000Z" }) }));
  });
  it("rejects an event outside the job workspace", async () => {
    tx.event.findFirst.mockResolvedValue(null);
    await expect(handleSourceLineageRebuild("job", { eventId: "other-workspace-event" }, "ws-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
  it("rejects arbitrary event types and missing identity", async () => {
    tx.event.findFirst.mockResolvedValue({ id: "event-1", workspaceId: "ws-1", type: "brain-article.updated", createdAt: new Date() });
    await expect(handleSourceLineageRebuild("job", { eventId: "event-1" }, "ws-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(handleSourceLineageRebuild("job", {}, "ws-1")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});
