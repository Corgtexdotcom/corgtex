import { describe, expect, it, beforeEach, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: {
      informationCategoryPolicy: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      artifactInputLineage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
      artifactInputSnapshot: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
      brainSource: { findFirst: vi.fn() },
      nativeTranscriptInput: { create: vi.fn(), findFirst: vi.fn() },
      workspaceFeatureFlag: {
        findUnique: vi.fn(),
      },
      knowledgeChunk: {
        findMany: vi.fn(),
      },
      document: {
        findMany: vi.fn(),
      },
      brainArticle: {
        findMany: vi.fn(),
      },
      circle: {
        findMany: vi.fn(),
      },
      role: {
        findMany: vi.fn(),
      },
      event: {
        findMany: vi.fn(),
      },
      communicationChannel: {
        findMany: vi.fn(),
      },
      communicationMessage: {
        findMany: vi.fn(),
      },
      meeting: {
        update: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      member: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      tension: {
        findMany: vi.fn(),
      },
      action: {
        findMany: vi.fn(),
      },
      proposal: {
        findMany: vi.fn(),
      },
      meetingInsight: {
        findMany: vi.fn(),
      },
      deliberationEntry: {
        findMany: vi.fn(),
      },
    },
  };
});

vi.mock("../../shared/src/env", () => ({env:{ENCRYPTION_KEY:"a".repeat(64)}}));

vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE", "FINANCE"]) }));

vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "member-1", role: "ADMIN" }) }));

vi.mock("./source-lineage", async importOriginal => ({
  inspectStoredArtifactInputDependencies: (await importOriginal<typeof import("./source-lineage")>()).inspectStoredArtifactInputDependencies,
  advanceHumanArtifactInputLineage: vi.fn(),
  captureArtifactInputProof: vi.fn(async (_actor: unknown, _workspace: string, inputs: Array<{ kind: string; id: string }>) =>
    inputs.map((input) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }))),
  captureArtifactInputSnapshotProof: vi.fn(async () => [{ kind: "ArtifactInputSnapshot", id: "snapshot-1", fingerprint: "b".repeat(64) }]),
  currentArtifactInputRoots: vi.fn(async () => [{ kind: "MeetingTranscript", id: "meeting-2", fingerprint: "a".repeat(64) }]),
  isArtifactInputProofReadable: vi.fn(async () => true),
  preserveUnknownArtifactInputSnapshot: vi.fn(),
  recordArtifactInputLineage: vi.fn(),
  lineageContentFingerprint: vi.fn(() => "safehash"),
  readableArtifactIds: vi.fn(async (_actor: unknown, _workspaceId: string, _kind: string, records: Array<{ id: string }>) =>
    new Set(records.map((record) => record.id))),
}));

import { prisma, type AppActor } from "@corgtex/shared";
import { buildMeetingIntelligenceContext, persistMeetingSummaryWithLineage, readMeetingInputBatches } from "./meeting-intelligence-context";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage, readableArtifactIds } from "./source-lineage";

