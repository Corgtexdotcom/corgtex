import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const prismaMock: any = {
    oAuthConnection: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
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

    await refreshOAuthTokenIfNeeded("conn-1");

    expect(prismaMock.oAuthConnection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
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
