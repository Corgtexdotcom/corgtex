import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildMeetingIntelligenceContextMock, syncKnowledgeForSourceMock } = vi.hoisted(() => ({
  buildMeetingIntelligenceContextMock: vi.fn(),
  syncKnowledgeForSourceMock: vi.fn(),
}));

const prismaMock = {
  agentRun: {
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  agentStep: {
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
  },
  agentToolCall: {
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
  },
  event: {
    create: vi.fn(),
  },
  modelUsageBudget: {
    findUnique: vi.fn(),
  },
  meeting: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
  agentIdentity: {
    findUnique: vi.fn(),
  },
};

const envMock = {
  AGENT_KILL_SWITCH: false,
  WORKSPACE_AGENT_MAX_CONCURRENCY: 4,
};

const modelUsage = { provider: "fake", model: "fake", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCostUsd: "0.000000" };

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
    env: envMock,
    toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value ?? null)),
  };
});

vi.mock("@corgtex/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/domain")>();
  return {
    ...actual,
    buildMeetingIntelligenceContext: buildMeetingIntelligenceContextMock,
    isAgentEnabled: vi.fn().mockResolvedValue(true),
    getAgentModelOverride: vi.fn().mockResolvedValue(undefined),
    resolveAgentIdentityLimits: vi.fn().mockResolvedValue(null),
    resolveAgentBehaviorContext: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("@corgtex/knowledge", () => ({
  syncKnowledgeForSource: syncKnowledgeForSourceMock,
}));

vi.mock("@corgtex/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/models")>();
  return {
    ...actual,
    resolveModel: vi.fn().mockReturnValue("gpt-4o-mini"),
    defaultModelGateway: {
      chat: vi.fn().mockResolvedValue({ content: "Mock summary", usage: modelUsage }),
      embed: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2]] }),
      extract: vi.fn().mockResolvedValue({ output: {} }),
      rerank: vi.fn().mockResolvedValue({ results: [] }),
    },
  };
});