describe("meeting-intelligence-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, records) => new Set(records.map((record) => record.id)));
    vi.mocked(isArtifactInputProofReadable).mockResolvedValue(true);
    vi.mocked(lineageContentFingerprint).mockReturnValue("safehash");
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (callback) => callback(prisma));
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    (prisma.workspaceFeatureFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });
    (prisma.meeting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "meeting-2",
      workspaceId: "ws-1",
      title: "Weekly progress review",
      source: "recorder",
      transcript: "We discussed the open onboarding tension and the pricing proposal.",
      summaryMd: "Current weekly summary",
      ingestionGuidanceMd: "Use Corporate Rebels spelling.",
      recordedAt: new Date("2026-05-13T16:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-13T17:00:00.000Z"),
      seriesId: "series-1",
      series: { id: "series-1", title: "Weekly progress review", recurrenceRule: "FREQ=WEEKLY" },
      participantIds: ["user-1"],
      participantEmails: ["alice@example.com"],
    });
    (prisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "member-1",
        userId: "user-1",
        user: { id: "user-1", displayName: "Alice", email: "alice@example.com" },
        roleAssignments: [
          { id: "assignment-1", role: { id: "role-1", circleId: "circle-1", circle: { id: "circle-1", name: "Operations" } } },
        ],
      },
    ]);
    (prisma.tension.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "tension-1",
        title: "Onboarding handoff unclear",
        status: "OPEN",
        priority: 4,
        bodyMd: "The handoff needs an owner.",
        upvotes: [{ id: "vote-1", tensionId: "tension-1", userId: "user-1", createdAt: new Date("2026-05-01") }],
        circle: { id: "circle-1", name: "Operations" },
        assigneeMember: null,
        raisedByMember: { user: { id: "user-1", displayName: "Alice", email: "alice@example.com" } },
      },
    ]);
    (prisma.action.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "action-1",
        title: "Send onboarding checklist",
        status: "OPEN",
        dueAt: new Date("2026-05-20T12:00:00.000Z"),
        bodyMd: "Send the latest checklist.",
        circle: { id: "circle-1", name: "Operations" },
        assigneeMember: { user: { id: "user-1", displayName: "Alice", email: "alice@example.com" } },
      },
    ]);
    (prisma.proposal.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "proposal-1",
        title: "Pricing proposal",
        status: "OPEN",
        summary: "Clarify pricing ownership.",
        bodyMd: "Proposal body.",
        circle: { id: "circle-1", name: "Operations" },
        author: { displayName: "Alice", email: "alice@example.com" },
        tensions: [{ id: "tension-1", title: "Onboarding handoff unclear", status: "OPEN" }],
        actions: [],
      },
    ]);
    (prisma.meeting.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "meeting-1",
        title: "Weekly progress review",
        recordedAt: new Date("2026-05-06T16:00:00.000Z"),
        summaryMd: "Previous weekly summary",
        decisionsJson: { items: [] },
      },
    ]);
    (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "follow-up-1",
        meetingId: "meeting-1",
        type: "FOLLOW_UP",
        operation: "CREATE",
        status: "SUGGESTED",
        title: "Review onboarding next week",
        bodyMd: "Carry this forward.",
        assigneeHint: "Alice",
        targetEntityType: null,
        targetEntityId: null,
        appliedEntityType: null,
        appliedEntityId: null,
      },
      {
        id: "resolved-1",
        meetingId: "meeting-1",
        type: "TENSION",
        operation: "RESOLVE",
        status: "APPLIED",
        title: "Clarified onboarding threshold",
        bodyMd: "Resolved in the previous weekly.",
        assigneeHint: null,
        targetEntityType: "Tension",
        targetEntityId: "tension-old",
        appliedEntityType: "Tension",
        appliedEntityId: "tension-old",
      },
      {
        id: "created-action-1",
        meetingId: "meeting-1",
        type: "ACTION_ITEM",
        operation: "CREATE",
        status: "APPLIED",
        title: "Send onboarding checklist",
        bodyMd: "Created last meeting.",
        assigneeHint: "Alice",
        targetEntityType: null,
        targetEntityId: null,
        appliedEntityType: "Action",
        appliedEntityId: "action-1",
      },
    ]);
    (prisma.deliberationEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "entry-1",
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        entryType: "REACTION",
        bodyMd: "Concern about rollout timing.",
        author: { displayName: "Alice", email: "alice@example.com" },
        createdAt: new Date("2026-05-12T12:00:00.000Z"),
      },
    ]);
    (prisma.knowledgeChunk.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "chunk-1",
        sourceType: "MEETING",
        sourceId: "meeting-1",
        sourceTitle: "Weekly progress review",
        chunkIndex: 0,
        content: "Previous weekly summary mentioned onboarding and pricing.",
        sensitivity: "PUBLIC",
        metadata: { sourceContentHash: "safehash" },
      },
      {
        id: "chunk-2",
        sourceType: "SLACK",
        sourceId: "slack-1",
        sourceTitle: "ops channel",
        chunkIndex: 0,
        content: "Unrelated lunch thread.",
        sensitivity: "PUBLIC",
      },
      {
        id: "chunk-3",
        sourceType: "PROPOSAL",
        sourceId: "private-proposal",
        sourceTitle: "Private proposal",
        chunkIndex: 0,
        content: "Private proposal pricing should not be visible.",
        sensitivity: "PUBLIC",
      },
      {
        id: "chunk-4",
        sourceType: "PROPOSAL",
        sourceId: "proposal-1",
        sourceTitle: "Pricing proposal",
        chunkIndex: 0,
        content: "Confidential pricing proposal should not be visible.",
        sensitivity: "CONFIDENTIAL",
      },
    ]);
    (prisma.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "document-1" }]);
    (prisma.brainArticle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "brain-1" }]);
    (prisma.circle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "circle-1" }]);
    (prisma.role.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "role-1" }]);
    (prisma.event.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "event-1" }]);
    (prisma.communicationChannel.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { installationId: "slack-installation-1", externalChannelId: "C123" },
    ]);
    (prisma.communicationMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "slack-1" }]);
  });

  it("selects recurring-meeting continuity, open governance records, deliberation, and broad knowledge", async () => {
    const context = await buildMeetingIntelligenceContext({
      workspaceId: "ws-1",
      meetingId: "meeting-2",
      mode: "insights",
    });

    expect(context.contextualIntelligenceEnabled).toBe(true);
    expect(context.previousMeetings).toEqual([
      expect.objectContaining({ id: "meeting-1", summaryMd: "Previous weekly summary" }),
    ]);
    expect(context.tensions).toEqual([
      expect.objectContaining({ id: "tension-1", title: "Onboarding handoff unclear", upvotes: 1 }),
    ]);
    expect(context.actions).toEqual([
      expect.objectContaining({ id: "action-1", owner: "Alice" }),
    ]);
    expect(context.proposals).toEqual([
      expect.objectContaining({ id: "proposal-1", title: "Pricing proposal" }),
    ]);
    expect(prisma.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["DRAFT", "OPEN", "IN_PROGRESS"] }, isPrivate: false }),
    }));
    expect(prisma.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["DRAFT", "OPEN"] }, isPrivate: false }),
    }));
    expect(prisma.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["DRAFT", "OPEN"] }, isPrivate: false }),
    }));
    expect(context.followUps).toEqual([
      expect.objectContaining({ id: "follow-up-1", owner: "Alice" }),
    ]);
    expect(context.resolvedTensions).toEqual([
      expect.objectContaining({ id: "resolved-1", targetEntityId: "tension-old" }),
    ]);
    expect(context.createdFromPreviousMeeting).toEqual([
      { meetingId: "meeting-1", entityType: "Action", entityId: "action-1" },
    ]);
    expect(context.deliberationEntries).toEqual([
      expect.objectContaining({ id: "entry-1", parentId: "proposal-1" }),
    ]);
    expect(context.knowledge).toEqual([
      expect.objectContaining({ chunkId: "chunk-1", sourceType: "MEETING" }),
    ]);
    expect(prisma.knowledgeChunk.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        sensitivity: "PUBLIC",
        OR: expect.arrayContaining([
          expect.objectContaining({ sourceType: "MEETING", sourceId: { in: expect.arrayContaining(["meeting-1", "meeting-2"]) } }),
          expect.objectContaining({ sourceType: "PROPOSAL", sourceId: { in: ["proposal-1"] } }),
        ]),
      }),
    }));
  });

  it("keeps broad knowledge and deliberation disabled when the workspace flag is off", async () => {
    (prisma.workspaceFeatureFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const context = await buildMeetingIntelligenceContext({
      workspaceId: "ws-1",
      meetingId: "meeting-2",
      mode: "summary",
    });

    expect(context.contextualIntelligenceEnabled).toBe(false);
    expect(context.knowledge).toEqual([]);
    expect(prisma.member.findMany).not.toHaveBeenCalled();
    expect(prisma.tension.findMany).not.toHaveBeenCalled();
    expect(prisma.action.findMany).not.toHaveBeenCalled();
    expect(prisma.proposal.findMany).not.toHaveBeenCalled();
    expect(prisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(prisma.deliberationEntry.findMany).not.toHaveBeenCalled();
  });

  it("keeps agenda context scoped to participant circles even when the intelligence flag is off", async () => {
    (prisma.workspaceFeatureFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const context = await buildMeetingIntelligenceContext({
      workspaceId: "ws-1",
      meetingId: "meeting-2",
      mode: "agenda",
    });

    expect(context.contextualIntelligenceEnabled).toBe(true);
    expect(prisma.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ["OPEN"] },
        publishedAt: { not: null },
        OR: expect.arrayContaining([
          expect.objectContaining({ circleId: { in: ["circle-1"] } }),
          expect.objectContaining({ raisedByMemberId: { in: ["member-1"] } }),
        ]),
      }),
    }));
    expect(prisma.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ["OPEN", "IN_PROGRESS"] },
        publishedAt: { not: null },
      }),
    }));
    expect(prisma.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ["OPEN"] },
        publishedAt: { not: null },
      }),
    }));
  });

  it("withholds a proposal from model context when its input lineage is not readable", async () => {
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, records) =>
      kind === "Proposal" ? new Set() : new Set(records.map((record) => record.id)));
    const context = await buildMeetingIntelligenceContext({ workspaceId: "ws-1", meetingId: "meeting-2", mode: "insights" });
    expect(context.proposals).toEqual([]);
    expect(context.knowledge.every((item) => item.sourceType !== "PROPOSAL")).toBe(true);
  });
  it("redacts unknown summary, blocks, agenda and series before first safe summary generation", async () => {
    (prisma.workspaceFeatureFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: false });
    (prisma.meeting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "meeting-2", workspaceId: "ws-1",
      title: "Original title", source: "manual", transcript: "Original transcript", summaryMd: "Unknown finance summary",
      blocksJson: { secret: "Unknown finance blocks" }, agendaJson: { secret: "Unknown agenda" },
      ingestionGuidanceMd: null, recordedAt: new Date("2026-05-13"), seriesId: "series-1",
      series: { id: "series-1", title: "Unknown series", recurrenceRule: null }, participantIds: [], participantEmails: [] });
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspace, kind, rows) =>
      new Set(kind === "MeetingTranscript" ? rows.map((row) => row.id) : []));
    const context = await buildMeetingIntelligenceContext({ workspaceId: "ws-1", meetingId: "meeting-2", mode: "summary" });
    expect(context.meeting.transcript).toBe("Original transcript");
    expect(context.meeting.summaryMd).toBeNull();
    expect(context.meeting.blocksJson).toBeNull();
    expect(context.meeting.agendaJson).toBeNull();
    expect(context.meeting.seriesTitle).toBeNull();
    expect(context.lineageInputs).toEqual([{ kind: "MeetingTranscript", id: "meeting-2" }]);
    expect(JSON.stringify(context)).not.toContain("Unknown finance");
    const rawSnapshot = vi.mocked(captureArtifactInputProof).mock.calls[0][2][0].snapshot;
    expect(rawSnapshot).not.toHaveProperty("summaryMd");
    expect(rawSnapshot).not.toHaveProperty("updatedAt");
  });

  it("withholds insights generation when its full Meeting parent has no readable receipt", async () => {
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspace, kind, rows) =>
      new Set(kind === "MeetingTranscript" ? rows.map((row) => row.id) : []));
    await expect(buildMeetingIntelligenceContext({ workspaceId: "ws-1", meetingId: "meeting-2", mode: "insights" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prisma.action.findMany).not.toHaveBeenCalled();
  });

  it("gates continuity rows before limits and captures every admitted prompt source", async () => {
    const actor = { kind: "user", user: { id: "user-1", email: "alice@example.com", displayName: "Alice" } } as const;
    const makeAction = (id: string) => ({ id, title: id.startsWith("hidden") ? "Payroll secret" : "Visible action",
      status: "OPEN", bodyMd: "Action body", priority: 1, circle: null, assigneeMember: null, dueAt: null });
    (prisma.action.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...Array.from({ length: 50 }, (_, index) => makeAction(`hidden-${index}`)), makeAction("visible-action")]);
    vi.mocked(readableArtifactIds).mockImplementation(async (reader, workspace, _kind, rows) => {
      expect(reader).toEqual(actor); expect(workspace).toBe("ws-1");
      return new Set(rows.filter((row) => !row.id.startsWith("hidden")).map((row) => row.id));
    });
    const context = await buildMeetingIntelligenceContext({ actor, workspaceId: "ws-1", meetingId: "meeting-2", mode: "insights" });
    expect(context.actions.map((row) => row.id)).toEqual(["visible-action"]);
    expect((prisma.action.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].take).toBe(100);
    expect(context.lineageInputs).toEqual(expect.arrayContaining([
      { kind: "MeetingTranscript", id: "meeting-2" }, { kind: "Meeting", id: "meeting-2" },
      { kind: "Action", id: "visible-action" }, { kind: "Tension", id: "tension-1" },
      { kind: "TensionUpvote", id: "vote-1" }, { kind: "Proposal", id: "proposal-1" },
      { kind: "Meeting", id: "meeting-1" }, { kind: "MeetingInsight", id: "follow-up-1" },
      { kind: "DeliberationEntry", id: "entry-1" }, { kind: "KnowledgeChunk", id: "chunk-1" },
      { kind: "Member", id: "member-1" }, { kind: "User", id: "user-1" },
      { kind: "Role", id: "role-1" }, { kind: "Circle", id: "circle-1" },
    ]));
    expect(JSON.stringify(context)).not.toContain("Payroll secret");
  });

  it("commits a summary and its full receipt in one transaction", async () => {
    const actor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "summary", workspaceIds: ["ws-1"] };
    const roots = [{ kind: "MeetingTranscript" as const, id: "meeting-2", fingerprint: "a".repeat(64) }];
    (prisma.meeting.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "meeting-2", workspaceId: "ws-1", summaryMd: "Generated" });
    const result = await persistMeetingSummaryWithLineage(actor, { workspaceId: "ws-1", meetingId: "meeting-2",
      sourceStateHash: "safehash", lineageInputs: [{ kind: "MeetingTranscript", id: "meeting-2" }], lineageRoots: roots,
      summaryMd: "Generated", blocksJson: { version: 1, blocks: [] } });
    expect(result.count).toBe(1);
    expect(recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: prisma,
      artifact: { kind: "Meeting", id: "meeting-2" }, content: expect.objectContaining({ summaryMd: "Generated" }),
      inputs: [{ kind: "MeetingTranscript", id: "meeting-2" }], inheritedRoots: roots,
    }));
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it("rejects stale state or revoked prompt inputs before writing summary content", async () => {
    const actor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "summary", workspaceIds: ["ws-1"] };
    const params = { workspaceId: "ws-1", meetingId: "meeting-2", sourceStateHash: "old-state",
      lineageInputs: [{ kind: "MeetingTranscript" as const, id: "meeting-2" }],
      lineageRoots: [{ kind: "MeetingTranscript" as const, id: "meeting-2", fingerprint: "a".repeat(64) }],
      summaryMd: "Stale output", blocksJson: { version: 1, blocks: [] } };
    await expect(persistMeetingSummaryWithLineage(actor, params)).resolves.toMatchObject({ count: 0, reason: "source_changed" });
    expect(prisma.meeting.update).not.toHaveBeenCalled();
    vi.mocked(isArtifactInputProofReadable).mockResolvedValue(false);
    await expect(persistMeetingSummaryWithLineage(actor, { ...params, sourceStateHash: "safehash" }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(prisma.meeting.update).not.toHaveBeenCalled();
    expect(recordArtifactInputLineage).not.toHaveBeenCalled();
  });

  it("keeps real summary receipts readable across self rewrites and withholds them after finance revocation", async () => {
    const actual = await vi.importActual<typeof import("./source-lineage")>("./source-lineage");
    const { resolveKnowledgeAccessDomains } = await import("./brain-access");
    const { captureArtifactInputSnapshotProof, preserveUnknownArtifactInputSnapshot } = await import("./source-lineage");
    const manifests: any[] = []; const snapshots: any[] = [];
    (prisma.$executeRaw as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(1);
    installSourcePermissionEpochFixture(prisma);
    let meeting: any = { id: "meeting-real", workspaceId: "ws-1", informationCategory: "GENERAL", title: "Public original", source: "manual",
      transcript: "Public transcript", summaryMd: "Unknown legacy summary", blocksJson: { secret: "Unknown blocks" }, decisionsJson: { secret: "Unknown decisions" }, agendaJson: { secret: "Unknown agenda" },
      ingestionGuidanceMd: null, recordedAt: new Date("2026-05-01"), scheduledEndAt: null, seriesId: null,
      participantIds: [], participantEmails: [], archivedAt: null, createdAt: new Date("2026-05-01"), updatedAt: new Date("2026-05-01") };
    const source: any = { id: "finance-source", workspaceId: "ws-1", informationCategory: "GENERAL", accessDomain: "FINANCE", content: "Finance fact",
      title: "Synthetic direct human finance original", sourceType: "RFC", archivedAt: null, authorMemberId: "member-1",
      metadata: null, createdAt: new Date("2026-05-01"), updatedAt: new Date("2026-05-01") };
    (prisma.meeting.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async ({ where, select }) => {
      if (where.id !== meeting.id || where.workspaceId !== meeting.workspaceId) return null;
      return select ? Object.fromEntries(Object.keys(select).map((field) => [field, meeting[field]])) : meeting;
    });
    (prisma.meeting.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => {
      const clean = Object.fromEntries(Object.entries(data).map(([field, value]) => [field, String(value) === "Prisma.JsonNull" ? null : value]));
      meeting = { ...meeting, ...clean, updatedAt: new Date(meeting.updatedAt.getTime() + 1000) }; return meeting;
    });
    (prisma.brainSource.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }) => where.id === source.id && where.workspaceId === source.workspaceId ? source : null);
    (prisma.artifactInputLineage.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }) =>
      [...manifests].reverse().find((row) => row.workspaceId === where.workspaceId && row.artifactType === where.artifactType && row.artifactId === where.artifactId) ?? null);
    (prisma.artifactInputLineage.findMany as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }) =>
      [...manifests].reverse().filter((row) => row.workspaceId === where.workspaceId && row.artifactType === where.artifactType && where.artifactId.in.includes(row.artifactId)));
    (prisma.artifactInputLineage.create as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => { manifests.push(data); return data; });
    (prisma.artifactInputSnapshot.create as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => {
      const row = { id: `snapshot-${snapshots.length + 1}`, ...data }; snapshots.push(row); return row;
    });
    (prisma.artifactInputSnapshot.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }) => snapshots.find((row) => row.id === where.id && row.workspaceId === where.workspaceId) ?? null);
    (prisma.artifactInputSnapshot.findMany as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }) =>
      snapshots.filter(row => row.workspaceId === where.workspaceId && where.id.in.includes(row.id)));
    vi.mocked(isArtifactInputProofReadable).mockImplementation(actual.isArtifactInputProofReadable);
    vi.mocked(lineageContentFingerprint).mockImplementation(actual.lineageContentFingerprint);
    vi.mocked(recordArtifactInputLineage).mockImplementation(actual.recordArtifactInputLineage);
    vi.mocked(captureArtifactInputSnapshotProof).mockImplementation(actual.captureArtifactInputSnapshotProof);
    vi.mocked(preserveUnknownArtifactInputSnapshot).mockImplementation(actual.preserveUnknownArtifactInputSnapshot);
    const actor: AppActor = { kind: "user", user: { id: "user-1", email: "alice@example.test", displayName: "Alice" } };
    // This is a new explicit native human fixture. The unknown legacy Meeting remains unproven.
    await actual.recordArtifactInputLineage({ tx: prisma, actor, workspaceId: "ws-1", artifact: { kind: "BrainSource", id: source.id },
      content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    const { requireWorkspaceMembership } = await import("./auth");
    vi.mocked(requireWorkspaceMembership).mockResolvedValue({ id: "member-1", userId: "user-1", role: "ADMIN" } as any);
    (prisma.member.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "member-1", userId: "user-1", workspaceId: "ws-1", isActive: true });
    const nativeInputs: any[] = [];
    (prisma.nativeTranscriptInput.create as ReturnType<typeof vi.fn>).mockImplementation(async ({data}) => {
      const input = {id: `native-${nativeInputs.length+1}`,createdAt:new Date("2026-05-01"),...data};nativeInputs.push(input);return input;
    });
    (prisma.nativeTranscriptInput.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async ({where}) => nativeInputs.find(input=>input.id===where.id&&input.workspaceId===where.workspaceId)??null);
    vi.mocked(captureArtifactInputProof).mockImplementation(actual.captureArtifactInputProof);
    const { captureDirectMemberTranscriptInput, directMemberTranscriptRoots } = await import("./native-transcript-input");
    const submission = {workspaceId:"ws-1",title:"Public original",source:"manual",transcript:"Public transcript"};
    const original = await captureDirectMemberTranscriptInput(actor,{workspaceId:"ws-1",submission});
    const transcriptRoots = await directMemberTranscriptRoots(actor,"ws-1",submission,original);
    const projection = Object.fromEntries(["id","workspaceId","title","source","externalId","calendarExternalId","meetingUrl","meetingUrlHash",
      "transcript","ingestionGuidanceMd","recordedAt","scheduledEndAt","seriesId","participantIds","participantEmails","archivedAt","createdAt"]
      .map(field=>[field,meeting[field]??null]));
    await actual.recordArtifactInputLineage({tx:prisma,actor,workspaceId:"ws-1",artifact:{kind:"MeetingTranscript",id:meeting.id},content:projection,
      origin:"DERIVED",inputs:[],inheritedRoots:transcriptRoots});
    const inputs = [{ kind: "MeetingTranscript" as const, id: meeting.id }, { kind: "BrainSource" as const, id: source.id }];
    const roots = await actual.captureArtifactInputProof(actor, "ws-1", inputs, prisma);
    await persistMeetingSummaryWithLineage(actor, { workspaceId: "ws-1", meetingId: meeting.id,
      sourceStateHash: actual.lineageContentFingerprint("Meeting", meeting), lineageInputs: inputs, lineageRoots: roots,
      summaryMd: "Generated finance-aware summary", blocksJson: { version: 1, blocks: [] } });
    expect(await actual.readableArtifactIds(actor, "ws-1", "Meeting", [meeting], prisma)).toEqual(new Set([meeting.id]));
    const secondInputs = [...inputs, { kind: "Meeting" as const, id: meeting.id }];
    const secondRoots = await actual.captureArtifactInputProof(actor, "ws-1", secondInputs, prisma);
    await persistMeetingSummaryWithLineage(actor, { workspaceId: "ws-1", meetingId: meeting.id,
      sourceStateHash: actual.lineageContentFingerprint("Meeting", meeting), lineageInputs: secondInputs, lineageRoots: secondRoots,
      summaryMd: "Rewritten summary with prior context", blocksJson: { version: 1, blocks: [] } });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].origin).toBe("UNKNOWN");
    expect(snapshots[0].contentJson.summaryMd).toBe("Unknown legacy summary");
    expect(snapshots[0].contentJson.decisionsJson).toEqual({ secret: "Unknown decisions" });
    expect(await actual.readableArtifactIds(actor, "ws-1", "ArtifactInputSnapshot", [snapshots[0]], prisma)).toEqual(new Set());
    expect(manifests.at(-1).rootsJson).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ArtifactInputSnapshot", id: snapshots[0].id })]));
    expect(meeting.decisionsJson).toBeNull();
    expect(meeting.agendaJson).toBeNull();
    expect(await actual.readableArtifactIds(actor, "ws-1", "Meeting", [meeting], prisma)).toEqual(new Set([meeting.id]));
    vi.mocked(resolveKnowledgeAccessDomains).mockResolvedValue(["WORKSPACE"]);
    expect(await actual.readableArtifactIds(actor, "ws-1", "Meeting", [meeting], prisma)).toEqual(new Set());
    const raw = Object.fromEntries(["id", "workspaceId", "title", "source", "transcript", "ingestionGuidanceMd", "recordedAt",
      "scheduledEndAt", "seriesId", "participantIds", "participantEmails", "archivedAt", "createdAt"].map((field) => [field, meeting[field]])) as any;
    expect(await actual.readableArtifactIds(actor, "ws-1", "MeetingTranscript", [raw], prisma)).toEqual(new Set([meeting.id]));
    expect(meeting.transcript).toBe("Public transcript");
  });

  it("continues keyset pages through hidden inputs before applying the visible limit", async () => {
    const rows = Array.from({ length: 105 }, (_, index) => ({ id: `row-${index}`, visible: index >= 100 }));
    const read = vi.fn(async (page: { take: number; cursor?: { id: string }; skip?: number }) => {
      const start = page.cursor ? rows.findIndex((row) => row.id === page.cursor!.id) + 1 : 0;
      return rows.slice(start, start + page.take);
    });
    const result = await readMeetingInputBatches(read, async (page) => page.filter((row) => row.visible), 3);
    expect(result.map((row) => row.id)).toEqual(["row-100", "row-101", "row-102"]);
    expect(read).toHaveBeenNthCalledWith(1, { take: 100 });
    expect(read).toHaveBeenNthCalledWith(2, { take: 100, cursor: { id: "row-99" }, skip: 1 });
  });

  it("fails closed at the explicit scan budget instead of returning a silently truncated list", async () => {
    let offset = 0;
    const read = vi.fn(async ({ take }: { take: number }) => Array.from({ length: take }, () => ({ id: `row-${offset++}` })));
    await expect(readMeetingInputBatches(read, async () => []))
      .rejects.toMatchObject({ code: "MEETING_READ_BUDGET", status: 413 });
    expect(read).toHaveBeenCalledTimes(50);
    expect(offset).toBe(5_000);
  });

});
