import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  requireWorkspaceMembershipMock,
  readableArtifactIdsMock,
  trackedLinks, authorityVersion,
} = vi.hoisted(() => ({
  authorityVersion: { value: 0 },
  trackedLinks: [] as any[],
  prismaMock: {
    $transaction: vi.fn(),
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
      groupBy: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    emailDelivery: {
      findMany: vi.fn(),
    },
    newspaperEdition: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
  readableArtifactIdsMock: vi.fn(async (_actor: unknown, _workspaceId: string, _kind: string,
    rows: Array<{ id: string }>) => new Set(rows.map((row) => row.id))),
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

vi.mock("./source-lineage", async () => {
  const { AppError } = await import("./errors");
  return {
    // These orchestration fixtures have no epoch vectors; avoid loading the real
    // source module through its newspaper dependency cycle.
    sealArtifactInputActor: (await import("./artifact-input-actor")).sealArtifactInputActor,
    mergeLineageInputRoot: (previous: {fingerprint: string} | undefined, root: {fingerprint: string}) => {
      if (previous && previous.fingerprint !== root.fingerprint) throw new AppError(409, "SOURCE_CHANGED", "Fixture revision changed.");
      return root;
    },
    captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({value: await read(), heads: new Map()}),
    withArtifactCountReleaseSnapshot: async (_actor: unknown, _ws: string, roots: Array<{fingerprint:string}>, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {
      if (roots.some(root => root.fingerprint !== `synthetic-proof-${authorityVersion.value}`)) throw new AppError(409, "SOURCE_CHANGED", "Original epoch changed");
      await remote(); return finish(prismaMock);
    }, readableArtifactIds: readableArtifactIdsMock,
    captureReadableNewspaperDeliveryInputs: async () => null,
    captureArtifactInputProof: vi.fn(async (actor, workspaceId, inputs) => {
      const input = inputs[0];
      const readable = await readableArtifactIdsMock(actor, workspaceId, input.kind, [input.snapshot]);
      if (!readable.has(input.id)) throw new AppError(409, "UNKNOWN_LINEAGE", "Unknown input");
      return [{ kind: input.kind, id: input.id, fingerprint: `synthetic-proof-${authorityVersion.value}` }];
    }),
    recordArtifactInputLineage: vi.fn(), invalidateArtifactInputLineage: vi.fn(),
  };
});

describe("newspaper delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks(); authorityVersion.value = 0;
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock));
    readableArtifactIdsMock.mockImplementation(async (_actor: unknown, _workspaceId: string, _kind: string,
      rows: Array<{ id: string }>) => new Set(rows.map((row) => row.id)));
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
      trackedLinks.find((link) => where.id ? link.id === where.id : link.tokenHash === where.tokenHash) ?? null
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
    prismaMock.newspaperEdition.findMany.mockResolvedValue([
      { id: "edition-1", runKey: "run-1", workflowJobId: "job-1" },
      { id: "edition-2", runKey: "run-2", workflowJobId: "job-2" },
      { id: "edition-3", runKey: "run-3", workflowJobId: "job-3" },
    ]);
    prismaMock.newspaperEdition.findFirst.mockImplementation(async ({where}) => {
      const rows = await prismaMock.newspaperEdition.findMany({where});
      return rows.find((row: any) => row.id === where.id && row.runKey === where.runKey) ?? null;
    });
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

    await expect(recordNewspaperLinkClick({ kind: "user", user: { id: "u-1" } } as any, token ?? "")).resolves.toEqual({
      targetUrl: "https://example.com/report",
    });

    expect(trackedLinks[0].clickCount).toBe(1);
    expect(trackedLinks[0].firstClickedAt).toBeInstanceOf(Date);
    expect(trackedLinks[0].lastClickedAt).toBeInstanceOf(Date);
  });

  it.each(["source", "source-revoke-restore", "caller", "edition-run"])("withholds tracked URL after %s changes during click update", async mode => {
    const { instrumentNewspaperHtmlLinks, recordNewspaperLinkClick } = await import("./newspaper-delivery");
    const html = await instrumentNewspaperHtmlLinks({ workspaceId: "ws-1", runKey: "run-1", html: '<a href="https://example.com/private">Private</a>' });
    const token = html.match(/\/api\/newspaper\/click\/([^"]+)/)?.[1] ?? "";
    const update = prismaMock.newspaperTrackedLink.update.getMockImplementation()!;
    prismaMock.newspaperTrackedLink.update.mockImplementationOnce(async args => {
      const result = await update(args);
      if (mode.startsWith("source")) authorityVersion.value += mode.endsWith("restore") ? 2 : 1;
      if (mode === "caller") requireWorkspaceMembershipMock.mockRejectedValue(new Error("member revoked"));
      if (mode === "edition-run") prismaMock.newspaperEdition.findFirst.mockResolvedValue(null);
      return result;
    });
    await expect(recordNewspaperLinkClick({ kind: "user", user: { id: "u-1" } } as any, token))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(trackedLinks[0].clickCount).toBe(1); // aggregate telemetry may survive a denied redirect
  });

  it("stops tracked redirects after the edition becomes unreadable", async () => {
    const { instrumentNewspaperHtmlLinks, recordNewspaperLinkClick } = await import("./newspaper-delivery");
    const html = await instrumentNewspaperHtmlLinks({
      workspaceId: "ws-1", runKey: "run-1", html: '<a href="https://example.com/private">Private</a>',
    });
    const token = html.match(/\/api\/newspaper\/click\/([^"]+)/)?.[1] ?? "";
    readableArtifactIdsMock.mockResolvedValueOnce(new Set());

    await expect(recordNewspaperLinkClick({ kind: "user", user: { id: "u-1" } } as any, token))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(trackedLinks[0].clickCount).toBe(0);
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

    await expect(recordNewspaperLinkClick({ kind: "user", user: { id: "u-1" } } as any, "missing-token")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    await expect(recordNewspaperLinkClick({ kind: "user", user: { id: "u-1" } } as any, "bad-token")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("returns aggregate run summaries with clicked link counts", async () => {
    prismaMock.newspaperDelivery.groupBy.mockResolvedValue([{runKey: "run-1", _max: {createdAt: new Date("2026-05-01T12:02:00.000Z")}}]);
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
      { id: "link-1", runKey: "run-1", clickCount: 2 },
      { id: "link-2", runKey: "run-1", clickCount: 0 },
    ]);

    await expect(listNewspaperDeliverySummaries({ kind: "user", user: { id: "u-1" } } as any, "ws-1")).resolves.toMatchObject({complete: true, items: [
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
    ]});
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor: { kind: "user", user: { id: "u-1" } },
      workspaceId: "ws-1",
    });
  });

  it("samples permitted groups from one bounded delivery window", async () => {
    const {listNewspaperDeliverySummaries} = await import("./newspaper-delivery");
    const time = new Date("2026-10-14T00:00:00Z");
    const hidden = {id: "hidden", runKey: "hidden-run", createdAt: time, status: "SENT"};
    const recent = Array.from({length: 120}, (_, index) => ({id: `recent-${index}`, runKey: "recent-run",
      createdAt: new Date(time.getTime() - 1000 - index), status: index % 2 ? "FAILED" : "SENT"}));
    const older = Array.from({length: 5_100}, (_, index) => ({id: `old-${index}`, runKey: `old-run-${index}`,
      createdAt: new Date(time.getTime() - 100_000 - index), status: "SENT"}));
    const all = [hidden, ...recent, ...older];
    prismaMock.newspaperDelivery.groupBy.mockResolvedValue([
      {runKey: hidden.runKey, _max: {createdAt: hidden.createdAt}},
      {runKey: "recent-run", _max: {createdAt: recent[0].createdAt}},
      {runKey: older[0].runKey, _max: {createdAt: older[0].createdAt}},
    ]);
    prismaMock.newspaperDelivery.findMany.mockImplementation(async ({where, take}) => {
      const before = where.OR?.[0].createdAt.lt;
      return all.filter(row => (!where.runKey || row.runKey === where.runKey) && (!before || row.createdAt < before)).slice(0, take);
    });
    prismaMock.newspaperTrackedLink.findMany.mockResolvedValue([]);
    readableArtifactIdsMock.mockImplementation(async (_actor, _workspace, _kind, rows) => new Set(rows.filter(row => row.id !== hidden.id).map(row => row.id)));
    const result = await listNewspaperDeliverySummaries({kind: "user", user: {id: "u-1"}} as any, "ws-1", {take: 1});
    expect(result).toMatchObject({complete: false, deliveriesComplete: false, items: [expect.objectContaining({runKey: "recent-run", recipientCount: 120, sentCount: 60, failedCount: 60})]});
    expect(prismaMock.newspaperDelivery.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.newspaperTrackedLink.findMany).toHaveBeenCalledWith(expect.objectContaining({where: {workspaceId: "ws-1", runKey: {in: ["recent-run"]}}}));
  });

  it("stops after 200 hidden candidates without claiming empty history", async () => {
    const {listNewspaperDeliverySummaries} = await import("./newspaper-delivery");
    const rows = Array.from({length: 5_003}, (_, index) => ({id: `delivery-${index}`,
      runKey: `run-${index}`, createdAt: new Date(1_800_000_000_000 - index), status: "SENT"}));
    prismaMock.newspaperDelivery.findMany.mockImplementation(async ({take}) => rows.slice(0, take));
    readableArtifactIdsMock.mockResolvedValue(new Set());
    const result = await listNewspaperDeliverySummaries({kind: "user", user: {id: "u-1"}} as any, "ws-1", {take: 1});
    expect(result).toEqual({items: [], complete: false, deliveriesComplete: false, linksComplete: true, scope: "WINDOW"});
    expect(prismaMock.newspaperDelivery.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.newspaperDelivery.groupBy).not.toHaveBeenCalled();
    expect(prismaMock.newspaperTrackedLink.findMany).not.toHaveBeenCalled();
    expect(readableArtifactIdsMock.mock.calls.every(call => call[3].length <= 100)).toBe(true);
  });

  it("keeps one fixed candidate set when rows are inserted during admission", async () => {
    const {listNewspaperDeliverySummaries} = await import("./newspaper-delivery");
    const rows = Array.from({length: 150}, (_, index) => ({id: `row-${index}`, runKey: "run", status: "SENT", createdAt: new Date(index)}));
    prismaMock.newspaperDelivery.findMany.mockImplementation(async ({take}) => rows.slice(0, take));
    let inserted = false;
    readableArtifactIdsMock.mockImplementation(async (_actor, _workspace, _kind, batch) => {
      if (!inserted) { inserted = true; rows.unshift({...rows[0], id: "new-before"}); rows.push({...rows[0], id: "new-after"}); }
      return new Set(batch.map(row => row.id));
    });
    const result = await listNewspaperDeliverySummaries({kind: "user", user: {id: "u-1"}} as any, "ws-1");
    expect(result).toMatchObject({complete: true, items: [{recipientCount: 150}]});
    expect(rows).toHaveLength(152);
    expect(prismaMock.newspaperDelivery.findMany).toHaveBeenCalledTimes(1);
  });

  it("bounds tracked links and retains original delivery proofs through the later query", async () => {
    const {listNewspaperDeliverySummaries} = await import("./newspaper-delivery");
    prismaMock.newspaperDelivery.findMany.mockResolvedValue([{id: "delivery", runKey: "run", status: "SENT", createdAt: new Date()}]);
    const links = Array.from({length: 5_001}, (_, index) => ({id: `link-${index}`, runKey: "run", clickCount: 2}));
    prismaMock.newspaperTrackedLink.findMany.mockImplementation(async ({take}) => links.slice(0, take));
    const actor = {kind: "user", user: {id: "u-1"}} as any;
    expect(await listNewspaperDeliverySummaries(actor, "ws-1")).toMatchObject({complete: false, deliveriesComplete: true, linksComplete: false,
      items: [{trackedLinkCount: 200, totalClickCount: 400}]});
    expect(prismaMock.newspaperTrackedLink.findMany).toHaveBeenCalledTimes(1);
    prismaMock.newspaperTrackedLink.findMany.mockImplementation(async () => { authorityVersion.value++; return []; });
    await expect(listNewspaperDeliverySummaries(actor, "ws-1")).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });

  it("bounds 20 requested summaries over 5020 deliveries to one candidate window", async () => {
    const {listNewspaperDeliverySummaries} = await import("./newspaper-delivery");
    const rows = Array.from({length: 20}, (_, run) => Array.from({length: 251}, (_, recipient) => ({
      id: `delivery-${run}-${recipient}`, runKey: `run-${run}`, status: "SENT",
      createdAt: new Date(1_800_000_000_000 - run * 1000 - recipient), sentAt: null,
    })));
    prismaMock.newspaperDelivery.groupBy.mockResolvedValue(rows.map(run => ({runKey: run[0].runKey, _max: {createdAt: run[0].createdAt}})));
    prismaMock.newspaperDelivery.findMany.mockImplementation(async ({where, take}) => rows.flat()
      .filter(row => (!where.runKey || row.runKey === where.runKey) && (!where.OR || row.createdAt < where.OR[0].createdAt.lt)).slice(0, take));
    prismaMock.newspaperTrackedLink.findMany.mockResolvedValue([]);
    const summaries = await listNewspaperDeliverySummaries({kind: "user", user: {id: "u-1"}} as any, "ws-1");
    expect(prismaMock.newspaperDelivery.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.newspaperDelivery.findMany).toHaveBeenCalledWith(expect.objectContaining({take: 200}));
    expect(summaries).toMatchObject({complete: false, deliveriesComplete: false, scope: "WINDOW", items: [expect.objectContaining({recipientCount: 200, sentCount: 200})]});
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

  it("withholds delivery counts and recipient rows when their own input receipts are unreadable", async () => {
    const { listNewspaperDeliverySummaries, listNewspaperDeliveryDetails } = await import("./newspaper-delivery");
    prismaMock.newspaperDelivery.findMany.mockResolvedValue([
      { id: "delivery-hidden", runKey: "run-1", subject: "Restricted subject", status: "SENT" },
    ]);
    readableArtifactIdsMock.mockResolvedValue(new Set());

    expect(await listNewspaperDeliverySummaries({ kind: "user", user: { id: "u-1" } } as any, "ws-1"))
      .toMatchObject({items: [], complete: true});
    expect(await listNewspaperDeliveryDetails({ kind: "user", user: { id: "u-1" } } as any, "ws-1"))
      .toEqual([]);
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
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      take: 50, skip: 0,
    }));
    expect(rows[0]).toEqual(expect.objectContaining({
      id: "edition-1",
      cadence: "WEEKLY",
    }));
  });

  it("withholds editions without a current complete input manifest", async () => {
    const { listNewspaperEditions } = await import("./newspaper-delivery");
    prismaMock.newspaperEdition.findMany.mockResolvedValueOnce([
      { id: "old-edition", workspaceId: "ws-1", title: "Restricted payroll", digestJson: {}, bodyMd: "Secret" },
    ]);
    readableArtifactIdsMock.mockResolvedValueOnce(new Set());

    expect(await listNewspaperEditions({ kind: "user", user: { id: "u-1" } } as any, "ws-1"))
      .toEqual([]);
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
    expect(diagnostics.sourceCounts).toBeNull();
    expect(diagnostics.recentJobs).toHaveLength(1);
    expect(diagnostics.recentDeliveries[0]).toEqual(expect.objectContaining({
      status: "SKIPPED",
      error: null,
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
        error: null,
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