describe("runMeetingSummaryAgent", () => {
  beforeEach(() => {
    envMock.AGENT_KILL_SWITCH = false;
    envMock.WORKSPACE_AGENT_MAX_CONCURRENCY = 4;

    prismaMock.agentRun.findFirst.mockReset().mockResolvedValue(null);
    prismaMock.agentRun.count.mockReset().mockResolvedValue(0);
    prismaMock.agentRun.create.mockReset().mockResolvedValue({ id: "run-1" });
    prismaMock.agentRun.update.mockReset().mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));

    prismaMock.agentStep.createMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.agentToolCall.createMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.event.create.mockReset().mockResolvedValue({ id: "event-1" });
    prismaMock.modelUsageBudget.findUnique.mockReset().mockResolvedValue(null);
    syncKnowledgeForSourceMock.mockReset().mockResolvedValue(1);

    buildMeetingIntelligenceContextMock.mockReset().mockResolvedValue({
      contextualIntelligenceEnabled: true,
      meeting: {
        id: "meeting-1",
        workspaceId: "ws-1",
        title: "Test Meeting",
        source: "manual",
        transcript: "We discussed project updates.",
        summaryMd: null,
        blocksJson: null,
        ingestionGuidanceMd: "Emphasize launch risks.",
        recordedAt: new Date("2026-04-29T12:00:00.000Z"),
      },
      previousMeetings: [{ id: "meeting-0", title: "Previous Meeting", summaryMd: "Previous summary" }],
      actions: [],
      tensions: [],
      proposals: [],
      deliberationEntries: [],
      followUps: [],
      knowledge: [],
    });
    prismaMock.meeting.updateMany.mockReset().mockResolvedValue({ count: 1 });

    // Mock $transaction to execute the callback
    prismaMock.$transaction.mockReset().mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.agentIdentity.findUnique.mockReset().mockResolvedValue(null);
  });

  it("completes without requiring a live database", async () => {
    const { runMeetingSummaryAgent } = await import(".");

    const result = await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "trigger-1",
      triggerType: "SCHEDULE",
      meetingId: "meeting-1",
    });

    expect(prismaMock.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agentKey: "meeting-summary",
        workspaceId: "ws-1",
      }),
    }));
    const { defaultModelGateway } = await import("@corgtex/models");
    expect(defaultModelGateway.chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("trusted operator context for spelling, name, and terminology corrections"),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Cortex means Corgtex"),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Emphasize launch risks."),
        }),
      ]),
    }));
    expect(syncKnowledgeForSourceMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ status: "COMPLETED" }));
  });

  it("detects dynamic meeting blocks and uses them as the summary spine", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    vi.mocked(defaultModelGateway.extract).mockResolvedValueOnce({
      output: {
        blocks: [
          {
            sequence: 1,
            title: "Opening check-in",
            kind: "check_in",
            summaryMd: "The meeting opened with a short personal check-in.",
          },
          {
            sequence: 2,
            title: "Meeting template proposal",
            kind: "proposal_discussion",
            summaryMd: "The group discussed connecting decisions to proposals in meeting summaries.",
            relatedRecords: [{ entityType: "Proposal", entityId: "proposal-1", title: "Meeting template refinement" }],
          },
          {
            sequence: 3,
            title: "Org structure visibility",
            kind: "custom",
            summaryMd: "The group discussed making circles and roles easier to inspect.",
          },
        ],
      },
      raw: "{}",
      usage: modelUsage,
    });
    vi.mocked(defaultModelGateway.chat).mockResolvedValueOnce({
      content: "## Opening check-in\nA quick check-in happened.\n\n## Meeting template proposal\nThe decision was tied to the proposal.",
      usage: modelUsage,
    });
    buildMeetingIntelligenceContextMock.mockResolvedValueOnce({
      contextualIntelligenceEnabled: true,
      meeting: {
        id: "meeting-1",
        workspaceId: "ws-1",
        title: "Template refinement",
        source: "recorder",
        transcript: "We checked in. Then we discussed the proposal and decision. Later we discussed org structure.",
        summaryMd: null,
        blocksJson: null,
        ingestionGuidanceMd: null,
        recordedAt: new Date("2026-04-29T12:00:00.000Z"),
      },
      previousMeetings: [],
      actions: [],
      tensions: [],
      proposals: [{ id: "proposal-1", title: "Meeting template refinement", status: "OPEN" }],
      deliberationEntries: [],
      followUps: [],
      knowledge: [],
    });

    const { runMeetingSummaryAgent } = await import(".");
    await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "trigger-blocks",
      triggerType: "EVENT",
      meetingId: "meeting-1",
    });

    expect(defaultModelGateway.extract).toHaveBeenCalledWith(expect.objectContaining({
      instruction: expect.stringContaining("Do not force a fixed template"),
      input: expect.stringContaining("Meeting template refinement"),
    }));
    expect(defaultModelGateway.chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("roughly twice the useful context"),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Meeting template proposal"),
        }),
      ]),
    }));
    expect(prismaMock.meeting.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "meeting-1", workspaceId: "ws-1" },
      data: expect.objectContaining({
        summaryMd: expect.stringContaining("Opening check-in"),
        blocksJson: expect.objectContaining({
          version: 1,
          blocks: expect.arrayContaining([
            expect.objectContaining({ title: "Opening check-in", kind: "check_in" }),
            expect.objectContaining({ title: "Meeting template proposal", kind: "proposal_discussion" }),
            expect.objectContaining({ title: "Org structure visibility", kind: "custom" }),
          ]),
        }),
      }),
    }));
  });

  it("processes long transcripts in full-coverage chunks before meeting-summary model calls", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    const longTranscript = [
      "BEGINNING_MARKER",
      "a".repeat(12_000),
      "TEAM_UPDATE_MARKER Datise will coordinate the Chicago team update follow-up.",
      "b".repeat(45_000),
      "ENDING_MARKER",
    ].join("\n");
    vi.mocked(defaultModelGateway.extract).mockClear().mockImplementation(async ({ input }) => {
      const parsed = JSON.parse(input);
      const chunkIndex = parsed.transcriptChunk?.chunkIndex ?? 1;
      return {
        output: {
          blocks: [
            parsed.transcript.includes("TEAM_UPDATE_MARKER")
              ? {
                sequence: 1,
                title: "Team updates",
                kind: "update",
                summaryMd: "The team update included TEAM_UPDATE_MARKER and Datise owning a follow-up.",
              }
              : {
                sequence: 1,
                title: `Chunk ${chunkIndex} discussion`,
                kind: "custom",
                summaryMd: `Chunk ${chunkIndex} was summarized from full-coverage transcript processing.`,
              },
          ],
        },
        raw: "{}",
        usage: modelUsage,
      };
    });
    vi.mocked(defaultModelGateway.chat).mockClear().mockResolvedValueOnce({
      content: "## Long discussion\nThe long discussion was handled.",
      usage: modelUsage,
    });
    buildMeetingIntelligenceContextMock.mockResolvedValueOnce({
      contextualIntelligenceEnabled: false,
      meeting: {
        id: "meeting-long",
        workspaceId: "ws-1",
        title: "Long recorder meeting",
        source: "recorder",
        transcript: longTranscript,
        summaryMd: null,
        blocksJson: null,
        ingestionGuidanceMd: null,
        recordedAt: new Date("2026-04-29T12:00:00.000Z"),
      },
      previousMeetings: [],
      actions: [],
      tensions: [],
      proposals: [],
      deliberationEntries: [],
      followUps: [],
      knowledge: [],
    });

    const { runMeetingSummaryAgent } = await import(".");
    await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "trigger-long",
      triggerType: "EVENT",
      meetingId: "meeting-long",
    });

    const extractInputs = vi.mocked(defaultModelGateway.extract).mock.calls.map((call) => JSON.parse(call[0].input ?? "{}"));
    const chatMessage = vi.mocked(defaultModelGateway.chat).mock.calls.at(-1)?.[0].messages.find((message) => message.role === "user");
    const chatInput = JSON.parse(chatMessage?.content ?? "{}");

    expect(extractInputs.length).toBeGreaterThan(1);
    expect(extractInputs.every((input) => input.transcriptChunkedForSummary === true)).toBe(true);
    expect(extractInputs.every((input) => input.transcriptCondensedForSummary === false)).toBe(true);
    expect(extractInputs.some((input) => input.transcript.includes("TEAM_UPDATE_MARKER"))).toBe(true);
    expect(JSON.stringify(extractInputs)).not.toContain("shortened for summary generation");
    expect(chatInput.transcriptChunkedForSummary).toBe(true);
    expect(chatInput.transcriptCondensedForSummary).toBe(false);
    expect(chatInput.transcriptChunks.length).toBeGreaterThan(1);
    expect(chatInput.meetingBlocks.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Team updates", kind: "update" }),
    ]));
  });

  it("applies explicit guidance term corrections before persisting the meeting summary", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    vi.mocked(defaultModelGateway.chat).mockResolvedValueOnce({
      content: "The Cortex launch was discussed.\nThe company name for Corporate-rebels.com was discussed.\nPuncar should configure info@karina.com.",
      usage: modelUsage,
    });
    buildMeetingIntelligenceContextMock.mockResolvedValueOnce({
      contextualIntelligenceEnabled: false,
      meeting: {
        id: "meeting-1",
        workspaceId: "ws-1",
        title: "Test Meeting",
        source: "manual",
        transcript: "We discussed the company name.",
        summaryMd: "The company name for Karina was discussed.",
        blocksJson: null,
        ingestionGuidanceMd: "Its not Karina - its Corporate-rebels.com or corporate rebels depends on the context",
        recordedAt: new Date("2026-04-29T12:00:00.000Z"),
      },
      previousMeetings: [],
      actions: [],
      tensions: [],
      proposals: [],
      deliberationEntries: [],
      followUps: [],
      knowledge: [],
    });

    const { runMeetingSummaryAgent } = await import(".");

    await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "trigger-1",
      triggerType: "EVENT",
      meetingId: "meeting-1",
    });

    const persistedSummary = prismaMock.meeting.updateMany.mock.calls.at(-1)?.[0]?.data?.summaryMd;
    expect(persistedSummary).toContain("Corgtex launch");
    expect(persistedSummary).not.toContain("Cortex launch");
    expect(persistedSummary).toContain("corporate rebels");
    expect(persistedSummary).toContain("info@corporate-rebels.com");
    expect(persistedSummary).not.toContain("company name for Corporate-rebels.com");
    expect(persistedSummary).not.toContain("company name for Karina");
  });

  it("skips cleanly when the meeting disappeared before summary generation", async () => {
    const { AppError } = await import("@corgtex/domain");
    const { defaultModelGateway } = await import("@corgtex/models");
    vi.mocked(defaultModelGateway.chat).mockClear();
    buildMeetingIntelligenceContextMock.mockRejectedValueOnce(new AppError(404, "NOT_FOUND", "Meeting not found."));

    const { runMeetingSummaryAgent } = await import(".");

    const result = await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "trigger-missing",
      triggerType: "EVENT",
      meetingId: "meeting-missing",
    });

    expect(defaultModelGateway.chat).not.toHaveBeenCalled();
    expect(prismaMock.meeting.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ status: "COMPLETED" }));
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "COMPLETED",
        resultJson: expect.objectContaining({
          skipped: true,
          reason: "missing_meeting",
        }),
      }),
    }));
  });

  it("skips without model calls when the meeting has no transcript", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    vi.mocked(defaultModelGateway.extract).mockClear();
    vi.mocked(defaultModelGateway.chat).mockClear();
    buildMeetingIntelligenceContextMock.mockResolvedValueOnce({
      contextualIntelligenceEnabled: true,
      meeting: {
        id: "meeting-empty",
        workspaceId: "ws-1",
        title: "Empty recorder meeting",
        source: "recorder",
        transcript: "   ",
        summaryMd: null,
        blocksJson: null,
        ingestionGuidanceMd: null,
        recordedAt: new Date("2026-04-29T12:00:00.000Z"),
      },
      previousMeetings: [],
      actions: [],
      tensions: [],
      proposals: [],
      deliberationEntries: [],
      followUps: [],
      knowledge: [],
    });

    const { runMeetingSummaryAgent } = await import(".");

    const result = await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "trigger-empty",
      triggerType: "EVENT",
      meetingId: "meeting-empty",
    });

    expect(defaultModelGateway.extract).not.toHaveBeenCalled();
    expect(defaultModelGateway.chat).not.toHaveBeenCalled();
    expect(prismaMock.meeting.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ status: "COMPLETED" }));
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "COMPLETED",
        resultJson: expect.objectContaining({
          skipped: true,
          reason: "missing_transcript",
          meetingId: "meeting-empty",
        }),
      }),
    }));
  });

  it("skips cleanly when the meeting disappears before persistence", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    vi.mocked(defaultModelGateway.extract).mockResolvedValueOnce({
      output: { blocks: [{ sequence: 1, title: "Operations", kind: "update", summaryMd: "Operations were discussed." }] },
      raw: "{}",
      usage: modelUsage,
    });
    vi.mocked(defaultModelGateway.chat).mockResolvedValueOnce({
      content: "Operations summary",
      usage: modelUsage,
    });
    prismaMock.meeting.updateMany.mockResolvedValueOnce({ count: 0 });

    const { runMeetingSummaryAgent } = await import(".");

    const result = await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "trigger-deleted",
      triggerType: "EVENT",
      meetingId: "meeting-1",
    });

    expect(prismaMock.meeting.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "meeting-1", workspaceId: "ws-1" },
    }));
    expect(result).toEqual(expect.objectContaining({ status: "COMPLETED" }));
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "COMPLETED",
        resultJson: expect.objectContaining({
          skipped: true,
          reason: "missing_meeting",
          meetingId: "meeting-1",
        }),
      }),
    }));
  });

});
