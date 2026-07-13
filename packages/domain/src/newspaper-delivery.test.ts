import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  requireWorkspaceMembershipMock,
  trackedLinks,
} = vi.hoisted(() => ({
  trackedLinks: [] as any[],
  prismaMock: {
    workspaceAgentConfig: {
      findUnique: vi.fn(),
    },
    workflowJob: {
      findMany: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    meeting: {
      count: vi.fn(),
    },
    proposal: {
      count: vi.fn(),
    },
    tension: {
      count: vi.fn(),
    },
    action: {
      count: vi.fn(),
    },
    goal: {
      count: vi.fn(),
    },
    goalUpdate: {
      count: vi.fn(),
    },
    roleVersion: {
      count: vi.fn(),
    },
    roleHolderHistory: {
      count: vi.fn(),
    },
    brainArticle: {
      count: vi.fn(),
    },
    document: {
      count: vi.fn(),
    },
    adviceRequest: {
      count: vi.fn(),
    },
    conversationSession: {
      count: vi.fn(),
    },
    communicationMessage: {
      count: vi.fn(),
    },
    buildArtifact: {
      count: vi.fn(),
    },
    newspaperTrackedLink: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    newspaperDelivery: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    emailDelivery: {
      findMany: vi.fn(),
    },
    newspaperEdition: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

function testHash(value: string) {
  return `sha-${Buffer.from(value).toString("base64url")}`;
}

vi.mock("@corgtex/shared", () => ({
  env: {
    APP_URL: "https://app.example.com",
    SESSION_COOKIE_SECRET: "test-session-secret",
  },
  prisma: prismaMock,
  sha256: testHash,
  toInputJson: (value: unknown) => value,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

describe("newspaper delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackedLinks.splice(0, trackedLinks.length);
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1" });

    prismaMock.newspaperTrackedLink.upsert.mockImplementation(async ({ where, create }: any) => {
      const existing = trackedLinks.find((link) => (
        link.runKey === where.runKey_targetUrlHash.runKey
          && link.targetUrlHash === where.runKey_targetUrlHash.targetUrlHash
      ));
      if (existing) {
        return existing;
      }
      const link = {
        id: `link-${trackedLinks.length + 1}`,
        clickCount: 0,
        firstClickedAt: null,
        lastClickedAt: null,
        ...create,
      };
      trackedLinks.push(link);
      return link;
    });
    prismaMock.newspaperTrackedLink.findUnique.mockImplementation(async ({ where }: any) => (
      trackedLinks.find((link) => link.tokenHash === where.tokenHash) ?? null
    ));
    prismaMock.newspaperTrackedLink.update.mockImplementation(async ({ where, data }: any) => {
      const link = trackedLinks.find((candidate) => candidate.id === where.id);
      if (!link) return null;
      link.clickCount += data.clickCount.increment;
      link.firstClickedAt = data.firstClickedAt;
      link.lastClickedAt = data.lastClickedAt;
      return link;
    });
    prismaMock.newspaperTrackedLink.findMany.mockResolvedValue([]);
    prismaMock.newspaperDelivery.create.mockImplementation(async ({ data }: any) => ({
      id: "delivery-1",
      createdAt: new Date("2026-05-01T12:00:00.000Z"),
      ...data,
    }));
    prismaMock.newspaperDelivery.findMany.mockResolvedValue([]);
    prismaMock.emailDelivery.findMany.mockResolvedValue([]);
    prismaMock.newspaperEdition.upsert.mockResolvedValue({ id: "edition-1" });
    prismaMock.newspaperEdition.findMany.mockResolvedValue([]);
    prismaMock.workspaceAgentConfig.findUnique.mockResolvedValue(null);
    prismaMock.workflowJob.findMany.mockResolvedValue([]);
    prismaMock.member.findMany.mockResolvedValue([]);
    prismaMock.member.count.mockResolvedValue(0);
    prismaMock.meeting.count.mockResolvedValue(0);
    prismaMock.proposal.count.mockResolvedValue(0);
    prismaMock.tension.count.mockResolvedValue(0);
    prismaMock.action.count.mockResolvedValue(0);
    prismaMock.goal.count.mockResolvedValue(0);
    prismaMock.goalUpdate.count.mockResolvedValue(0);
    prismaMock.roleVersion.count.mockResolvedValue(0);
    prismaMock.roleHolderHistory.count.mockResolvedValue(0);
    prismaMock.brainArticle.count.mockResolvedValue(0);
    prismaMock.document.count.mockResolvedValue(0);
    prismaMock.adviceRequest.count.mockResolvedValue(0);
    prismaMock.conversationSession.count.mockResolvedValue(0);
    prismaMock.communicationMessage.count.mockResolvedValue(0);
    prismaMock.buildArtifact.count.mockResolvedValue(0);
  });

  it("rewrites absolute links to aggregate tracked links without storing raw tokens", async () => {
    const { instrumentNewspaperHtmlLinks } = await import("./newspaper-delivery");

    const html = await instrumentNewspaperHtmlLinks({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      runKey: "run-1",
      html: [
        "<a href=\"https://example.com/report?a=1&amp;b=2\">Report</a>",
        "<a href='https://example.com/report?a=1&amp;b=2'>Again</a>",
        "<a href=\"mailto:hello@example.com\">Mail</a>",
      ].join(""),
    });

    expect(html).toContain("https://app.example.com/api/newspaper/click/");
    expect(html).toContain("mailto:hello@example.com");
    expect(prismaMock.newspaperTrackedLink.upsert).toHaveBeenCalledTimes(1);
    expect(trackedLinks[0]).toEqual(expect.objectContaining({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      runKey: "run-1",
      targetUrl: "https://example.com/report?a=1&b=2",
    }));
    expect(trackedLinks[0].tokenHash).not.toContain("https://example.com/report");
  });

  it("increments aggregate click counts and redirects only stored http targets", async () => {
    const { instrumentNewspaperHtmlLinks, recordNewspaperLinkClick } = await import("./newspaper-delivery");
    const html = await instrumentNewspaperHtmlLinks({
      workspaceId: "ws-1",
      runKey: "run-1",
      html: "<a href=\"https://example.com/report\">Report</a>",
    });
    const token = html.match(/\/api\/newspaper\/click\/([^"]+)/)?.[1];

    await expect(recordNewspaperLinkClick(token ?? "")).resolves.toEqual({
      targetUrl: "https://example.com/report",
    });

    expect(trackedLinks[0].clickCount).toBe(1);
    expect(trackedLinks[0].firstClickedAt).toBeInstanceOf(Date);
    expect(trackedLinks[0].lastClickedAt).toBeInstanceOf(Date);
  });

  it("rejects unknown tokens and stored non-http targets", async () => {
    const { recordNewspaperLinkClick } = await import("./newspaper-delivery");
    const { sha256 } = await import("@corgtex/shared");
    trackedLinks.push({
      id: "bad-link",
      tokenHash: sha256("bad-token"),
      targetUrl: "javascript:alert(1)",
      firstClickedAt: null,
      clickCount: 0,
    });

    await expect(recordNewspaperLinkClick("missing-token")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    await expect(recordNewspaperLinkClick("bad-token")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("returns aggregate run summaries with clicked link counts", async () => {
    const { listNewspaperDeliverySummaries } = await import("./newspaper-delivery");
    prismaMock.newspaperDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-1",
        kind: "MEMBER_NEWSPAPER",
        cadence: "DAILY",
        runKey: "run-1",
        subject: "Daily Newspaper",
        status: "SENT",
        sentAt: new Date("2026-05-01T12:00:00.000Z"),
        skippedAt: null,
        failedAt: null,
        createdAt: new Date("2026-05-01T12:00:00.000Z"),
        workflowJobId: "job-1",
      },
      {
        id: "delivery-2",
        kind: "MEMBER_NEWSPAPER",
        cadence: "DAILY",
        runKey: "run-1",
        subject: "Daily Newspaper",
        status: "FAILED",
        sentAt: null,
        skippedAt: null,
        failedAt: new Date("2026-05-01T12:01:00.000Z"),
        createdAt: new Date("2026-05-01T12:01:00.000Z"),
        workflowJobId: "job-1",
      },
      {
        id: "delivery-3",
        kind: "MEMBER_NEWSPAPER",
        cadence: "DAILY",
        runKey: "run-1",
        subject: "Daily Newspaper",
        status: "SKIPPED",
        sentAt: null,
        skippedAt: new Date("2026-05-01T12:02:00.000Z"),
        failedAt: null,
        createdAt: new Date("2026-05-01T12:02:00.000Z"),
        workflowJobId: "job-1",
      },
    ]);
    prismaMock.newspaperTrackedLink.findMany.mockResolvedValue([
      { runKey: "run-1", clickCount: 2 },
      { runKey: "run-1", clickCount: 0 },
    ]);

    await expect(listNewspaperDeliverySummaries({ kind: "user", user: { id: "u-1" } } as any, "ws-1")).resolves.toEqual([
      expect.objectContaining({
        runKey: "run-1",
        sentCount: 1,
        failedCount: 1,
        skippedCount: 1,
        recipientCount: 3,
        trackedLinkCount: 2,
        clickedLinkCount: 1,
        totalClickCount: 2,
      }),
    ]);
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor: { kind: "user", user: { id: "u-1" } },
      workspaceId: "ws-1",
    });
  });

  it("returns recipient delivery rows without recipient-level click behavior", async () => {
    const { listNewspaperDeliveryDetails } = await import("./newspaper-delivery");
    prismaMock.newspaperDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-1",
        kind: "MEMBER_NEWSPAPER",
        cadence: "DAILY",
        runKey: "run-1",
        recipientEmail: "member@example.com",
        subject: "Daily Newspaper",
        status: "SENT",
        providerMessageId: "email-1",
        sentAt: new Date("2026-05-01T12:00:00.000Z"),
        skippedAt: null,
        failedAt: null,
        error: null,
        createdAt: new Date("2026-05-01T12:00:00.000Z"),
        member: {
          user: {
            displayName: "Member One",
            email: "member@example.com",
          },
        },
      },
    ]);

    const rows = await listNewspaperDeliveryDetails({ kind: "user", user: { id: "u-1" } } as any, "ws-1");

    expect(rows[0]).toEqual(expect.objectContaining({
      recipientEmail: "member@example.com",
      status: "SENT",
    }));
    expect(rows[0]).not.toHaveProperty("clickCount");
    expect(rows[0]).not.toHaveProperty("clickedAt");
  });

  it("upserts canonical newspaper editions by workspace, cadence, and date", async () => {
    const { upsertNewspaperEdition } = await import("./newspaper-delivery");

    await upsertNewspaperEdition({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      cadence: "DAILY",
      dateKey: "2026-07-11",
      runKey: "run-1",
      title: "Daily Newspaper - 2026-07-11",
      slug: "daily-newspaper-2026-07-11",
      digestJson: { intro: "Hello", sections: [{ id: "builtWork", items: ["Shipped work"] }] },
      bodyMd: "# Daily Newspaper\n\n## Built Work",
      sourceCounts: { buildArtifacts: 1 },
    });

    expect(prismaMock.newspaperEdition.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_cadence_dateKey: {
          workspaceId: "ws-1",
          cadence: "DAILY",
          dateKey: "2026-07-11",
        },
      },
      create: expect.objectContaining({
        workspaceId: "ws-1",
        workflowJobId: "job-1",
        cadence: "DAILY",
        dateKey: "2026-07-11",
        runKey: "run-1",
        title: "Daily Newspaper - 2026-07-11",
        slug: "daily-newspaper-2026-07-11",
        bodyMd: "# Daily Newspaper\n\n## Built Work",
        sourceCounts: { buildArtifacts: 1 },
      }),
      update: expect.objectContaining({
        workflowJobId: "job-1",
        runKey: "run-1",
        digestJson: expect.objectContaining({
          intro: "Hello",
        }),
        sourceCounts: { buildArtifacts: 1 },
      }),
    });
  });

  it("rejects off cadence when storing a canonical edition", async () => {
    const { upsertNewspaperEdition } = await import("./newspaper-delivery");

    await expect(upsertNewspaperEdition({
      workspaceId: "ws-1",
      cadence: "OFF",
      dateKey: "2026-07-11",
      runKey: "run-1",
      title: "Off Newspaper",
      slug: "off-newspaper",
      digestJson: {},
      bodyMd: "",
      sourceCounts: {},
    })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    expect(prismaMock.newspaperEdition.upsert).not.toHaveBeenCalled();
  });

  it("lists canonical newspaper editions behind workspace membership", async () => {
    const { listNewspaperEditions } = await import("./newspaper-delivery");
    prismaMock.newspaperEdition.findMany.mockResolvedValue([
      {
        id: "edition-1",
        workflowJobId: "job-1",
        cadence: "WEEKLY",
        dateKey: "2026-07-06",
        runKey: "run-1",
        title: "Weekly Newspaper - 2026-07-06",
        slug: "weekly-newspaper-2026-07-06",
        digestJson: { sections: [] },
        bodyMd: "# Weekly Newspaper",
        sourceCounts: {},
        generatedAt: new Date("2026-07-06T08:00:00.000Z"),
        createdAt: new Date("2026-07-06T08:00:00.000Z"),
        updatedAt: new Date("2026-07-06T08:00:00.000Z"),
      },
    ]);

    const rows = await listNewspaperEditions({ kind: "user", user: { id: "u-1" } } as any, "ws-1", { take: 5 });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor: { kind: "user", user: { id: "u-1" } },
      workspaceId: "ws-1",
    });
    expect(prismaMock.newspaperEdition.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      orderBy: { generatedAt: "desc" },
      take: 5,
    }));
    expect(rows[0]).toEqual(expect.objectContaining({
      id: "edition-1",
      cadence: "WEEKLY",
    }));
  });

  it("returns newspaper diagnostics with effective recipients, next runs, jobs, deliveries, and source counts", async () => {
    const { getNewspaperDiagnostics } = await import("./newspaper-delivery");
    prismaMock.workspaceAgentConfig.findUnique.mockResolvedValue({
      enabled: true,
      configJson: {
        newspaperCadence: "WEEKLY",
        newspaperWeekday: "MONDAY",
        newspaperLocalTime: "08:00",
        newspaperTimeZone: "UTC",
      },
    });
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-1",
        newspaperCadence: null,
        joinedAt: new Date("2026-06-01T12:00:00.000Z"),
        user: { email: "member@example.com", displayName: "Member One" },
      },
    ]);
    prismaMock.meeting.count.mockResolvedValue(2);
    prismaMock.action.count.mockResolvedValue(1);
    prismaMock.workflowJob.findMany.mockResolvedValue([
      {
        id: "job-1",
        status: "COMPLETED",
        dedupeKey: "ws-1:weekly-digest:2026-06-22",
        payload: { cadence: "WEEKLY" },
        error: null,
        runAfter: new Date("2026-06-22T08:00:00.000Z"),
        createdAt: new Date("2026-06-22T08:00:00.000Z"),
        startedAt: new Date("2026-06-22T08:00:00.000Z"),
        completedAt: new Date("2026-06-22T08:01:00.000Z"),
      },
    ]);
    prismaMock.newspaperDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-1",
        workflowJobId: "job-1",
        memberId: "member-1",
        cadence: "WEEKLY",
        runKey: "run-1",
        recipientEmail: "member@example.com",
        subject: "Weekly Newspaper",
        status: "SKIPPED",
        providerMessageId: null,
        error: "No digest inputs.",
        sentAt: null,
        skippedAt: new Date("2026-06-22T08:01:00.000Z"),
        failedAt: null,
        createdAt: new Date("2026-06-22T08:01:00.000Z"),
      },
    ]);
    prismaMock.newspaperEdition.findMany.mockResolvedValue([
      {
        id: "edition-1",
        workflowJobId: "job-1",
        cadence: "WEEKLY",
        dateKey: "2026-06-22",
        runKey: "run-1",
        title: "Weekly Newspaper - 2026-06-22",
        slug: "weekly-newspaper-2026-06-22",
        generatedAt: new Date("2026-06-22T08:00:30.000Z"),
        updatedAt: new Date("2026-06-22T08:00:30.000Z"),
      },
    ]);

    const diagnostics = await getNewspaperDiagnostics(
      { kind: "user", user: { id: "u-1" } } as any,
      "ws-1",
      { now: new Date("2026-06-28T12:00:00.000Z"), take: 5 },
    );

    expect(diagnostics.defaultSchedule).toEqual({
      cadence: "WEEKLY",
      weekday: "MONDAY",
      localTime: "08:00",
      timeZone: "UTC",
    });
    expect(diagnostics.nextRuns.weekly).toBe("2026-06-29T08:00:00.000Z");
    expect(diagnostics.recipients[0]).toEqual(expect.objectContaining({
      memberId: "member-1",
      effectiveCadence: "WEEKLY",
      receivesNewspaper: true,
    }));
    expect(diagnostics.sourceCounts.sevenDays).toEqual(expect.objectContaining({
      meetings: 2,
      openActions: 1,
    }));
    expect(diagnostics.recentJobs).toHaveLength(1);
    expect(diagnostics.recentDeliveries[0]).toEqual(expect.objectContaining({
      status: "SKIPPED",
      error: "No digest inputs.",
    }));
    expect(diagnostics.recentEditions[0]).toEqual(expect.objectContaining({
      cadence: "WEEKLY",
      dateKey: "2026-06-22",
      slug: "weekly-newspaper-2026-06-22",
    }));
    expect(diagnostics.deliveryAlert).toEqual(expect.objectContaining({
      state: "ok",
      failedCount: 0,
      skippedAttentionCount: 0,
      providerFailureCount: 0,
    }));
  });

  it("flags failed newspaper deliveries in diagnostics", async () => {
    const { getNewspaperDiagnostics } = await import("./newspaper-delivery");
    prismaMock.member.findMany.mockResolvedValue([]);
    prismaMock.newspaperDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-failed",
        workflowJobId: "job-1",
        memberId: "member-1",
        cadence: "DAILY",
        runKey: "run-1",
        recipientEmail: "member@example.com",
        subject: "Daily Newspaper",
        status: "FAILED",
        providerMessageId: null,
        error: "provider unavailable",
        sentAt: null,
        skippedAt: null,
        failedAt: new Date("2026-07-11T08:00:00.000Z"),
        createdAt: new Date("2026-07-11T08:00:00.000Z"),
      },
    ]);

    const diagnostics = await getNewspaperDiagnostics(
      { kind: "user", user: { id: "u-1" } } as any,
      "ws-1",
      { now: new Date("2026-07-11T12:00:00.000Z") },
    );

    expect(diagnostics.deliveryAlert).toEqual(expect.objectContaining({
      state: "attention",
      latestRunKey: "run-1",
      failedCount: 1,
      skippedAttentionCount: 0,
      providerFailureCount: 0,
    }));
    expect(diagnostics.deliveryAlert.affectedRecipients).toEqual([
      expect.objectContaining({
        id: "delivery-failed",
        recipientEmail: "member@example.com",
        error: "provider unavailable",
      }),
    ]);
  });

  it("alerts only provider skipped deliveries and ignores older failed runs after a clean latest run", async () => {
    const { getNewspaperDiagnostics } = await import("./newspaper-delivery");
    prismaMock.member.findMany.mockResolvedValue([]);
    prismaMock.newspaperDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-latest-benign",
        workflowJobId: "job-2",
        memberId: "member-1",
        cadence: "DAILY",
        runKey: "run-2",
        recipientEmail: "member@example.com",
        subject: "Daily Newspaper",
        status: "SKIPPED",
        providerMessageId: null,
        error: "No digest inputs.",
        sentAt: null,
        skippedAt: new Date("2026-07-12T08:00:00.000Z"),
        failedAt: null,
        createdAt: new Date("2026-07-12T08:00:00.000Z"),
      },
      {
        id: "delivery-old-failed",
        workflowJobId: "job-1",
        memberId: "member-1",
        cadence: "DAILY",
        runKey: "run-1",
        recipientEmail: "member@example.com",
        subject: "Daily Newspaper",
        status: "FAILED",
        providerMessageId: null,
        error: "provider unavailable",
        sentAt: null,
        skippedAt: null,
        failedAt: new Date("2026-07-11T08:00:00.000Z"),
        createdAt: new Date("2026-07-11T08:00:00.000Z"),
      },
    ]);

    const cleanDiagnostics = await getNewspaperDiagnostics({ kind: "user", user: { id: "u-1" } } as any, "ws-1");
    expect(cleanDiagnostics.deliveryAlert).toEqual(expect.objectContaining({
      state: "ok",
      latestRunKey: "run-2",
      failedCount: 0,
      skippedAttentionCount: 0,
    }));

    prismaMock.newspaperDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-provider-skip",
        workflowJobId: "job-3",
        memberId: "member-1",
        cadence: "DAILY",
        runKey: "run-3",
        recipientEmail: "member@example.com",
        subject: "Daily Newspaper",
        status: "SKIPPED",
        providerMessageId: null,
        error: "RESEND_API_KEY is not configured.",
        sentAt: null,
        skippedAt: new Date("2026-07-13T08:00:00.000Z"),
        failedAt: null,
        createdAt: new Date("2026-07-13T08:00:00.000Z"),
      },
    ]);

    const alertDiagnostics = await getNewspaperDiagnostics({ kind: "user", user: { id: "u-1" } } as any, "ws-1");
    expect(alertDiagnostics.deliveryAlert).toEqual(expect.objectContaining({
      state: "attention",
      latestRunKey: "run-3",
      failedCount: 0,
      skippedAttentionCount: 1,
    }));
  });

  it("flags bounced or complained provider events attached to recent newspaper deliveries", async () => {
    const { getNewspaperDiagnostics } = await import("./newspaper-delivery");
    prismaMock.member.findMany.mockResolvedValue([]);
    prismaMock.newspaperDelivery.findMany.mockResolvedValue([
      {
        id: "delivery-sent",
        workflowJobId: "job-1",
        memberId: "member-1",
        cadence: "DAILY",
        runKey: "run-1",
        recipientEmail: "member@example.com",
        subject: "Daily Newspaper",
        status: "SENT",
        providerMessageId: "email-1",
        error: null,
        sentAt: new Date("2026-07-11T08:00:00.000Z"),
        skippedAt: null,
        failedAt: null,
        createdAt: new Date("2026-07-11T08:00:00.000Z"),
      },
    ]);
    prismaMock.emailDelivery.findMany.mockResolvedValue([
      {
        providerMessageId: "email-1",
        status: "BOUNCED",
        lastEventType: "email.bounced",
        bouncedAt: new Date("2026-07-11T08:05:00.000Z"),
        complainedAt: null,
      },
    ]);

    const diagnostics = await getNewspaperDiagnostics({ kind: "user", user: { id: "u-1" } } as any, "ws-1");

    expect(prismaMock.emailDelivery.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { providerMessageId: { in: ["email-1"] } },
    }));
    expect(diagnostics.deliveryAlert).toEqual(expect.objectContaining({
      state: "attention",
      providerFailureCount: 1,
    }));
  });
});
