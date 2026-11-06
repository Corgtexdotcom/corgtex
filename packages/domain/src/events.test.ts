import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createActionEvent } from "@corgtex/shared/work-item-events";
import { appendEvents } from "./events";

describe("versioned action persistence", () => {
  it("uses the supplied transaction and retains unmigrated events in the same batch", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = { event: { createMany } } as unknown as Prisma.TransactionClient;
    const ordinary = createActionEvent("action.updated", { actionId: "a1", fields: ["title"], evidenceDocumentIds: ["d1"] }, "ws1");
    const publication = { workspaceId: "ws1", type: "action.published", aggregateType: "Action", aggregateId: "a1", payload: { actionId: "a1", actorUserId: "u1", assigneeMemberId: null } };
    await appendEvents(tx, [ordinary, publication]);
    expect(createMany).toHaveBeenCalledExactlyOnceWith({ data: [ordinary, publication] });
  });
  it("propagates transaction failures without opening another persistence path", async () => {
    const failure = new Error("Synthetic transaction failure");
    const createMany = vi.fn().mockRejectedValue(failure);
    const tx = { event: { createMany } } as unknown as Prisma.TransactionClient;
    await expect(appendEvents(tx, [createActionEvent("action.created", { actionId: "a1", title: "Synthetic" }, "ws1")])).rejects.toBe(failure);
    expect(createMany).toHaveBeenCalledOnce();
    await appendEvents(tx, []);
    expect(createMany).toHaveBeenCalledOnce();
  });
});
