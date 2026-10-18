import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockCrmLinkClosure = vi.hoisted(() => vi.fn().mockResolvedValue({ activities: [], deals: [], contacts: [], accountIds: [] }));
const prismaMock = vi.hoisted(() => {
  const mock = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    crmAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    crmActivity: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    crmContact: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    crmConversation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    crmConversationMessage: {upsert: vi.fn()},
    meeting: {
      findFirst: vi.fn(),
    },
    meetingInsight: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
    },
  };
  mock.$transaction.mockImplementation((fn: any) => fn(mock));
  return mock;
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

// This suite exercises active CRM gathering, never native archive presentation.
// Isolate the unused presentation import graph rather than supplying fake provider grants.
const unexpectedDirectPresentation = vi.hoisted(() => vi.fn(() => {
  throw new Error("CRM information gathering must not enter direct archive presentation.");
}));
vi.mock("./crm-direct-original-read", () => ({
  admitCrmDirectOriginalRows: unexpectedDirectPresentation,
  assertCrmDirectReadCurrent: unexpectedDirectPresentation,
  trackCrmDirectOrdinaryRows: unexpectedDirectPresentation,
}));
afterEach(() => { expect(unexpectedDirectPresentation).not.toHaveBeenCalled(); });

vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async () => ({ id: "member-1", role: "ADMIN" })) }));
vi.mock("./meeting-intelligence-context", () => ({ meetingTranscriptInputProjection: (row: Record<string, unknown>) => Object.fromEntries(
  ["id", "workspaceId", "title", "source", "transcript", "recordedAt", "participantEmails"].map((field) => [field, row[field]])) }));
vi.mock("./source-lineage", () => ({
  readableArtifactIds: vi.fn(async (_actor: unknown, _ws: string, _kind: string, rows: Array<{ id: string }>) => new Set(rows.map((row) => row.id))),
  captureArtifactInputProof: vi.fn(async (_actor: unknown, _ws: string, inputs: Array<{ kind: string; id: string }>) => inputs.map((input) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }))),
  isArtifactInputProofReadable: vi.fn(async () => true),
  lineageContentFingerprint: vi.fn((kind: string, row: unknown) => JSON.stringify({ kind, row })),
  recordArtifactInputLineage: vi.fn(),
  assertArtifactInputWriteFence: vi.fn(async () => {}),
}));

const emailClaimCurrent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./oauth-provider-native", () => ({getOAuthEmailSyncPublication: (_token: unknown, workspaceId: string, connectionId: string, messages: Array<{id: string}>) => ({
  workspaceId, connectionId, sourceTransactionGuard: (operation: () => Promise<unknown>) => operation(), actor: {kind: "user", user: {id: "owner"}}, assertCurrent: emailClaimCurrent,
  messages: messages.map(message => ({message, roots: [{kind: "Document", id: `document-${message.id}`, fingerprint: "a".repeat(64)}]})),
})}));
vi.mock("./artifact-commit-preflight", () => ({prepareArtifactCommitPreflight: vi.fn(async () => ({})),
  withArtifactCommitPreflight: vi.fn(async (_actor: unknown, _workspaceId: string, _tx: unknown, _roots: unknown, _token: unknown, work: () => Promise<unknown>) => work()),
}));

const meetingActor = { kind: "agent" as const, authProvider: "bootstrap" as const, label: "synthetic-crm", workspaceIds: ["workspace-1"] };
vi.mock("./crm-archive-guards", () => ({ lockCrmLinkClosure }));
import {
  createCrmMeetingReviewInsights,
  materializeCrmCalendarTouchpoints,
  materializeCrmEmailTouchpoints as materializeProvenCrmEmailTouchpoints,
  safeCrmEmailFilters,
} from "./crm-information-gathering";

// Provider capture is isolated in this pre-existing CRM projection suite; real native
// capability, account replay, claim and transactional proofs are covered by OAuth PG tests.
const materializeCrmEmailTouchpoints = (params: Omit<Parameters<typeof materializeProvenCrmEmailTouchpoints>[0], "publication">) =>
  materializeProvenCrmEmailTouchpoints({...params, publication: {} as Parameters<typeof materializeProvenCrmEmailTouchpoints>[0]["publication"]});

