import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    meeting: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

describe("meetings domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
  });

  it("listMeetings returns meetings newest first", async () => {
    prismaMock.meeting.findMany.mockResolvedValue([{ id: "meeting-1" }]);

    const { listMeetings } = await import("./meetings");
    await expect(listMeetings("workspace-1")).resolves.toEqual([{ id: "meeting-1" }]);
    expect(prismaMock.meeting.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      orderBy: { recordedAt: "desc" },
    });
  });

  it("getMeeting returns a meeting with related records", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({ id: "meeting-1" });

    const { getMeeting } = await import("./meetings");
    await expect(getMeeting("workspace-1", "meeting-1")).resolves.toEqual({ id: "meeting-1" });
  });

  it("getMeeting returns null when not found", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue(null);

    const { getMeeting } = await import("./meetings");
    await expect(getMeeting("workspace-1", "missing-meeting")).resolves.toBeNull();
  });

  it("createMeeting creates a meeting and event", async () => {
    const recordedAt = new Date("2026-04-24T12:00:00.000Z");
    prismaMock.meeting.create.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly",
      source: "zoom",
      recordedAt,
    });

    const { createMeeting } = await import("./meetings");
    await expect(createMeeting(actor, {
      workspaceId: "workspace-1",
      title: " Weekly ",
      source: " zoom ",
      recordedAt,
      participantIds: [" user-1 ", ""],
    })).resolves.toMatchObject({ id: "meeting-1" });

    expect(prismaMock.meeting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        title: "Weekly",
        source: "zoom",
        recordedAt,
        participantIds: ["user-1"],
      }),
    });
  });

  it("createMeeting rejects a missing source", async () => {
    const { createMeeting } = await import("./meetings");
    await expect(createMeeting(actor, {
      workspaceId: "workspace-1",
      source: " ",
      recordedAt: new Date("2026-04-24T12:00:00.000Z"),
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("deleteMeeting deletes an existing meeting", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly",
      source: "zoom",
    });
    prismaMock.meeting.delete.mockResolvedValue({ id: "meeting-1" });

    const { deleteMeeting } = await import("./meetings");
    await expect(deleteMeeting(actor, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
    })).resolves.toEqual({ id: "meeting-1" });
  });
});
