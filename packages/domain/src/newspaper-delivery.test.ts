import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  requireWorkspaceMembershipMock,
  trackedLinks,
} = vi.hoisted(() => ({
  trackedLinks: [] as any[],
  prismaMock: {
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
});
