import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  buildMeetingIntelligenceContextMock,
  createActionMock,
  updateActionMock,
  createProposalMock,
  createProposalFromTensionMock,
  createActivityMock,
  createContactMock,
  createCrmMeetingReviewInsightsMock,
  createDealMock,
  resolveProposalMock,
  submitProposalMock,
  createTensionMock,
  updateTensionMock,
  postDeliberationEntryMock,
} = vi.hoisted(() => ({
  buildMeetingIntelligenceContextMock: vi.fn(),
  createActionMock: vi.fn(),
  updateActionMock: vi.fn(),
  createProposalMock: vi.fn(),
  createProposalFromTensionMock: vi.fn(),
  createActivityMock: vi.fn(),
  createContactMock: vi.fn(),
  createCrmMeetingReviewInsightsMock: vi.fn(),
  createDealMock: vi.fn(),
  resolveProposalMock: vi.fn(),
  submitProposalMock: vi.fn(),
  createTensionMock: vi.fn(),
  updateTensionMock: vi.fn(),
  postDeliberationEntryMock: vi.fn(),
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: {
      $transaction: vi.fn(),
      member: {
        findMany: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: "member-123", workspaceId: "ws-1", userId: "user-123", role: "ADMIN", isActive: true }),
      },
      meeting: {
        update: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
      action: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      tension: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      proposal: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      policyCorpus: {
        upsert: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
      workspaceFeatureFlag: {
        findUnique: vi.fn(),
      },
      meetingInsight: {
        create: vi.fn(),
        createMany: vi.fn(),
        deleteMany: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      meetingTranscriptSourceRecord: {
        findFirst: vi.fn(),
      },
    },
  };
});

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    extract: vi.fn(),
  },
}));

vi.mock("./actions", () => ({
  createAction: createActionMock,
  updateAction: updateActionMock,
}));

vi.mock("./proposals", () => ({
  createProposal: createProposalMock,
  createProposalFromTension: createProposalFromTensionMock,
  resolveProposal: resolveProposalMock,
  submitProposal: submitProposalMock,
}));

vi.mock("./tensions", () => ({
  createTension: createTensionMock,
  updateTension: updateTensionMock,
}));

vi.mock("./crm", () => ({
  createActivity: createActivityMock,
  createContact: createContactMock,
  createDeal: createDealMock,
}));

vi.mock("./crm-information-gathering", () => ({
  createCrmMeetingReviewInsights: createCrmMeetingReviewInsightsMock,
  crmInsightPayload: (metadataJson: any) => metadataJson?.crm ?? {},
  requireCrmInsightEmail: (payload: any) => {
    if (!payload?.email) throw new Error("CRM contact insight requires a valid email.");
    return String(payload.email).trim().toLowerCase();
  },
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn(),
}));

vi.mock("./deliberation", () => ({
  postDeliberationEntry: postDeliberationEntryMock,
}));

vi.mock("./meeting-intelligence-context", () => ({
  buildMeetingIntelligenceContext: buildMeetingIntelligenceContextMock,
}));

import { prisma } from "@corgtex/shared";
import { humanMemberIdentityWhere, isHumanMemberIdentity } from "./member-identity";
import { 
  extractMeetingInsights, 
  confirmInsight, 
  dismissInsight, 
  updateInsight,
  applyInsight,
  autoApplyMeetingInsights,
  confirmAllInsights
} from "./meeting-intelligence";

const mockActor = {
  kind: "user" as const,
  user: { id: "user-123", email: "test@example.com", displayName: "Test User" },
};

