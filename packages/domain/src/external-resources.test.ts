import type { AppActor } from "@corgtex/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  recordAuditMock,
  requireWorkspaceMembershipMock,
  txMock,
} = vi.hoisted(() => {
  const tx = {
    action: { findFirst: vi.fn() },
    brainSource: { findFirst: vi.fn() },
    knowledgeChunk: { deleteMany: vi.fn() },
    meeting: { findFirst: vi.fn() },
    proposal: { findFirst: vi.fn() },
    tension: { findFirst: vi.fn() },
    workflowJob: { upsert: vi.fn() },
    workspaceExternalResource: {
      update: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceExternalResourceAttachment: {
      createMany: vi.fn(),
    },
    workspaceExternalResourceMention: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
  };

  return {
    prismaMock: {
      $transaction: vi.fn(),
      communicationChannel: { findMany: vi.fn(), findUnique: vi.fn() },
      communicationExternalUser: { findMany: vi.fn() },
      communicationMessage: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      knowledgeChunk: { deleteMany: vi.fn() },
      workflowJob: { upsert: vi.fn() },
      workspaceExternalResource: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      workspaceExternalResourceAttachment: {
        findMany: vi.fn(),
      },
    },
    recordAuditMock: vi.fn(),
    requireWorkspaceMembershipMock: vi.fn(),
    txMock: tx,
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./audit-trail", () => ({
  recordAudit: recordAuditMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
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

function resourceFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "resource-1",
    workspaceId: "ws-1",
    createdByUserId: "user-1",
    providerKey: "box",
    externalId: "url:box-hash",
    resourceType: "link",
    category: "FILES",
    priority: 100,
    title: "Budget model",
    url: "https://app.box.com/s/budget",
    sharedLinkUrl: "https://app.box.com/s/budget",
    mimeType: null,
    descriptionMd: "Client budget model",
    summaryMd: null,
    metadata: {
      canonicalUrl: "https://app.box.com/s/budget",
      host: "app.box.com",
      providerKey: "box",
    },
    lastEnrichedAt: new Date("2026-06-28T17:00:00.000Z"),
    lastEnrichmentError: null,
    archivedAt: null,
    archiveReason: null,
    createdAt: new Date("2026-06-28T17:00:00.000Z"),
    updatedAt: new Date("2026-06-28T17:00:00.000Z"),
    ...overrides,
  };
}

function slackMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    workspaceId: "ws-1",
    provider: "SLACK",
    installationId: "install-1",
    externalChannelId: "C1",
    externalMessageId: "1714320000.000100",
    externalUserId: "U1",
    threadExternalId: null,
    text: "Use <https://app.box.com/s/budget?utm_source=slack|Budget model> and https://example.com/reference.",
    textRedactedAt: null,
    messageTs: new Date("2026-06-28T17:00:00.000Z"),
    permalink: "https://slack.test/archives/C1/p1714320000000100",
    raw: {},
    isBot: false,
    isHidden: false,
    isDeleted: false,
    receivedAt: new Date("2026-06-28T17:00:01.000Z"),
    createdAt: new Date("2026-06-28T17:00:01.000Z"),
    updatedAt: new Date("2026-06-28T17:00:01.000Z"),
    installation: { id: "install-1", externalTeamName: "Client Workspace" },
    ...overrides,
  };
}

