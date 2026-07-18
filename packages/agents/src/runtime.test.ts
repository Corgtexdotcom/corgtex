import { beforeEach, describe, expect, it, vi } from "vitest";
import { meetingRecordFromReplayFixture, operationsTacticalReplayFixture } from "./meeting-transcript-replay-fixtures";

const { autoApplyMeetingInsightsMock, buildMeetingIntelligenceContextMock, syncKnowledgeForSourceMock } = vi.hoisted(() => ({
  autoApplyMeetingInsightsMock: vi.fn(),
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
  action: {
    count: vi.fn(),
  },
  tension: {
    count: vi.fn(),
  },
  proposal: {
    count: vi.fn(),
    findUnique: vi.fn(),
  },
  meeting: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  policyCorpus: {
    findUnique: vi.fn(),
  },
  workspaceAgentConfig: {
    findUnique: vi.fn(),
  },
  event: {
    create: vi.fn(),
  },
  modelUsageBudget: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  member: {
    findMany: vi.fn(),
  },
  notification: {
    createMany: vi.fn(),
  },
  agentIdentity: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
};

const envMock = {
  AGENT_KILL_SWITCH: false,
  WORKSPACE_AGENT_MAX_CONCURRENCY: 4,
};

const modelGatewayMock = {
  chat: vi.fn(),
  extract: vi.fn(),
};

const knowledgeMock = {
  searchIndexedKnowledge: vi.fn(),
};

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
    env: envMock,
    toInputJson: (v: any) => JSON.parse(JSON.stringify(v ?? null)),
  };
});

vi.mock("@corgtex/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/domain")>();
  return {
    ...actual,
    isAgentEnabled: vi.fn().mockResolvedValue(true),
    getAgentModelOverride: vi.fn().mockResolvedValue(undefined),
    resolveAgentIdentityLimits: vi.fn().mockResolvedValue(null),
    resolveAgentBehaviorContext: vi.fn().mockResolvedValue(null),
    autoApplyMeetingInsights: autoApplyMeetingInsightsMock,
    buildMeetingIntelligenceContext: buildMeetingIntelligenceContextMock,
  };
});

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: modelGatewayMock,
  resolveModel: vi.fn().mockReturnValue("fake-model"),
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: knowledgeMock.searchIndexedKnowledge,
  syncKnowledgeForSource: syncKnowledgeForSourceMock,
}));

