import type { AppActor } from "@corgtex/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, requireMembership } = vi.hoisted(() => ({
  findMany: vi.fn(),
  requireMembership: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({ prisma: { meeting: { findMany } } }));
vi.mock("@corgtex/domain", () => ({ requireWorkspaceMembership: requireMembership }));

import { listLinkableBrainSearchMeetingRefs } from "./search-meeting-refs";

const actor = { kind: "user", user: { id: "user-1" } } as AppActor;

beforeEach(() => {
  vi.resetAllMocks();
  requireMembership.mockResolvedValue({ id: "member-1", workspaceId: "workspace-1" });
});

describe("Brain search meeting source validation", () => {
  it("does not query meetings for other source types", async () => {
    const refs = await listLinkableBrainSearchMeetingRefs({
      actor, workspaceId: "workspace-1",
      results: [{ sourceType: "BRAIN_ARTICLE", sourceId: "article-1" }],
    });

    expect(refs).toEqual([]);
    expect(requireMembership).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns only active meetings from the current workspace", async () => {
    const rows = [
      { id: "meeting-1", workspaceId: "workspace-1", archivedAt: null },
      { id: "meeting-2", workspaceId: "workspace-1", archivedAt: new Date() },
      { id: "meeting-3", workspaceId: "workspace-2", archivedAt: null },
    ];
    findMany.mockImplementation(async ({ where }: {
      where: { id: { in: string[] }; workspaceId: string; archivedAt: null };
    }) => rows.filter((row) => where.id.in.includes(row.id)
      && row.workspaceId === where.workspaceId && row.archivedAt === where.archivedAt)
      .map((row) => ({ id: row.id })));

    const refs = await listLinkableBrainSearchMeetingRefs({
      actor, workspaceId: "workspace-1",
      results: ["meeting-1", "meeting-2", "meeting-3", "calendar-event-1", "meeting-1"]
        .map((sourceId) => ({ sourceType: "MEETING", sourceId })),
    });

    expect(requireMembership).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["meeting-1", "meeting-2", "meeting-3", "calendar-event-1"] },
        workspaceId: "workspace-1", archivedAt: null,
      },
      select: { id: true },
    });
    expect(refs).toEqual([{ id: "meeting-1" }]);
  });

  it("does not query source rows after a denied membership check", async () => {
    requireMembership.mockRejectedValueOnce(new Error("Forbidden"));

    await expect(listLinkableBrainSearchMeetingRefs({
      actor, workspaceId: "workspace-1",
      results: [{ sourceType: "MEETING", sourceId: "meeting-1" }],
    })).rejects.toThrow("Forbidden");
    expect(findMany).not.toHaveBeenCalled();
  });
});
