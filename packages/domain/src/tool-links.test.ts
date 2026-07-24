import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, encryptSecretMock, decryptSecretMock } = vi.hoisted(() => ({
  encryptSecretMock: vi.fn((value: string) => `enc:${value}`),
  decryptSecretMock: vi.fn((value: string) => value.replace(/^enc:/, "")),
  prismaMock: {
    $transaction: vi.fn(),
    workspaceToolLink: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    workspaceToolLinkCircleTag: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    circle: {
      findMany: vi.fn(),
    },
  },
}));

const requireWorkspaceMembership = vi.fn();
const actorUserIdForWorkspace = vi.fn();
const recordAudit = vi.fn();
const archiveWorkspaceArtifact = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  encryptSecret: encryptSecretMock,
  decryptSecret: decryptSecretMock,
}));

vi.mock("./auth", () => ({
  actorUserIdForWorkspace,
  requireWorkspaceMembership,
}));

vi.mock("./audit-trail", () => ({
  recordAudit,
}));

vi.mock("./archive", () => ({
  archiveFilterWhere: vi.fn(() => ({ archivedAt: null })),
  archiveWorkspaceArtifact,
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

function toolLinkFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "tool-1",
    workspaceId: "workspace-1",
    createdByUserId: "user-1",
    title: "Miro board",
    url: "https://miro.com/app/board/example",
    category: "WHITEBOARD",
    descriptionMd: "Planning board",
    accessNotesMd: "Use the board password.",
    previewTitle: null,
    previewDescription: null,
    previewImageUrl: null,
    previewFaviconUrl: null,
    credentialLabel: "Board password",
    credentialSecretEnc: "enc:board-pass",
    archivedAt: null,
    archiveReason: null,
    createdAt: new Date("2026-04-29T12:00:00.000Z"),
    updatedAt: new Date("2026-04-29T12:10:00.000Z"),
    createdBy: {
      id: "user-1",
      email: "user@example.com",
      displayName: "User",
    },
    circleTags: [
      {
        circle: {
          id: "circle-1",
          name: "Ops",
          archivedAt: null,
        },
      },
    ],
    ...overrides,
  };
}

describe("workspace tool links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    actorUserIdForWorkspace.mockResolvedValue("user-1");
    recordAudit.mockResolvedValue(undefined);
    archiveWorkspaceArtifact.mockResolvedValue({ id: "tool-1" });
    prismaMock.circle.findMany.mockResolvedValue([{ id: "circle-1" }]);
  });

  it("creates encrypted shared credentials and returns only credential presence", async () => {
    prismaMock.workspaceToolLink.create.mockResolvedValue(toolLinkFixture());

    const { createWorkspaceToolLink } = await import("./tool-links");
    const result = await createWorkspaceToolLink(actor, {
      workspaceId: "workspace-1",
      title: "Miro board",
      url: "miro.com/app/board/example",
      category: "whiteboard",
      descriptionMd: "Planning board",
      accessNotesMd: "Use the board password.",
      credentialLabel: "Board password",
      credentialSecret: "board-pass",
      circleIds: ["circle-1"],
    });

    expect(encryptSecretMock).toHaveBeenCalledWith("board-pass");
    expect(prismaMock.workspaceToolLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        url: "https://miro.com/app/board/example",
        category: "WHITEBOARD",
        credentialSecretEnc: "enc:board-pass",
        circleTags: { create: [{ circleId: "circle-1" }] },
      }),
    }));
    expect(result).toMatchObject({
      id: "tool-1",
      hasCredential: true,
      circles: [{ id: "circle-1", name: "Ops" }],
    });
    expect(JSON.stringify(result)).not.toContain("board-pass");
    expect(recordAudit).toHaveBeenCalledWith(
      prismaMock,
      actor,
      expect.objectContaining({
        action: "tool_link.created",
        meta: expect.objectContaining({ hasCredential: true }),
      }),
    );
    expect(JSON.stringify(recordAudit.mock.calls[0])).not.toContain("board-pass");
  });

  it("reveals a credential to the creator and audits without the raw secret", async () => {
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue({
      id: "tool-1",
      title: "Miro board",
      createdByUserId: "user-1",
      credentialLabel: "Board password",
      credentialSecretEnc: "enc:board-pass",
    });

    const { revealWorkspaceToolLinkCredential } = await import("./tool-links");
    const result = await revealWorkspaceToolLinkCredential(actor, {
      workspaceId: "workspace-1",
      toolLinkId: "tool-1",
    });

    expect(decryptSecretMock).toHaveBeenCalledWith("enc:board-pass");
    expect(result).toEqual({
      credentialLabel: "Board password",
      credentialSecret: "board-pass",
    });
    expect(recordAudit).toHaveBeenCalledWith(
      prismaMock,
      actor,
      expect.objectContaining({
        action: "tool_link.credential_revealed",
        meta: expect.objectContaining({ hasCredential: true }),
      }),
    );
    expect(JSON.stringify(recordAudit.mock.calls[0])).not.toContain("board-pass");
  });

  it("allows active members to edit another member's tool-link metadata", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue({
      id: "tool-1",
      createdByUserId: "user-1",
    });
    prismaMock.workspaceToolLink.update.mockResolvedValue(toolLinkFixture({
      title: "Changed",
      descriptionMd: "Updated notes",
    }));

    const { updateWorkspaceToolLink } = await import("./tool-links");
    await expect(updateWorkspaceToolLink({
      kind: "user",
      user: {
        id: "user-2",
        email: "other@example.com",
        displayName: "Other",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      toolLinkId: "tool-1",
      title: "Changed",
      descriptionMd: " Updated notes ",
    })).resolves.toMatchObject({
      title: "Changed",
      descriptionMd: "Updated notes",
      canManage: true,
      canManageCredentials: false,
    });

    expect(prismaMock.workspaceToolLink.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "tool-1" },
      data: expect.objectContaining({
        title: "Changed",
        descriptionMd: "Updated notes",
      }),
    }));
  });

  it("blocks active non-managers from editing another member's credentials", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue({
      id: "tool-1",
      createdByUserId: "user-1",
    });

    const { updateWorkspaceToolLink } = await import("./tool-links");
    await expect(updateWorkspaceToolLink({
      kind: "user",
      user: {
        id: "user-2",
        email: "other@example.com",
        displayName: "Other",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      toolLinkId: "tool-1",
      credentialSecret: "new-secret",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    expect(prismaMock.workspaceToolLink.update).not.toHaveBeenCalled();
    expect(encryptSecretMock).not.toHaveBeenCalled();
  });

  it("blocks active non-managers from revealing another member's credential", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue({
      id: "tool-1",
      title: "Miro board",
      createdByUserId: "user-1",
      credentialLabel: "Board password",
      credentialSecretEnc: "enc:board-pass",
    });

    const { revealWorkspaceToolLinkCredential } = await import("./tool-links");
    await expect(revealWorkspaceToolLinkCredential({
      kind: "user",
      user: {
        id: "user-2",
        email: "other@example.com",
        displayName: "Other",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      toolLinkId: "tool-1",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    expect(decryptSecretMock).not.toHaveBeenCalled();
  });

  it("allows facilitators to retag and update an existing tool link", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      role: "FACILITATOR",
      isActive: true,
    });
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue({
      id: "tool-1",
      createdByUserId: "user-1",
    });
    prismaMock.workspaceToolLink.update.mockResolvedValue(toolLinkFixture({
      title: "Box files",
      category: "FILES",
      credentialSecretEnc: null,
    }));

    const { updateWorkspaceToolLink } = await import("./tool-links");
    await expect(updateWorkspaceToolLink({
      kind: "user",
      user: {
        id: "user-2",
        email: "facilitator@example.com",
        displayName: "Facilitator",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      toolLinkId: "tool-1",
      title: "Box files",
      category: "files",
      credentialSecret: null,
      circleIds: ["circle-1"],
    })).resolves.toMatchObject({
      title: "Box files",
      category: "FILES",
      hasCredential: false,
    });

    expect(prismaMock.workspaceToolLinkCircleTag.deleteMany).toHaveBeenCalledWith({ where: { toolLinkId: "tool-1" } });
    expect(prismaMock.workspaceToolLinkCircleTag.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [{ toolLinkId: "tool-1", circleId: "circle-1" }],
    }));
  });

  it("archives through the shared archive path", async () => {
    const { archiveWorkspaceToolLink } = await import("./tool-links");
    await expect(archiveWorkspaceToolLink(actor, {
      workspaceId: "workspace-1",
      toolLinkId: "tool-1",
      reason: "No longer used",
    })).resolves.toEqual({ id: "tool-1" });

    expect(archiveWorkspaceArtifact).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      entityType: "WorkspaceToolLink",
      entityId: "tool-1",
      reason: "No longer used",
    });
  });
});