describe("agent runtime", () => {
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

    prismaMock.agentStep.create.mockReset().mockImplementation(async ({ data }: any) => ({
      id: `step-${String(data.name)}`,
      ...data,
    }));
    prismaMock.agentStep.createMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.agentStep.update.mockReset().mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));

    prismaMock.agentToolCall.create.mockReset().mockImplementation(async ({ data }: any) => ({
      id: `tool-${String(data.name)}`,
      ...data,
    }));
    prismaMock.agentToolCall.createMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.agentToolCall.update.mockReset().mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));

    prismaMock.action.count.mockReset().mockResolvedValue(1);
    prismaMock.tension.count.mockReset().mockResolvedValue(2);
    prismaMock.proposal.count.mockReset().mockResolvedValue(3);
    prismaMock.proposal.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.meeting.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.meeting.update.mockReset().mockResolvedValue({});
    prismaMock.meeting.updateMany.mockReset().mockResolvedValue({ count: 1 });
    buildMeetingIntelligenceContextMock.mockReset().mockImplementation(async ({ workspaceId, meetingId }: { workspaceId: string; meetingId: string }) => {
      const meeting = await prismaMock.meeting.findUnique({ where: { id: meetingId, workspaceId } });
      return {
        contextualIntelligenceEnabled: false,
        meeting,
        previousMeetings: [],
        actions: [],
        tensions: [],
        proposals: [],
        deliberationEntries: [],
        followUps: [],
        knowledge: [],
      };
    });
    prismaMock.policyCorpus.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.workspaceAgentConfig.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.event.create.mockReset().mockResolvedValue({ id: "event-1" });
    prismaMock.modelUsageBudget.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.member.findMany.mockReset().mockResolvedValue([]);
    prismaMock.agentIdentity.findUnique.mockReset().mockResolvedValue(null);
    autoApplyMeetingInsightsMock.mockReset().mockResolvedValue({ applied: 1, failed: 0, skipped: 0, threshold: 0.8 });
    syncKnowledgeForSourceMock.mockReset().mockResolvedValue(1);

    // Mock $transaction to execute the callback
    prismaMock.$transaction.mockReset().mockImplementation(async (fn: any) => fn(prismaMock));

    modelGatewayMock.chat.mockReset().mockResolvedValue({
      content: "model output",
      usage: { provider: "fake", model: "fake", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCostUsd: "0.000000" },
    });
    modelGatewayMock.extract.mockReset().mockResolvedValue({
      output: {},
      raw: "{}",
      usage: { provider: "fake", model: "fake", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCostUsd: "0.000000" },
    });
    knowledgeMock.searchIndexedKnowledge.mockReset().mockResolvedValue([]);
  });

  it("skips agent execution when the kill switch is enabled", async () => {
    envMock.AGENT_KILL_SWITCH = true;
    const { runInboxTriageAgent } = await import(".");

    await expect(runInboxTriageAgent({
      workspaceId: "ws-1",
      triggerRef: "job-1",
    })).resolves.toEqual({ skipped: true, reason: "kill_switch" });

    expect(prismaMock.agentRun.create).not.toHaveBeenCalled();
  });

  it("auto-applies high-confidence meeting insights", async () => {
    const fixture = operationsTacticalReplayFixture;
    const meetingRecord = meetingRecordFromReplayFixture(fixture);
    prismaMock.meeting.findUnique.mockResolvedValue(meetingRecord);
    autoApplyMeetingInsightsMock.mockResolvedValueOnce(fixture.expectedAutoApply);

    expect(meetingRecord.insights).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: fixture.workspaceId,
        meetingId: fixture.meetingId,
        type: "ACTION_ITEM",
        operation: "CREATE",
        bodyMd: expect.stringContaining("Milan will publish"),
        sourceQuote: expect.stringContaining("checklist by Friday"),
        status: "SUGGESTED",
      }),
    ]));

    const { runActionExtractionAgent } = await import(".");
    await runActionExtractionAgent({
      workspaceId: fixture.workspaceId,
      triggerRef: `replay-${fixture.id}`,
      meetingId: fixture.meetingId,
    });

    expect(prismaMock.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agentKey: "action-extraction",
        goal: expect.stringContaining("Auto-apply high-confidence"),
      }),
    }));
    expect(prismaMock.agentToolCall.createMany).toHaveBeenCalled();
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "COMPLETED",
        approvalRequired: false,
      }),
    }));
    expect(autoApplyMeetingInsightsMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent",
      label: "action-extraction",
    }), {
      workspaceId: fixture.workspaceId,
      meetingId: fixture.meetingId,
    });
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        resultJson: expect.objectContaining({
          meetingId: fixture.meetingId,
          ...fixture.expectedAutoApply,
        }),
      }),
    }));
  });

  it("skips action extraction when the meeting has no transcript", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: "meeting-empty",
      workspaceId: "ws-1",
      title: "Empty recorder meeting",
      transcript: "",
      summaryMd: null,
      insights: [],
    });

    const { runActionExtractionAgent } = await import(".");
    await runActionExtractionAgent({
      workspaceId: "ws-1",
      triggerRef: "job-empty",
      meetingId: "meeting-empty",
    });

    expect(autoApplyMeetingInsightsMock).not.toHaveBeenCalled();
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

  it("does not count waiting-approval runs against execution concurrency", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: "meeting-waiting",
      workspaceId: "ws-1",
      title: "Queued Summary",
      source: "manual",
      transcript: "Summarize this meeting.",
      summaryMd: null,
      recordedAt: new Date("2026-04-03T10:00:00.000Z"),
    });

    prismaMock.agentRun.count.mockImplementation(async ({ where }) => {
      expect(where).toEqual({
        workspaceId: "ws-1",
        status: {
          in: ["PENDING", "RUNNING"],
        },
      });
      return 0;
    });

    const { runMeetingSummaryAgent } = await import(".");
    await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "job-waiting",
      meetingId: "meeting-waiting",
    });

    expect(prismaMock.agentRun.create).toHaveBeenCalled();
  });

  it("completes meeting summaries and persists the summary", async () => {
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: "meeting-2",
      workspaceId: "ws-1",
      title: "Weekly Sync",
      source: "manual",
      transcript: "Discussed operations and finance.",
      summaryMd: null,
      recordedAt: new Date("2026-04-03T10:00:00.000Z"),
    });
    modelGatewayMock.chat.mockResolvedValue({
      content: "Concise meeting summary",
      usage: { provider: "fake", model: "fake", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCostUsd: "0.000000" },
    });

    const { runMeetingSummaryAgent } = await import(".");
    await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "job-3",
      meetingId: "meeting-2",
    });

    expect(prismaMock.meeting.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "meeting-2", workspaceId: "ws-1" },
      data: expect.objectContaining({ summaryMd: "Concise meeting summary" }),
    }));
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "COMPLETED",
        approvalRequired: false,
      }),
    }));
  });

  it("waits for approval after drafting a proposal", async () => {
    knowledgeMock.searchIndexedKnowledge.mockResolvedValue([
      {
        chunkId: "chunk-1",
        sourceType: "DOCUMENT",
        sourceId: "doc-1",
        title: "Finance policy",
        chunkIndex: 0,
        snippet: "Budget policy",
        score: 0.98,
      },
    ]);
    modelGatewayMock.chat.mockResolvedValue({
      content: "# Budget policy\n\nSummary draft",
      usage: { provider: "fake", model: "fake", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCostUsd: "0.000000" },
    });
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        title: "Budget policy",
        summary: "Summary draft",
        bodyMd: "# Budget policy\n\nSummary draft",
      },
      raw: "{\"title\":\"Budget policy\"}",
      usage: { provider: "fake", model: "fake", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCostUsd: "0.000000" },
    });

    const { runProposalDraftingAgent } = await import(".");
    await runProposalDraftingAgent({
      workspaceId: "ws-1",
      triggerRef: "job-4",
      prompt: "Create a budget policy",
    });

    expect(knowledgeMock.searchIndexedKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      query: "Create a budget policy",
    }));
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "WAITING_APPROVAL",
        approvalRequired: true,
      }),
    }));
  });

  it("waits for approval after constitution follow-up analysis", async () => {
    prismaMock.proposal.findUnique.mockResolvedValue({
      id: "proposal-1",
      workspaceId: "ws-1",
      title: "Update finance policy",
      summary: "Adjust the approval thresholds.",
      bodyMd: "# Policy update",
      status: "APPROVED",
    });
    prismaMock.policyCorpus.findUnique.mockResolvedValue({
      id: "policy-1",
      title: "Current constitution",
      bodyMd: "Current policy body",
      acceptedAt: new Date("2026-04-01T10:00:00.000Z"),
    });
    modelGatewayMock.chat.mockResolvedValue({
      content: "Constitution follow-up is recommended.",
      usage: { provider: "fake", model: "fake", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCostUsd: "0.000000" },
    });

    const { runConstitutionUpdateTriggerAgent } = await import(".");
    await runConstitutionUpdateTriggerAgent({
      workspaceId: "ws-1",
      triggerRef: "job-5",
      proposalId: "proposal-1",
    });

    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "WAITING_APPROVAL",
        approvalRequired: true,
      }),
    }));
  });
});