describe("crm information gathering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock));
    prismaMock.crmContact.findUnique.mockImplementation(async ({where}) => ({id: where.id, workspaceId: "workspace-1",
      accountId: where.id === "z-contact" ? "z-account" : where.id === "a-contact" ? "a-account" : "account-1",
      email: where.id === "z-contact" ? "z@example.test" : where.id === "a-contact" ? "a@example.test" : "buyer@example.test"}));
    prismaMock.crmAccount.findUnique.mockImplementation(async ({where}) => ({id: where.id, workspaceId: "workspace-1"}));
    prismaMock.crmConversationMessage.upsert.mockImplementation(async ({create}) => create);
    prismaMock.crmContact.findFirst.mockResolvedValue(null);
    prismaMock.crmAccount.findFirst.mockResolvedValue(null);
    prismaMock.crmActivity.findUnique.mockResolvedValue(null);
    prismaMock.crmActivity.findMany.mockResolvedValue([]);
    prismaMock.crmActivity.create.mockResolvedValue({ id: "activity-1" });
    prismaMock.crmActivity.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.crmConversation.findUnique.mockResolvedValue(null);
    prismaMock.crmConversation.create.mockResolvedValue({ id: "conversation-1" });
    prismaMock.crmConversation.update.mockResolvedValue({ id: "conversation-1" });
    prismaMock.meeting.findFirst.mockResolvedValue(null);
    prismaMock.meetingInsight.findMany.mockResolvedValue([]);
    prismaMock.meetingInsight.createMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingInsight.findFirst.mockResolvedValue({
      id: "insight-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      type: "CRM_ACTIVITY",
      status: "SUGGESTED",
    });
  });

  it("keeps CRM email materialization behind explicit business email filters", () => {
    expect(safeCrmEmailFilters([
      "",
      "newer_than:30d",
      "from:person@gmail.com",
      "from:buyer@example.test",
      "to:@customer.io",
      "FROM:BUYER@example.test",
    ])).toEqual(["from:buyer@example.test", "to:@customer.io"]);
  });

  it("materializes matched OAuth email once and updates on repeated sync without duplicate conversations", async () => {
    prismaMock.crmContact.findFirst.mockResolvedValue({
      id: "contact-1",
      name: "Buyer",
      email: "buyer@example.test",
      company: "Example",
      account: { id: "account-1", name: "Example", domain: "example.test" },
    });
    prismaMock.crmActivity.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "activity-1", sourceExternalId: "oauth-email:conn-1:google:msg-1" }]);
    prismaMock.crmConversation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "conversation-1" });
    const message = {
      id: "msg-1",
      provider: "GOOGLE" as const,
      subject: "Pilot next steps",
      from: "Buyer <buyer@example.test>",
      receivedAt: new Date("2026-06-18T09:00:00.000Z"),
      webUrl: "https://mail.test/msg-1",
      snippet: "Let's continue the pilot.",
      filter: "from:buyer@example.test",
    };

    const first = await materializeCrmEmailTouchpoints({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      messages: [message],
    });
    const second = await materializeCrmEmailTouchpoints({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      messages: [message],
    });

    expect(first).toMatchObject({ activitiesCreated: 1, conversationsCreated: 1 });
    expect(second).toMatchObject({ activitiesUpdated: 1, conversationsUpdated: 1 });
    expect(prismaMock.crmContact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      archivedAt: null, OR: [{ accountId: null }, { account: { archivedAt: null } }],
    }) }));
    expect(prismaMock.crmConversation.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.crmConversation.update).toHaveBeenCalledTimes(1);
  });

  it("skips unsafe email filters before matching CRM records", async () => {
    await materializeCrmEmailTouchpoints({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      messages: [{
        id: "msg-1",
        provider: "MICROSOFT",
        subject: "Broad result",
        from: "buyer@example.test",
        receivedAt: null,
        webUrl: null,
        snippet: "This came from a broad query.",
        filter: "newer_than:30d",
      }],
    });

    expect(prismaMock.crmContact.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.crmConversation.create).not.toHaveBeenCalled();
  });

  it("locks and skips an archived activity during repeated email materialization", async () => {
    prismaMock.crmContact.findFirst.mockResolvedValue({ id: "contact-1", name: "Buyer", email: "buyer@example.test", company: "Example",
      account: { id: "account-1", name: "Example", domain: "example.test" } });
    prismaMock.crmActivity.findMany.mockResolvedValue([{ id: "activity-1", sourceExternalId: "oauth-email:conn-1:google:msg-1" }]);
    prismaMock.crmActivity.updateMany.mockResolvedValue({ count: 0 });
    const result = await materializeCrmEmailTouchpoints({ workspaceId: "workspace-1", connectionId: "conn-1", messages: [{
      id: "msg-1", provider: "GOOGLE", subject: "Archived", from: "buyer@example.test",
      receivedAt: null, webUrl: null, snippet: "Do not overwrite.", filter: "from:buyer@example.test",
    }] });
    expect(lockCrmLinkClosure).toHaveBeenCalledWith(prismaMock, "workspace-1", { activityId: "activity-1" },
      { contactId: "contact-1", accountId: "account-1" });
    expect(prismaMock.crmActivity.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ archivedAt: null }) }));
    expect(result.activitiesUpdated).toBe(0);
  });
  it("matches calendar events by existing business-domain accounts", async () => {
    prismaMock.crmContact.findUnique.mockImplementation(async ({where}) => ({id: where.id, workspaceId: "workspace-1",
      accountId: where.id === "z-contact" ? "z-account" : where.id === "a-contact" ? "a-account" : "account-1",
      email: where.id === "z-contact" ? "z@example.test" : where.id === "a-contact" ? "a@example.test" : "buyer@example.test"}));
    prismaMock.crmAccount.findUnique.mockImplementation(async ({where}) => ({id: where.id, workspaceId: "workspace-1"}));
    prismaMock.crmConversationMessage.upsert.mockImplementation(async ({create}) => create);
    prismaMock.crmContact.findFirst.mockResolvedValue(null);
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: "account-1", name: "Example", domain: "example.test" });

    const result = await materializeCrmCalendarTouchpoints({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      events: [{
        id: "event-1",
        provider: "GOOGLE",
        title: "Pilot kickoff",
        description: "Discuss kickoff",
        startTime: new Date("2026-06-18T10:00:00.000Z"),
        endTime: new Date("2026-06-18T10:30:00.000Z"),
        attendees: ["buyer@example.test"],
        organizerEmail: "owner@corgtex.com",
        meetingUrl: null,
        htmlLink: "https://calendar.test/event-1",
        status: null,
      }],
    });

    expect(result).toMatchObject({ activitiesCreated: 1 });
    expect(prismaMock.crmActivity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        accountId: "account-1",
        contactId: null,
        type: "MEETING",
        source: "oauth_calendar",
      }),
    }));
  });

  it("locks and skips an archived activity during repeated calendar materialization", async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: "account-1", name: "Example", domain: "example.test" });
    prismaMock.crmActivity.findMany.mockResolvedValue([{ id: "activity-1", sourceExternalId: "oauth-calendar:conn-1:google:event-1" }]);
    prismaMock.crmActivity.updateMany.mockResolvedValue({ count: 0 });
    const result = await materializeCrmCalendarTouchpoints({ workspaceId: "workspace-1", connectionId: "conn-1", events: [{
      id: "event-1", provider: "GOOGLE", title: "Archived", description: null, startTime: new Date("2026-06-18T10:00:00.000Z"),
      endTime: new Date("2026-06-18T10:30:00.000Z"), attendees: ["buyer@example.test"], organizerEmail: null,
      meetingUrl: null, htmlLink: null, status: null,
    }] });
    expect(lockCrmLinkClosure).toHaveBeenCalledWith(prismaMock, "workspace-1", { activityId: "activity-1" },
      { contactId: null, accountId: "account-1" });
    expect(result.activitiesUpdated).toBe(0);
  });
  it("locks the deduplicated existing activity batch before the first mutation", async () => {
    prismaMock.crmContact.findFirst.mockResolvedValue({ id: "contact-1", name: "Buyer", email: "buyer@example.test", company: "Example",
      account: { id: "account-1", name: "Example", domain: "example.test" } });
    prismaMock.crmActivity.findMany.mockResolvedValue([
      { id: "z-activity", sourceExternalId: "oauth-email:conn-1:google:z" },
      { id: "a-activity", sourceExternalId: "oauth-email:conn-1:google:a" },
    ]);
    await materializeCrmEmailTouchpoints({ workspaceId: "workspace-1", connectionId: "conn-1", messages: ["z", "a", "z"].map((id) => ({
      id, provider: "GOOGLE" as const, subject: id, from: "buyer@example.test", receivedAt: null, webUrl: null,
      snippet: id, filter: "from:buyer@example.test",
    })) });
    expect(prismaMock.crmActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      sourceExternalId: { in: ["oauth-email:conn-1:google:z", "oauth-email:conn-1:google:a"] },
    }) }));
    expect(lockCrmLinkClosure).toHaveBeenCalledTimes(1);
    expect(lockCrmLinkClosure.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.crmActivity.updateMany.mock.invocationCallOrder[0]!);
  });
  it("locks all matched parents once and skips a match archived after discovery", async () => {
    prismaMock.crmContact.findFirst
      .mockResolvedValueOnce({ id: "z-contact", email: "z@example.test", account: { id: "z-account" } })
      .mockResolvedValueOnce({ id: "a-contact", email: "a@example.test", account: { id: "a-account" } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "a-contact" });
    const result = await materializeCrmEmailTouchpoints({ workspaceId: "workspace-1", connectionId: "conn-1",
      messages: ["z", "a"].map((id) => ({ id, provider: "GOOGLE" as const, subject: id, from: `${id}@example.test`,
        receivedAt: null, webUrl: null, snippet: id, filter: `from:${id}@example.test` })) });
    expect(lockCrmLinkClosure).toHaveBeenCalledTimes(1);
    expect(lockCrmLinkClosure).toHaveBeenCalledWith(prismaMock, "workspace-1",
      { contactId: "z-contact", accountId: "z-account" }, { contactId: "a-contact", accountId: "a-account" });
    expect(result).toMatchObject({ skippedUnmatched: 1, activitiesCreated: 1 });
  });
  it("revalidates the exact email identity after locking", async () => {
    prismaMock.crmContact.findFirst
      .mockResolvedValueOnce({ id: "contact-1", email: "buyer@example.test", account: { id: "account-1", domain: "example.test" } })
      .mockResolvedValueOnce(null);
    const result = await materializeCrmEmailTouchpoints({ workspaceId: "workspace-1", connectionId: "conn-1", messages: [{
      id: "msg-1", provider: "GOOGLE", subject: "Stale", from: "buyer@example.test", receivedAt: null,
      webUrl: null, snippet: "Do not write.", filter: "from:buyer@example.test",
    }] });
    expect(result).toMatchObject({ skippedUnmatched: 1, activitiesCreated: 0 });
    expect(prismaMock.crmActivity.create).not.toHaveBeenCalled();
  });
  it("revalidates the exact account domain after locking", async () => {
    prismaMock.crmAccount.findFirst
      .mockResolvedValueOnce({ id: "account-1", name: "Example", domain: "example.test" })
      .mockResolvedValueOnce(null);
    const result = await materializeCrmCalendarTouchpoints({ workspaceId: "workspace-1", connectionId: "conn-1", events: [{
      id: "event-1", provider: "GOOGLE", title: "Stale", description: null, startTime: new Date(), endTime: new Date(),
      attendees: ["buyer@example.test"], organizerEmail: null, meetingUrl: null, htmlLink: null, status: null,
    }] });
    expect(result).toMatchObject({ skippedUnmatched: 1, activitiesCreated: 0 });
    expect(prismaMock.crmActivity.create).not.toHaveBeenCalled();
  });
  it("creates reviewable CRM meeting suggestions from matched meeting participants", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      title: "Pilot review",
      transcript: "We should send the next step and discuss pricing for the pilot.",
      summaryMd: "Pilot pricing and follow up.",
      recordedAt: new Date("2026-06-18T10:00:00.000Z"),
      participantEmails: ["buyer@example.test"],
    });
    prismaMock.crmContact.findFirst.mockResolvedValue({
      id: "contact-1",
      name: "Buyer",
      email: "buyer@example.test",
      company: "Example",
      account: { id: "account-1", name: "Example", domain: "example.test" },
    });

    await createCrmMeetingReviewInsights(meetingActor, { workspaceId: "workspace-1", meetingId: "meeting-1" });

    expect(prismaMock.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        type: "CRM_ACTIVITY",
        metadataJson: expect.objectContaining({
          crm: expect.objectContaining({ accountId: "account-1", contactId: "contact-1" }),
        }),
      })],
      skipDuplicates: true,
    }));
    expect(prismaMock.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        type: "CRM_DEAL",
        metadataJson: expect.objectContaining({
          crm: expect.objectContaining({ recordType: "CRM_DEAL", contactId: "contact-1" }),
        }),
      })],
      skipDuplicates: true,
    }));
  });
  it("captures every admitted CRM match and meeting input in each created suggestion", async () => {
    const { captureArtifactInputProof, recordArtifactInputLineage } = await import("./source-lineage");
    prismaMock.meeting.findFirst.mockResolvedValue({ id: "meeting-1", workspaceId: "workspace-1", title: "Pilot",
      transcript: "Pilot follow up", summaryMd: "Pricing", participantEmails: ["buyer@example.test"], recordedAt: new Date() });
    prismaMock.crmContact.findFirst.mockResolvedValue({ id: "contact-full", workspaceId: "workspace-1", email: "buyer@example.test", name: "Buyer",
      company: "Example", account: { id: "account-full", workspaceId: "workspace-1", name: "Example", domain: "example.test" } });
    await createCrmMeetingReviewInsights(meetingActor, { workspaceId: "workspace-1", meetingId: "meeting-1" });
    expect(captureArtifactInputProof).toHaveBeenCalledWith(meetingActor, "workspace-1", [expect.objectContaining({ kind: "CrmContact", id: "contact-full",
      snapshot: expect.objectContaining({ name: "Buyer", email: "buyer@example.test" }) })], prismaMock);
    expect(recordArtifactInputLineage).toHaveBeenCalledTimes(3);
    for (const [params] of vi.mocked(recordArtifactInputLineage).mock.calls) {
      expect(params.inputs).toEqual(expect.arrayContaining([{ kind: "Meeting", id: "meeting-1" }, { kind: "CrmContact", id: "contact-full" }, { kind: "CrmAccount", id: "account-full" }]));
      expect(params.inheritedRoots).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Meeting", id: "meeting-1" }),
        expect.objectContaining({ kind: "CrmContact", id: "contact-full" }), expect.objectContaining({ kind: "CrmAccount", id: "account-full" })]));
      expect(params.transitiveOnlyKinds).toEqual(["Meeting"]);
    }
  });

  it("does not use unknown summaries or restricted CRM match bodies", async () => {
    const { readableArtifactIds, captureArtifactInputProof } = await import("./source-lineage");
    prismaMock.meeting.findFirst.mockResolvedValue({ id: "meeting-1", workspaceId: "workspace-1", title: "Public meeting",
      transcript: "Hello buyer@example.test", summaryMd: "Secret pricing pilot follow up", participantEmails: ["buyer@example.test"], recordedAt: new Date() });
    prismaMock.crmContact.findFirst.mockResolvedValue({ id: "restricted-contact", name: "Finance secret", email: "buyer@example.test",
      company: "Finance secret company", account: { id: "restricted-account", name: "Finance secret account" } });
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: "restricted-account", name: "Finance secret account" });
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _ws, kind, rows) => new Set(kind === "MeetingTranscript" ? rows.map((row) => row.id) : []));
    await createCrmMeetingReviewInsights(meetingActor, { workspaceId: "workspace-1", meetingId: "meeting-1" });
    const writes = prismaMock.meetingInsight.createMany.mock.calls.flatMap(([params]) => params.data);
    expect(writes).toHaveLength(1); expect(writes[0].type).toBe("CRM_CONTACT");
    expect(JSON.stringify(writes)).not.toContain("secret");
    expect(captureArtifactInputProof).toHaveBeenCalledWith(meetingActor, "workspace-1", [expect.objectContaining({ kind: "MeetingTranscript",
      snapshot: expect.not.objectContaining({ summaryMd: expect.anything() }) })]);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _ws, _kind, rows) => new Set(rows.map((row) => row.id)));
  });

  it("rejects a stale meeting revision before creating CRM suggestions", async () => {
    const before = { id: "meeting-1", workspaceId: "workspace-1", title: "Original", transcript: "Hello buyer@example.test",
      summaryMd: "Original", participantEmails: ["buyer@example.test"], recordedAt: new Date() };
    prismaMock.meeting.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, summaryMd: "Changed" });
    await expect(createCrmMeetingReviewInsights(meetingActor, { workspaceId: "workspace-1", meetingId: "meeting-1" }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(prismaMock.meetingInsight.createMany).not.toHaveBeenCalled();
  });

  it("keeps replay idempotent and preserves earlier generations through source changes and restoration", async () => {
    const { captureArtifactInputProof, recordArtifactInputLineage, readableArtifactIds } = await import("./source-lineage");
    const stored: any[] = []; const receipts = new Map<string, string>();
    const meeting = { id: "meeting-1", workspaceId: "workspace-1", title: "Original", transcript: "Hello buyer@example.test",
      summaryMd: "First summary", participantEmails: ["buyer@example.test"], recordedAt: new Date() };
    prismaMock.meeting.findFirst.mockImplementation(async () => ({ ...meeting }));
    prismaMock.meetingInsight.findFirst.mockImplementation(async ({ where }) => [...stored].reverse().find((row) =>
      where.dedupeKey ? row.dedupeKey === where.dedupeKey : where.OR?.some((clause: any) => typeof clause.dedupeKey === "string"
        ? row.dedupeKey === clause.dedupeKey : row.dedupeKey.startsWith(clause.dedupeKey.startsWith))) ?? null);
    prismaMock.meetingInsight.findMany.mockImplementation(async ({ where }) => [...stored].reverse().filter((row) =>
      where.OR.some((clause: any) => typeof clause.dedupeKey === "string" ? row.dedupeKey === clause.dedupeKey : row.dedupeKey.startsWith(clause.dedupeKey.startsWith))));
    prismaMock.meetingInsight.createMany.mockImplementation(async ({ data }) => {
      if (stored.some((row) => row.dedupeKey === data[0].dedupeKey)) return { count: 0 };
      stored.push({ id: `generated-${stored.length + 1}`, reviewedAt: null, supersededAt: null, ...data[0] }); return { count: 1 };
    });
    prismaMock.meetingInsight.updateMany.mockImplementation(async ({ where, data }) => {
      const outdated = stored.filter((row) => row.status === "SUGGESTED" && !row.supersededAt && !where.dedupeKey.notIn.includes(row.dedupeKey));
      outdated.forEach((row) => Object.assign(row, data)); return { count: outdated.length };
    });
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_actor, _ws, inputs) => inputs.map((input) => ({ kind: input.kind,
      id: input.id, fingerprint: JSON.stringify(input.snapshot) })));
    vi.mocked(recordArtifactInputLineage).mockImplementation(async ({ content, artifact }) => { receipts.set(artifact.id, JSON.stringify(content)); return {} as any; });
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _ws, kind, rows) => new Set(rows.filter((row) =>
      kind !== "MeetingInsight" || receipts.get(row.id) === JSON.stringify(row)).map((row) => row.id)));
    const params = { workspaceId: "workspace-1", meetingId: "meeting-1" };
    expect(await createCrmMeetingReviewInsights(meetingActor, params)).toHaveLength(1);
    expect(await createCrmMeetingReviewInsights(meetingActor, params)).toHaveLength(0);
    const originalBody = stored[0].bodyMd;
    meeting.summaryMd = "Changed summary";
    expect(await createCrmMeetingReviewInsights(meetingActor, params)).toHaveLength(1);
    expect(stored[0].supersededAt).toBeInstanceOf(Date); expect(stored[0].bodyMd).toBe(originalBody);
    meeting.summaryMd = "First summary";
    expect(await createCrmMeetingReviewInsights(meetingActor, params)).toHaveLength(1);
    expect(stored[2].dedupeKey.split(":").slice(0, 2)).toEqual(stored[0].dedupeKey.split(":").slice(0, 2));
    expect(stored[2].dedupeKey).not.toBe(stored[0].dedupeKey);
    expect(await createCrmMeetingReviewInsights(meetingActor, params)).toHaveLength(0);
    expect(stored).toHaveLength(3); expect(stored[0].bodyMd).toBe(originalBody);
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_actor, _ws, inputs) => inputs.map((input) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
    vi.mocked(recordArtifactInputLineage).mockReset();
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _ws, _kind, rows) => new Set(rows.map((row) => row.id)));
  });

});
