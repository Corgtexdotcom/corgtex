import { beforeEach, describe, expect, it, vi } from "vitest";
import { meetingRecordFromReplayFixture, operationsTacticalReplayFixture } from "./meeting-transcript-replay-fixtures";

const { autoApplyMeetingInsightsMock, buildMeetingIntelligenceContextMock, syncKnowledgeForSourceMock } = vi.hoisted(() => ({
  autoApplyMeetingInsightsMock: vi.fn(),
  buildMeetingIntelligenceContextMock: vi.fn(),
  syncKnowledgeForSourceMock: vi.fn(),
}));

const lineage = vi.hoisted(() => ({
  request: vi.fn(), feedback: vi.fn(), capture: vi.fn(), readableIds: vi.fn(), persistMeeting: vi.fn(), snapshot: vi.fn(), readable: vi.fn(), record: vi.fn(), invalidate: vi.fn(), observe: vi.fn(),
}));
const prismaMock = {
  agentRun: {
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  agentStep: {
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
  },
  agentToolCall: {
    findMany: vi.fn(),
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
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  meeting: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  meetingInsight: { findMany: vi.fn() },
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
  searchIndexedKnowledge: vi.fn(), getKnowledgeSearchInputRoots: vi.fn(),
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

// Audited context helpers share the same primitive receipt boundary as the runtime.
// Keep the scanner real; context collection below consumes these same captured primitive proofs.
vi.mock("../../domain/src/source-lineage", async importOriginal => ({ ...await importOriginal<any>(),
  withArtifactCountReleaseSnapshot: async (actor: unknown, ws: string, roots: unknown, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {
    await remote();
    if (!await lineage.readable(actor, ws, roots)) throw new (await import("../../domain/src/errors")).AppError(409, "SOURCE_CHANGED", "Fixture inputs changed.");
    return finish(prismaMock);
  },
  captureArtifactInputProof: lineage.capture, readableArtifactIds: lineage.readableIds,
  isArtifactInputProofReadable: lineage.readable,
}));

vi.mock("@corgtex/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/domain")>();
  return {
    ...actual,
    loadAgentRequestInput: lineage.request, loadAgentFeedbackContinuation: lineage.feedback,
    captureReadableDigestInputs: async ({ actor, workspaceId, kind, records }: any) => {
      const proofs = new Map<string, any[]>();
      for (const record of records) proofs.set(record.id, await lineage.capture(actor, workspaceId, [{ kind, id: record.id, snapshot: record }]));
      return { records, proofs, roots: [...proofs.values()].flat() };
    },
    captureArtifactInputProof: lineage.capture, readableArtifactIds: lineage.readableIds, persistMeetingSummaryWithLineage: lineage.persistMeeting, captureArtifactInputSnapshotProof: lineage.snapshot,
    captureImmutableArtifactInputProof: async (actor: any, ws: string, roots: any[], tx: any) => (await Promise.all(roots.map(root => root.kind === "ArtifactInputSnapshot" ? [root] : lineage.snapshot(actor, ws, root, tx)))).flat(),
    isArtifactInputProofReadable: lineage.readable, recordArtifactInputLineage: lineage.record,
    invalidateArtifactInputLineage: lineage.invalidate, withArtifactInputReadCapture: lineage.observe,
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
  searchIndexedKnowledge: knowledgeMock.searchIndexedKnowledge, getKnowledgeSearchInputRoots: knowledgeMock.getKnowledgeSearchInputRoots,
  syncKnowledgeForSource: syncKnowledgeForSourceMock,
}));

describe("agent runtime", () => {
  beforeEach(() => {
    lineage.readableIds.mockReset().mockResolvedValue(new Set());
    lineage.persistMeeting.mockReset().mockResolvedValue({ count: 1 });
    lineage.request.mockReset().mockResolvedValue({ actor: { kind: "user", user: { id: "owner" } }, prompt: "Create a budget policy", meetingId: "meeting-1", proposalId: "proposal-1", lineageRoots: [{kind: "AgentRequestInput",id: "request-1",fingerprint:"a".repeat(64)}] });
    lineage.feedback.mockReset().mockImplementation(async ({agentKey}) => ({ actor: { kind: "user", user: { id: "owner" } }, prompt: "Create a budget policy", meetingId: "meeting-1", proposalId: "proposal-1", reviewFeedback: agentKey === "proposal-drafting" ? "Clarify the threshold" : "Explain the policy impact", previousAdvice: "Earlier assessment", lineageRoots: [{kind: "AgentFeedbackInput", id: "feedback-1",fingerprint:"a".repeat(64)},{kind: "ArtifactInputSnapshot",id:"prior-run",fingerprint:"a".repeat(64)}] }));
    knowledgeMock.getKnowledgeSearchInputRoots.mockReset().mockResolvedValue([]);
    lineage.capture.mockReset().mockImplementation(async (_actor, _workspaceId, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
    lineage.snapshot.mockReset().mockImplementation(async (_actor, _workspaceId, input) => [{ kind: "ArtifactInputSnapshot", id: `snapshot-${input.kind}-${input.id}`, fingerprint: input.fingerprint }]);
    lineage.readable.mockReset().mockResolvedValue(true);
    lineage.record.mockReset().mockResolvedValue({}); lineage.invalidate.mockReset().mockResolvedValue({});
    lineage.observe.mockReset().mockImplementation(async (_actor, _workspaceId, work) => ({ value: await work(), roots: [{ kind: "Workspace", id: "ws-1", fingerprint: "a".repeat(64) }] }));
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
    prismaMock.agentStep.findMany.mockImplementation(async () => prismaMock.agentStep.createMany.mock.calls.at(-1)?.[0].data ?? []);
    prismaMock.agentToolCall.findMany.mockImplementation(async () => prismaMock.agentToolCall.createMany.mock.calls.at(-1)?.[0].data ?? []);
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
    prismaMock.meeting.findFirst.mockReset().mockImplementation(args => prismaMock.meeting.findUnique(args));
    prismaMock.meetingInsight.findMany.mockReset().mockImplementation(async () => (await prismaMock.meeting.findUnique({}))?.insights ?? []);
    prismaMock.meeting.update.mockReset().mockResolvedValue({});
    prismaMock.meeting.updateMany.mockReset().mockResolvedValue({ count: 1 });
    buildMeetingIntelligenceContextMock.mockReset().mockImplementation(async ({ workspaceId, meetingId }: { workspaceId: string; meetingId: string }) => {
      const meeting = await prismaMock.meeting.findUnique({ where: { id: meetingId, workspaceId } });
      return {
        lineageInputs: [{ kind: "MeetingTranscript", id: meetingId }],
        lineageRoots: [{ kind: "MeetingTranscript", id: meetingId, fingerprint: "a".repeat(64) }],
        sourceStateHash: "fixture-state",
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

  it("keeps replayed meeting insights reviewable by default", async () => {
    lineage.readableIds.mockImplementation(async (_actor, _workspaceId, kind, rows) => new Set(kind === "MeetingInsight" ? rows.map((row: {id: string}) => row.id) : []));
    const fixture = operationsTacticalReplayFixture;
    const meetingRecord = meetingRecordFromReplayFixture(fixture);
    prismaMock.meeting.findUnique.mockResolvedValue(meetingRecord);

    expect(meetingRecord.insights).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: fixture.workspaceId,
        meetingId: fixture.meetingId,
        type: "ACTION_ITEM",
        operation: "CREATE",
        bodyMd: expect.stringContaining("Milan will publish"),
        dueAt: new Date("2026-07-17T17:00:00.000Z"),
        sourceQuote: expect.stringContaining("checklist by Friday"),
        status: "SUGGESTED",
      }),
      expect.objectContaining({
        workspaceId: fixture.workspaceId,
        meetingId: fixture.meetingId,
        type: "ACTION_ITEM",
        operation: "CREATE",
        bodyMd: expect.stringContaining("Rhea owns the customer retest evidence matrix"),
        assigneeHint: "Rhea",
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
        goal: expect.stringContaining("reviewable drafts"),
      }),
    }));
    expect(prismaMock.agentToolCall.createMany).toHaveBeenCalled();
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "COMPLETED",
        approvalRequired: false,
      }),
    }));
    expect(autoApplyMeetingInsightsMock).not.toHaveBeenCalled();
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        resultJson: expect.objectContaining({
          meetingId: fixture.meetingId,
          reviewRequired: true,
          suggested: meetingRecord.insights.length,
        }),
      }),
    }));
  });

  it("keeps uploaded transcript insights reviewable without auto-creating Actions or tensions", async () => {
    lineage.readableIds.mockImplementation(async (_actor, _workspaceId, kind, rows) => new Set(kind === "MeetingInsight" ? rows.map((row: {id: string}) => row.id) : []));
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: "meeting-upload",
      workspaceId: "ws-1",
      title: "Steering meeting",
      transcript: "Andy: I will send the steering update.",
      summaryMd: null,
      insights: [{ id: "insight-1", type: "ACTION_ITEM", status: "SUGGESTED" }],
    });

    const { runActionExtractionAgent } = await import(".");
    await runActionExtractionAgent({
      workspaceId: "ws-1",
      triggerRef: "job-upload",
      meetingId: "meeting-upload",
    });

    expect(autoApplyMeetingInsightsMock).not.toHaveBeenCalled();
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "COMPLETED",
        resultJson: expect.objectContaining({
          meetingId: "meeting-upload",
          reviewRequired: true,
          suggested: 1,
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

    expect(lineage.persistMeeting).toHaveBeenCalledWith(expect.objectContaining({ workspaceIds: ["ws-1"] }), expect.objectContaining({
      meetingId: "meeting-2", workspaceId: "ws-1", sourceStateHash: "fixture-state", summaryMd: "Concise meeting summary",
      lineageRoots: [expect.objectContaining({ kind: "MeetingTranscript", id: "meeting-2" })],
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
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1", title: "Budget sync", summaryMd: null, transcript: "Discussed spending thresholds.",
    });

    const { runProposalDraftingAgent } = await import(".");
    await runProposalDraftingAgent({
      workspaceId: "ws-1",
      triggerRef: "job-4",
      prompt: "Create a budget policy",
      meetingId: "meeting-1",
      reviewFeedback: "Clarify the threshold",
      previousAdvice: "Spoofed old job text", feedbackInputId: "feedback-1", priorRunSnapshotId: "prior-run",
    });

    expect(knowledgeMock.searchIndexedKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      query: "Create a budget policy",
    }));
    expect(prismaMock.meeting.findFirst).toHaveBeenCalledWith({
      where: { id: "meeting-1", workspaceId: "ws-1" },
    });
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "WAITING_APPROVAL",
        approvalRequired: true,
      }),
    }));
    expect(prismaMock.agentStep.createMany).toHaveBeenCalledWith({ data: expect.arrayContaining([
      expect.objectContaining({
        name: "approval-checkpoint", status: "PENDING",
        outputJson: { question: "Review this advisory draft. Reply with changes; creating a proposal record requires a separate action." },
      }),
    ]) });
    expect(modelGatewayMock.chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        role: "user", content: expect.stringContaining("Discussed spending thresholds."),
      })]),
    }));
    expect(JSON.stringify(modelGatewayMock.chat.mock.calls[0]?.[0]?.messages)).toContain("Clarify the threshold");
    expect(JSON.stringify(modelGatewayMock.chat.mock.calls[0]?.[0]?.messages)).not.toContain("Spoofed old job text");
    expect(prismaMock.proposal.count).not.toHaveBeenCalled();
  });

  it("blocks legacy raw prompts and raw feedback before creating a run or calling a model", async () => {
    const { runProposalDraftingAgent, runConstitutionUpdateTriggerAgent } = await import(".");
    await expect(runProposalDraftingAgent({ workspaceId: "ws-1", triggerRef: "legacy", prompt: "Unproven old prompt" }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(runConstitutionUpdateTriggerAgent({ workspaceId: "ws-1", triggerRef: "legacy", proposalId: "proposal-1", reviewFeedback: "Unproven old reply" }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.agentRun.create).not.toHaveBeenCalled();
    expect(modelGatewayMock.chat).not.toHaveBeenCalled();
  });

  it("waits for approval after constitution follow-up analysis", async () => {
    prismaMock.proposal.findFirst.mockResolvedValue({
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
      reviewFeedback: "Explain the policy impact",
      previousAdvice: "Spoofed old job text", feedbackInputId: "feedback-1", priorRunSnapshotId: "prior-run",
    });

    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "WAITING_APPROVAL",
        approvalRequired: true,
      }),
    }));
    expect(prismaMock.agentStep.createMany).toHaveBeenCalledWith({ data: expect.arrayContaining([
      expect.objectContaining({
        name: "approval-checkpoint", status: "PENDING",
        outputJson: { question: "Review this advisory policy analysis. Reply with changes; protected follow-up requires a separate action." },
      }),
    ]) });
    expect(modelGatewayMock.chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        role: "user", content: expect.stringContaining("Explain the policy impact"),
      })]),
    }));
  });
  function provenRunParams() {
    const roots = [{ kind: "Workspace" as const, id: "ws-1", fingerprint: "a".repeat(64) }];
    const dataRoots = [{ kind: "Document" as const, id: "doc-1", fingerprint: "b".repeat(64) }];
    return {
      agentKey: "inbox-triage" as const, workspaceId: "ws-1", triggerType: "EVENT" as const, triggerRef: "proof-job",
      goal: "Static operational goal", payload: {}, plan: ["read", "model"],
      lineageActor: { kind: "agent" as const, authProvider: "bootstrap" as const, label: "receipt-test", workspaceIds: ["ws-1"] }, lineageRoots: roots,
      contextLineageRoots: () => dataRoots,
      buildContext: async () => ({ source: "Exact document content" }),
      execute: async (_context: Record<string, unknown>, helpers: import("./runtime").AgentHelpers) => {
        const receipt = await helpers.captureInputs([...dataRoots, ...helpers.behaviorLineageRoots]);
        const output = await helpers.tool("model.chat", { content: "Exact document content" }, async () => "Generated content", { receipt });
        return { resultJson: { output }, lineageReceipt: receipt };
      },
    };
  }

  it("captures immutable inputs before work and writes exact child IDs plus DERIVED receipts atomically", async () => {
    const { executeAgentRun } = await import("./runtime");
    await executeAgentRun(provenRunParams());
    const modelRow = prismaMock.agentToolCall.createMany.mock.calls[0][0].data[0];
    expect(modelRow.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lineage.record).toHaveBeenCalledWith(expect.objectContaining({ tx: prismaMock, artifact: { kind: "AgentToolCall", id: modelRow.id },
      content: modelRow, origin: "DERIVED", inheritedRoots: [{ kind: "ArtifactInputSnapshot", id: "snapshot-Document-doc-1", fingerprint: "b".repeat(64) }] }));
    expect(lineage.record).toHaveBeenLastCalledWith(expect.objectContaining({ artifact: { kind: "AgentRun", id: "run-1" }, origin: "DERIVED",
      inheritedRoots: expect.arrayContaining([expect.objectContaining({ id: "snapshot-Workspace-ws-1" }), expect.objectContaining({ id: "snapshot-Document-doc-1" })]) }));
    expect(lineage.snapshot.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.agentRun.create.mock.invocationCallOrder[0]);
    expect(prismaMock.agentToolCall.createMany.mock.invocationCallOrder[0]).toBeLessThan(lineage.record.mock.invocationCallOrder.at(-1)!);
  });

  it("never upgrades arbitrary work or a forged model outcome to complete lineage", async () => {
    const { executeAgentRun } = await import("./runtime");
    const params = provenRunParams();
    await executeAgentRun({ ...params, execute: async (_context, helpers) => {
      await helpers.tool("unproved", {}, async () => "Unproved private output");
      return { resultJson: { output: "Unproved private output" }, lineageReceipt: { kind: "agent-input-receipt" } };
    } });
    expect(lineage.invalidate).toHaveBeenCalledWith(expect.objectContaining({ artifact: expect.objectContaining({ kind: "AgentToolCall" }) }));
    expect(lineage.invalidate).toHaveBeenLastCalledWith(expect.objectContaining({ artifact: { kind: "AgentRun", id: "run-1" } }));
    expect(lineage.record.mock.calls.some(([call]) => call.origin === "HUMAN_ORIGINAL")).toBe(false);
  });

  it("retains original live job roots alongside immutable receipt roots for each model attempt", async () => {
    const {executeAgentRun} = await import("./runtime");
    const jobRoot = {kind: "WorkflowJobInput" as const, id: "job-input", fingerprint: "c".repeat(64)};
    const initial = provenRunParams();
    await executeAgentRun({...initial, lineageRoots: [...initial.lineageRoots, jobRoot], execute: async (_context, helpers) => {
      const receipt = await helpers.captureInputs([jobRoot]);
      jobRoot.fingerprint = "d".repeat(64);
      await helpers.tool("model.test", {}, async operation => {
        const request = operation.modelRequest({});
        for (let i = 0; i < 2; i++) {
          await request.authorizeAttempt!({signal: new AbortController().signal});
          expect(lineage.readable.mock.lastCall?.[2]).toEqual(expect.arrayContaining([
            expect.objectContaining({kind: "WorkflowJobInput", id: "job-input", fingerprint: "c".repeat(64)}),
            expect.objectContaining({kind: "ArtifactInputSnapshot"}),
          ]));
        }
      }, {receipt});
      return {resultJson: {done: true}, lineageReceipt: receipt};
    }});
  });

  it("rejects forged operation receipts before any work", async () => {
    const { executeAgentRun } = await import("./runtime");
    const work = vi.fn();
    await expect(executeAgentRun({ ...provenRunParams(), execute: async (_context, helpers) => {
      await helpers.tool("model.chat", {}, work, { receipt: { kind: "agent-input-receipt" } });
      return { resultJson: {} };
    } })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(work).not.toHaveBeenCalled();
    expect(lineage.invalidate).toHaveBeenLastCalledWith(expect.objectContaining({ artifact: { kind: "AgentRun", id: "run-1" } }));
  });

  it("unions observed actual read roots only for explicitly audited readers", async () => {
    const { executeAgentRun } = await import("./runtime");
    lineage.observe.mockImplementation(async (_actor, _workspaceId, work) => ({ value: await work(), roots: [{ kind: "Document", id: "read-doc", fingerprint: "c".repeat(64) }] }));
    await executeAgentRun({ ...provenRunParams(), execute: async (_context, helpers) => {
      await helpers.tool("audited-read", {}, async () => "Read content", { receipt: helpers.plannedInputReceipt, auditedRead: true });
      return { resultJson: {} };
    } });
    expect(lineage.record).toHaveBeenCalledWith(expect.objectContaining({ artifact: expect.objectContaining({ kind: "AgentToolCall" }),
      inheritedRoots: expect.arrayContaining([expect.objectContaining({ id: "snapshot-Workspace-ws-1" }), expect.objectContaining({ id: "snapshot-Document-read-doc" })]) }));
  });

  it("downgrades revoked receipts at persistence while retaining operational completion", async () => {
    const { executeAgentRun } = await import("./runtime");
    await executeAgentRun({ ...provenRunParams(), execute: async (_context, helpers) => {
      const receipt = await helpers.captureInputs([{ kind: "Document", id: "doc-1", fingerprint: "b".repeat(64) }]);
      await helpers.tool("model.chat", {}, async () => { lineage.readable.mockResolvedValue(false); return "Generated before revocation"; }, { receipt });
      return { resultJson: { output: "Generated before revocation" }, lineageReceipt: receipt };
    } });
    expect(prismaMock.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }));
    expect(lineage.invalidate).toHaveBeenLastCalledWith(expect.objectContaining({ artifact: { kind: "AgentRun", id: "run-1" } }));
  });

  it("withholds exception text despite a valid pre-work input receipt", async () => {
    const { executeAgentRun } = await import("./runtime");
    await expect(executeAgentRun({ ...provenRunParams(), execute: async (_context, helpers) => {
      await helpers.tool("model.chat", {}, async () => { throw new Error("Unobserved private exception"); }, { receipt: helpers.plannedInputReceipt });
      return { resultJson: {} };
    } })).rejects.toThrow("Unobserved private exception");
    expect(lineage.invalidate).toHaveBeenCalledWith(expect.objectContaining({ artifact: expect.objectContaining({ kind: "AgentToolCall" }) }));
    expect(lineage.invalidate).toHaveBeenLastCalledWith(expect.objectContaining({ artifact: { kind: "AgentRun", id: "run-1" } }));
  });

  it("validates exact behavior identity before including its text and proof", async () => {
    const { executeAgentRun } = await import("./runtime");
    const identity = { id: "behavior-1", workspaceId: "ws-1", agentKey: "__workspace__", isActive: true, behaviorMd: "Verified workspace policy" };
    prismaMock.agentIdentity.findUnique.mockImplementation(async ({ where }) => where.workspaceId_agentKey.agentKey === "__workspace__" ? identity : null);
    const params = provenRunParams();
    await executeAgentRun({ ...params, execute: async (context, helpers, runId, model) => {
      expect((context as Record<string, unknown>).__behaviorMd).toContain(identity.behaviorMd);
      expect(helpers.behaviorLineageRoots).toEqual([expect.objectContaining({ id: "snapshot-AgentIdentity-behavior-1" })]);
      return params.execute(context, helpers);
    } });
    expect(lineage.capture).toHaveBeenCalledWith(params.lineageActor, "ws-1", [{ kind: "AgentIdentity", id: identity.id, snapshot: identity }]);
  });

  it("does not execute a model with unknown behavior directives", async () => {
    const { executeAgentRun } = await import("./runtime");
    prismaMock.agentIdentity.findUnique.mockResolvedValue({ id: "unknown-policy", isActive: true, behaviorMd: "Unknown private policy" });
    lineage.capture.mockRejectedValue(Object.assign(new Error("Unknown behavior"), { code: "UNKNOWN_LINEAGE" }));
    const execute = vi.fn();
    await expect(executeAgentRun({ ...provenRunParams(), execute })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not return stale replay results or rerun an unknown completed job", async () => {
    const { executeAgentRun } = await import("./runtime");
    prismaMock.agentRun.findFirst.mockResolvedValue({ id: "old-run", status: "COMPLETED", goal: "Private old goal", contextJson: { secret: true }, resultJson: { secret: true } });
    const result = await executeAgentRun(provenRunParams());
    expect(result).toMatchObject({ id: "old-run", status: "COMPLETED", resultJson: null, contextJson: null, reason: "existing_run_inputs_unavailable" });
    expect(prismaMock.agentRun.create).not.toHaveBeenCalled();
  });

  it("blocks unreceipted feedback continuations before generating or persisting copied history", async () => {
    const { executeAgentRun } = await import("./runtime");
    await expect(executeAgentRun({ ...provenRunParams(), lineageRoots: undefined,
      payload: { reviewFeedback: "Revise it", previousAdvice: "Old private advice" } })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.agentRun.create).not.toHaveBeenCalled();
  });

});