describe("meeting-intelligence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mocks
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(prisma));
    buildMeetingIntelligenceContextMock.mockResolvedValue({
      contextualIntelligenceEnabled: false,
      meeting: {
        id: "meeting-1",
        workspaceId: "ws-1",
        title: "Weekly sync",
        source: "manual",
        transcript: "Alice: I will follow up tomorrow.",
        summaryMd: null,
        blocksJson: null,
        ingestionGuidanceMd: "Prioritize follow-up actions.",
        recordedAt: new Date("2026-04-29T12:00:00.000Z"),
        scheduledEndAt: null,
        seriesId: null,
        seriesTitle: null,
        participantIds: [],
        participantEmails: [],
      },
      attendees: [],
      previousMeetings: [],
      tensions: [],
      actions: [],
      proposals: [],
      followUps: [],
      deliberationEntries: [],
      knowledgeSearchQuery: "",
      knowledge: [],
    });
    (prisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "member-raised",
        user: {
          displayName: "Milan",
          email: "milan@example.com",
        },
      },
    ]);
    createActionMock.mockResolvedValue({ id: "action-1" });
    updateActionMock.mockResolvedValue({ id: "action-1" });
    createProposalMock.mockResolvedValue({ id: "proposal-1" });
    createProposalFromTensionMock.mockResolvedValue({ id: "proposal-from-tension-1" });
    createActivityMock.mockResolvedValue({ id: "activity-1" });
    createContactMock.mockResolvedValue({ id: "contact-1" });
    createCrmMeetingReviewInsightsMock.mockResolvedValue([]);
    createDealMock.mockResolvedValue({ id: "deal-1" });
    resolveProposalMock.mockResolvedValue({ id: "proposal-1" });
    submitProposalMock.mockResolvedValue({ proposalId: "proposal-1" });
    createTensionMock.mockResolvedValue({ id: "tension-1" });
    updateTensionMock.mockResolvedValue({ id: "tension-1" });
    postDeliberationEntryMock.mockResolvedValue({ id: "deliberation-1" });
    (prisma.meeting.findFirst as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
    (prisma.meetingInsight.findFirst as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
    (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
    (prisma.meetingInsight.updateMany as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({ count: 0 });
    (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
    (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.workspaceFeatureFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  describe("extractMeetingInsights", () => {
    it("should call model gateway to extract structured insights and create records", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "ACTION_ITEM",
              operation: "CREATE",
              title: "#001 > Cortex Next Steps - follow up on email",
              body: "**CONTEXT:** Received Cortex customer feedback\n**REQUEST:** Need to follow up\n**ANSWER:** Alice will follow up in Cortex\n**RESULT:** OPEN",
              assigneeHint: "Alice",
              dueAt: "2026-04-30T17:00:00.000Z",
              confidence: 0.9,
              sourceQuote: "I will follow up in Cortex tomorrow",
            }
          ]
        }
      });

      // Mock dependencies
      (prisma.meeting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "meeting-1",
        workspaceId: "ws-1",
        transcript: "Alice: I will follow up tomorrow.",
        ingestionGuidanceMd: "Prioritize follow-up actions.",
      });
      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1"
      });

      const extractCall = vi.mocked(defaultModelGateway.extract).mock.calls[0]?.[0] as { instruction: string; input: string; workspaceId: string };
      expect(extractCall.workspaceId).toBe("ws-1");
      expect(extractCall.instruction).not.toContain("Number items sequentially");
      expect(extractCall.instruction).not.toContain("**CONTEXT:**");
      expect(extractCall.instruction).toContain("Treat owner-backed commitments as ACTION_ITEM");
      expect(extractCall.input).toContain("Prioritize follow-up actions.");
      expect(defaultModelGateway.extract).toHaveBeenCalledWith(expect.objectContaining({
        instruction: expect.stringContaining("trusted operator context for spelling, name, and terminology corrections"),
      }));
      expect(defaultModelGateway.extract).toHaveBeenCalledWith(expect.objectContaining({
        instruction: expect.stringContaining("Cortex means Corgtex"),
      }));
      expect(defaultModelGateway.extract).toHaveBeenCalledWith(expect.objectContaining({
        input: expect.stringContaining("Alice: I will follow up tomorrow."),
      }));
      expect(prisma.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
        data: [expect.objectContaining({
          type: "ACTION_ITEM",
          title: "Corgtex Next Steps - follow up on email",
          bodyMd: expect.stringContaining("### Outcome"),
          sourceQuote: "I will follow up in Corgtex tomorrow",
          dueAt: new Date("2026-04-30T17:00:00.000Z"),
        })],
      }));
      expect(prisma.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
        data: [expect.objectContaining({
          bodyMd: expect.stringContaining("Corgtex customer feedback"),
        })],
      }));
    });

    it("passes meeting blocks to extraction and persists block labels on suggested insights", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "DECISION",
              operation: "CREATE",
              title: "#001 > Template proposal - connect decisions",
              body: "**CONTEXT:** The proposal discussion covered decision formatting.\n**REQUEST:** Tie decisions to proposals.\n**ANSWER:** Decisions should reference the proposal context.\n**RESULT:** PROCESSED",
              confidence: 0.92,
              targetEntityType: "Proposal",
              targetEntityId: "proposal-1",
              blockSequence: 2,
              blockTitle: "Meeting template proposal",
              blockKind: "proposal_discussion",
            },
          ],
        },
      });

      buildMeetingIntelligenceContextMock.mockResolvedValueOnce({
        contextualIntelligenceEnabled: true,
        meeting: {
          id: "meeting-1",
          workspaceId: "ws-1",
          title: "Weekly sync",
          source: "manual",
          transcript: "We discussed the template proposal and decision.",
          summaryMd: "The proposal discussion led to a decision.",
          blocksJson: {
            version: 1,
            blocks: [
              { sequence: 1, title: "Opening check-in", kind: "check_in", summaryMd: "Short check-in." },
              { sequence: 2, title: "Meeting template proposal", kind: "proposal_discussion", summaryMd: "Decision formatting was discussed." },
            ],
          },
          ingestionGuidanceMd: null,
          recordedAt: new Date("2026-04-29T12:00:00.000Z"),
          scheduledEndAt: null,
          seriesId: null,
          seriesTitle: null,
          participantIds: [],
          participantEmails: [],
        },
        attendees: [],
        previousMeetings: [],
        tensions: [],
        actions: [],
        proposals: [{ id: "proposal-1", title: "Meeting template refinement", status: "OPEN" }],
        followUps: [],
        deliberationEntries: [],
        knowledgeSearchQuery: "",
        knowledge: [],
      });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      expect(defaultModelGateway.extract).toHaveBeenCalledWith(expect.objectContaining({
        instruction: expect.stringContaining("Use meetingBlocks as the conversation map"),
        input: expect.stringContaining("Meeting template proposal"),
      }));
      expect(prisma.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
        data: [expect.objectContaining({
          type: "DECISION",
          bodyMd: expect.stringContaining("**MEETING BLOCK:** Meeting template proposal"),
          targetEntityType: "Proposal",
          targetEntityId: "proposal-1",
        })],
      }));
    });

    it("processes long transcripts in full-coverage chunks for insight extraction", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockImplementation(async ({ input }) => {
        const parsed = JSON.parse(input);
        return {
          output: {
            insights: parsed.transcript.includes("TEAM_UPDATE_MARKER")
              ? [
                {
                  type: "ACTION_ITEM",
                  operation: "CREATE",
                  title: "Datise coordinate team update follow-up",
                  body: "Datise will coordinate the TEAM_UPDATE_MARKER follow-up from the team update section.",
                  assigneeHint: "Datise",
                  confidence: 0.9,
                  sourceQuote: "TEAM_UPDATE_MARKER Datise will coordinate",
                  dedupeKey: "action:datise-team-update-follow-up",
                },
              ]
              : [],
          },
        };
      });

      const longTranscript = [
        "Alice: Beginning action item.",
        "Filler ".repeat(2_000),
        "Datise: TEAM_UPDATE_MARKER I will coordinate the team update follow-up.",
        "More filler ".repeat(4_000),
        "Jan: Ending decision.",
      ].join("\n");

      buildMeetingIntelligenceContextMock.mockResolvedValueOnce({
        contextualIntelligenceEnabled: false,
        meeting: {
          id: "meeting-1",
          workspaceId: "ws-1",
          title: "Weekly sync",
          source: "manual",
          transcript: longTranscript,
          summaryMd: "Summary: Alice owns the follow-up and Jan confirmed the decision.",
          blocksJson: null,
          ingestionGuidanceMd: "Prioritize follow-up actions.",
          recordedAt: new Date("2026-04-29T12:00:00.000Z"),
          scheduledEndAt: null,
          seriesId: null,
          seriesTitle: null,
          participantIds: [],
          participantEmails: [],
        },
        attendees: [],
        previousMeetings: [],
        tensions: [],
        actions: [],
        proposals: [],
        followUps: [],
        deliberationEntries: [],
        knowledgeSearchQuery: "",
        knowledge: [],
      });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      const calls = (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
      const inputs = calls.map((call) => JSON.parse(call.input));
      expect(inputs.length).toBeGreaterThan(1);
      expect(inputs.every((input) => input.transcriptChunkedForExtraction === true)).toBe(true);
      expect(inputs.every((input) => input.transcriptCondensedForExtraction === false)).toBe(true);
      expect(inputs.some((input) => input.transcript.includes("TEAM_UPDATE_MARKER"))).toBe(true);
      expect(JSON.stringify(inputs)).not.toContain("BEGINNING EXCERPT");
      expect(JSON.stringify(inputs)).not.toContain("MIDDLE EXCERPT");
      expect(JSON.stringify(inputs)).not.toContain("ENDING EXCERPT");
      expect(prisma.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
        data: [expect.objectContaining({
          type: "ACTION_ITEM",
          title: "Datise coordinate team update follow-up",
          assigneeHint: "Datise",
        })],
      }));
    });

    it("merges exact overlapping commitments despite different model keys and retains late evidence", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const context = await buildMeetingIntelligenceContextMock();
      context.meeting.transcript = "x".repeat(15_400) + "OVERLAP_COMMITMENT" + "x".repeat(35_000) + "LATE_COMMITMENT";
      context.meeting.summaryMd = "Milan will send the invoice. Milan will prepare the report.";
      buildMeetingIntelligenceContextMock.mockResolvedValue(context);
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockImplementation(async ({ input }) => {
        const parsed = JSON.parse(input);
        return { output: { insights: ["OVERLAP_COMMITMENT", "LATE_COMMITMENT"]
          .filter((marker) => parsed.transcript.includes(marker))
          .map((marker) => ({
            type: "ACTION_ITEM", operation: "CREATE", title: `Prepare ${marker}`,
            body: `Milan will prepare ${marker}.`, assigneeHint: "Milan", confidence: 0.95,
            sourceQuote: marker, dedupeKey: `${marker}-chunk-${parsed.transcriptChunk.chunkIndex}`,
          })) } };
      });

      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });

      const calls = (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mock.calls.map(([call]) => call);
      const inputs = calls.map((call) => JSON.parse(call.input));
      expect(inputs.filter((input) => input.transcript.includes("OVERLAP_COMMITMENT"))).toHaveLength(2);
      expect(inputs.at(-1).transcript).toContain("LATE_COMMITMENT");
      expect(inputs.every((input) => input.summaryMd === context.meeting.summaryMd)).toBe(true);
      expect(calls.every((call) => call.instruction.includes("summaryMd alone never authorizes another item"))).toBe(true);
      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data);
      expect(rows.map((row) => row.title)).toEqual(["Prepare OVERLAP_COMMITMENT", "Prepare LATE_COMMITMENT"]);
      expect(rows.every((row) => !row.metadataJson.requiresCommitmentReview)).toBe(true);
    });

    it.each(["ACTION_ITEM", "FOLLOW_UP"])("keeps ambiguous %s commitments reviewable without automatic actions", async (type) => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const shared = { type, operation: "CREATE", title: "Prepare report", assigneeHint: "Milan", confidence: 0.99 };
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [
        { ...shared, body: "Milan will prepare the report.", sourceQuote: "I will prepare it.", dedupeKey: "report-a" },
        { ...shared, body: "Milan will prepare the report.", sourceQuote: "I will prepare it.", dedupeKey: "report-b" },
        { ...shared, body: "Milan owns preparing the report.", sourceQuote: "I own that report.", dedupeKey: "report-c" },
        { ...shared, body: "Milan will prepare the report.", sourceQuote: "Prepare the second report too.", dedupeKey: "report-d" },
      ] } });

      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });

      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data)
        .map((row, index) => ({ ...row, id: `insight-${index}`, meeting: { id: "meeting-1", title: "Weekly sync" } }));
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(3);
      expect(rows.every((row) => row.status === "SUGGESTED" && row.metadataJson.requiresCommitmentReview)).toBe(true);
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
      await expect(autoApplyMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" }))
        .resolves.toMatchObject({ applied: 0, failed: 0, skipped: 3 });
      expect(createActionMock).not.toHaveBeenCalled();
      expect(prisma.meetingInsight.update).not.toHaveBeenCalled();

      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(rows[0]);
      await applyInsight(mockActor, { workspaceId: "ws-1", insightId: rows[0].id });
      expect(createActionMock).toHaveBeenCalledTimes(1);
    });

    it("preserves full bodies, owners, deadlines, operation and resolution targets", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const context = await buildMeetingIntelligenceContextMock();
      context.actions = [{ id: "action-a", title: "Report A" }, { id: "action-b", title: "Report B" }];
      buildMeetingIntelligenceContextMock.mockResolvedValue(context);
      const shared = {
        type: "ACTION_ITEM", operation: "CREATE", title: "Prepare report", body: "Milan will prepare the report.",
        assigneeHint: "Milan", dueAt: "2026-09-15T12:00:00Z", sourceQuote: "I will prepare the report.", confidence: 0.9,
      };
      const items = [
        shared,
        { ...shared, assigneeHint: "Alice" },
        { ...shared, dueAt: "2026-09-16T12:00:00Z" },
        { ...shared, body: "Milan will prepare " + "details ".repeat(100) + "for customer A." },
        { ...shared, body: "Milan will prepare " + "details ".repeat(100) + "for customer B." },
        { ...shared, operation: "RESOLVE", targetEntityType: "Action", targetEntityId: "action-a" },
        { ...shared, operation: "RESOLVE", targetEntityType: "Action", targetEntityId: "action-b" },
      ];
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: {
        insights: items.map((item, index) => ({ ...item, dedupeKey: `item-${index}` })),
      } });

      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });

      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data);
      expect(rows).toHaveLength(7);
      expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(7);
      expect(rows.filter((row) => row.metadataJson.requiresCommitmentReview)).toHaveLength(3);
      expect(rows[1].metadataJson).toEqual({});
      expect(rows[2].metadataJson).toEqual({});
      expect(rows.filter((row) => row.operation === "RESOLVE").map((row) => row.targetEntityId)).toEqual(["action-a", "action-b"]);
    });

    it("compares CREATE commitments using their persisted target semantics", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const context = await buildMeetingIntelligenceContextMock();
      context.actions = [{ id: "action-a", title: "Existing report" }];
      buildMeetingIntelligenceContextMock.mockResolvedValue(context);
      const shared = { type: "ACTION_ITEM", operation: "CREATE", title: "Prepare report", body: "Milan will prepare the report.", assigneeHint: "Milan", confidence: 0.9 };
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [
        { ...shared, targetEntityType: "Action", targetEntityId: "other-workspace-action", confidence: 0.99 },
        { ...shared, dedupeKey: "without-target" },
        { ...shared, targetEntityType: "Action", targetEntityId: "action-a", dedupeKey: "with-target" },
      ] } });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetEntityType: null, targetEntityId: null, confidence: 0.9 });
    });

    it.each([false, true])("flags the whole same-source pending group on replay (repeats original: %s)", async (repeatOriginal) => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const shared = { type: "ACTION_ITEM", operation: "CREATE", title: "Prepare report", assigneeHint: "Milan", confidence: 0.99 };
      const original = { ...shared, body: "Milan will prepare the report.", dedupeKey: "original" };
      const pending = {
        ...shared, id: "existing", workspaceId: "ws-1", meetingId: "meeting-1", sourceRecordId: "source-1",
        bodyMd: original.body, status: "SUGGESTED", reviewedAt: null, supersededAt: null,
        dedupeKey: "legacy-key", metadataJson: { retained: "existing metadata" },
      };
      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "source-1", recordedAt: new Date() });
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([pending]);
      (prisma.meetingInsight.findFirst as ReturnType<typeof vi.fn>).mockImplementation(({ where }) =>
        where.OR?.some((item: Record<string, unknown>) => item.bodyMd === original.body) ? pending : null);
      (prisma.meetingInsight.updateMany as ReturnType<typeof vi.fn>).mockImplementation(({ where, data }) => {
        if (where.id === pending.id) pending.metadataJson = data.metadataJson;
        return { count: 1 };
      });
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [
        ...(repeatOriginal ? [original] : []),
        { ...shared, body: "Milan owns preparing the report.", dedupeKey: "variant" },
      ] } });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      expect(prisma.meetingInsight.findMany).toHaveBeenCalledWith({ where: expect.objectContaining({
        workspaceId: "ws-1", meetingId: "meeting-1", sourceRecordId: "source-1", status: { in: ["SUGGESTED", "CONFIRMED", "APPLIED", "DISMISSED"] }, supersededAt: null,
      }) });
      expect(prisma.meetingInsight.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: pending.id, workspaceId: "ws-1", sourceRecordId: "source-1", status: "SUGGESTED", reviewedAt: null }),
        data: { metadataJson: { retained: "existing metadata", requiresCommitmentReview: true } },
      });
      expect(pending.dedupeKey).toBe("legacy-key");
      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadataJson.requiresCommitmentReview).toBe(true);
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([pending, ...rows]);
      await expect(autoApplyMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" }))
        .resolves.toMatchObject({ applied: 0, failed: 0, skipped: 2 });
      expect(createActionMock).not.toHaveBeenCalled();
    });

    it("does not recreate an exact pending commitment when its legacy key and block decoration differ", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "source-1", recordedAt: new Date() });
      const pending = {
        id: "existing", type: "ACTION_ITEM", operation: "CREATE", title: "Prepare report", assigneeHint: "Milan",
        bodyMd: "**MEETING BLOCK:** Previous block label\n**BLOCK KIND:** update\n\nMILAN WILL PREPARE THE REPORT.",
        sourceQuote: "I will prepare it.", dueAt: null, status: "SUGGESTED", metadataJson: {}, dedupeKey: "old-model-key",
      };
      const baseline = JSON.stringify(pending);
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([pending]);
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [{
        type: "ACTION_ITEM", operation: "CREATE", title: "#12 > Prepare report", assigneeHint: "Milan",
        body: "Milan will prepare the report.", sourceQuote: "I will prepare it.", confidence: 0.9, dedupeKey: "new-model-key",
      }] } });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      expect(prisma.meetingInsight.createMany).not.toHaveBeenCalled();
      expect(prisma.meetingInsight.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: pending.id }),
      }));
      expect(JSON.stringify(pending)).toBe(baseline);
    });

    it("preserves different resolved customer block contexts while merging repeats in the same block", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const context = await buildMeetingIntelligenceContextMock();
      context.meeting.blocksJson = { version: 1, blocks: [
        { sequence: 1, title: "Customer A", kind: "update", summaryMd: "Review Customer A." },
        { sequence: 2, title: "Customer B", kind: "update", summaryMd: "Review Customer B." },
      ] };
      buildMeetingIntelligenceContextMock.mockResolvedValue(context);
      const shared = { type: "ACTION_ITEM", operation: "CREATE", title: "Send the report", body: "Milan will send the report.", assigneeHint: "Milan", sourceQuote: "I will send the report.", confidence: 0.99 };
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [
        { ...shared, blockSequence: 1, dedupeKey: "first" },
        { ...shared, blockTitle: "Customer A", dedupeKey: "repeat" },
        { ...shared, blockSequence: 2, dedupeKey: "second" },
      ] } });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data);
      expect(rows).toHaveLength(2);
      expect(rows[0].bodyMd).toContain("**MEETING BLOCK:** Customer A");
      expect(rows[1].bodyMd).toContain("**MEETING BLOCK:** Customer B");
      expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);
      expect(rows.every((row) => row.metadataJson.requiresCommitmentReview)).toBe(true);
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
      await expect(autoApplyMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" }))
        .resolves.toMatchObject({ applied: 0, skipped: 2 });
      expect(createActionMock).not.toHaveBeenCalled();
    });

    it("preserves same-title blocks of different kinds and reconstructs their identities on replay", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const context = await buildMeetingIntelligenceContextMock();
      context.meeting.blocksJson = { version: 1, blocks: [
        { sequence: 1, title: "Customer review", kind: "update", summaryMd: "Customer update." },
        { sequence: 2, title: "Customer review", kind: "proposal_discussion", summaryMd: "Customer proposal." },
      ] };
      buildMeetingIntelligenceContextMock.mockResolvedValue(context);
      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "source-1", recordedAt: new Date() });
      const shared = { type: "ACTION_ITEM", operation: "CREATE", title: "Send the report", body: "Milan will send the report.", assigneeHint: "Milan", sourceQuote: "I will send the report.", confidence: 0.99 };
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [
        { ...shared, blockSequence: 1 },
        { ...shared, blockSequence: 2 },
        { ...shared, blockTitle: "Customer review", blockKind: "proposal discussion" },
      ] } });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data);
      expect(rows).toHaveLength(2);
      expect(rows[0].bodyMd).toContain("**BLOCK KIND:** update");
      expect(rows[1].bodyMd).toContain("**BLOCK KIND:** proposal discussion");
      expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);
      expect(rows.every((row) => row.metadataJson.requiresCommitmentReview)).toBe(true);
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
      await expect(autoApplyMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" }))
        .resolves.toMatchObject({ applied: 0, skipped: 2 });
      expect(createActionMock).not.toHaveBeenCalled();
      (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mockClear();
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      expect(prisma.meetingInsight.createMany).not.toHaveBeenCalled();
    });

    it.each(["SUGGESTED", "CONFIRMED", "APPLIED", "DISMISSED"])("preserves an exact reviewed legacy %s commitment when a source record is introduced", async (status) => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const legacy = {
        id: "legacy", workspaceId: "ws-1", meetingId: "meeting-1", sourceRecordId: null,
        type: "ACTION_ITEM", operation: "CREATE", title: "Prepare report", assigneeHint: "Milan",
        bodyMd: "Milan will prepare the report.", sourceQuote: "I will prepare it.", dueAt: null,
        status, reviewedAt: new Date("2026-09-01T12:00:00Z"), metadataJson: { retained: true }, dedupeKey: "legacy-key",
      };
      const baseline = JSON.stringify(legacy);
      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "source-1", recordedAt: new Date() });
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }) =>
        where.workspaceId === legacy.workspaceId && where.meetingId === legacy.meetingId && where.sourceRecordId === null ? [legacy] : []);
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [
        { ...legacy, body: legacy.bodyMd, dedupeKey: "new-key" },
        { ...legacy, body: "Milan owns preparing the report.", dedupeKey: "variant" },
      ] } });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data);
      expect(rows).toHaveLength(1);
      expect(rows[0].bodyMd).toBe("Milan owns preparing the report.");
      expect(JSON.stringify(legacy)).toBe(baseline);
      expect(prisma.meetingInsight.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: legacy.id }),
      }));
      expect(prisma.meetingInsight.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ sourceRecordId: null }),
      }));
      expect(prisma.meetingInsight.findMany).toHaveBeenCalledWith({ where: {
        workspaceId: "ws-1", meetingId: "meeting-1", sourceRecordId: null, supersededAt: null,
        operation: "CREATE", type: { in: ["ACTION_ITEM", "FOLLOW_UP"] },
        OR: [{ status: { in: ["CONFIRMED", "APPLIED", "DISMISSED"] } }, { status: "SUGGESTED", reviewedAt: { not: null } }],
      } });
    });

    it("treats action items and follow-ups as one commitment family", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const shared = { operation: "CREATE", title: "Prepare report", body: "Milan will prepare the report.", assigneeHint: "Milan", confidence: 0.99 };
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [
        { ...shared, type: "ACTION_ITEM", dedupeKey: "action" },
        { ...shared, type: "FOLLOW_UP", dedupeKey: "follow-up" },
        { ...shared, type: "FOLLOW_UP", body: "Milan owns preparing the report.", dedupeKey: "variant" },
      ] } });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.metadataJson.requiresCommitmentReview)).toBe(true);
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
      await expect(autoApplyMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" }))
        .resolves.toMatchObject({ applied: 0, skipped: 2 });
      expect(createActionMock).not.toHaveBeenCalled();
    });

    it.each(["SUGGESTED", "CONFIRMED", "APPLIED", "DISMISSED"])("holds a new ambiguous variant without changing a reviewed %s commitment", async (status) => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const reviewed = {
        id: "reviewed", type: "ACTION_ITEM", operation: "CREATE", title: "Prepare report", assigneeHint: "Milan",
        bodyMd: "Milan will prepare the report.", sourceQuote: "I will prepare it.", dueAt: null,
        status, reviewedAt: new Date("2026-09-01T12:00:00Z"), metadataJson: { retained: true }, dedupeKey: "legacy-reviewed",
      };
      const baseline = JSON.stringify(reviewed);
      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "source-1", recordedAt: new Date() });
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([reviewed]);
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [
        { ...reviewed, body: reviewed.bodyMd, dedupeKey: "new-key" },
        { ...reviewed, body: "Milan owns preparing the report.", dedupeKey: "variant" },
      ] } });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      const rows = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap(([call]) => call.data);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadataJson.requiresCommitmentReview).toBe(true);
      expect(JSON.stringify(reviewed)).toBe(baseline);
      expect(prisma.meetingInsight.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ status: "SUGGESTED", reviewedAt: null, sourceRecordId: null }) });
      expect(prisma.meetingInsight.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: reviewed.id }) }));
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
      await expect(autoApplyMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" }))
        .resolves.toMatchObject({ applied: 0, skipped: 1 });
      expect(createActionMock).not.toHaveBeenCalled();
    });

    it("compares quotes after the same terminology correction and truncation used in storage", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const quote = "x".repeat(190) + " Cortex report";
      const storedQuote = quote.replace("Cortex", "Corgtex").slice(0, 200);
      const shared = { type: "ACTION_ITEM", operation: "CREATE", title: "Prepare report", assigneeHint: "Milan", confidence: 0.9 };
      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "source-1", recordedAt: new Date() });
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{
        ...shared, id: "existing", bodyMd: "Milan will prepare the report.", sourceQuote: storedQuote, status: "SUGGESTED", metadataJson: {},
      }]);
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [{
        ...shared, body: "Milan will prepare the report.", sourceQuote: quote, dedupeKey: "new-key",
      }] } });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      expect(prisma.meetingInsight.createMany).not.toHaveBeenCalled();
      expect(prisma.meetingInsight.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "existing" }) }));
    });

    it("extracts named, collective, and coordinator team actions without awareness-only items", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const action = (title: string, body: string, assigneeHint: string, dedupeKey: string) => ({
        type: "ACTION_ITEM",
        operation: "CREATE",
        title,
        body,
        assigneeHint,
        confidence: 0.9,
        sourceQuote: body.slice(0, 80),
        dedupeKey,
      });
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            action("Puncar send email setup testing instructions", "Puncar will send instructions for testing the Microsoft/Zinata email setup to Datise and Andy.", "Puncar", "action:puncar-email-setup-instructions"),
            action("Review CR US website titles and provide photos", "Team members will review their CR US website titles and provide photos for Puncar.", "Team members", "action:team-review-cr-us-titles"),
            action("Post Chicago Ground Campaign document", "Andy will post the Chicago Ground Campaign document on Slack and clarify tactical assignments.", "Andy", "action:andy-post-chicago-ground-campaign"),
            action("Pick up Chicago outreach contacts", "Team members will pick up specific Chicago outreach contacts to follow up and nurture.", "Team members", "action:team-pick-up-chicago-contacts"),
            action("Keep the website reframe in mind", "Everyone should keep this in mind for awareness.", "Everyone", "action:vague-awareness"),
          ],
        },
      });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      const extractCall = (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(extractCall.instruction).toContain("team-update, scorecard, round-robin");
      expect(extractCall.instruction).toContain("extract one collective ACTION_ITEM");
      expect(extractCall.instruction).toContain("vague awareness");

      const saved = (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0].data);
      expect(saved).toEqual(expect.arrayContaining([
        expect.objectContaining({
          title: "Puncar send email setup testing instructions",
          assigneeHint: "Puncar",
        }),
        expect.objectContaining({
          title: "Review CR US website titles and provide photos",
          assigneeHint: "Team members",
        }),
        expect.objectContaining({
          title: "Post Chicago Ground Campaign document",
          assigneeHint: "Andy",
        }),
        expect.objectContaining({
          title: "Pick up Chicago outreach contacts",
          assigneeHint: "Team members",
        }),
      ]));
      expect(saved.filter((item) => item.title === "Review CR US website titles and provide photos")).toHaveLength(1);
      expect(saved.map((item) => item.title)).not.toContain("Keep the website reframe in mind");
    });

    it("skips archived meetings that disappeared before extraction runs", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      const { AppError } = await import("./errors");
      buildMeetingIntelligenceContextMock.mockRejectedValueOnce(new AppError(404, "NOT_FOUND", "Meeting not found."));
      (prisma.meeting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "meeting-1" });

      await expect(extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toEqual([]);

      expect(defaultModelGateway.extract).not.toHaveBeenCalled();
      expect(prisma.meeting.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: "meeting-1",
          workspaceId: "ws-1",
          archivedAt: { not: null },
        }),
      }));
    });

    it("normalizes model insight enum variants before saving", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "RESOLUTION",
              operation: "RESOLVE",
              title: "#001 > Proposal resolved",
              body: "**CONTEXT:** Proposal discussed\n**REQUEST:** Decide outcome\n**ANSWER:** Adopted\n**RESULT:** PROCESSED",
              confidence: 0.85,
              targetEntityType: "Proposal",
              targetEntityId: "proposal-123",
              resolutionOutcome: "adopted",
            },
            {
              type: "ACTION_ITEMS",
              operation: "CREATE",
              title: "#002 > Alice Follow-up",
              body: "**CONTEXT:** Follow-up needed\n**REQUEST:** Email customer\n**ANSWER:** Alice owns it\n**RESULT:** OPEN",
              confidence: 0.7,
              sourceQuote: "x".repeat(240),
            },
            {
              type: "RESOLUTION",
              operation: "CREATE",
              title: "#003 > Unsupported loose resolution",
              body: "No concrete target",
              confidence: 0.5,
            },
            {
              type: "PROPOSAL",
              operation: "RESOLVE",
              title: "#004 > Proposal ambiguous outcome",
              body: "Malformed outcome should not default to adopted",
              confidence: 0.8,
              targetEntityType: "Proposal",
              targetEntityId: "proposal-123",
              resolutionOutcome: "maybe",
            },
            {
              type: "ACTION_ITEM",
              operation: "CREATE",
              title: "   ",
              body: "Empty title should be skipped",
              confidence: 0.7,
            },
            {
              type: "DELIBERATION_ENTRY",
              operation: "RESOLVE",
              title: "#005 > Existing proposal discussion",
              body: "Discussion should become a deliberation note, not a proposal resolution.",
              confidence: 0.9,
              targetEntityType: "Proposal",
              targetEntityId: "proposal-123",
              deliberationEntryType: "reaction",
            },
          ],
        },
      });

      buildMeetingIntelligenceContextMock.mockResolvedValueOnce({
        contextualIntelligenceEnabled: true,
        meeting: {
          id: "meeting-1",
          workspaceId: "ws-1",
          title: "Weekly sync",
          source: "manual",
          transcript: "Meeting transcript.",
          summaryMd: null,
          blocksJson: null,
          ingestionGuidanceMd: null,
          recordedAt: new Date("2026-04-29T12:00:00.000Z"),
          scheduledEndAt: null,
          seriesId: null,
          seriesTitle: null,
          participantIds: [],
          participantEmails: [],
        },
        attendees: [],
        previousMeetings: [],
        tensions: [],
        actions: [],
        proposals: [{ id: "proposal-123", title: "Existing proposal", status: "OPEN" }],
        followUps: [],
        deliberationEntries: [],
        knowledgeSearchQuery: "",
        knowledge: [],
      });
      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      expect(prisma.meetingInsight.createMany).toHaveBeenCalledTimes(3);
      expect(prisma.meetingInsight.createMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
        data: [expect.objectContaining({
          type: "PROPOSAL",
          operation: "RESOLVE",
          targetEntityType: "Proposal",
          targetEntityId: "proposal-123",
          resolutionOutcome: "ADOPTED",
        })],
      }));
      expect(prisma.meetingInsight.createMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
        data: [expect.objectContaining({
          type: "ACTION_ITEM",
          operation: "CREATE",
          title: "Alice Follow-up",
          bodyMd: expect.stringContaining("### Outcome"),
          sourceQuote: "x".repeat(200),
        })],
      }));
      expect(prisma.meetingInsight.createMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
        data: [expect.objectContaining({
          type: "DELIBERATION_ENTRY",
          operation: "CREATE",
          targetEntityType: "Proposal",
          targetEntityId: "proposal-123",
          deliberationEntryType: "REACTION",
        })],
      }));
      expect(prisma.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "meeting-1" },
        data: expect.objectContaining({ aiProcessedAt: expect.any(Date) }),
      }));
    });
  });

  describe("confirmInsight", () => {
    it("updates insight status to CONFIRMED", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        status: "SUGGESTED",
      });

      await confirmInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123"
      });

      expect(prisma.meetingInsight.update).toHaveBeenCalledWith({
        where: { id: "insight-123" },
        data: {
          status: "CONFIRMED",
          reviewedByUserId: "user-123",
          reviewedAt: expect.any(Date),
        },
      });
    });
  });

  describe("updateInsight", () => {
    it("updates editable insight fields and records reviewer metadata", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        status: "SUGGESTED",
      });
      (prisma.meetingInsight.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        title: "Updated title",
      });

      await updateInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123",
        title: "  Updated title  ",
        bodyMd: "  Updated body  ",
        assigneeHint: "  Milan  ",
      });

      expect(prisma.meetingInsight.update).toHaveBeenCalledWith({
        where: { id: "insight-123" },
        data: {
          title: "Updated title",
          bodyMd: "Updated body",
          assigneeHint: "Milan",
          reviewedByUserId: "user-123",
          reviewedAt: expect.any(Date),
        },
      });
    });

    it("rejects edits after an insight has been applied", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        status: "APPLIED",
      });

      await expect(updateInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123",
        title: "Updated title",
      })).rejects.toThrow("Only reviewable insights can be edited.");

      expect(prisma.meetingInsight.update).not.toHaveBeenCalled();
    });
  });

  describe("dismissInsight", () => {
    it("updates insight status to DISMISSED", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        status: "SUGGESTED",
      });

      await dismissInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123"
      });

      expect(prisma.meetingInsight.update).toHaveBeenCalledWith({
        where: { id: "insight-123" },
        data: {
          status: "DISMISSED",
          reviewedByUserId: "user-123",
          reviewedAt: expect.any(Date),
        },
      });
    });
  });

  describe("applyInsight", () => {
    it("is defined and callable", async () => {
      expect(applyInsight).toBeDefined();
    });

    it.each(["ACTION_ITEM", "FOLLOW_UP", "TENSION"])("uses only the active human match for %s despite earlier historical/system duplicates", async (type) => {
      const candidates = [
        { id: "historical", workspaceId: "ws-1", isActive: false, kind: "HUMAN" as const, user: { displayName: "Milan", email: "historical@example.com" } },
        { id: "system", workspaceId: "ws-1", isActive: true, kind: "SYSTEM" as const, user: { displayName: "Milan", email: "system@example.com" } },
        { id: "legacy-system", workspaceId: "ws-1", isActive: true, kind: "HUMAN" as const, user: { displayName: "Milan", email: "support+milan@example.com" } },
        { id: "other-workspace", workspaceId: "ws-2", isActive: true, kind: "HUMAN" as const, user: { displayName: "Milan", email: "other@example.com" } },
        { id: "active-human", workspaceId: "ws-1", isActive: true, kind: "HUMAN" as const, user: { displayName: "Milan", email: "milan@example.com" } },
      ];
      (prisma.member.findMany as ReturnType<typeof vi.fn>).mockImplementation(async (args: Prisma.MemberFindManyArgs) => candidates.filter((member) =>
        member.workspaceId === args?.where?.workspaceId
        && (args.where.isActive !== true || member.isActive)
        && (!args.where.NOT || isHumanMemberIdentity(member))
      ) as never);
      vi.mocked(prisma.meetingInsight.findUnique).mockResolvedValue({
        id: "insight-eligible", workspaceId: "ws-1", meetingId: "meeting-1", type,
        operation: "CREATE", status: "SUGGESTED", title: "Follow up", bodyMd: "Milan will follow up.",
        assigneeHint: "Milan", meeting: { id: "meeting-1", title: "Weekly sync" },
      } as never);

      await applyInsight(mockActor, { workspaceId: "ws-1", insightId: "insight-eligible" });

      expect(prisma.member.findMany).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1", isActive: true, ...humanMemberIdentityWhere() }, include: { user: true },
      });
      expect(type === "TENSION" ? createTensionMock : createActionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining(
        type === "TENSION" ? { raisedByMemberId: "active-human" } : { assigneeMemberId: "active-human" },
      ));
    });

    it("does not assign an inactive-only hint", async () => {
      (prisma.member.findMany as ReturnType<typeof vi.fn>).mockImplementation(async (args: Prisma.MemberFindManyArgs) =>
        args?.where?.isActive === true ? [] : [{ id: "historical", user: { displayName: "Milan", email: "old@example.com" } }] as never);
      vi.mocked(prisma.meetingInsight.findUnique).mockResolvedValue({
        id: "insight-old", workspaceId: "ws-1", meetingId: "meeting-1", type: "ACTION_ITEM",
        operation: "CREATE", status: "SUGGESTED", title: "Follow up", bodyMd: "Follow up.",
        assigneeHint: "Milan", meeting: { id: "meeting-1", title: "Weekly sync" },
      } as never);
      await applyInsight(mockActor, { workspaceId: "ws-1", insightId: "insight-old" });
      expect(createActionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({ assigneeMemberId: null }));
    });

    it("completes an action with the existing insight evidence and meeting provenance", async () => {
      vi.mocked(prisma.meetingInsight.findUnique).mockResolvedValue({
        id: "insight-resolve", workspaceId: "ws-1", meetingId: "meeting-1", type: "ACTION_ITEM",
        operation: "RESOLVE", targetEntityType: "Action", targetEntityId: "action-1", status: "SUGGESTED",
        title: "Follow up completed", bodyMd: "The owner confirmed the handoff was delivered.",
        meeting: { id: "meeting-1", title: "Weekly sync" },
      } as never);
      updateActionMock.mockImplementation(async (_actor, params) => {
        if (!params.completedVia?.trim()) throw new Error("Completion note is required.");
        return { id: "action-1" };
      });
      await applyInsight(mockActor, { workspaceId: "ws-1", insightId: "insight-resolve" });
      expect(updateActionMock).toHaveBeenCalledWith(mockActor, {
        workspaceId: "ws-1", actionId: "action-1", status: "COMPLETED",
        completedVia: "The owner confirmed the handoff was delivered.\n\n*Created from meeting:* [Weekly sync](/workspaces/ws-1/meetings/meeting-1)",
      });
      expect(prisma.meetingInsight.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: "APPLIED", appliedEntityType: "Action", appliedEntityId: "action-1" }),
      }));
    });

    it("uses assignee hints as raised-by members for tension insights", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "TENSION",
        status: "CONFIRMED",
        title: "Onboarding ownership is unclear",
        bodyMd: [
          "**MEETING BLOCK:** Onboarding discussion",
          "**BLOCK KIND:** tension",
          "",
          "### Current reality",
          "The handoff owner was unclear.",
        ].join("\n"),
        assigneeHint: "Milan",
        meeting: {
          id: "meeting-1",
          title: "Weekly sync",
        },
      });
      (prisma.meetingInsight.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        status: "APPLIED",
      });

      await applyInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123",
      });

      expect(createTensionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        title: "Onboarding ownership is unclear",
        bodyMd: expect.not.stringContaining("MEETING BLOCK"),
        raisedByMemberId: "member-raised",
        meetingId: "meeting-1",
        isPrivate: false,
      }));
      expect(createTensionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        bodyMd: expect.stringContaining("### Current reality"),
      }));
      expect(updateTensionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        tensionId: "tension-1",
        status: "OPEN",
      }));
      expect(createTensionMock).toHaveBeenCalledWith(mockActor, expect.not.objectContaining({
        assigneeMemberId: "member-raised",
      }));
    });

    it("uses an injected member directory loader and does not query members directly", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-injected",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "TENSION",
        status: "CONFIRMED",
        title: "Ownership unclear",
        bodyMd: "The handoff owner was unclear.",
        assigneeHint: "Milan",
        meeting: { id: "meeting-1", title: "Weekly sync" },
      });
      (prisma.meetingInsight.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-injected",
        status: "APPLIED",
      });

      const loadMemberDirectory = vi.fn().mockResolvedValue([
        { id: "injected-member", user: { displayName: "Milan", email: "milan@example.com" } },
      ]);

      await applyInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-injected",
        loadMemberDirectory,
      });

      expect(loadMemberDirectory).toHaveBeenCalledTimes(1);
      expect(prisma.member.findMany).not.toHaveBeenCalled();
      expect(createTensionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        raisedByMemberId: "injected-member",
      }));
    });

    it("applies adopted proposal resolutions through the proposal resolution domain path", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-proposal",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "PROPOSAL",
        operation: "RESOLVE",
        targetEntityType: "Proposal",
        targetEntityId: "proposal-1",
        resolutionOutcome: "ADOPTED",
        status: "SUGGESTED",
        title: "Adopt pricing policy",
        bodyMd: "The group agreed to adopt the pricing policy.",
        meeting: {
          id: "meeting-1",
          title: "Weekly sync",
        },
      });

      await applyInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-proposal",
      });

      expect(resolveProposalMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        proposalId: "proposal-1",
        outcome: "ADOPTED",
        decisionMd: expect.stringContaining("Created from meeting"),
      }));
    });

    it("posts deliberation entries to validated proposal targets", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-deliberation",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "DELIBERATION_ENTRY",
        operation: "RESOLVE",
        targetEntityType: "Proposal",
        targetEntityId: "proposal-1",
        deliberationEntryType: "OBJECTION",
        status: "SUGGESTED",
        title: "Concern about timeline",
        bodyMd: "The team raised a timeline risk.",
        meeting: {
          id: "meeting-1",
          title: "Weekly sync",
        },
      });
      (prisma.proposal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "proposal-1" });

      await applyInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-deliberation",
      });

      expect(postDeliberationEntryMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        entryType: "OBJECTION",
        bodyMd: expect.stringContaining("timeline risk"),
      }));
      expect(resolveProposalMock).not.toHaveBeenCalled();
      expect(prisma.meetingInsight.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          appliedEntityType: "DeliberationEntry",
          appliedEntityId: "deliberation-1",
        }),
      }));
    });

    it("drafts proposals from linked tension insights through the tension proposal path", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-linked-proposal",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "PROPOSAL",
        operation: "CREATE",
        targetEntityType: "Tension",
        targetEntityId: "tension-1",
        status: "SUGGESTED",
        title: "Create customer escalation rule",
        bodyMd: "The team discussed a rule for escalations.",
        meeting: {
          id: "meeting-1",
          title: "Weekly sync",
        },
      });

      await applyInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-linked-proposal",
      });

      expect(createProposalFromTensionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        sourceTensionId: "tension-1",
        title: "Create customer escalation rule",
        bodyMd: expect.stringContaining("escalations"),
      }));
      expect(submitProposalMock).not.toHaveBeenCalled();
      expect(prisma.meetingInsight.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          appliedEntityType: "Proposal",
          appliedEntityId: "proposal-from-tension-1",
        }),
      }));
    });

    it("applies CRM contact insights through the Relationships contact path", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-crm-contact",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "CRM_CONTACT",
        operation: "CREATE",
        status: "SUGGESTED",
        title: "Review CRM contact",
        bodyMd: "Create a contact for Buyer.",
        metadataJson: {
          crm: {
            email: "buyer@example.test",
            name: "Buyer",
            company: "Example",
            accountId: "account-1",
            source: "meeting_intelligence",
          },
        },
        meeting: { id: "meeting-1", title: "Pilot review" },
      });

      await applyInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-crm-contact",
      });

      expect(createContactMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        email: "buyer@example.test",
        name: "Buyer",
        company: "Example",
        accountId: "account-1",
      }));
      expect(prisma.meetingInsight.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: "APPLIED",
          appliedEntityType: "CrmContact",
          appliedEntityId: "contact-1",
        }),
      }));
    });

    it("applies CRM deal and activity insights through Relationships domain paths", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          id: "insight-crm-deal",
          workspaceId: "ws-1",
          meetingId: "meeting-1",
          type: "CRM_DEAL",
          operation: "CREATE",
          status: "SUGGESTED",
          title: "Review opportunity",
          bodyMd: "Pilot pricing came up.",
          metadataJson: {
            crm: {
              accountId: "account-1",
              contactId: "contact-1",
              dealTitle: "Pilot opportunity",
              valueCents: 250000,
              currency: "USD",
            },
          },
          meeting: { id: "meeting-1", title: "Pilot review" },
        })
        .mockResolvedValueOnce({
          id: "insight-crm-activity",
          workspaceId: "ws-1",
          meetingId: "meeting-1",
          type: "CRM_ACTIVITY",
          operation: "CREATE",
          status: "SUGGESTED",
          title: "Follow up with buyer",
          bodyMd: "Send the pilot recap.",
          dueAt: new Date("2026-06-20T17:00:00.000Z"),
          metadataJson: {
            crm: {
              accountId: "account-1",
              contactId: "contact-1",
              activityType: "TASK",
              source: "meeting_intelligence",
            },
          },
          meeting: { id: "meeting-1", title: "Pilot review" },
        });

      await applyInsight(mockActor, { workspaceId: "ws-1", insightId: "insight-crm-deal" });
      await applyInsight(mockActor, { workspaceId: "ws-1", insightId: "insight-crm-activity" });

      expect(createDealMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        accountId: "account-1",
        contactId: "contact-1",
        title: "Pilot opportunity",
        valueCents: 250000,
      }));
      expect(createActivityMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        accountId: "account-1",
        contactId: "contact-1",
        title: "Follow up with buyer",
        type: "TASK",
        dueAt: new Date("2026-06-20T17:00:00.000Z"),
      }));
    });

    it("skips already reviewed insights with the same dedupe key during extraction replay", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "ACTION_ITEM",
              operation: "CREATE",
              title: "#001 > Alice Follow-up",
              body: "Alice owns the follow-up.",
              confidence: 0.9,
              dedupeKey: "action:alice-follow-up",
            },
          ],
        },
      });
      (prisma.meetingInsight.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "existing-applied" });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      expect(prisma.meetingInsight.createMany).not.toHaveBeenCalled();
    });

    it("skips historical insights with null dedupe keys when the normalized shape matches", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "ACTION_ITEM",
              operation: "CREATE",
              title: "#001 > Alice Follow-up",
              body: "Alice owns the follow-up.",
              confidence: 0.9,
            },
          ],
        },
      });
      (prisma.meetingInsight.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "legacy-applied" });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      expect(prisma.meetingInsight.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              sourceRecordId: null,
              assigneeHint: null,
              dueAt: null,
              sourceQuote: null,
              type: "ACTION_ITEM",
              operation: "CREATE",
              title: "Alice Follow-up",
              bodyMd: "Alice owns the follow-up.",
            }),
          ]),
        }),
      }));
      expect(prisma.meetingInsight.createMany).not.toHaveBeenCalled();
    });

    it("skips duplicate suggested rows created by a concurrent extraction", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "ACTION_ITEM",
              operation: "CREATE",
              title: "#001 > Alice Follow-up",
              body: "Alice owns the follow-up.",
              confidence: 0.9,
              dedupeKey: "action:alice-follow-up",
            },
          ],
        },
      });
      (prisma.meetingInsight.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      (prisma.meetingInsight.createMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });

      await expect(extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toEqual([]);

      expect(prisma.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
        skipDuplicates: true,
      }));
    });

    it("preserves a reviewed legacy commitment on replay while isolating another source and workspace", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ output: { insights: [{
        type: "ACTION_ITEM", operation: "CREATE", title: "Prepare report", body: "Milan will prepare the report.",
        assigneeHint: "Milan", dueAt: "2026-09-15T12:00:00Z", sourceQuote: "I will prepare the report.",
        confidence: 0.9, dedupeKey: "new-model-key",
      }] } });
      const legacy = {
        id: "legacy", workspaceId: "ws-1", meetingId: "meeting-1", sourceRecordId: "source-1",
        type: "ACTION_ITEM", operation: "CREATE", title: "Prepare report", bodyMd: "Milan will prepare the report.",
        assigneeHint: "Milan", dueAt: new Date("2026-09-15T12:00:00Z"), sourceQuote: "I will prepare the report.",
        dedupeKey: "historical-key:source:source-1", status: "APPLIED", targetEntityType: null, targetEntityId: null,
        deliberationEntryType: null, resolutionOutcome: null,
      };
      const original = JSON.stringify(legacy);
      (prisma.meetingInsight.findFirst as ReturnType<typeof vi.fn>).mockImplementation(({ where }) => {
        if (!where.OR || where.workspaceId !== legacy.workspaceId || where.meetingId !== legacy.meetingId) return null;
        const match = where.OR.some((condition: Record<string, unknown>) => Object.entries(condition).every(([key, value]) =>
          JSON.stringify(legacy[key as keyof typeof legacy]) === JSON.stringify(value)));
        return match ? legacy : null;
      });
      const source = { id: "source-1", recordedAt: new Date("2026-09-11T12:00:00Z") };
      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(source);
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      expect(prisma.meetingInsight.createMany).not.toHaveBeenCalled();
      expect(JSON.stringify(legacy)).toBe(original);

      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ ...source, id: "source-2" });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-1", meetingId: "meeting-1" });
      expect(prisma.meetingInsight.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.meetingInsight.createMany).toHaveBeenLastCalledWith(expect.objectContaining({
        data: [expect.objectContaining({ workspaceId: "ws-1", sourceRecordId: "source-2", dedupeKey: expect.stringContaining(":source:source-2") })],
      }));

      const context = await buildMeetingIntelligenceContextMock();
      context.meeting.workspaceId = "ws-2";
      buildMeetingIntelligenceContextMock.mockResolvedValue(context);
      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(source);
      (prisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "member-2", workspaceId: "ws-2", userId: "user-123", role: "ADMIN", isActive: true });
      await extractMeetingInsights(mockActor, { workspaceId: "ws-2", meetingId: "meeting-1" });
      expect(prisma.meetingInsight.createMany).toHaveBeenCalledTimes(2);
      expect(prisma.meetingInsight.createMany).toHaveBeenLastCalledWith(expect.objectContaining({
        data: [expect.objectContaining({ workspaceId: "ws-2", sourceRecordId: "source-1" })],
      }));
      expect(JSON.stringify(legacy)).toBe(original);
      expect(prisma.meetingInsight.update).not.toHaveBeenCalled();
    });

    it("does not create proposal resolution insights for draft proposals", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "PROPOSAL",
              operation: "RESOLVE",
              title: "#001 > Draft proposal decision",
              body: "The draft proposal was discussed as if resolved.",
              confidence: 0.95,
              targetEntityType: "Proposal",
              targetEntityId: "draft-proposal",
              resolutionOutcome: "ADOPTED",
            },
          ],
        },
      });
      buildMeetingIntelligenceContextMock.mockResolvedValueOnce({
        contextualIntelligenceEnabled: true,
        meeting: {
          id: "meeting-1",
          workspaceId: "ws-1",
          title: "Weekly sync",
          source: "manual",
          transcript: "Meeting transcript.",
          summaryMd: null,
          blocksJson: null,
          ingestionGuidanceMd: null,
          recordedAt: new Date("2026-04-29T12:00:00.000Z"),
          scheduledEndAt: null,
          seriesId: null,
          seriesTitle: null,
          participantIds: [],
          participantEmails: [],
        },
        attendees: [],
        previousMeetings: [],
        tensions: [],
        actions: [],
        proposals: [{ id: "draft-proposal", title: "Draft proposal", status: "DRAFT" }],
        followUps: [],
        deliberationEntries: [],
        knowledgeSearchQuery: "",
        knowledge: [],
      });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      expect(prisma.meetingInsight.createMany).not.toHaveBeenCalled();
    });

    it("ignores invalid target ids returned by the model", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "DELIBERATION_ENTRY",
              operation: "CREATE",
              title: "#001 > Proposal discussion",
              body: "Discussion on a guessed proposal.",
              confidence: 0.9,
              targetEntityType: "Proposal",
              targetEntityId: "missing-proposal",
            },
          ],
        },
      });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      expect(prisma.meetingInsight.createMany).not.toHaveBeenCalled();
    });

    it("links proposal-targeted insights to the newest transcript source and supersedes older suggestions", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      buildMeetingIntelligenceContextMock.mockResolvedValueOnce({
        contextualIntelligenceEnabled: true,
        meeting: {
          id: "meeting-1",
          workspaceId: "ws-1",
          title: "Proposal review",
          transcript: "Jan: This changes the active proposal.",
          summaryMd: null,
          blocksJson: null,
          ingestionGuidanceMd: null,
          recordedAt: new Date("2026-05-03T10:00:00.000Z"),
        },
        actions: [],
        tensions: [],
        proposals: [{ id: "proposal-1", title: "Meeting template", status: "OPEN" }],
        previousMeetings: [],
        followUps: [],
        deliberationEntries: [],
        knowledgeSearchQuery: "",
        knowledge: [],
        attendees: [],
      });
      (prisma.meetingTranscriptSourceRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "source-record-new",
        recordedAt: new Date("2026-05-03T10:00:00.000Z"),
        sourceUpdatedAt: new Date("2026-05-03T11:00:00.000Z"),
      });
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "DELIBERATION_ENTRY",
              operation: "CREATE",
              title: "Proposal evidence",
              body: "The meeting adds newer evidence to the proposal.",
              confidence: 0.9,
              targetEntityType: "Proposal",
              targetEntityId: "proposal-1",
              deliberationEntryType: "REACTION",
              dedupeKey: "proposal:evidence",
              sourceQuote: "This changes the active proposal.",
            },
          ],
        },
      });
      (prisma.meetingInsight.findFirst as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "insight-new",
          targetEntityType: "Proposal",
          targetEntityId: "proposal-1",
        });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      expect(prisma.meetingTranscriptSourceRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        orderBy: [
          { sourceUpdatedAt: { sort: "desc", nulls: "last" } },
          { recordedAt: "desc" },
          { createdAt: "desc" },
        ],
      }));
      expect(prisma.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
        data: [expect.objectContaining({
          dedupeKey: "proposal:evidence:source:source-record-new",
          sourceRecordId: "source-record-new",
          sourceRecordedAt: new Date("2026-05-03T10:00:00.000Z"),
          targetEntityType: "Proposal",
          targetEntityId: "proposal-1",
        })],
      }));
      expect(prisma.meetingInsight.deleteMany).toHaveBeenCalledWith({
        where: {
          workspaceId: "ws-1",
          meetingId: "meeting-1",
          status: "SUGGESTED",
          reviewedAt: null,
          sourceRecordId: null,
        },
      });
      expect(prisma.meetingInsight.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          targetEntityType: "Proposal",
          targetEntityId: "proposal-1",
          supersededAt: null,
        }),
        data: expect.objectContaining({
          supersededByInsightId: "insight-new",
        }),
      }));
      expect(prisma.meetingInsight.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          meetingId: "meeting-1",
          sourceRecordId: { not: null },
          NOT: { sourceRecordId: "source-record-new" },
          supersededAt: null,
        }),
        data: expect.objectContaining({
          supersededAt: expect.any(Date),
        }),
      }));
    });
  });

  describe("confirmAllInsights", () => {
    it("updates all suggested insights to confirmed", async () => {
      await confirmAllInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-123"
      });

      expect(prisma.meetingInsight.updateMany).toHaveBeenCalledWith({
        where: { meetingId: "meeting-123", workspaceId: "ws-1", status: "SUGGESTED", supersededAt: null },
        data: {
          status: "CONFIRMED",
          reviewedByUserId: "user-123",
          reviewedAt: expect.any(Date),
        },
      });
    });
  });

  describe("autoApplyMeetingInsights", () => {
    it.each([false, true])("links an already-open public proposal without resubmitting it (linked tension: %s)", async (linkedTension) => {
      const insight = {
        id: "insight-public-proposal",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "PROPOSAL",
        operation: "CREATE",
        status: "SUGGESTED",
        confidence: 0.95,
        sourceQuote: "We agreed to propose a new escalation rule.",
        targetEntityType: linkedTension ? "Tension" : null,
        targetEntityId: linkedTension ? "tension-1" : null,
        title: "Escalation rule",
        bodyMd: "Propose a clear escalation path.",
        meeting: { id: "meeting-1", title: "Weekly sync" },
      };
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([insight]);
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(insight);
      const create = linkedTension ? createProposalFromTensionMock : createProposalMock;
      // Both public creation paths open the proposal and activate its approval flow.
      create.mockResolvedValue({ id: "proposal-public", status: "OPEN", isPrivate: false });
      submitProposalMock.mockRejectedValue(new Error("Only draft proposals can be opened."));

      await expect(autoApplyMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toMatchObject({ applied: 1, failed: 0, skipped: 0 });

      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        isPrivate: false,
      }));
      expect(linkedTension ? createProposalMock : createProposalFromTensionMock).not.toHaveBeenCalled();
      expect(submitProposalMock).not.toHaveBeenCalled();
      expect(prisma.meetingInsight.update).toHaveBeenCalledTimes(1);
      expect(prisma.meetingInsight.update).toHaveBeenCalledWith({
        where: { id: insight.id },
        data: expect.objectContaining({
          status: "APPLIED",
          appliedEntityType: "Proposal",
          appliedEntityId: "proposal-public",
          autoAppliedAt: expect.any(Date),
          autoApplyError: null,
        }),
      });
    });

    it("only loads high-confidence suggested or confirmed insights for auto-apply", async () => {
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "insight-action",
          type: "ACTION_ITEM",
          operation: "CREATE",
          targetEntityType: null,
          targetEntityId: null,
          confidence: 0.9,
          sourceQuote: "I will follow up.",
        },
      ]);
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-action",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "ACTION_ITEM",
        operation: "CREATE",
        status: "SUGGESTED",
        title: "Follow up with customer",
        bodyMd: "Milan will follow up.",
        assigneeHint: "Milan",
        meeting: {
          id: "meeting-1",
          title: "Weekly sync",
        },
      });

      await expect(autoApplyMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toMatchObject({
        applied: 1,
        failed: 0,
        threshold: 0.8,
      });

      expect(prisma.meetingInsight.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          meetingId: "meeting-1",
          status: { in: ["SUGGESTED", "CONFIRMED"] },
          supersededAt: null,
          confidence: { gte: 0.8 },
        }),
      }));
      expect(createActionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        title: "Follow up with customer",
        assigneeMemberId: "member-raised",
      }));
      expect(prisma.meetingInsight.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "insight-action" },
        data: expect.objectContaining({
          status: "APPLIED",
          autoAppliedAt: expect.any(Date),
        }),
      }));
    });

    it("does not auto-apply CRM relationship insights", async () => {
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "insight-crm-activity",
          type: "CRM_ACTIVITY",
          operation: "CREATE",
          targetEntityType: null,
          targetEntityId: null,
          confidence: 0.99,
          sourceQuote: "Send the follow-up.",
        },
      ]);

      await expect(autoApplyMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toMatchObject({
        applied: 0,
        failed: 0,
        skipped: 1,
      });

      expect(createActivityMock).not.toHaveBeenCalled();
      expect(prisma.meetingInsight.findUnique).not.toHaveBeenCalled();
    });

    it("reads the workspace member directory once when applying multiple hinted insights", async () => {
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "insight-a",
          type: "ACTION_ITEM",
          operation: "CREATE",
          targetEntityType: null,
          targetEntityId: null,
          confidence: 0.95,
          sourceQuote: "Milan will follow up on A.",
        },
        {
          id: "insight-b",
          type: "ACTION_ITEM",
          operation: "CREATE",
          targetEntityType: null,
          targetEntityId: null,
          confidence: 0.95,
          sourceQuote: "Milan will follow up on B.",
        },
      ]);
      const insightsById: Record<string, unknown> = {
        "insight-a": {
          id: "insight-a",
          workspaceId: "ws-1",
          meetingId: "meeting-1",
          type: "ACTION_ITEM",
          operation: "CREATE",
          status: "SUGGESTED",
          title: "Follow up A",
          bodyMd: "Milan will follow up on A.",
          assigneeHint: "Milan",
          meeting: { id: "meeting-1", title: "Weekly sync" },
        },
        "insight-b": {
          id: "insight-b",
          workspaceId: "ws-1",
          meetingId: "meeting-1",
          type: "ACTION_ITEM",
          operation: "CREATE",
          status: "SUGGESTED",
          title: "Follow up B",
          bodyMd: "Milan will follow up on B.",
          assigneeHint: "Milan",
          meeting: { id: "meeting-1", title: "Weekly sync" },
        },
      };
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { id: string } }) => Promise.resolve(insightsById[where.id] ?? null),
      );

      await expect(autoApplyMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toMatchObject({ applied: 2, failed: 0 });

      expect(createActionMock).toHaveBeenCalledTimes(2);
      // The full member table must be read at most once for the whole batch.
      expect(prisma.member.findMany).toHaveBeenCalledTimes(1);
    });

    it("skips collective team-scoped actions during auto-apply", async () => {
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "insight-team-action",
          type: "ACTION_ITEM",
          operation: "CREATE",
          targetEntityType: null,
          targetEntityId: null,
          confidence: 0.92,
          sourceQuote: "Team members will pick up contacts.",
          assigneeHint: "Team members",
        },
      ]);

      await expect(autoApplyMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toMatchObject({
        applied: 0,
        failed: 0,
        skipped: 1,
      });

      expect(prisma.meetingInsight.findUnique).not.toHaveBeenCalled();
      expect(createActionMock).not.toHaveBeenCalled();
    });

    it("uses stricter automatic thresholds for deliberation and proposal resolutions", async () => {
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "insight-deliberation-low",
          type: "DELIBERATION_ENTRY",
          operation: "CREATE",
          targetEntityType: "Proposal",
          targetEntityId: "proposal-1",
          confidence: 0.84,
          sourceQuote: "We discussed the timeline risk.",
        },
        {
          id: "insight-resolution-low",
          type: "PROPOSAL",
          operation: "RESOLVE",
          targetEntityType: "Proposal",
          targetEntityId: "proposal-1",
          confidence: 0.91,
          sourceQuote: "We agreed to adopt it.",
        },
      ]);

      await expect(autoApplyMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toMatchObject({
        applied: 0,
        failed: 0,
        skipped: 2,
        threshold: 0.8,
      });

      expect(prisma.meetingInsight.findUnique).not.toHaveBeenCalled();
    });

    it("bypasses auto-apply for configured Slack-reviewed customer action items", async () => {
      (prisma.meeting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        series: { externalId: "ops:weekly-progress-review" },
      });
      (prisma.workspaceFeatureFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        config: {
          meetingSeriesExternalId: "ops:weekly-progress-review",
          channelId: "C999",
        },
      });
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "insight-action",
          type: "ACTION_ITEM",
          operation: "CREATE",
          targetEntityType: null,
          targetEntityId: null,
          confidence: 0.95,
          sourceQuote: "I will follow up.",
        },
      ]);

      await expect(autoApplyMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toMatchObject({
        applied: 0,
        failed: 0,
        skipped: 1,
        threshold: 0.8,
      });

      expect(createActionMock).not.toHaveBeenCalled();
      expect(prisma.meetingInsight.findUnique).not.toHaveBeenCalled();
    });
  });
});
