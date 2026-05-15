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
    update: vi.fn(),
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
    prismaMock.meeting.update.mockReset().mockResolvedValue({ id: "meeting-1" });

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
          content: expect.stringContaining("dynamic meeting blocks"),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Meeting template proposal"),
        }),
      ]),
    }));
    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
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

  it("applies explicit guidance term corrections before persisting the meeting summary", async () => {
    const { defaultModelGateway } = await import("@corgtex/models");
    vi.mocked(defaultModelGateway.chat).mockResolvedValueOnce({
      content: "The company name for Corporate-rebels.com was discussed.\nPuncar should configure info@karina.com.",
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

    const persistedSummary = prismaMock.meeting.update.mock.calls.at(-1)?.[0]?.data?.summaryMd;
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
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
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

});
