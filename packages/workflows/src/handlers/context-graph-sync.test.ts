import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, syncContextGraphForMeetingMock, upsertContextGraphObjectMock, upsertContextGraphRelationshipMock } = vi.hoisted(() => ({
  prismaMock: {
    action: { findFirst: vi.fn() },
    brainArticle: { findFirst: vi.fn() },
  },
  syncContextGraphForMeetingMock: vi.fn(),
  upsertContextGraphObjectMock: vi.fn(),
  upsertContextGraphRelationshipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@corgtex/domain", () => ({
  contextGraphSystemActor: vi.fn(() => ({ kind: "agent", authProvider: "control-plane", label: "context-graph-sync" })),
  syncContextGraphForMeeting: syncContextGraphForMeetingMock,
  attachContextGraphEvidence: vi.fn(),
  upsertContextGraphObject: upsertContextGraphObjectMock,
  upsertContextGraphRelationship: upsertContextGraphRelationshipMock,
}));

describe("handleContextGraphSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates meeting sync to the domain meeting graph sync", async () => {
    const { handleContextGraphSync } = await import("./context-graph-sync");

    await handleContextGraphSync("job-1", { sourceType: "MEETING", sourceId: "meeting-1" }, "ws-1");

    expect(syncContextGraphForMeetingMock).toHaveBeenCalledWith(expect.objectContaining({ label: "context-graph-sync" }), {
      workspaceId: "ws-1",
      meetingId: "meeting-1",
    });
  });

  it("maps actions to task objects and circle relationships", async () => {
    const { handleContextGraphSync } = await import("./context-graph-sync");
    prismaMock.action.findFirst.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "ws-1",
      title: "Draft onboarding checklist",
      bodyMd: "Make the handoff explicit.",
      status: "OPEN",
      dueAt: null,
      createdAt: new Date("2026-05-20T10:00:00.000Z"),
      updatedAt: new Date("2026-05-21T10:00:00.000Z"),
      assigneeMember: { user: { displayName: "Alex", email: "alex@example.com" } },
      circle: { id: "circle-1", name: "Customer Success", purposeMd: "Own onboarding" },
    });
    upsertContextGraphObjectMock
      .mockResolvedValueOnce({ id: "task-1" })
      .mockResolvedValueOnce({ id: "circle-object-1" });

    await handleContextGraphSync("job-1", { sourceType: "ACTION", sourceId: "action-1" }, "ws-1");

    expect(upsertContextGraphObjectMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: "ws-1",
      objectType: "Task",
      title: "Draft onboarding checklist",
      sourceEntityType: "Action",
      sourceEntityId: "action-1",
      status: "approved",
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceObjectId: "task-1",
      targetObjectId: "circle-object-1",
      relationshipType: "part_of",
    }));
  });

  it("maps Brain process articles to process graph objects", async () => {
    const { handleContextGraphSync } = await import("./context-graph-sync");
    prismaMock.brainArticle.findFirst.mockResolvedValueOnce({
      id: "article-1",
      workspaceId: "ws-1",
      slug: "customer-onboarding",
      title: "Customer onboarding",
      type: "PROCESS",
      authority: "AUTHORITATIVE",
      bodyMd: "Approved onboarding process.",
      publishedAt: new Date("2026-05-20T10:00:00.000Z"),
      createdAt: new Date("2026-05-19T10:00:00.000Z"),
      lastVerifiedAt: new Date("2026-05-21T10:00:00.000Z"),
    });
    upsertContextGraphObjectMock.mockResolvedValueOnce({ id: "process-1" });

    await handleContextGraphSync("job-1", { sourceType: "BRAIN_ARTICLE", sourceId: "article-1" }, "ws-1");

    expect(upsertContextGraphObjectMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      objectType: "Process",
      title: "Customer onboarding",
      sourceEntityType: "BrainArticle",
      sourceEntityId: "article-1",
    }));
  });
});
