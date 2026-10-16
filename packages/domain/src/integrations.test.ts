import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const prismaMock: any = {
    oAuthConnection: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    workflowJob: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
  };
  prismaMock.$transaction = vi.fn(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock));
  return {
    prismaMock,
    requireWorkspaceMembershipMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
    encryptSecret: vi.fn((value: string) => `enc:${value}`),
    decryptSecret: vi.fn((value: string) => value.replace(/^enc:/, "")),
  };
});

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

describe("OAuth integration sync helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1" });
    prismaMock.oAuthConnection.updateMany.mockImplementation(async ({ where, data }: any) => {
      const current = await prismaMock.oAuthConnection.findUnique({ where: { id: where.id } });
      if (!current || current.status !== where.status) return { count: 0 };
      Object.assign(current, data);
      return { count: 1 };
    });
  });

  it("encrypts OAuth tokens when saving a workspace connection", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue(null);
    prismaMock.oAuthConnection.create.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      status: "ACTIVE",
    });
    prismaMock.workflowJob.create.mockResolvedValue({ id: "job-1" });
    const { saveOAuthConnectionAndEnqueueCalendarSync } = await import("./integrations");

    await saveOAuthConnectionAndEnqueueCalendarSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      provider: "GOOGLE",
      providerAccountId: "google-user-1",
      providerEmail: "user@example.test",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
      scopes: ["openid", "profile", "https://www.googleapis.com/auth/calendar.readonly"],
    });

    expect(prismaMock.oAuthConnection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        provider: "GOOGLE",
        accessToken: "enc:access-token",
        refreshToken: "enc:refresh-token",
        tokenStorageVersion: "aes-256-gcm",
        scopes: ["openid", "profile", "https://www.googleapis.com/auth/calendar.readonly"],
      }),
    });
    expect(prismaMock.workflowJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        type: "calendar.sync",
      }),
    }));
  });

  it("merges Drive-first Google scopes when Calendar is connected later", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      scopes: ["openid", "profile", "https://www.googleapis.com/auth/drive.file"],
      syncSettings: {
        calendar: { enabled: false, includeAllEvents: false },
        documents: { enabled: false, selectedDriveIds: [] },
        email: { enabled: false, filters: [] },
      },
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      status: "ACTIVE",
    });
    prismaMock.workflowJob.create.mockResolvedValue({ id: "job-1" });
    const { saveOAuthConnectionAndEnqueueCalendarSync } = await import("./integrations");

    await saveOAuthConnectionAndEnqueueCalendarSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      provider: "GOOGLE",
      providerAccountId: "google-user-1",
      providerEmail: "user@example.test",
      accessToken: "access-token",
      scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.readonly"],
      enableCalendarSync: true,
    });

    expect(prismaMock.oAuthConnection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: expect.objectContaining({
        scopes: [
          "openid",
          "profile",
          "https://www.googleapis.com/auth/drive.file",
          "email",
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
        syncSettings: expect.objectContaining({
          calendar: { enabled: true, includeAllEvents: false },
          documents: { enabled: false, selectedDriveIds: [] },
        }),
      }),
    });
    expect(prismaMock.workflowJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "calendar.sync" }),
    }));
  });

  it("resets hidden legacy all-events calendar sync when Calendar is connected", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      scopes: ["openid", "profile", "https://www.googleapis.com/auth/drive.file"],
      syncSettings: {
        calendar: { enabled: false, includeAllEvents: true },
        documents: { enabled: true, selectedDriveIds: ["doc-1"] },
        email: { enabled: false, filters: [] },
      },
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      status: "ACTIVE",
    });
    prismaMock.workflowJob.create.mockResolvedValue({ id: "job-1" });
    const { saveOAuthConnectionAndEnqueueCalendarSync } = await import("./integrations");

    await saveOAuthConnectionAndEnqueueCalendarSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      provider: "GOOGLE",
      providerAccountId: "google-user-1",
      providerEmail: "user@example.test",
      accessToken: "access-token",
      scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.readonly"],
      enableCalendarSync: true,
    });

    expect(prismaMock.oAuthConnection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: expect.objectContaining({
        syncSettings: expect.objectContaining({
          calendar: { enabled: true, includeAllEvents: false },
          documents: { enabled: true, selectedDriveIds: ["doc-1"] },
        }),
      }),
    });
    expect(prismaMock.workflowJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "calendar.sync" }),
    }));
  });

  it("merges Calendar-first Google scopes when Drive is connected later without queuing calendar sync", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.readonly"],
      syncSettings: {
        calendar: { enabled: true, includeAllEvents: false },
        documents: { enabled: false, selectedDriveIds: [] },
        email: { enabled: false, filters: [] },
      },
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      status: "ACTIVE",
    });
    const { saveOAuthConnectionAndEnqueueCalendarSync } = await import("./integrations");

    await saveOAuthConnectionAndEnqueueCalendarSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      provider: "GOOGLE",
      providerAccountId: "google-user-1",
      providerEmail: "user@example.test",
      accessToken: "access-token",
      scopes: ["openid", "profile", "https://www.googleapis.com/auth/drive.file"],
      createSyncSettings: {
        calendar: { enabled: false, includeAllEvents: false },
        documents: { enabled: false, selectedDriveIds: [] },
        email: { enabled: false, filters: [] },
      },
      enqueueCalendarSync: false,
    });

    expect(prismaMock.oAuthConnection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: expect.objectContaining({
        scopes: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/drive.file",
        ],
      }),
    });
    expect(prismaMock.workflowJob.create).not.toHaveBeenCalled();
  });

  it("opportunistically backfills plaintext OAuth tokens before sync use", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      status: "ACTIVE",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenStorageVersion: "plaintext",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({
      id: "conn-1",
      accessToken: "enc:access-token",
      refreshToken: "enc:refresh-token",
      tokenStorageVersion: "aes-256-gcm",
    });
    const { refreshOAuthTokenIfNeeded } = await import("./integrations");

    const encrypted = await refreshOAuthTokenIfNeeded("conn-1");
    expect(encrypted.accessToken).toBe("enc:access-token");

    expect(prismaMock.oAuthConnection.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "conn-1", status: "ACTIVE", accessToken: "access-token" }),
      data: {
        accessToken: "enc:access-token",
        refreshToken: "enc:refresh-token",
        tokenStorageVersion: "aes-256-gcm",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes Microsoft workspace tokens through the work-school organization endpoint", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "microsoft-client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "microsoft-client-secret");
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      provider: "MICROSOFT",
      status: "ACTIVE",
      accessToken: "enc:old-access-token",
      refreshToken: "enc:refresh-token",
      tokenStorageVersion: "aes-256-gcm",
      expiresAt: new Date(Date.now() - 1000),
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({
      id: "conn-1",
      accessToken: "enc:new-access-token",
      refreshToken: "enc:new-refresh-token",
      tokenStorageVersion: "aes-256-gcm",
      status: "ACTIVE",
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    }), { status: 200 }));
    const { refreshOAuthTokenIfNeeded } = await import("./integrations");

    await refreshOAuthTokenIfNeeded("conn-1");

    expect(fetch).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fetches selected Google Drive documents only for explicit IDs", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      status: "ACTIVE",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenStorageVersion: "plaintext",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "doc-1",
        name: "Launch notes",
        mimeType: "application/vnd.google-apps.document",
        webViewLink: "https://drive.test/doc-1",
        modifiedTime: "2026-05-24T12:00:00.000Z",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Launch content", { status: 200 }));
    const { fetchSelectedDocuments } = await import("./integrations");

    await expect(fetchSelectedDocuments("conn-1", ["doc-1"])).resolves.toEqual([
      expect.objectContaining({
        id: "doc-1",
        provider: "GOOGLE",
        name: "Launch notes",
        contentText: "Launch content",
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("lists Google Drive document candidates through a document-scoped connection", async () => {
    prismaMock.oAuthConnection.findFirst.mockResolvedValue({
      id: "conn-1",
      workspaceId: "ws-1",
      providerEmail: "user@example.test",
      providerAccountId: "google-user-1",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
      syncSettings: null,
      status: "ACTIVE",
    });
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      status: "ACTIVE",
      accessToken: "access-token",
      refreshToken: null,
      tokenStorageVersion: "plaintext",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      status: "ACTIVE",
      accessToken: "enc:access-token",
      refreshToken: null,
      tokenStorageVersion: "aes-256-gcm",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      files: [{
        id: "doc-1",
        name: "Launch notes",
        mimeType: "application/vnd.google-apps.document",
        webViewLink: "https://drive.test/doc-1",
        modifiedTime: "2026-05-24T12:00:00.000Z",
      }],
    }), { status: 200 }));
    const { listGoogleDriveDocuments } = await import("./integrations");

    await expect(listGoogleDriveDocuments({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      query: "Launch",
    })).resolves.toEqual({
      connection: expect.objectContaining({
        id: "conn-1",
        hasDocumentScope: true,
      }),
      documents: [expect.objectContaining({
        id: "doc-1",
        name: "Launch notes",
      })],
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://www.googleapis.com/drive/v3/files?"),
      expect.objectContaining({
        headers: { Authorization: "Bearer access-token" },
      }),
    );
  });

  it("selects Google Drive documents into sync settings and queues document sync", async () => {
    prismaMock.oAuthConnection.findFirst.mockResolvedValueOnce({
      id: "conn-1",
      workspaceId: "ws-1",
      providerEmail: "user@example.test",
      providerAccountId: "google-user-1",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
      syncSettings: { calendar: { enabled: true }, documents: { enabled: false, selectedDriveIds: [] } },
      status: "ACTIVE",
    }).mockResolvedValueOnce({
      id: "conn-1",
      provider: "GOOGLE",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
      status: "ACTIVE",
      syncSettings: { calendar: { enabled: true }, documents: { enabled: true, selectedDriveIds: ["doc-1"] } },
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({
      id: "conn-1",
      status: "ACTIVE",
    });
    prismaMock.workflowJob.upsert.mockImplementation(async (input: any) => ({ id: input.create.type, type: input.create.type }));
    const { selectGoogleDriveDocumentsForSync } = await import("./integrations");

    await expect(selectGoogleDriveDocumentsForSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      documentIds: ["doc-1", "doc-1", " "],
    })).resolves.toEqual({
      scheduled: ["oauth.documents.sync"],
    });
    expect(prismaMock.oAuthConnection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: expect.objectContaining({
        workspaceId: "ws-1",
        syncSettings: expect.objectContaining({
          documents: expect.objectContaining({
            enabled: true,
            selectedDriveIds: ["doc-1"],
          }),
        }),
      }),
    });
  });

  it("recovers Google Drive selection from a previous sync error", async () => {
    prismaMock.oAuthConnection.findFirst.mockResolvedValueOnce({
      id: "conn-1",
      workspaceId: "ws-1",
      providerEmail: "user@example.test",
      providerAccountId: "google-user-1",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
      syncSettings: { calendar: { enabled: true }, documents: { enabled: false, selectedDriveIds: [] } },
      status: "ERROR",
    }).mockResolvedValueOnce({
      id: "conn-1",
      provider: "GOOGLE",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
      status: "ACTIVE",
      syncSettings: { calendar: { enabled: true }, documents: { enabled: true, selectedDriveIds: ["doc-1"] } },
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({
      id: "conn-1",
      status: "ACTIVE",
    });
    prismaMock.workflowJob.upsert.mockImplementation(async (input: any) => ({ id: input.create.type, type: input.create.type }));
    const { selectGoogleDriveDocumentsForSync } = await import("./integrations");

    await expect(selectGoogleDriveDocumentsForSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      documentIds: ["doc-1"],
    })).resolves.toEqual({
      scheduled: ["oauth.documents.sync"],
    });
    expect(prismaMock.oAuthConnection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: expect.objectContaining({
        status: "ACTIVE",
        lastSyncError: null,
        syncSettings: expect.objectContaining({
          documents: expect.objectContaining({
            enabled: true,
            selectedDriveIds: ["doc-1"],
          }),
        }),
      }),
    });
  });

  it("continues to accept legacy Google Drive readonly connections for selected document sync", async () => {
    prismaMock.oAuthConnection.findFirst.mockResolvedValueOnce({
      id: "conn-1",
      workspaceId: "ws-1",
      providerEmail: "user@example.test",
      providerAccountId: "google-user-1",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      syncSettings: { documents: { enabled: false, selectedDriveIds: [] } },
      status: "ACTIVE",
    }).mockResolvedValueOnce({
      id: "conn-1",
      provider: "GOOGLE",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      status: "ACTIVE",
      syncSettings: { documents: { enabled: true, selectedDriveIds: ["doc-1"] } },
    });
    prismaMock.oAuthConnection.update.mockResolvedValue({
      id: "conn-1",
      status: "ACTIVE",
    });
    prismaMock.workflowJob.upsert.mockImplementation(async (input: any) => ({ id: input.create.type, type: input.create.type }));
    const { selectGoogleDriveDocumentsForSync } = await import("./integrations");

    await expect(selectGoogleDriveDocumentsForSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      documentIds: ["doc-1"],
    })).resolves.toEqual({
      scheduled: ["oauth.documents.sync"],
    });
  });

  it("skips selected Google Drive binary files until extraction is supported", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      status: "ACTIVE",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenStorageVersion: "plaintext",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: "pdf-1",
      name: "Binary brief.pdf",
      mimeType: "application/pdf",
      webViewLink: "https://drive.test/pdf-1",
      modifiedTime: "2026-05-24T12:00:00.000Z",
    }), { status: 200 }));
    const { fetchSelectedDocuments } = await import("./integrations");

    await expect(fetchSelectedDocuments("conn-1", ["pdf-1"])).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not fetch email when no filters are configured", async () => {
    const { fetchFilteredEmailMessages } = await import("./integrations");

    await expect(fetchFilteredEmailMessages("conn-1", [])).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches Microsoft Outlook messages through explicit filters", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      provider: "MICROSOFT",
      status: "ACTIVE",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenStorageVersion: "plaintext",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      value: [{
        id: "msg-1",
        subject: "Customer launch",
        from: { emailAddress: { address: "customer@example.test" } },
        receivedDateTime: "2026-05-24T12:00:00.000Z",
        webLink: "https://outlook.test/msg-1",
        bodyPreview: "Please connect the ERP export.",
      }],
    }), { status: 200 }));
    const { fetchFilteredEmailMessages } = await import("./integrations");

    await expect(fetchFilteredEmailMessages("conn-1", ["from:customer@example.test"])).resolves.toEqual([
      expect.objectContaining({
        id: "msg-1",
        provider: "MICROSOFT",
        subject: "Customer launch",
        snippet: "Please connect the ERP export.",
        filter: "from:customer@example.test",
      }),
    ]);
  });

  it("fetches Microsoft SharePoint documents through explicit drive item references", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      provider: "MICROSOFT",
      status: "ACTIVE",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenStorageVersion: "plaintext",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "item-1",
        name: "SharePoint rollout",
        file: { mimeType: "text/plain" },
        webUrl: "https://sharepoint.test/item-1",
        lastModifiedDateTime: "2026-05-24T12:00:00.000Z",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("SharePoint content", { status: 200 }));
    const { fetchSelectedDocuments } = await import("./integrations");

    await expect(fetchSelectedDocuments("conn-1", ["drive-1:item-1"])).resolves.toEqual([
      expect.objectContaining({
        id: "item-1",
        provider: "MICROSOFT",
        name: "SharePoint rollout",
        contentText: "SharePoint content",
      }),
    ]);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://graph.microsoft.com/v1.0/drives/drive-1/items/item-1",
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://graph.microsoft.com/v1.0/drives/drive-1/items/item-1/content",
      expect.any(Object),
    );
  });

  it("skips selected Microsoft binary files until extraction is supported", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      provider: "MICROSOFT",
      status: "ACTIVE",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenStorageVersion: "plaintext",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: "item-1",
      name: "Launch deck.pptx",
      file: { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
      webUrl: "https://sharepoint.test/item-1",
      lastModifiedDateTime: "2026-05-24T12:00:00.000Z",
    }), { status: 200 }));
    const { fetchSelectedDocuments } = await import("./integrations");

    await expect(fetchSelectedDocuments("conn-1", ["drive-1:item-1"])).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("enqueues only enabled manual sync kinds for a connection", async () => {
    prismaMock.oAuthConnection.findFirst.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/drive.file"],
      status: "ACTIVE",
      syncSettings: {
        calendar: { enabled: true },
        documents: { enabled: true, selectedDriveIds: ["doc-1"] },
        email: { enabled: false, filters: [] },
      },
    });
    prismaMock.workflowJob.upsert.mockImplementation(async (input: any) => ({ id: input.create.type, type: input.create.type }));
    const { enqueueOAuthConnectionSync } = await import("./integrations");

    await expect(enqueueOAuthConnectionSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      connectionId: "conn-1",
    })).resolves.toEqual({
      scheduled: ["calendar.sync", "oauth.documents.sync"],
    });
  });

  it("does not let manual sync bypass disabled sections", async () => {
    prismaMock.oAuthConnection.findFirst.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/drive.file"],
      status: "ACTIVE",
      syncSettings: {
        calendar: { enabled: false },
        documents: { enabled: false, selectedDriveIds: ["doc-1"] },
        email: { enabled: false, filters: ["from:customer@example.test"] },
      },
    });
    const { enqueueOAuthConnectionSync } = await import("./integrations");

    await expect(enqueueOAuthConnectionSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      connectionId: "conn-1",
      kinds: ["calendar", "documents", "email"],
    })).resolves.toEqual({ scheduled: [] });
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it("does not let manual sync bypass missing Google scopes", async () => {
    prismaMock.oAuthConnection.findFirst.mockResolvedValue({
      id: "conn-1",
      provider: "GOOGLE",
      scopes: ["openid", "profile", "https://www.googleapis.com/auth/drive.file"],
      status: "ACTIVE",
      syncSettings: {
        calendar: { enabled: true },
        documents: { enabled: true, selectedDriveIds: ["doc-1"] },
      },
    });
    prismaMock.workflowJob.upsert.mockImplementation(async (input: any) => ({ id: input.create.type, type: input.create.type }));
    const { enqueueOAuthConnectionSync } = await import("./integrations");

    await expect(enqueueOAuthConnectionSync({
      kind: "user",
      user: { id: "user-1", email: "user@example.test" },
    } as any, {
      workspaceId: "ws-1",
      connectionId: "conn-1",
      kinds: ["calendar", "documents"],
    })).resolves.toEqual({
      scheduled: ["oauth.documents.sync"],
    });
  });
});

