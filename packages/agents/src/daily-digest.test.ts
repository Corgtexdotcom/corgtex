import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  chatMock,
  extractMock,
  sendEmailMock,
  loggerMock,
  txMock,
  batchIngestDailyConversationsMock,
  createArticleMock,
  listSlackMessagesForDigestMock,
  updateArticleMock,
  rebuildBacklinksMock,
  getWorkspaceNewspaperCadenceMock,
  instrumentNewspaperHtmlLinksMock,
  recordNewspaperDeliveryMock,
} = vi.hoisted(() => ({
  txMock: {
    demoLead: {
      update: vi.fn(),
    },
    crmActivity: {
      create: vi.fn(),
    },
    newspaperDelivery: {
      create: vi.fn(),
    },
  },
  prismaMock: {
    $transaction: vi.fn(),
    conversationSession: {
      findMany: vi.fn(),
    },
    buildArtifact: {
      findMany: vi.fn(),
    },
    brainSource: {
      create: vi.fn(),
    },
    brainArticle: {
      findUnique: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    demoLead: {
      findFirst: vi.fn(),
    },
  },
  chatMock: vi.fn(),
  extractMock: vi.fn(),
  sendEmailMock: vi.fn(),
  loggerMock: {
    info: vi.fn(),
    error: vi.fn(),
  },
  batchIngestDailyConversationsMock: vi.fn(),
  createArticleMock: vi.fn(),
  listSlackMessagesForDigestMock: vi.fn(),
  updateArticleMock: vi.fn(),
  rebuildBacklinksMock: vi.fn(),
  getWorkspaceNewspaperCadenceMock: vi.fn(),
  instrumentNewspaperHtmlLinksMock: vi.fn(),
  recordNewspaperDeliveryMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  env: { APP_URL: "https://app.example.com" },
  logger: loggerMock,
  prisma: prismaMock,
  sendEmail: sendEmailMock,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    chat: chatMock,
    extract: extractMock,
  },
  resolveModel: vi.fn().mockReturnValue("fake-model"),
}));

vi.mock("@corgtex/domain", () => ({
  AGENT_REGISTRY: {
    "daily-digest": {
      defaultModelTier: "standard",
    },
  },
  getAgentModelOverride: vi.fn().mockResolvedValue(undefined),
  getWorkspaceNewspaperCadence: getWorkspaceNewspaperCadenceMock,
  normalizeNewspaperCadence: (value: unknown) => {
    if (value === "WEEKLY" || value === "OFF") return value;
    return "DAILY";
  },
  computeNewspaperLayout: (sections: Array<{ id: string; itemCount: number }>) => {
    const visibleSections = sections
      .filter((section) => section.itemCount > 0)
      .map((section) => ({
        ...section,
        itemCap: Math.min(section.itemCount, 5),
        excerptMaxLength: 180,
        placement: "standard",
      }));
    return {
      variant: visibleSections.length <= 2 ? "sparse" : "balanced",
      visibleSections,
      sectionCaps: Object.fromEntries(visibleSections.map((section) => [
        section.id,
        {
          itemCap: section.itemCap,
          excerptMaxLength: section.excerptMaxLength,
          placement: section.placement,
        },
      ])),
    };
  },
  instrumentNewspaperHtmlLinks: instrumentNewspaperHtmlLinksMock,
  recordNewspaperDelivery: recordNewspaperDeliveryMock,
  batchIngestDailyConversations: batchIngestDailyConversationsMock,
  createArticle: createArticleMock,
  listSlackMessagesForDigest: listSlackMessagesForDigestMock,
  updateArticle: updateArticleMock,
  rebuildBacklinks: rebuildBacklinksMock,
}));

function mockRecentBuildArtifact() {
  return {
    repositoryOwner: "puncar-dev",
    repositoryName: "corgtex",
    pullRequestNumber: 52,
    pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/52",
    branchName: "feat/newspaper",
    title: "Newspaper delivery observability",
    summaryMd: "Delivery records and reporting.",
    status: "MERGED",
    mergedAt: new Date("2026-04-30T12:00:00.000Z"),
    closedAt: new Date("2026-04-30T12:00:00.000Z"),
    updatedAt: new Date("2026-04-30T12:00:00.000Z"),
    assets: [],
  };
}

