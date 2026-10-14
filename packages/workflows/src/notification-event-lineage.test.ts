import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { captureProof } = vi.hoisted(() => ({ captureProof: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ captureArtifactInputProof: captureProof }));
import { captureCurrentAdviceNotification } from "./notification-event-lineage";

const event = { type: "advice.requested", workspaceId: "workspace-1", aggregateType: "AdviceRequest", aggregateId: "request-1",
  payload: { subjectTitle: "Old restricted title", messageMd: "Old restricted request", deadlineAt: "old", requestedByUserId: "old-user" } };
function fixture() {
  const request = { id: "request-1", workspaceId: "workspace-1", processId: "process-1", status: "ACTIVE", requestedByUserId: "current-user", messageMd: "Current permitted request", deadlineAt: new Date("2026-10-12T12:00:00Z") };
  const subject = { id: "action-1", workspaceId: "workspace-1", title: "Current permitted title", bodyMd: "Current body" };
  const process = { id: "process-1", workspaceId: "workspace-1", subjectType: "ACTION", subjectId: "action-1" };
  const entry = { id: "entry-1", workspaceId: "workspace-1", adviceRequestId: "request-1", parentType: "ACTION", parentId: "action-1", authorUserId: "current-author", bodyMd: "Reply" };
  const db = { $queryRaw: vi.fn().mockResolvedValue([]), adviceRequest: { findFirst: vi.fn().mockResolvedValue(request) },
    adviceProcess: { findFirst: vi.fn().mockResolvedValue(process) }, action: { findFirst: vi.fn().mockResolvedValue(subject) },
    deliberationEntry: { findFirst: vi.fn().mockResolvedValue(entry) } };
  return { request, subject, process, entry, db, tx: db as unknown as Prisma.TransactionClient };
}
describe("advice notification current receipts", () => {
  beforeEach(() => { vi.resetAllMocks(); captureProof.mockImplementation(async (_actor, _workspaceId, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }))); });
  it("captures exact current request and subject before copying content", async () => {
    const { request, subject, db, tx } = fixture();
    const result = await captureCurrentAdviceNotification(tx, event);
    expect(result).toMatchObject({ adviceRequestId: request.id, subjectId: subject.id, subjectType: "ACTION", subjectTitle: subject.title,
      messageMd: request.messageMd, deadlineAt: request.deadlineAt.toISOString(), requestedByUserId: request.requestedByUserId, authorUserId: null });
    expect(JSON.stringify(result)).not.toMatch(/Old restricted|old-user/);
    expect(captureProof).toHaveBeenCalledWith(expect.objectContaining({ workspaceIds: ["workspace-1"] }), "workspace-1", [
      { kind: "AdviceRequest", id: request.id, snapshot: request }, { kind: "Action", id: subject.id, snapshot: subject },
    ], tx);
    expect(db.$queryRaw).toHaveBeenCalledTimes(3);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.adviceRequest.findFirst.mock.invocationCallOrder[0]);
    expect(db.$queryRaw.mock.invocationCallOrder[2]).toBeLessThan(db.action.findFirst.mock.invocationCallOrder[0]);
    expect(db.action.findFirst.mock.invocationCallOrder[0]).toBeLessThan(captureProof.mock.invocationCallOrder[0]);
  });
  it("proves the actual reply and takes its current author instead of event fields", async () => {
    const { request, subject, entry, db, tx } = fixture();
    const result = await captureCurrentAdviceNotification(tx, { ...event, type: "advice.reply_posted", aggregateType: "DeliberationEntry", aggregateId: entry.id,
      payload: { adviceRequestId: request.id, authorUserId: "old-author" } });
    expect(result?.authorUserId).toBe(entry.authorUserId);
    expect(db.deliberationEntry.findFirst).toHaveBeenCalledWith({ where: { id: entry.id, workspaceId: "workspace-1", adviceRequestId: request.id, parentType: "ACTION", parentId: subject.id } });
    expect(result?.lineageRoots).toContainEqual({ kind: "DeliberationEntry", id: entry.id, fingerprint: "a".repeat(64) });
  });
  it("withholds canceled requests, missing linked replies, and unknown proof", async () => {
    const { request, db, tx } = fixture();
    db.adviceRequest.findFirst.mockResolvedValueOnce({ ...request, status: "CANCELED" });
    expect(await captureCurrentAdviceNotification(tx, event)).toBeNull();
    db.deliberationEntry.findFirst.mockResolvedValueOnce(null);
    expect(await captureCurrentAdviceNotification(tx, { ...event, type: "advice.reply_posted", aggregateType: "DeliberationEntry", aggregateId: "entry-1", payload: { adviceRequestId: request.id } })).toBeNull();
    captureProof.mockRejectedValueOnce(Object.assign(new Error("Unproved"), { code: "UNKNOWN_LINEAGE" }));
    expect(await captureCurrentAdviceNotification(tx, event)).toBeNull();
    captureProof.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(captureCurrentAdviceNotification(tx, event)).rejects.toThrow("Database unavailable");
  });
});