describe("read-only calendar availability", () => {
  const actor = { kind: "user", user: { id: "user-1", email: "user@example.test", displayName: null } } as const;
  const email = "user@example.test";
  const timeMin = "2026-10-14T09:00:00.000Z", timeMax = "2026-10-14T17:00:00.000Z";
  const params = (provider: "GOOGLE" | "MICROSOFT" = "GOOGLE") => ({ workspaceId: "ws-1", provider, emails: [email], timeMin, timeMax });
  let rows: any[];
  let encrypt: (value: string) => string;
  let decrypt: (value: string) => string;
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]) =>
    value === undefined || (value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value));
  const fixture = (provider: "GOOGLE" | "MICROSOFT" = "GOOGLE", overrides: Record<string, unknown> = {}) => ({
    id: `conn-${provider}`, userId: actor.user.id, workspaceId: "ws-1", provider, status: "ACTIVE",
    scopes: [provider === "GOOGLE" ? "https://www.googleapis.com/auth/calendar.readonly" : "Calendars.Read"],
    accessToken: encrypt("synthetic-access"), refreshToken: encrypt("synthetic-refresh"),
    tokenStorageVersion: "aes-256-gcm", expiresAt: new Date(Date.now() + 3600_000),
    updatedAt: new Date("2026-10-14T08:00:00Z"), syncSettings: { calendar: { enabled: true } }, ...overrides,
  });
  const providerReply = (provider: "GOOGLE" | "MICROSOFT", emails = [email]) => provider === "GOOGLE"
    ? { calendars: Object.fromEntries(emails.map(id => [id, { busy: [{ start: timeMin, end: timeMax }] }])) }
    : { value: emails.map(scheduleId => ({ scheduleId, scheduleItems: [{ status: "busy",
      start: { dateTime: timeMin, timeZone: "UTC" }, end: { dateTime: timeMax, timeZone: "UTC" },
      subject: "synthetic-access", location: "synthetic-refresh" }] })) };
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

  beforeEach(async () => {
    vi.resetModules(); vi.resetAllMocks();
    vi.stubEnv("ENCRYPTION_KEY", "11".repeat(32));
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "synthetic-client"); vi.stubEnv("MICROSOFT_CLIENT_SECRET", "synthetic-secret");
    vi.stubGlobal("fetch", vi.fn());
    const shared = await import("@corgtex/shared"), crypto = await import("../../shared/src/crypto");
    encrypt = crypto.encryptSecret; decrypt = crypto.decryptSecret;
    vi.mocked(shared.encryptSecret).mockImplementation(encrypt);
    vi.mocked(shared.decryptSecret).mockImplementation(decrypt);
    rows = [fixture()];
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", isActive: true });
    prismaMock.oAuthConnection.findMany.mockImplementation(async ({ where, take }: any) => structuredClone(rows.filter(row => matches(row, where)).slice(0, take)));
    prismaMock.oAuthConnection.findUnique.mockImplementation(async ({ where }: any) => structuredClone(rows.find(row => row.id === where.id) ?? null));
    prismaMock.oAuthConnection.updateMany.mockImplementation(async ({ where, data }: any) => {
      const found = rows.filter(row => matches(row, where));
      for (const row of found) Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
      return { count: found.length };
    });
  });

  afterEach(async () => {
    const shared = await import("@corgtex/shared");
    vi.mocked(shared.encryptSecret).mockImplementation(value => `enc:${value}`);
    vi.mocked(shared.decryptSecret).mockImplementation(value => value.replace(/^enc:/, ""));
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  });

  it.each(["GOOGLE", "MICROSOFT"] as const)("uses decrypted %s tokens for encrypted, refreshed and legacy rows", async provider => {
    const { getCalendarAvailability, refreshOAuthTokenIfNeeded } = await import("./integrations");
    for (const mode of ["encrypted", "refreshed", "legacy"] as const) {
      rows = [fixture(provider, mode === "legacy" ? {
        accessToken: "synthetic-access", refreshToken: "synthetic-refresh", tokenStorageVersion: "plaintext",
      } : mode === "refreshed" ? { expiresAt: new Date(0) } : {})];
      vi.mocked(fetch).mockReset();
      if (mode === "refreshed") vi.mocked(fetch).mockResolvedValueOnce(json({
        access_token: "synthetic-refreshed-access", refresh_token: "synthetic-refreshed-refresh", expires_in: 3600,
      }));
      vi.mocked(fetch).mockResolvedValueOnce(json(providerReply(provider)));
      const result = await getCalendarAvailability(actor, params(provider));
      expect(result).toMatchObject({ provider });
      const token = mode === "refreshed" ? "synthetic-refreshed-access" : "synthetic-access";
      const calls = vi.mocked(fetch).mock.calls;
      expect(calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      expect(calls.at(-1)?.[0]).toBe(provider === "GOOGLE"
        ? "https://www.googleapis.com/calendar/v3/freeBusy" : "https://graph.microsoft.com/v1.0/me/calendar/getSchedule");
      expect(calls).toHaveLength(mode === "refreshed" ? 2 : 1);
      if (mode === "refreshed") {
        expect(calls[0][1]?.body?.toString()).toContain("refresh_token=synthetic-refresh");
        expect(calls[0][1]?.body?.toString()).not.toContain("aes-256-gcm");
      }
      expect(rows[0].accessToken).toMatch(/^aes-256-gcm:/);
      expect(rows[0].refreshToken).toMatch(/^aes-256-gcm:/);
      expect(decrypt(rows[0].accessToken)).toBe(token);
      expect(decrypt(rows[0].refreshToken)).toBe(mode === "refreshed" ? "synthetic-refreshed-refresh" : "synthetic-refresh");
      expect(rows[0].tokenStorageVersion).toBe("aes-256-gcm");
      const returnedRow = await refreshOAuthTokenIfNeeded(rows[0].id);
      expect(returnedRow.accessToken).toBe(rows[0].accessToken);
      expect(JSON.stringify(result)).not.toMatch(/synthetic-(access|refresh)|aes-256-gcm|accessToken|refreshToken|subject|location/);
    }
  });

  it.each([
    { userId: "foreign-user" }, { workspaceId: "foreign-workspace" }, { workspaceId: null },
    { provider: "MICROSOFT" }, { status: "PAUSED" }, { status: "ERROR" }, { status: "DISCONNECTED" },
    { scopes: [] }, { scopes: ["https://www.googleapis.com/auth/drive.file"] },
    { syncSettings: { calendar: { enabled: false } } },
  ])("performs zero HTTP and zero token writes for ineligible %j", async overrides => {
    rows = [fixture("GOOGLE", { ...overrides, expiresAt: new Date(0) })];
    const { getCalendarAvailability } = await import("./integrations");
    expect(await getCalendarAvailability(actor, params())).toHaveProperty("error");
    expect(fetch).not.toHaveBeenCalled();
    expect(prismaMock.oAuthConnection.updateMany).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "google", "BOX"])("requires explicit provider %j before lookup/HTTP", async provider => {
    rows.push(fixture("MICROSOFT"));
    const { getCalendarAvailability } = await import("./integrations");
    expect(await getCalendarAvailability(actor, { ...params(), provider } as any)).toHaveProperty("error");
    expect(prismaMock.oAuthConnection.findMany).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("selects the explicit provider when both providers exist and rejects duplicate candidates", async () => {
    rows.push(fixture("MICROSOFT"));
    vi.mocked(fetch).mockResolvedValueOnce(json(providerReply("MICROSOFT")));
    const { getCalendarAvailability } = await import("./integrations");
    expect(await getCalendarAvailability(actor, params("MICROSOFT"))).toMatchObject({ provider: "MICROSOFT" });
    expect(prismaMock.oAuthConnection.findMany).toHaveBeenCalledWith({
      where: { userId: actor.user.id, workspaceId: "ws-1", provider: "MICROSOFT", status: "ACTIVE" }, take: 2,
    });
    rows.push(fixture("GOOGLE", { id: "duplicate" }));
    vi.mocked(fetch).mockClear();
    expect(await getCalendarAvailability(actor, params())).toHaveProperty("error"); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["bootstrap", "credential", "control-plane"])("denies %s actors before connection access", async authProvider => {
    const { getCalendarAvailability } = await import("./integrations");
    expect(await getCalendarAvailability({ kind: "agent", authProvider, label: "synthetic" } as any, params())).toHaveProperty("error");
    expect(requireWorkspaceMembershipMock).not.toHaveBeenCalled();
    expect(prismaMock.oAuthConnection.findMany).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("requires current active membership both before selection and after refresh", async () => {
    const { getCalendarAvailability } = await import("./integrations");
    requireWorkspaceMembershipMock.mockRejectedValueOnce(new Error("not an active member"));
    expect(await getCalendarAvailability(actor, params())).toHaveProperty("error");
    expect(prismaMock.oAuthConnection.findMany).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    requireWorkspaceMembershipMock.mockResolvedValueOnce({ isActive: true }).mockRejectedValueOnce(new Error("membership revoked"));
    expect(await getCalendarAvailability(actor, params())).toHaveProperty("error"); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: "PAUSED" }, { status: "DISCONNECTED" }, { workspaceId: "foreign-workspace" },
    { userId: "foreign-user" }, { provider: "MICROSOFT" }, { scopes: [] },
    { syncSettings: { calendar: { enabled: false } } },
  ])("revalidates the helper reread before refresh for %j", async change => {
    rows[0].expiresAt = new Date(0);
    const original = prismaMock.oAuthConnection.findMany.getMockImplementation();
    prismaMock.oAuthConnection.findMany.mockImplementation(async (query: any) => {
      const selected = await original(query); Object.assign(rows[0], change); return selected;
    });
    const { getCalendarAvailability } = await import("./integrations");
    expect(await getCalendarAvailability(actor, params())).toHaveProperty("error"); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["PAUSED", "DISCONNECTED"])("cannot revive %s during successful or failed refresh", async status => {
    const { getCalendarAvailability } = await import("./integrations");
    for (const success of [true, false]) {
      rows = [fixture("GOOGLE", { expiresAt: new Date(0) })];
      vi.mocked(fetch).mockReset().mockImplementationOnce(async () => {
        rows[0].status = status; rows[0].updatedAt = new Date();
        return success ? json({ access_token: "synthetic-refreshed-access", expires_in: 3600 }) : new Response("synthetic-access", { status: 401 });
      });
      expect(await getCalendarAvailability(actor, params())).toHaveProperty("error");
      expect(rows[0].status).toBe(status); expect(decrypt(rows[0].accessToken)).toBe("synthetic-access");
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it.each(["PAUSED", "ERROR", "DISCONNECTED"])("guards direct refresh of inactive %s rows, including legacy tokens", async status => {
    rows = [fixture("GOOGLE", { status, expiresAt: new Date(0), tokenStorageVersion: "plaintext", accessToken: "synthetic-access" })];
    const { refreshOAuthTokenIfNeeded } = await import("./integrations");
    await expect(refreshOAuthTokenIfNeeded(rows[0].id)).rejects.toMatchObject({ code: "CALENDAR_CONNECTION_UNAVAILABLE" });
    expect(prismaMock.oAuthConnection.updateMany).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("guards legacy backfill and the refreshed-row reread against pause", async () => {
    const { getCalendarAvailability } = await import("./integrations");
    const write = prismaMock.oAuthConnection.updateMany.getMockImplementation();
    rows = [fixture("GOOGLE", { tokenStorageVersion: "plaintext", accessToken: "synthetic-access", expiresAt: new Date(0) })];
    prismaMock.oAuthConnection.updateMany.mockImplementationOnce(async (query: any) => {
      rows[0].status = "PAUSED"; return write(query);
    });
    expect(await getCalendarAvailability(actor, params())).toHaveProperty("error");
    expect(rows[0].accessToken).toBe("synthetic-access"); expect(fetch).not.toHaveBeenCalled();
    rows = [fixture("MICROSOFT", { expiresAt: new Date(0) })];
    vi.mocked(fetch).mockResolvedValueOnce(json({ access_token: "synthetic-refreshed-access", expires_in: 3600 }));
    prismaMock.oAuthConnection.updateMany.mockImplementationOnce(async (query: any) => {
      const written = await write(query); rows[0].status = "PAUSED"; return written;
    });
    expect(await getCalendarAvailability(actor, params("MICROSOFT"))).toHaveProperty("error");
    expect(rows[0].status).toBe("PAUSED"); expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects pause/restore and token replacement while refresh is in flight", async () => {
    rows[0].expiresAt = new Date(0);
    const initial = rows[0].accessToken;
    vi.mocked(fetch).mockImplementationOnce(async () => {
      rows[0].status = "ACTIVE"; rows[0].updatedAt = new Date(); rows[0].accessToken = encrypt("replacement");
      return json({ access_token: "synthetic-refreshed-access", expires_in: 3600 });
    });
    const { getCalendarAvailability } = await import("./integrations");
    expect(await getCalendarAvailability(actor, params())).toHaveProperty("error");
    expect(rows[0].accessToken).not.toBe(initial); expect(decrypt(rows[0].accessToken)).toBe("replacement");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("checks connection eligibility immediately before the availability request", async () => {
    requireWorkspaceMembershipMock.mockImplementationOnce(async () => ({ isActive: true })).mockImplementationOnce(async () => {
      rows[0].status = "PAUSED"; return { isActive: true };
    });
    const { getCalendarAvailability } = await import("./integrations");
    expect(await getCalendarAvailability(actor, params())).toHaveProperty("error"); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["GOOGLE", "MICROSOFT"] as const)("never reports partial %s failures or missing schedules as free time", async provider => {
    rows = [fixture(provider)];
    const other = "other@example.test", request = { ...params(provider), emails: [email, other] };
    const { getCalendarAvailability } = await import("./integrations");
    for (const missing of [false, true]) {
      const value = providerReply(provider, [email]) as any;
      if (!missing) {
        if (provider === "GOOGLE") value.calendars[other] = { errors: [{ reason: "synthetic-access" }] };
        else value.value.push({ scheduleId: other, error: { message: "synthetic-access" }, scheduleItems: [] });
      }
      vi.mocked(fetch).mockResolvedValueOnce(json(value));
      const result = await getCalendarAvailability(actor, request);
      expect(result).toHaveProperty("error"); expect(result).not.toHaveProperty("calendars"); expect(result).not.toHaveProperty("schedules");
      expect(JSON.stringify(result)).not.toContain("synthetic-access");
    }
  });

  it.each(["http", "throw", "refresh", "decrypt", "malformed"])("controls %s failure without token leakage or event creation", async failure => {
    const errorLog = vi.spyOn(console, "error"), warnLog = vi.spyOn(console, "warn");
    const secret = rows[0].accessToken;
    if (failure === "refresh") rows[0].expiresAt = new Date(0);
    if (failure === "decrypt") rows[0].accessToken = "aes-256-gcm:broken";
    if (failure === "throw") vi.mocked(fetch).mockRejectedValueOnce(new Error(`synthetic-access ${secret}`));
    else if (failure === "malformed") vi.mocked(fetch).mockResolvedValueOnce(json({ calendars: { [email]: { busy: [{ start: "synthetic-access", end: timeMax }] } } }));
    else vi.mocked(fetch).mockResolvedValueOnce(new Response(`synthetic-access ${secret}`, { status: 401 }));
    const { getCalendarAvailability } = await import("./integrations");
    const result = await getCalendarAvailability(actor, params());
    expect(result).toHaveProperty("error"); expect(JSON.stringify(result)).not.toMatch(/synthetic-access|aes-256-gcm/);
    expect(errorLog).not.toHaveBeenCalled(); expect(warnLog).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes("/events"))).toBe(true);
  });
});