describe("runDailyDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    batchIngestDailyConversationsMock.mockResolvedValue(undefined);
    prismaMock.conversationSession.findMany.mockResolvedValue([]);
    listSlackMessagesForDigestMock.mockResolvedValue([]);
    prismaMock.buildArtifact.findMany.mockResolvedValue([]);
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-1",
        newspaperCadence: null,
        user: {
          id: "user-1",
          email: "member@example.com",
          displayName: "Member One",
        },
      },
    ]);
    prismaMock.demoLead.findFirst.mockResolvedValue(null);
    prismaMock.brainSource.create.mockResolvedValue({ id: "source-1" });
    prismaMock.brainArticle.findUnique.mockResolvedValue(null);
    chatMock.mockResolvedValue({ content: "Merged profile body" });
    extractMock.mockImplementation(async ({ instruction }: { instruction: string }) => {
      if (instruction.startsWith("Generate a structured")) {
        return {
          output: {
            intro: "Structured daily brief.",
            builtWork: ["Shipped a useful update."],
            conversationHighlights: ["Discussed operating priorities."],
          },
        };
      }
      if (instruction.startsWith("Personalize this structured")) {
        return {
          output: {
            greeting: "Hello Member One,",
            intro: "Here is what matters most today.",
            emphasizedSectionIds: ["builtWork"],
          },
        };
      }
      return { output: {} };
    });
    createArticleMock.mockResolvedValue({ id: "article-1" });
    updateArticleMock.mockResolvedValue({ id: "article-1" });
    rebuildBacklinksMock.mockResolvedValue(undefined);
    sendEmailMock.mockResolvedValue({ status: "SENT", providerMessageId: "email-1" });
    instrumentNewspaperHtmlLinksMock.mockImplementation(async ({ html }: { html: string }) => html);
    recordNewspaperDeliveryMock.mockResolvedValue({ id: "delivery-1" });
    txMock.demoLead.update.mockResolvedValue({ id: "lead-1" });
    txMock.crmActivity.create.mockResolvedValue({ id: "activity-1" });
    txMock.newspaperDelivery.create.mockResolvedValue({ id: "delivery-1" });
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("DAILY");
    prismaMock.workspace.findUnique.mockResolvedValue({ name: "Workspace One" });
  });

  it("includes recent active and merged build artifacts in the digest input", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([
      {
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/42",
        branchName: "feat/outcome-board",
        title: "Built outcome board",
        summaryMd: "Plan and acceptance criteria.",
        status: "OPEN",
        mergedAt: null,
        closedAt: null,
        updatedAt: new Date("2026-04-30T09:00:00.000Z"),
        assets: [
          {
            kind: "SCREENSHOT",
            label: "In-progress board",
            captionMd: "Shows active PR work.",
          },
        ],
      },
      {
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        pullRequestNumber: 41,
        pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/41",
        branchName: "feat/tools",
        title: "Tools directory",
        summaryMd: "Merged tools outcome.",
        status: "MERGED",
        mergedAt: new Date("2026-04-30T08:00:00.000Z"),
        closedAt: new Date("2026-04-30T08:00:00.000Z"),
        updatedAt: new Date("2026-04-30T08:00:00.000Z"),
        assets: [],
      },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
    });

    const digestCall = extractMock.mock.calls.find(([request]) => request.instruction.startsWith("Generate a structured"));
    const digestInput = digestCall?.[0].input;
    expect(digestInput).toContain("Built / PR activity for accomplishments and shipped work");
    expect(digestInput).toContain("Active PR work");
    expect(digestInput).toContain("Built outcome board");
    expect(digestInput).toContain("Visual proof: In-progress board (SCREENSHOT): Shows active PR work.");
    expect(digestInput).toContain("Merged PRs / shipped outcomes");
    expect(digestInput).toContain("Tools directory");
    expect(createArticleMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      workspaceId: "workspace-1",
      type: "DIGEST",
      bodyMd: expect.stringContaining("## Built / Shipped Work"),
      title: "Daily Newspaper - 2026-04-30",
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "member@example.com",
      subject: "Daily Newspaper - 2026-04-30 - Your Personal Briefing",
      html: expect.stringContaining("The Workspace One Edition"),
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      memberId: "member-1",
      kind: "MEMBER_NEWSPAPER",
      cadence: "DAILY",
      status: "SENT",
      providerMessageId: "email-1",
    }));
  });

  it("skips digest generation when no active members match the requested cadence", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("WEEKLY");
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-1",
        newspaperCadence: null,
        user: {
          id: "user-1",
          email: "member@example.com",
          displayName: "Member One",
        },
      },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      cadence: "DAILY",
      processedSessions: 0,
    }));
    expect(batchIngestDailyConversationsMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not generate a newspaper when the requested cadence is off", async () => {
    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "OFF",
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      cadence: "OFF",
      sentEmails: 0,
    }));
    expect(batchIngestDailyConversationsMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith("newspaper_delivery_skipped", expect.objectContaining({
      reason: "cadence_off",
    }));
  });

  it("excludes members whose effective cadence is off", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-off",
        newspaperCadence: "OFF",
        user: {
          id: "user-off",
          email: "off@example.com",
          displayName: "Off Member",
        },
      },
      {
        id: "member-daily",
        newspaperCadence: "DAILY",
        user: {
          id: "user-daily",
          email: "daily@example.com",
          displayName: "Daily Member",
        },
      },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "daily@example.com",
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      memberId: "member-daily",
      status: "SENT",
    }));
  });

  it("records skipped deliveries when email is not configured", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    sendEmailMock.mockResolvedValue({ status: "SKIPPED", reason: "RESEND_API_KEY is not configured." });

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      sentEmails: 0,
      skippedEmails: 1,
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "SKIPPED",
      error: "RESEND_API_KEY is not configured.",
    }));
  });

  it("records skipped deliveries instead of sending empty structured newspapers", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    extractMock.mockImplementation(async ({ instruction }: { instruction: string }) => {
      if (instruction.startsWith("Generate a structured")) {
        return { output: {} };
      }
      return { output: {} };
    });

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      sentEmails: 0,
      skippedEmails: 1,
    }));
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      memberId: "member-1",
      status: "SKIPPED",
      error: "No digest sections generated.",
    }));
  });

  it("records failed deliveries when sending fails", async () => {
    prismaMock.buildArtifact.findMany.mockResolvedValue([mockRecentBuildArtifact()]);
    sendEmailMock.mockRejectedValue(new Error("provider unavailable"));

    const { runDailyDigest } = await import("./daily-digest");
    const result = await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "DAILY",
    });

    expect(result).toEqual(expect.objectContaining({
      sentEmails: 0,
      failedEmails: 1,
    }));
    expect(recordNewspaperDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "FAILED",
      error: "provider unavailable",
    }));
    expect(loggerMock.error).toHaveBeenCalledWith("newspaper_delivery_failed", expect.objectContaining({
      error: "provider unavailable",
    }));
  });

  it("uses a seven-day lookback for weekly newspapers", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("WEEKLY");
    prismaMock.buildArtifact.findMany.mockResolvedValue([
      {
        repositoryOwner: "puncar-dev",
        repositoryName: "corgtex",
        pullRequestNumber: 50,
        pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/50",
        branchName: "feat/weekly",
        title: "Weekly operating summary",
        summaryMd: "Weekly shipped work.",
        status: "MERGED",
        mergedAt: new Date("2026-04-29T12:00:00.000Z"),
        closedAt: new Date("2026-04-29T12:00:00.000Z"),
        updatedAt: new Date("2026-04-29T12:00:00.000Z"),
        assets: [],
      },
    ]);

    const { runDailyDigest } = await import("./daily-digest");
    await runDailyDigest({
      workspaceId: "workspace-1",
      dateISO: "2026-04-30T12:00:00.000Z",
      cadence: "WEEKLY",
    });

    expect(batchIngestDailyConversationsMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      since: new Date("2026-04-23T12:00:00.000Z"),
    });
    expect(createArticleMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      slug: "weekly-newspaper-2026-04-30",
      title: "Weekly Newspaper - 2026-04-30",
    }));
  });

  it("sends the curated demo welcome newspaper once and records a CRM activity", async () => {
    prismaMock.demoLead.findFirst.mockResolvedValue({
      id: "lead-1",
      workspaceId: "workspace-1",
      email: "lead@example.com",
      convertedContactId: "contact-1",
      welcomeEmailSentAt: null,
      workspace: { name: "Corgtex" },
    });

    const { sendDemoWelcomeNewspaper } = await import("./daily-digest");
    await expect(sendDemoWelcomeNewspaper({
      workspaceId: "workspace-1",
      demoLeadId: "lead-1",
    })).resolves.toEqual({ success: true, skipped: false });

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "lead@example.com",
      subject: "Welcome to Corgtex - your first newspaper",
      html: expect.stringContaining("Already built"),
    }));
    expect(txMock.demoLead.update).toHaveBeenCalledWith({
      where: { id: "lead-1" },
      data: { welcomeEmailSentAt: expect.any(Date) },
    });
    expect(txMock.crmActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        contactId: "contact-1",
        type: "EMAIL",
        title: "Sent welcome newspaper",
      }),
    });
    expect(txMock.newspaperDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        demoLeadId: "lead-1",
        kind: "DEMO_WELCOME",
        status: "SENT",
        providerMessageId: "email-1",
      }),
    });
  });

  it("does not resend the demo welcome newspaper when it already has a sent timestamp", async () => {
    prismaMock.demoLead.findFirst.mockResolvedValue({
      id: "lead-1",
      workspaceId: "workspace-1",
      email: "lead@example.com",
      welcomeEmailSentAt: new Date("2026-04-30T12:00:00.000Z"),
      workspace: { name: "Corgtex" },
    });

    const { sendDemoWelcomeNewspaper } = await import("./daily-digest");
    await sendDemoWelcomeNewspaper({
      workspaceId: "workspace-1",
      demoLeadId: "lead-1",
    });

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(txMock.demoLead.update).not.toHaveBeenCalled();
  });
});