describe("workspace external resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    txMock.action.findFirst.mockResolvedValue({ id: "action-1" });
    txMock.workspaceExternalResource.upsert.mockResolvedValue(resourceFixture());
    txMock.workspaceExternalResourceAttachment.createMany.mockResolvedValue({ count: 1 });
    txMock.workspaceExternalResourceMention.findMany.mockResolvedValue([]);
    txMock.workspaceExternalResourceMention.updateMany.mockResolvedValue({ count: 0 });
    txMock.workspaceExternalResourceMention.upsert.mockResolvedValue({ id: "mention-1" });
    txMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    prismaMock.communicationExternalUser.findMany.mockResolvedValue([]);
    prismaMock.communicationChannel.findMany.mockResolvedValue([]);
    recordAuditMock.mockResolvedValue({ id: "audit-1" });
  });

  it("classifies Box as a high-priority file reference and generic URLs as normal links", async () => {
    const { classifyExternalResourceUrl } = await import("./external-resources");

    expect(classifyExternalResourceUrl("https://app.box.com/s/budget?utm_source=slack", "Budget model")).toEqual(expect.objectContaining({
      providerKey: "box",
      category: "FILES",
      priority: 100,
      title: "Budget model",
      url: "https://app.box.com/s/budget",
    }));
    expect(classifyExternalResourceUrl("https://app.box.com/s/ik1wlmvcd2v7mn82qiqgk5aeurl8qg5m")).toEqual(expect.objectContaining({
      providerKey: "box",
      category: "FILES",
      priority: 100,
      title: "Box link",
      url: "https://app.box.com/s/ik1wlmvcd2v7mn82qiqgk5aeurl8qg5m",
    }));
    expect(classifyExternalResourceUrl("https://example.com/report")).toEqual(expect.objectContaining({
      providerKey: "generic_url",
      category: "LINK",
      priority: 0,
    }));
  });

  it("extracts Slack markup and bare URLs without duplicates", async () => {
    const { extractExternalResourceReferencesFromText } = await import("./external-resources");

    const references = extractExternalResourceReferencesFromText(
      "Open <https://app.box.com/s/budget?utm_source=slack|Budget model> and also https://app.box.com/s/budget.",
    );

    expect(references).toEqual([expect.objectContaining({
      url: "https://app.box.com/s/budget",
      label: "Budget model",
      sourceText: expect.stringContaining("Budget model"),
    })]);
  });

  it("saves a manual reference and attaches it to an action without requiring Box OAuth", async () => {
    const { upsertWorkspaceExternalResourceFromUrl } = await import("./external-resources");
    const result = await upsertWorkspaceExternalResourceFromUrl(actor, {
      workspaceId: "ws-1",
      url: " https://app.box.com/s/budget#preview ",
      descriptionMd: "Client budget model",
      entityType: "Action",
      entityId: "action-1",
      purpose: "reference",
    });

    expect(result).toMatchObject({
      id: "resource-1",
      providerKey: "box",
      priority: 100,
    });
    expect(txMock.workspaceExternalResource.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_providerKey_externalId: {
          workspaceId: "ws-1",
          providerKey: "box",
          externalId: expect.stringMatching(/^url:/),
        },
      },
      update: expect.objectContaining({
        category: "FILES",
        priority: 100,
        url: "https://app.box.com/s/budget",
        descriptionMd: "Client budget model",
      }),
      create: expect.objectContaining({
        createdByUserId: "user-1",
        providerKey: "box",
        category: "FILES",
        priority: 100,
      }),
    }));
    expect(txMock.workspaceExternalResourceAttachment.createMany).toHaveBeenCalledWith({
      data: [{
        workspaceId: "ws-1",
        resourceId: "resource-1",
        entityType: "Action",
        entityId: "action-1",
        purpose: "reference",
        createdByUserId: "user-1",
      }],
      skipDuplicates: true,
    });
    expect(recordAuditMock).toHaveBeenCalledWith(
      txMock,
      actor,
      expect.objectContaining({
        action: "external-resource.attached",
        meta: expect.objectContaining({ providerKey: "box", targetType: "Action" }),
      }),
    );
  });

  it("captures Slack message references as resources plus source mentions", async () => {
    prismaMock.communicationMessage.findUnique.mockResolvedValueOnce(slackMessage());
    prismaMock.communicationChannel.findUnique.mockResolvedValueOnce({ kind: "PUBLIC", name: "client-files" });
    txMock.workspaceExternalResource.upsert
      .mockResolvedValueOnce(resourceFixture())
      .mockResolvedValueOnce(resourceFixture({
        id: "resource-2",
        providerKey: "generic_url",
        externalId: "url:generic",
        category: "LINK",
        priority: 0,
        title: "reference",
        url: "https://example.com/reference",
        sharedLinkUrl: "https://example.com/reference",
      }));

    const { captureReferencesForSource } = await import("./external-resources");
    const result = await captureReferencesForSource("SLACK_MESSAGE", "message-1");

    expect(result).toEqual(expect.objectContaining({
      scanned: 2,
      captured: 2,
      providerCounts: { box: 1, generic_url: 1 },
    }));
    expect(txMock.workspaceExternalResourceMention.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        resourceId: "resource-1",
        sourceType: "SLACK_MESSAGE",
        sourceId: "message-1",
        sourceProvider: "SLACK",
        sourceExternalId: "1714320000.000100",
        sourcePermalink: "https://slack.test/archives/C1/p1714320000000100",
        sourceLabel: "Budget model",
        communicationMessageId: "message-1",
      }),
    }));
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "knowledge.sync.external-resource",
        payload: { resourceId: "resource-1" },
      }),
    }));
  });

  it("lists captured resources with source owner and channel context", async () => {
    prismaMock.workspaceExternalResource.findMany.mockResolvedValueOnce([resourceFixture({
      createdBy: { id: "user-1", email: "user@example.com", displayName: "User" },
      mentions: [{
        id: "mention-1",
        sourceType: "SLACK_MESSAGE",
        sourceProvider: "SLACK",
        sourceExternalId: "1714320000.000100",
        sourcePermalink: "https://slack.test/archives/C1/p1714320000000100",
        sourceLabel: "Budget model",
        sourceText: "Budget model shared for the client proposal.",
        mentionedAt: new Date("2026-06-28T17:00:00.000Z"),
        redactedAt: null,
        createdAt: new Date("2026-06-28T17:00:01.000Z"),
        communicationMessage: {
          installationId: "install-1",
          provider: "SLACK",
          externalUserId: "U1",
          externalChannelId: "C1",
          messageTs: new Date("2026-06-28T17:00:00.000Z"),
        },
      }],
    })]);
    prismaMock.communicationExternalUser.findMany.mockResolvedValueOnce([{
      installationId: "install-1",
      externalUserId: "U1",
      email: "nina@example.com",
      displayName: "Nina",
    }]);
    prismaMock.communicationChannel.findMany.mockResolvedValueOnce([{
      installationId: "install-1",
      externalChannelId: "C1",
      name: "client-files",
    }]);

    const { listWorkspaceExternalResources } = await import("./external-resources");
    const result = await listWorkspaceExternalResources(actor, {
      workspaceId: "ws-1",
      take: 20,
    });

    expect(result[0]).toEqual(expect.objectContaining({
      id: "resource-1",
      createdBy: { id: "user-1", email: "user@example.com", displayName: "User" },
      mentions: [expect.objectContaining({
        id: "mention-1",
        sharedByName: "Nina",
        sourceChannelName: "client-files",
        sourceChannelExternalId: "C1",
      })],
    }));
    expect(result[0].mentions[0]).not.toHaveProperty("communicationMessage");
    expect(prismaMock.workspaceExternalResource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 20,
    }));
  });

  it("redacts mention text when the source Slack message is deleted", async () => {
    prismaMock.communicationMessage.findUnique.mockResolvedValueOnce(slackMessage({
      text: null,
      textRedactedAt: new Date("2026-06-28T18:00:00.000Z"),
      isDeleted: true,
    }));
    prismaMock.communicationChannel.findUnique.mockResolvedValueOnce({ kind: "PUBLIC", name: "client-files" });
    txMock.workspaceExternalResourceMention.findMany.mockResolvedValueOnce([{
      resourceId: "resource-1",
      resource: {
        id: "resource-1",
        workspaceId: "ws-1",
        updatedAt: new Date("2026-06-28T17:00:00.000Z"),
      },
    }]);

    const { captureReferencesForSource } = await import("./external-resources");
    const result = await captureReferencesForSource("SLACK_MESSAGE", "message-1");

    expect(result).toEqual(expect.objectContaining({ captured: 0, redacted: 1 }));
    expect(txMock.workspaceExternalResourceMention.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceLabel: null,
        sourceText: null,
        redactedAt: expect.any(Date),
      }),
    }));
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "knowledge.sync.external-resource",
        payload: { resourceId: "resource-1" },
        dedupeKey: expect.stringContaining("redaction:"),
      }),
    }));
  });

  it("dry-runs a Slack reference backfill with provider counts and no raw URLs", async () => {
    prismaMock.communicationChannel.findMany.mockResolvedValueOnce([
      { installationId: "install-1", externalChannelId: "C1" },
    ]);
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      { id: "message-1", text: "Box <https://app.box.com/s/budget|Budget>", updatedAt: new Date("2026-06-28T17:00:00.000Z") },
      { id: "message-2", text: "Docs https://docs.google.com/document/d/abc", updatedAt: new Date("2026-06-28T17:10:00.000Z") },
    ]);

    const { backfillExternalResourceReferencesForWorkspace } = await import("./external-resources");
    const result = await backfillExternalResourceReferencesForWorkspace(actor, {
      workspaceId: "ws-1",
      dryRun: true,
      take: 100,
    });

    expect(result).toEqual({
      workspaceId: "ws-1",
      dryRun: true,
      scannedMessages: 2,
      candidateMessages: 2,
      references: 2,
      providerCounts: { box: 1, google_drive: 1 },
      enqueued: 0,
    });
    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ installationId: "install-1", externalChannelId: "C1" }],
      }),
    }));
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
  });
});
