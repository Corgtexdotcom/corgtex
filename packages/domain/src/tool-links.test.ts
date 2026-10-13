import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, encryptSecretMock, decryptSecretMock } = vi.hoisted(() => ({
  encryptSecretMock: vi.fn((value: string) => `enc:${value}`),
  decryptSecretMock: vi.fn((value: string) => value.replace(/^enc:/, "")),
  prismaMock: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
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
const captureArtifactInputProof = vi.fn();
const captureArtifactInputSnapshotProof = vi.fn();
const isArtifactInputProofReadable = vi.fn();
const prepareProducerLineage = vi.fn();
const finishProducerLineage = vi.fn();
const currentArtifactInputRoots = vi.fn();

vi.mock("./source-lineage", async importOriginal => ({
  sealArtifactInputActor: (await importOriginal<typeof import("./source-lineage")>()).sealArtifactInputActor,
  captureArtifactInputProof, captureArtifactInputSnapshotProof, isArtifactInputProofReadable, currentArtifactInputRoots,
  lineageContentFingerprint: vi.fn(() => "a".repeat(64)),
}));
vi.mock("./finance", () => ({ getFinanceAccessPolicy: async () => ({ canRead: false }) }));
vi.mock("./producer-lineage", () => ({ prepareProducerLineage, finishProducerLineage }));

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
    archivedByUserId: null,
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
        id: "tag-1", toolLinkId: "tool-1", circleId: "circle-1", createdAt: new Date("2026-04-29T12:00:00.000Z"),
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
    vi.resetAllMocks();
    prismaMock.$queryRaw.mockResolvedValue([]);
    encryptSecretMock.mockImplementation((value: string) => `enc:${value}`);
    decryptSecretMock.mockImplementation((value: string) => value.replace(/^enc:/, ""));
    captureArtifactInputProof.mockImplementation(async (_actor, _ws, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
    isArtifactInputProofReadable.mockResolvedValue(true);
    captureArtifactInputSnapshotProof.mockResolvedValue([]);
    currentArtifactInputRoots.mockResolvedValue([]);
    prepareProducerLineage.mockResolvedValue({ mode: "HUMAN_ORIGINAL", inputs: [], roots: [] });
    finishProducerLineage.mockResolvedValue(undefined);
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
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue(toolLinkFixture());
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
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue(toolLinkFixture());

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
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue(toolLinkFixture());
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
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue(toolLinkFixture());

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
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue(toolLinkFixture());

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
    prismaMock.workspaceToolLink.findFirst.mockResolvedValue(toolLinkFixture());
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
      _tx: prismaMock,
    });
  });

  it("filters unknown rows before ordering and replenishes across stable batches", async () => {
    const hidden = Array.from({ length: 100 }, (_, index) => toolLinkFixture({ id: `hidden-${index}`, title: "Restricted title", category: "AAA" }));
    prismaMock.workspaceToolLink.findMany.mockResolvedValueOnce(hidden).mockResolvedValueOnce([toolLinkFixture()]);
    captureArtifactInputProof.mockImplementation(async (_actor, _ws, inputs) => {
      if (inputs.some((input: { id: string }) => input.id.startsWith("hidden-"))) {
        const { AppError } = await import("./errors");
        throw new AppError(409, "UNKNOWN_LINEAGE", "Unknown source.");
      }
      return inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }));
    });
    const { listWorkspaceToolLinks } = await import("./tool-links");
    const result = await listWorkspaceToolLinks(actor, { workspaceId: "workspace-1" });
    expect(result.map((row) => row.id)).toEqual(["tool-1"]);
    expect(JSON.stringify(result)).not.toContain("Restricted title");
    expect(prismaMock.workspaceToolLink.findMany.mock.calls[1][0]).toMatchObject({
      where: { id: { gt: "hidden-99" } }, orderBy: { id: "asc" }, take: 100,
    });
  });

  it("withholds unknown creator and circle labels before names and counts are serialized", async () => {
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([toolLinkFixture()]);
    captureArtifactInputProof.mockImplementation(async (_actor, _ws, inputs) => {
      if (inputs.some((input: { kind: string }) => ["User", "Circle"].includes(input.kind))) {
        const { AppError } = await import("./errors");
        throw new AppError(409, "UNKNOWN_LINEAGE", "Unknown label source.");
      }
      return inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }));
    });
    const { listWorkspaceToolLinks } = await import("./tool-links");
    const result = await listWorkspaceToolLinks(actor, { workspaceId: "workspace-1" });
    expect(result[0]).toMatchObject({ createdBy: null, circles: [] });
    expect(JSON.stringify(result)).not.toContain("user@example.com");
    expect(JSON.stringify(result)).not.toContain("Ops");
  });

  it("rechecks actor, workspace, exact payload and source grants on opaque result reuse", async () => {
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([toolLinkFixture()]);
    const { listWorkspaceToolLinks, getWorkspaceToolLinkInputRoots } = await import("./tool-links");
    const result = await listWorkspaceToolLinks(actor, { workspaceId: "workspace-1" });
    await expect(getWorkspaceToolLinkInputRoots(actor, "workspace-1", result)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "WorkspaceToolLink", id: "tool-1" }),
      expect.objectContaining({ kind: "User", id: "user-1" }),
      expect.objectContaining({ kind: "Circle", id: "circle-1" }),
    ]));
    await expect(getWorkspaceToolLinkInputRoots({ ...actor, user: { ...actor.user, id: "user-2" } }, "workspace-1", result)).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(getWorkspaceToolLinkInputRoots(actor, "workspace-2", result)).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(getWorkspaceToolLinkInputRoots(actor, "workspace-1", [...result])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    isArtifactInputProofReadable.mockResolvedValue(false);
    await expect(getWorkspaceToolLinkInputRoots(actor, "workspace-1", result)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    isArtifactInputProofReadable.mockResolvedValue(true);
    result[0]!.title = "Changed after capture";
    await expect(getWorkspaceToolLinkInputRoots(actor, "workspace-1", result)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("binds an authorized empty list to current workspace and membership proof", async () => {
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([]);
    const { listWorkspaceToolLinks, getWorkspaceToolLinkInputRoots } = await import("./tool-links");
    const result = await listWorkspaceToolLinks(actor, { workspaceId: "workspace-1" });
    expect(result).toEqual([]);
    await expect(getWorkspaceToolLinkInputRoots(actor, "workspace-1", result)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "Member", id: "member-1" }),
    ]));
  });

  it("commits newly authored content and its full producer receipt in the same transaction", async () => {
    prismaMock.workspaceToolLink.create.mockResolvedValue(toolLinkFixture());
    const roots = [{ kind: "ConversationPromptInput", id: "request-1", fingerprint: "a".repeat(64) }];
    prepareProducerLineage.mockResolvedValue({ mode: "DERIVED", inputs: [], roots });
    const { createWorkspaceToolLink } = await import("./tool-links");
    await createWorkspaceToolLink(actor, { workspaceId: "workspace-1", title: "Miro board", url: "https://miro.com", lineageRoots: roots as any });
    expect(prepareProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: prismaMock, capture: expect.objectContaining({ lineageRoots: roots }) }));
    expect(finishProducerLineage).toHaveBeenCalledWith(expect.objectContaining({
      tx: prismaMock, artifact: { kind: "WorkspaceToolLink", id: "tool-1" },
      content: expect.objectContaining({ credentialSecretEnc: "enc:board-pass", circleTags: expect.any(Array) }),
      receipt: { mode: "DERIVED", inputs: [], roots },
    }));
    expect(prismaMock.workspaceToolLink.create.mock.invocationCallOrder[0]).toBeLessThan(finishProducerLineage.mock.invocationCallOrder[0]!);
  });

  it("rejects model creation without full input proof before storing content", async () => {
    prepareProducerLineage.mockResolvedValue({ mode: "UNKNOWN" });
    const { createWorkspaceToolLink } = await import("./tool-links");
    await expect(createWorkspaceToolLink({ kind: "agent", authProvider: "bootstrap", label: "test", workspaceIds: ["workspace-1"] }, {
      workspaceId: "workspace-1", title: "Unproved model output", url: "https://example.com",
    })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.workspaceToolLink.create).not.toHaveBeenCalled();
  });

  it("captures the complete prior body before a partial update and keeps unknown body untouched", async () => {
    prismaMock.workspaceToolLink.update.mockResolvedValue(toolLinkFixture({ title: "Updated" }));
    const { updateWorkspaceToolLink } = await import("./tool-links");
    await updateWorkspaceToolLink(actor, { workspaceId: "workspace-1", toolLinkId: "tool-1", title: "Updated" });
    expect(prepareProducerLineage).toHaveBeenCalledWith(expect.objectContaining({
      artifact: { kind: "WorkspaceToolLink", id: "tool-1" },
      before: expect.objectContaining({ descriptionMd: "Planning board", credentialSecretEnc: "enc:board-pass", circleTags: expect.any(Array) }),
    }));
    prismaMock.workspaceToolLink.update.mockClear();
    prepareProducerLineage.mockResolvedValue({ mode: "UNKNOWN" });
    await expect(updateWorkspaceToolLink(actor, { workspaceId: "workspace-1", toolLinkId: "tool-1", title: "Cannot promote", circleIds: [] })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.workspaceToolLink.update).not.toHaveBeenCalled();
    expect(prismaMock.workspaceToolLinkCircleTag.deleteMany).not.toHaveBeenCalled();
  });

  it("preserves a known original revision before advancing a direct human edit", async () => {
    prepareProducerLineage.mockResolvedValue({ mode: "ADVANCE", before: toolLinkFixture(), allowSystemTransition: false });
    prismaMock.workspaceToolLink.update.mockResolvedValue(toolLinkFixture({ title: "Updated" }));
    const { updateWorkspaceToolLink } = await import("./tool-links");
    await updateWorkspaceToolLink(actor, { workspaceId: "workspace-1", toolLinkId: "tool-1", title: "Updated" });
    expect(captureArtifactInputSnapshotProof).toHaveBeenCalledWith(actor, "workspace-1", { kind: "WorkspaceToolLink", id: "tool-1", fingerprint: "a".repeat(64) }, prismaMock);
    expect(captureArtifactInputSnapshotProof.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.workspaceToolLink.update.mock.invocationCallOrder[0]!);
  });

  it("withholds reveal before decrypt when the exact credential or metadata proof is unknown", async () => {
    captureArtifactInputProof.mockImplementation(async (_actor, _ws, inputs) => {
      if (inputs.some((input: { kind: string }) => input.kind === "WorkspaceToolLinkCredential")) {
        const { AppError } = await import("./errors");
        throw new AppError(409, "UNKNOWN_LINEAGE", "Unproved credential version.");
      }
      return inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }));
    });
    const { revealWorkspaceToolLinkCredential } = await import("./tool-links");
    await expect(revealWorkspaceToolLinkCredential(actor, { workspaceId: "workspace-1", toolLinkId: "tool-1" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(decryptSecretMock).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("does not release a decrypted result if current access is revoked during decrypt", async () => {
    decryptSecretMock.mockImplementation(() => { isArtifactInputProofReadable.mockResolvedValue(false); return "synthetic-only"; });
    const { revealWorkspaceToolLinkCredential } = await import("./tool-links");
    await expect(revealWorkspaceToolLinkCredential(actor, { workspaceId: "workspace-1", toolLinkId: "tool-1" })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(decryptSecretMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain("synthetic-only");
  });

  it("checks native credential version for protected UI handoff without decrypting", async () => {
    const { getWorkspaceToolLinkCredentialAccess, getWorkspaceToolLinkInputRoots } = await import("./tool-links");
    const result = await getWorkspaceToolLinkCredentialAccess(actor, { workspaceId: "workspace-1", toolLinkId: "tool-1" });
    expect(result).toEqual({ credentialLabel: "Board password", hasCredential: true });
    expect(decryptSecretMock).not.toHaveBeenCalled();
    expect(captureArtifactInputProof).toHaveBeenCalledWith(actor, "workspace-1", [expect.objectContaining({ kind: "WorkspaceToolLinkCredential", snapshot: expect.objectContaining({ credentialSecretEnc: "enc:board-pass", updatedAt: expect.any(Date) }) })], prismaMock);
    await expect(getWorkspaceToolLinkInputRoots(actor, "workspace-1", result)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "WorkspaceToolLinkCredential" })]));
  });

  it("blocks archive before effect when target proof or actual model drivers are revoked", async () => {
    isArtifactInputProofReadable.mockResolvedValue(false);
    const { archiveWorkspaceToolLink } = await import("./tool-links");
    await expect(archiveWorkspaceToolLink(actor, { workspaceId: "workspace-1", toolLinkId: "tool-1", lineageRoots: [{ kind: "ConversationPromptInput", id: "request-1", fingerprint: "a".repeat(64) }] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(archiveWorkspaceArtifact).not.toHaveBeenCalled();
  });

});
