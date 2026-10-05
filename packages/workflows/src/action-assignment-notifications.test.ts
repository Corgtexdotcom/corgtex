import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createNotificationIntent } = vi.hoisted(() => ({ createNotificationIntent: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ createNotificationIntent }));

import { createActionAssignmentNotification } from "./action-assignment-notifications";

const event = {
  id: "event-1",
  type: "action.published",
  workspaceId: "workspace-1",
  aggregateType: "Action",
  aggregateId: "action-1",
  payload: { assigneeMemberId: "member-2" },
};

function transaction() {
  const lock = vi.fn().mockResolvedValue([]);
  const actionFindFirst = vi.fn().mockResolvedValue({ title: "Current public title" });
  const memberFindFirst = vi.fn().mockResolvedValue({ userId: "user-2" });
  const tx = {
    $queryRaw: lock,
    action: { findFirst: actionFindFirst },
    member: { findFirst: memberFindFirst },
  } as unknown as Prisma.TransactionClient;
  return { tx, lock, actionFindFirst, memberFindFirst };
}

describe("Action assignment notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotificationIntent.mockResolvedValue({ count: 1 });
  });

  it("targets the current public assignee and suppresses their generic publication notice", async () => {
    const { tx, lock, actionFindFirst, memberFindFirst } = transaction();

    expect(await createActionAssignmentNotification(tx, event, "publisher-1")).toBe("user-2");
    expect(lock).toHaveBeenCalledOnce();
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(actionFindFirst.mock.invocationCallOrder[0]);
    expect(actionFindFirst).toHaveBeenCalledWith({
      where: {
        id: "action-1", workspaceId: "workspace-1", assigneeMemberId: "member-2",
        isPrivate: false, status: { in: ["OPEN", "IN_PROGRESS"] },
        archivedAt: null, duplicateOfActionId: null,
      },
      select: { title: true },
    });
    expect(memberFindFirst).toHaveBeenCalledWith({
      where: { id: "member-2", workspaceId: "workspace-1", isActive: true },
      select: { userId: true },
    });
    expect(createNotificationIntent).toHaveBeenCalledWith(tx, {
      workspaceId: "workspace-1", type: "action.assigned", recipientUserIds: ["user-2"],
      actorUserId: "publisher-1", entityType: "Action", entityId: "action-1",
      title: "Assigned to you: Current public title",
      bodyMd: "You were assigned an action in this workspace.",
      priority: "HIGH", dedupeKey: "action-assigned:event-1",
    });
  });

  it("keeps the assignee eligible for a generic notice when assignment delivery is off", async () => {
    const { tx } = transaction();
    createNotificationIntent.mockResolvedValueOnce({ count: 0 });

    expect(await createActionAssignmentNotification(tx, event, "publisher-1")).toBeNull();
  });

  it("does not reveal drafts, archived Actions, stale assignments, or other workspaces", async () => {
    const { tx, actionFindFirst, memberFindFirst } = transaction();
    actionFindFirst.mockResolvedValue(null);

    expect(await createActionAssignmentNotification(tx, { ...event, type: "action.assigned" }, "publisher-1"))
      .toBeNull();
    expect(memberFindFirst).not.toHaveBeenCalled();
    expect(createNotificationIntent).not.toHaveBeenCalled();

    expect(await createActionAssignmentNotification(tx, { ...event, workspaceId: "workspace-2" }, "publisher-1"))
      .toBeNull();
    expect(actionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "workspace-2", assigneeMemberId: "member-2" }),
    }));
  });

  it("ignores replayed and malformed assignment events", async () => {
    const { tx, lock } = transaction();
    for (const candidate of [
      { ...event, payload: { ...event.payload, runtimeMeta: { replayOfEventId: "original" } } },
      { ...event, payload: {} },
      { ...event, aggregateType: "Tension" },
      { ...event, aggregateId: null },
    ]) {
      expect(await createActionAssignmentNotification(tx, candidate, "publisher-1")).toBeNull();
    }
    expect(lock).not.toHaveBeenCalled();
    expect(createNotificationIntent).not.toHaveBeenCalled();
  });
});
