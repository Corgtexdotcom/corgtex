import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, tx, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const txMock = {
    member: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    proposal: {
      findUnique: vi.fn(),
    },
    tension: {
      findUnique: vi.fn(),
    },
    action: {
      findUnique: vi.fn(),
    },
    circle: {
      findUnique: vi.fn(),
    },
    adviceProcess: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    adviceRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    adviceRequestRecipient: {
      createMany: vi.fn(),
    },
    workflowJob: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      create: vi.fn(),
      createMany: vi.fn(),
    },
  };

  return {
    tx: txMock,
    prismaMock: {
      ...txMock,
      $transaction: vi.fn(async (callback: (transaction: typeof txMock) => Promise<unknown>) => callback(txMock)),
    },
    requireWorkspaceMembershipMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-owner",
    email: "owner@example.com",
    displayName: "Owner",
    globalRole: "USER",
  },
};

describe("advice requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00.000Z"));

    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-owner",
      workspaceId: "workspace-1",
      userId: "user-owner",
      role: "CONTRIBUTOR",
      isActive: true,
    });

    tx.member.findUnique.mockImplementation(async ({ where }: any) => {
      const key = where.workspaceId_userId;
      if (key?.workspaceId === "workspace-1" && key.userId === "user-owner") {
        return { id: "member-owner", userId: "user-owner", role: "CONTRIBUTOR", isActive: true };
      }
      return null;
    });
    tx.member.findMany.mockResolvedValue([{ id: "member-a" }, { id: "member-b" }]);
    tx.tension.findUnique.mockResolvedValue({
      id: "tension-1",
      workspaceId: "workspace-1",
      title: "Clarify launch owner",
      status: "OPEN",
      circleId: "circle-1",
      authorUserId: "user-owner",
      assigneeMemberId: null,
      raisedByMemberId: "member-owner",
      archivedAt: null,
      isPrivate: false,
    });
    tx.adviceProcess.findFirst.mockResolvedValue(null);
    tx.adviceProcess.create.mockResolvedValue({
      id: "process-1",
      workspaceId: "workspace-1",
      subjectType: "TENSION",
      subjectId: "tension-1",
      status: "GATHERING",
    });
    tx.adviceRequest.create.mockResolvedValue({
      id: "request-1",
      workspaceId: "workspace-1",
      processId: "process-1",
      status: "ACTIVE",
    });
    tx.adviceRequestRecipient.createMany.mockResolvedValue({ count: 2 });
    tx.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    tx.event.createMany.mockResolvedValue({ count: 1 });
    tx.event.create.mockResolvedValue({ id: "event-1" });
    tx.auditLog.create.mockResolvedValue({});
  });

  it("creates a member-targeted request for an open tension and schedules a reminder", async () => {
    const { createAdviceRequest } = await import("./advice-requests");

    await createAdviceRequest(actor, {
      workspaceId: "workspace-1",
      subjectType: "TENSION",
      subjectId: "tension-1",
      audienceType: "MEMBERS",
      memberIds: ["member-a", "member-a", "member-b"],
      messageMd: "Please confirm who owns the launch decision.",
      deadlineAt: new Date("2026-06-26T12:00:00.000Z"),
      reminderAt: new Date("2026-06-25T12:00:00.000Z"),
      preferredChannel: "IN_APP",
    });

    expect(tx.adviceProcess.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        proposalId: null,
        authorMemberId: "member-owner",
        ownerMemberId: "member-owner",
        subjectType: "TENSION",
        subjectId: "tension-1",
      }),
    });
    expect(tx.adviceRequestRecipient.createMany).toHaveBeenCalledWith({
      data: [
        { requestId: "request-1", memberId: "member-a" },
        { requestId: "request-1", memberId: "member-b" },
      ],
      skipDuplicates: true,
    });
    expect(tx.workflowJob.upsert).toHaveBeenCalledWith({
      where: { dedupeKey: "advice.request.reminder:request-1:2026-06-25T12:00:00.000Z" },
      update: {},
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        type: "advice.request.reminder",
        payload: { adviceRequestId: "request-1" },
        runAfter: new Date("2026-06-25T12:00:00.000Z"),
      }),
    });
    expect(tx.event.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        workspaceId: "workspace-1",
        type: "advice.requested",
        aggregateType: "AdviceRequest",
        aggregateId: "request-1",
        payload: expect.objectContaining({
          adviceRequestId: "request-1",
          subjectType: "TENSION",
          subjectId: "tension-1",
          recipientMemberIds: ["member-a", "member-b"],
        }),
      })],
    });
  });

  it("rejects selected-person requests without recipients", async () => {
    const { createAdviceRequest } = await import("./advice-requests");

    await expect(createAdviceRequest(actor, {
      workspaceId: "workspace-1",
      subjectType: "TENSION",
      subjectId: "tension-1",
      audienceType: "MEMBERS",
      memberIds: [],
      messageMd: "Please confirm who owns the launch decision.",
      preferredChannel: "IN_APP",
    })).rejects.toThrow(/Choose at least one person/);

    expect(tx.adviceProcess.create).not.toHaveBeenCalled();
    expect(tx.adviceRequest.create).not.toHaveBeenCalled();
    expect(tx.adviceRequestRecipient.createMany).not.toHaveBeenCalled();
  });

  it("uses the proposal owner as the advice subject owner", async () => {
    const { createAdviceRequest } = await import("./advice-requests");

    tx.proposal.findUnique.mockResolvedValueOnce({
      id: "proposal-1",
      workspaceId: "workspace-1",
      title: "Clarify launch owner",
      status: "OPEN",
      circleId: "circle-1",
      authorUserId: "user-author",
      ownerMemberId: "member-owner",
      archivedAt: null,
    });

    await createAdviceRequest(actor, {
      workspaceId: "workspace-1",
      subjectType: "PROPOSAL",
      subjectId: "proposal-1",
      audienceType: "WORKSPACE",
      messageMd: "Please advise.",
    });

    expect(tx.adviceProcess.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        proposalId: "proposal-1",
        authorMemberId: "member-owner",
        ownerMemberId: "member-owner",
        subjectType: "PROPOSAL",
        subjectId: "proposal-1",
      }),
    });
  });

  it("rejects input requests for draft tensions", async () => {
    tx.tension.findUnique.mockResolvedValueOnce({
      id: "tension-1",
      workspaceId: "workspace-1",
      title: "Draft tension",
      status: "DRAFT",
      circleId: null,
      authorUserId: "user-owner",
      assigneeMemberId: null,
      raisedByMemberId: "member-owner",
      archivedAt: null,
      isPrivate: false,
    });

    const { createAdviceRequest } = await import("./advice-requests");
    await expect(createAdviceRequest(actor, {
      workspaceId: "workspace-1",
      subjectType: "TENSION",
      subjectId: "tension-1",
      audienceType: "WORKSPACE",
      messageMd: "Please advise.",
    })).rejects.toThrow(/open tensions/);
  });

  it("creates input requests for open public actions", async () => {
    tx.action.findUnique.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "workspace-1",
      title: "Collect evidence",
      status: "OPEN",
      circleId: "circle-1",
      authorUserId: "user-author",
      assigneeMemberId: "member-owner",
      archivedAt: null,
      isPrivate: false,
    });

    const { createAdviceRequest } = await import("./advice-requests");
    await createAdviceRequest(actor, {
      workspaceId: "workspace-1",
      subjectType: "ACTION",
      subjectId: "action-1",
      audienceType: "WORKSPACE",
      messageMd: "Please confirm the evidence owner.",
      preferredChannel: "IN_APP",
    });

    expect(tx.adviceProcess.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        proposalId: null,
        authorMemberId: "member-owner",
        ownerMemberId: "member-owner",
        subjectType: "ACTION",
        subjectId: "action-1",
      }),
    });
    expect(tx.event.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        workspaceId: "workspace-1",
        type: "advice.requested",
        aggregateType: "AdviceRequest",
        aggregateId: "request-1",
        payload: expect.objectContaining({
          adviceRequestId: "request-1",
          subjectType: "ACTION",
          subjectId: "action-1",
          subjectTitle: "Collect evidence",
        }),
      })],
    });
  });

  it("rejects input requests for private actions", async () => {
    tx.action.findUnique.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "workspace-1",
      title: "Private action",
      status: "OPEN",
      circleId: "circle-1",
      authorUserId: "user-owner",
      assigneeMemberId: "member-owner",
      archivedAt: null,
      isPrivate: true,
    });

    const { createAdviceRequest } = await import("./advice-requests");
    await expect(createAdviceRequest(actor, {
      workspaceId: "workspace-1",
      subjectType: "ACTION",
      subjectId: "action-1",
      audienceType: "WORKSPACE",
      messageMd: "Please advise.",
    })).rejects.toThrow(/private actions/);
  });

  it("resolves circle recipients dynamically and excludes the requester", async () => {
    tx.adviceRequest.findUnique.mockResolvedValueOnce({
      id: "request-1",
      workspaceId: "workspace-1",
      audienceType: "CIRCLE",
      targetCircleId: "circle-1",
      recipients: [],
    });
    tx.member.findMany.mockResolvedValueOnce([
      { id: "member-owner", userId: "user-owner" },
      { id: "member-a", userId: "user-a" },
      { id: "member-b", userId: "user-b" },
    ]);

    const { resolveAdviceRequestRecipientUsers } = await import("./advice-requests");
    await expect(resolveAdviceRequestRecipientUsers(tx as any, {
      workspaceId: "workspace-1",
      adviceRequestId: "request-1",
      excludeUserIds: ["user-owner"],
    })).resolves.toEqual([
      { memberId: "member-a", userId: "user-a" },
      { memberId: "member-b", userId: "user-b" },
    ]);
    expect(tx.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        roleAssignments: expect.objectContaining({
          some: expect.objectContaining({
            role: expect.objectContaining({ circleId: "circle-1" }),
          }),
        }),
      }),
    }));
  });

  it("emits a reminder event when a scheduled request is due", async () => {
    tx.adviceRequest.findUnique.mockResolvedValueOnce({
      id: "request-1",
      workspaceId: "workspace-1",
      processId: "process-1",
      requestedByUserId: "user-owner",
      audienceType: "WORKSPACE",
      targetCircleId: null,
      messageMd: "Please advise.",
      deadlineAt: new Date("2026-06-26T12:00:00.000Z"),
      reminderAt: new Date("2026-06-23T11:59:00.000Z"),
      preferredChannel: "IN_APP",
      status: "ACTIVE",
      process: {
        subjectType: "TENSION",
        subjectId: "tension-1",
      },
    });

    const { runAdviceRequestReminderJob } = await import("./advice-requests");
    await expect(runAdviceRequestReminderJob({
      workspaceId: "workspace-1",
      adviceRequestId: "request-1",
    })).resolves.toEqual({ skipped: false });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        type: "advice.reminder_due",
        aggregateType: "AdviceRequest",
        aggregateId: "request-1",
      }),
    });
  });
});
