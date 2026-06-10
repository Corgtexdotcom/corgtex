import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, syncContextGraphForMeetingMock, upsertContextGraphObjectMock, upsertContextGraphRelationshipMock } = vi.hoisted(() => ({
  prismaMock: {
    action: { findFirst: vi.fn() },
    brainArticle: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    goal: { findFirst: vi.fn() },
    agentIdentity: { findFirst: vi.fn() },
    contextGraphRelationship: { findMany: vi.fn() },
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

  it("maps active members to person objects with role and circle relationships", async () => {
    const { handleContextGraphSync } = await import("./context-graph-sync");
    prismaMock.member.findFirst.mockResolvedValueOnce({
      id: "member-1",
      workspaceId: "ws-1",
      role: "CONTRIBUTOR",
      isActive: true,
      joinedAt: new Date("2026-01-10T10:00:00.000Z"),
      user: { displayName: "Ana Novak", email: "ana@example.com" },
      roleAssignments: [
        {
          role: {
            id: "role-1",
            name: "Onboarding lead",
            purposeMd: "Own onboarding outcomes.",
            archivedAt: null,
            circle: { id: "circle-1", name: "Customer Success", purposeMd: "Own onboarding", archivedAt: null },
          },
        },
      ],
    });
    upsertContextGraphObjectMock
      .mockResolvedValueOnce({ id: "person-1" })
      .mockResolvedValueOnce({ id: "role-object-1" })
      .mockResolvedValueOnce({ id: "circle-object-1" });
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([
      { sourceObjectId: "person-1", targetObjectId: "stale-role-object", relationshipType: "assigned_to" },
    ]);

    await handleContextGraphSync("job-1", { sourceType: "MEMBER", sourceId: "member-1" }, "ws-1");

    expect(upsertContextGraphObjectMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      objectType: "Person",
      title: "Ana Novak",
      status: "approved",
      sourceEntityType: "Member",
      sourceEntityId: "member-1",
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceObjectId: "person-1",
      targetObjectId: "role-object-1",
      relationshipType: "assigned_to",
      status: "approved",
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceObjectId: "person-1",
      targetObjectId: "circle-object-1",
      relationshipType: "member_of",
      status: "approved",
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceObjectId: "person-1",
      targetObjectId: "stale-role-object",
      relationshipType: "assigned_to",
      status: "archived",
    }));
  });

  it("archives person objects and their edges when a member is deactivated", async () => {
    const { handleContextGraphSync } = await import("./context-graph-sync");
    prismaMock.member.findFirst.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "ws-1",
      role: "CONTRIBUTOR",
      isActive: false,
      joinedAt: new Date("2026-01-10T10:00:00.000Z"),
      user: { displayName: null, email: "left@example.com" },
      roleAssignments: [
        {
          role: {
            id: "role-1",
            name: "Onboarding lead",
            purposeMd: null,
            archivedAt: null,
            circle: { id: "circle-1", name: "Customer Success", purposeMd: null, archivedAt: null },
          },
        },
      ],
    });
    upsertContextGraphObjectMock.mockResolvedValueOnce({ id: "person-2" });
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([
      { sourceObjectId: "person-2", targetObjectId: "circle-object-1", relationshipType: "member_of" },
    ]);

    await handleContextGraphSync("job-1", { sourceType: "MEMBER", sourceId: "member-2" }, "ws-1");

    expect(upsertContextGraphObjectMock).toHaveBeenCalledTimes(1);
    expect(upsertContextGraphObjectMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      objectType: "Person",
      title: "left@example.com",
      status: "archived",
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledTimes(1);
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetObjectId: "circle-object-1",
      relationshipType: "member_of",
      status: "archived",
    }));
  });

  it("maps goals to goal objects with parent, circle, and owner relationships", async () => {
    const { handleContextGraphSync } = await import("./context-graph-sync");
    prismaMock.goal.findFirst.mockResolvedValueOnce({
      id: "goal-1",
      workspaceId: "ws-1",
      title: "Reach 100 active workspaces",
      descriptionMd: "Quarterly growth goal.",
      status: "ON_TRACK",
      level: "CIRCLE",
      cadence: "QUARTERLY",
      progressPercent: 40,
      archivedAt: null,
      startDate: new Date("2026-04-01T00:00:00.000Z"),
      targetDate: new Date("2026-06-30T00:00:00.000Z"),
      createdAt: new Date("2026-03-20T10:00:00.000Z"),
      updatedAt: new Date("2026-06-01T10:00:00.000Z"),
      parentGoal: {
        id: "goal-parent",
        title: "2035 vision",
        descriptionMd: "Long horizon target.",
        status: "ACTIVE",
        archivedAt: null,
      },
      circle: { id: "circle-1", name: "Growth", purposeMd: "Grow usage", archivedAt: null },
      ownerMember: {
        id: "member-1",
        role: "CONTRIBUTOR",
        isActive: true,
        user: { displayName: "Ana Novak", email: "ana@example.com" },
      },
    });
    upsertContextGraphObjectMock
      .mockResolvedValueOnce({ id: "goal-object-1" })
      .mockResolvedValueOnce({ id: "goal-parent-object" })
      .mockResolvedValueOnce({ id: "circle-object-1" })
      .mockResolvedValueOnce({ id: "person-1" });
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([]);

    await handleContextGraphSync("job-1", { sourceType: "GOAL", sourceId: "goal-1" }, "ws-1");

    expect(upsertContextGraphObjectMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      objectType: "Goal",
      title: "Reach 100 active workspaces",
      status: "approved",
      sourceEntityType: "Goal",
      sourceEntityId: "goal-1",
      properties: expect.objectContaining({
        level: "CIRCLE",
        cadence: "QUARTERLY",
        progressPercent: 40,
      }),
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceObjectId: "goal-object-1",
      targetObjectId: "goal-parent-object",
      relationshipType: "part_of",
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceObjectId: "circle-object-1",
      targetObjectId: "goal-object-1",
      relationshipType: "owns",
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceObjectId: "person-1",
      targetObjectId: "goal-object-1",
      relationshipType: "owns",
    }));
  });

  it("maps agent identities to agent objects with circle and role relationships", async () => {
    const { handleContextGraphSync } = await import("./context-graph-sync");
    prismaMock.agentIdentity.findFirst.mockResolvedValueOnce({
      id: "agent-1",
      workspaceId: "ws-1",
      agentKey: "meeting-summary",
      memberType: "INTERNAL",
      displayName: "Meeting summary agent",
      purposeMd: "Summarize meetings.",
      isActive: true,
      archivedAt: null,
      createdAt: new Date("2026-02-01T10:00:00.000Z"),
      updatedAt: new Date("2026-06-01T10:00:00.000Z"),
      circleAssignments: [
        {
          circle: { id: "circle-1", name: "Operations", purposeMd: "Run the company", archivedAt: null },
          role: { id: "role-1", name: "Scribe", purposeMd: "Record decisions", archivedAt: null },
        },
      ],
    });
    upsertContextGraphObjectMock
      .mockResolvedValueOnce({ id: "agent-object-1" })
      .mockResolvedValueOnce({ id: "circle-object-1" })
      .mockResolvedValueOnce({ id: "role-object-1" });
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([]);

    await handleContextGraphSync("job-1", { sourceType: "AGENT_IDENTITY", sourceId: "agent-1" }, "ws-1");

    expect(upsertContextGraphObjectMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      objectType: "Agent",
      title: "Meeting summary agent",
      status: "approved",
      sourceEntityType: "AgentIdentity",
      sourceEntityId: "agent-1",
      properties: expect.objectContaining({ agentKey: "meeting-summary", memberType: "INTERNAL" }),
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceObjectId: "agent-object-1",
      targetObjectId: "circle-object-1",
      relationshipType: "member_of",
      status: "approved",
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceObjectId: "agent-object-1",
      targetObjectId: "role-object-1",
      relationshipType: "assigned_to",
      status: "approved",
    }));
  });

  it("archives agent objects and stale edges when an agent identity is deactivated", async () => {
    const { handleContextGraphSync } = await import("./context-graph-sync");
    prismaMock.agentIdentity.findFirst.mockResolvedValueOnce({
      id: "agent-2",
      workspaceId: "ws-1",
      agentKey: "ext_abc",
      memberType: "EXTERNAL",
      displayName: "External research agent",
      purposeMd: null,
      isActive: false,
      archivedAt: new Date("2026-06-05T10:00:00.000Z"),
      createdAt: new Date("2026-02-01T10:00:00.000Z"),
      updatedAt: new Date("2026-06-05T10:00:00.000Z"),
      circleAssignments: [
        {
          circle: { id: "circle-1", name: "Operations", purposeMd: null, archivedAt: null },
          role: null,
        },
      ],
    });
    upsertContextGraphObjectMock.mockResolvedValueOnce({ id: "agent-object-2" });
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([
      { sourceObjectId: "agent-object-2", targetObjectId: "circle-object-1", relationshipType: "member_of" },
    ]);

    await handleContextGraphSync("job-1", { sourceType: "AGENT_IDENTITY", sourceId: "agent-2" }, "ws-1");

    expect(upsertContextGraphObjectMock).toHaveBeenCalledTimes(1);
    expect(upsertContextGraphObjectMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      objectType: "Agent",
      status: "archived",
    }));
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledTimes(1);
    expect(upsertContextGraphRelationshipMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetObjectId: "circle-object-1",
      relationshipType: "member_of",
      status: "archived",
    }));
  });

  it("marks draft goals as proposed graph facts", async () => {
    const { handleContextGraphSync } = await import("./context-graph-sync");
    prismaMock.goal.findFirst.mockResolvedValueOnce({
      id: "goal-2",
      workspaceId: "ws-1",
      title: "Draft idea",
      descriptionMd: null,
      status: "DRAFT",
      level: "COMPANY",
      cadence: "ANNUAL",
      progressPercent: 0,
      archivedAt: null,
      startDate: null,
      targetDate: null,
      createdAt: new Date("2026-06-01T10:00:00.000Z"),
      updatedAt: new Date("2026-06-01T10:00:00.000Z"),
      parentGoal: null,
      circle: null,
      ownerMember: null,
    });
    upsertContextGraphObjectMock.mockResolvedValueOnce({ id: "goal-object-2" });
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([]);

    await handleContextGraphSync("job-1", { sourceType: "GOAL", sourceId: "goal-2" }, "ws-1");

    expect(upsertContextGraphObjectMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      objectType: "Goal",
      status: "proposed",
    }));
    expect(upsertContextGraphRelationshipMock).not.toHaveBeenCalled();
  });
});
