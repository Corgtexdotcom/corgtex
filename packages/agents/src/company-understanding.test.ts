import { AppError } from "../../domain/src/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  modelGatewayMock,
  createGoalMock,
  createGoalLinkMock,
  createQuestionMock,
  createDiffMock,
  getApplyModeMock,
  readableArtifactIdsMock,
  readableSourcesMock,
  captureProofMock,
  currentRootsMock,
  sourceFingerprintMock,
  artifactFingerprintMock,
  releaseProofMock,
} = vi.hoisted(() => ({
  prismaMock: {
    brainSource: { findMany: vi.fn(), count: vi.fn() },
    brainArticle: { findMany: vi.fn() },
    goal: { findMany: vi.fn() },
    member: { findFirst: vi.fn() },
    checkIn: { findMany: vi.fn() },
    contextGraphProposedDiff: { findMany: vi.fn() },
  },
  modelGatewayMock: {
    extract: vi.fn(),
  },
  createGoalMock: vi.fn(),
  createGoalLinkMock: vi.fn(),
  createQuestionMock: vi.fn(),
  createDiffMock: vi.fn(),
  getApplyModeMock: vi.fn(),
  readableArtifactIdsMock: vi.fn(),
  readableSourcesMock: vi.fn(),
  captureProofMock: vi.fn(),
  currentRootsMock: vi.fn(),
  sourceFingerprintMock: vi.fn(),
  artifactFingerprintMock: vi.fn(),
  releaseProofMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: modelGatewayMock,
}));

vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: async () => ({id: "member-1"}) }));
vi.mock("../../domain/src/source-lineage", () => ({
  captureArtifactInputProof: captureProofMock,
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({value: await read(), heads: new Map()}),
  mergeLineageInputRoot: (_previous: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _workspace: string, roots: unknown, _remote: unknown, finish: (tx: unknown) => Promise<unknown>) => { await releaseProofMock(roots); return finish({}); },
}));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/digest-lineage"),
  AGENT_REGISTRY: {
    "company-understanding": { defaultModelTier: "quality" },
  },
  CONTEXT_GRAPH_OBJECT_TYPES: [
    "Person",
    "Team",
    "Role",
    "Process",
    "ProcessStep",
    "Project",
    "Task",
    "Decision",
    "Document",
    "Meeting",
    "Customer",
    "Tool",
    "Risk",
    "Metric",
    "Policy",
    "Agent",
    "Question",
    "Hypothesis",
    "Evidence",
  ],
  CONTEXT_GRAPH_RELATIONSHIP_TYPES: [
    "owns",
    "member_of",
    "reports_to",
    "depends_on",
    "blocks",
    "uses",
    "created_in",
    "decided_in",
    "supports",
    "contradicts",
    "supersedes",
    "assigned_to",
    "needs_approval_from",
    "has_evidence",
    "part_of",
    "input_to",
    "output_of",
  ],
  createCompanyUnderstandingQuestion: createQuestionMock,
  createContextGraphProposedDiff: createDiffMock,
  createGoal: createGoalMock,
  createGoalLink: createGoalLinkMock,
  getCompanyUnderstandingGoalApplyMode: getApplyModeMock,
  resolveKnowledgeAccessDomains: vi.fn().mockResolvedValue(["WORKSPACE"]),
  readableArtifactIds: readableArtifactIdsMock,
  readableBrainSourceIds: readableSourcesMock,
  captureArtifactInputProof: captureProofMock,
  currentArtifactInputRoots: currentRootsMock,
  brainSourceContentFingerprint: sourceFingerprintMock,
  lineageContentFingerprint: artifactFingerprintMock,
}));

describe("company understanding synthesis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseProofMock.mockReset().mockResolvedValue(undefined);
    prismaMock.brainSource.findMany.mockResolvedValue([
      {
        id: "source-1",
        accessDomain: "WORKSPACE",
        workspaceId: "workspace-1",
        archivedAt: null,
        channel: null,
        sourceType: "DOC",
        tier: 1,
        title: "Company plan",
        content: "Launch onboarding and document support ownership.",
        ingestionGuidanceMd: null,
        absorbedAt: new Date(),
      },
    ]);
    prismaMock.brainSource.count.mockResolvedValue(1);
    prismaMock.brainArticle.findMany.mockResolvedValue([
      {
        id: "article-1",
        slug: "company-plan",
        title: "Company plan",
        type: "STRATEGY",
        authority: "REFERENCE",
        bodyMd: "Launch onboarding and document support ownership.",
        sourceIds: ["source-1"],
      },
    ]);
    prismaMock.goal.findMany.mockResolvedValue([]);
    prismaMock.member.findFirst.mockResolvedValue({ id: "member-1" });
    prismaMock.checkIn.findMany.mockResolvedValue([]);
    prismaMock.contextGraphProposedDiff.findMany.mockResolvedValue([]);
    createGoalMock.mockResolvedValue({ id: "goal-1" });
    createGoalLinkMock.mockResolvedValue({ id: "link-1" });
    createQuestionMock.mockResolvedValue({ id: "question-1" });
    createDiffMock.mockResolvedValue({ id: "diff-1" });
    getApplyModeMock.mockResolvedValue("AUTO");
    readableArtifactIdsMock.mockImplementation(async (_actor, _workspaceId, _kind, records) => new Set(records.map((record: { id: string }) => record.id)));
    readableSourcesMock.mockImplementation(async (_actor, _workspaceId, records) => new Set(records.filter((row: { accessDomain: string; archivedAt?: unknown }) => row.accessDomain === "WORKSPACE" && !row.archivedAt).map((row: { id: string }) => row.id)));
    captureProofMock.mockImplementation(async (_actor, _workspaceId, inputs) => {
      const roots = [];
      for (const input of inputs) {
        const permitted = input.kind === "BrainSource"
          ? await readableSourcesMock(_actor, _workspaceId, [input.snapshot])
          : await readableArtifactIdsMock(_actor, _workspaceId, input.kind, [input.snapshot]);
        if (!permitted.has(input.id)) throw new AppError(409, "UNKNOWN_LINEAGE", "Not permitted.");
        roots.push({ kind: input.kind, id: input.id, fingerprint: input.kind === "BrainSource"
          ? sourceFingerprintMock(input.snapshot) : artifactFingerprintMock(input.kind, input.snapshot) });
        if (input.kind !== "BrainSource") {
          const inherited = await currentRootsMock(null, null, input, input.snapshot);
          if (!inherited) throw new AppError(409, "UNKNOWN_LINEAGE", "No original manifest.");
          roots.push(...inherited);
        }
      }
      return roots;
    });
    currentRootsMock.mockResolvedValue([]);
    sourceFingerprintMock.mockImplementation((record) => `source-fingerprint:${record.id}`);
    artifactFingerprintMock.mockImplementation((kind, record) => `${kind}-fingerprint:${record.id}`);
  });

  it.each([false, true])("only readable duplicates suppress fresh map proposals and questions (readable=%s)", async (permitted) => {
    prismaMock.checkIn.findMany.mockResolvedValue([{ id: "old-question", questionText: "Who owns onboarding?" }]);
    prismaMock.contextGraphProposedDiff.findMany.mockResolvedValue([{ id: "old-diff", reason: "Company understanding proposal: org: Onboarding ownership" }]);
    readableArtifactIdsMock.mockImplementation(async (_actor, _workspaceId, kind, records) =>
      new Set(["CheckIn", "ContextGraphProposedDiff"].includes(kind) && !permitted ? [] : records.map((row: { id: string }) => row.id)));
    modelGatewayMock.extract.mockResolvedValue({ output: {
      openQuestions: [{ questionText: "Who owns onboarding?", reason: "Clarify owner", confidence: 0.9 }],
      mapProposals: [{ title: "Onboarding ownership", mapType: "org", confidence: 0.9,
        evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }],
        objects: [{ ref: "team", objectType: "Team", title: "Onboarding team", summary: "Current permitted source" }], relationships: [] }],
    } });
    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    await runCompanyUnderstandingSynthesis({ workspaceId: "workspace-1", agentRunId: "run-1", model: "gpt-4o-mini" });
    expect(createQuestionMock).toHaveBeenCalledTimes(permitted ? 0 : 1);
    expect(createDiffMock).toHaveBeenCalledTimes(permitted ? 0 : 1);
    expect(modelGatewayMock.extract.mock.calls[0]?.[0].input).not.toContain("old-diff");
    expect(modelGatewayMock.extract.mock.calls[0]?.[0].input).not.toContain("old-question");
  });

  it("normalizes all six goal cadences from model labels", async () => {
    const { normalizeCompanyUnderstandingGoalCadence } = await import("./company-understanding");

    expect(normalizeCompanyUnderstandingGoalCadence("10Y")).toBe("TEN_YEAR");
    expect(normalizeCompanyUnderstandingGoalCadence("five year")).toBe("FIVE_YEAR");
    expect(normalizeCompanyUnderstandingGoalCadence("Annual")).toBe("ANNUAL");
    expect(normalizeCompanyUnderstandingGoalCadence("quarterly")).toBe("QUARTERLY");
    expect(normalizeCompanyUnderstandingGoalCadence("Monthly")).toBe("MONTHLY");
    expect(normalizeCompanyUnderstandingGoalCadence("week")).toBe("WEEKLY");
  });

  it("creates an active evidence-backed goal at high confidence", async () => {
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        goals: [
          {
            title: "Launch onboarding",
            summary: "Ship the onboarding flow this quarter.",
            cadence: "QUARTERLY",
            confidence: 0.91,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1", quote: "Launch onboarding" }],
          },
        ],
      },
    });

    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    const result = await runCompanyUnderstandingSynthesis({
      workspaceId: "workspace-1",
      agentRunId: "run-1",
      sourceId: "source-1",
      model: "gpt-4o-mini",
    });

    expect(result).toMatchObject({ generatedGoals: 1, questions: 0 });
    expect(createGoalMock).toHaveBeenCalledWith(expect.objectContaining({ label: "company-understanding" }), expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Launch onboarding",
      status: "ACTIVE",
      cadence: "QUARTERLY",
    }));
    expect(createGoalLinkMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      goalId: "goal-1",
      entityType: "BrainSource",
      entityId: "source-1",
      confidence: 0.91,
      source: "company-understanding",
    }));
  });

  it("applies the workspace source limit after excluding unreadable copied sources", async () => {
    const source = (await prismaMock.brainSource.findMany())[0];
    const records = Array.from({ length: 21 }, (_, index) => ({ ...source, id: `source-${index}` }));
    prismaMock.brainSource.findMany.mockResolvedValue(records);
    readableSourcesMock.mockResolvedValue(new Set(["source-20"]));
    modelGatewayMock.extract.mockResolvedValue({ output: {} });
    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    const result = await runCompanyUnderstandingSynthesis({ workspaceId: "workspace-1", agentRunId: "run-1", model: "gpt-4o-mini" });
    expect(result).toMatchObject({ sourceCount: 1 });
    expect(prismaMock.brainSource.findMany).toHaveBeenLastCalledWith(expect.not.objectContaining({ take: 20 }));
    expect(JSON.parse(modelGatewayMock.extract.mock.calls[0]?.[0].input).sources.map((row: { id: string }) => row.id)).toEqual(["source-20"]);
  });

  it("skips source-triggered synthesis when the exact source is unavailable", async () => {
    prismaMock.brainSource.findMany.mockResolvedValue([]);

    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    const result = await runCompanyUnderstandingSynthesis({
      workspaceId: "workspace-1",
      agentRunId: "run-1",
      sourceId: "archived-source",
      model: "gpt-4o-mini",
    });

    expect(result).toEqual({ skipped: true, reason: "source_unavailable" });
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(createGoalMock).not.toHaveBeenCalled();
  });

  it("stops source-triggered synthesis when the exact source is archived before persistence", async () => {
    prismaMock.brainSource.count.mockResolvedValue(0);
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        goals: [
          {
            title: "Launch onboarding",
            summary: "Ship the onboarding flow this quarter.",
            cadence: "QUARTERLY",
            confidence: 0.91,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1", quote: "Launch onboarding" }],
          },
        ],
        openQuestions: [
          {
            questionText: "Who owns onboarding?",
            priority: 8,
            confidence: 0.8,
            relatedEntityType: "BrainSource",
            relatedEntityId: "source-1",
          },
        ],
        mapProposals: [
          {
            title: "Support ownership",
            mapType: "org",
            confidence: 0.9,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }],
            objects: [{ ref: "support", objectType: "Team", title: "Support", summary: null }],
            relationships: [],
          },
        ],
      },
    });

    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    const result = await runCompanyUnderstandingSynthesis({
      workspaceId: "workspace-1",
      agentRunId: "run-1",
      sourceId: "source-1",
      model: "gpt-4o-mini",
    });

    expect(result).toMatchObject({ generatedGoals: 0, questions: 0, mapProposals: 0 });
    expect(createGoalMock).not.toHaveBeenCalled();
    expect(createQuestionMock).not.toHaveBeenCalled();
    expect(createDiffMock).not.toHaveBeenCalled();
  });

  it("applies automatic confidence gates across active goals, drafts, and questions", async () => {
    createGoalMock
      .mockResolvedValueOnce({ id: "goal-high" })
      .mockResolvedValueOnce({ id: "goal-medium" });
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        goals: [
          {
            title: "Win category leadership",
            summary: "Establish durable category position.",
            cadence: "TEN_YEAR",
            confidence: 0.91,
            evidenceRefs: [{ sourceType: "BrainArticle", sourceId: "article-1" }],
          },
          {
            title: "Build launch operating system",
            summary: "Draft evidence-backed operating system.",
            cadence: "ANNUAL",
            confidence: 0.72,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }],
          },
          {
            title: "Speculative expansion",
            summary: "Low confidence direction.",
            cadence: "FIVE_YEAR",
            confidence: 0.44,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }],
          },
        ],
      },
    });

    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    const result = await runCompanyUnderstandingSynthesis({
      workspaceId: "workspace-1",
      agentRunId: "run-1",
      sourceId: "source-1",
      model: "gpt-4o-mini",
    });

    expect(result).toMatchObject({ generatedGoals: 2, questions: 1, goalApplyMode: "AUTO" });
    expect(createGoalMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      title: "Win category leadership",
      cadence: "TEN_YEAR",
      status: "ACTIVE",
    }));
    expect(createGoalMock).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      title: "Build launch operating system",
      cadence: "ANNUAL",
      status: "DRAFT",
    }));
    expect(createQuestionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      questionText: "Should this become a company goal: Speculative expansion?",
    }));
  });

  it("keeps generated goals as drafts in manual apply mode", async () => {
    getApplyModeMock.mockResolvedValue("MANUAL");
    createGoalMock
      .mockResolvedValueOnce({ id: "goal-high" })
      .mockResolvedValueOnce({ id: "goal-medium" });
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        goals: [
          {
            title: "Own strategic platform",
            cadence: "FIVE_YEAR",
            confidence: 0.94,
            evidenceRefs: [{ sourceType: "BrainArticle", sourceId: "article-1" }],
          },
          {
            title: "Resolve launch blockers",
            cadence: "MONTHLY",
            confidence: 0.75,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }],
          },
        ],
      },
    });

    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    const result = await runCompanyUnderstandingSynthesis({
      workspaceId: "workspace-1",
      agentRunId: "run-1",
      sourceId: "source-1",
      model: "gpt-4o-mini",
    });

    expect(result).toMatchObject({ generatedGoals: 2, questions: 0, goalApplyMode: "MANUAL" });
    expect(createGoalMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      title: "Own strategic platform",
      status: "DRAFT",
    }));
    expect(createGoalMock).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      title: "Resolve launch blockers",
      status: "DRAFT",
    }));
  });

  it("links generated child goals to generated parents in cadence order", async () => {
    createGoalMock
      .mockResolvedValueOnce({ id: "annual-goal" })
      .mockResolvedValueOnce({ id: "quarterly-goal" });
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        goals: [
          {
            title: "Ship Q1 growth system",
            cadence: "QUARTERLY",
            confidence: 0.9,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }],
            parentTitle: "Build annual growth system",
            parentCadence: "ANNUAL",
          },
          {
            title: "Build annual growth system",
            cadence: "ANNUAL",
            confidence: 0.9,
            evidenceRefs: [{ sourceType: "BrainArticle", sourceId: "article-1" }],
          },
        ],
      },
    });

    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    await runCompanyUnderstandingSynthesis({
      workspaceId: "workspace-1",
      agentRunId: "run-1",
      sourceId: "source-1",
      model: "gpt-4o-mini",
    });

    expect(createGoalMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      title: "Build annual growth system",
      cadence: "ANNUAL",
      parentGoalId: null,
    }));
    expect(createGoalMock).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      title: "Ship Q1 growth system",
      cadence: "QUARTERLY",
      parentGoalId: "annual-goal",
    }));
  });

  it("does not overwrite duplicate manual goals and only links evidence", async () => {
    prismaMock.goal.findMany.mockResolvedValue([
      {
        id: "manual-goal",
        title: "Launch onboarding",
        status: "ACTIVE",
        cadence: "QUARTERLY",
        parentGoalId: null,
        links: [],
      },
    ]);
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        goals: [
          {
            title: "Launch onboarding",
            summary: "Model description should not replace manual content.",
            cadence: "QUARTERLY",
            confidence: 0.93,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }],
          },
        ],
      },
    });

    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    const result = await runCompanyUnderstandingSynthesis({
      workspaceId: "workspace-1",
      agentRunId: "run-1",
      sourceId: "source-1",
      model: "gpt-4o-mini",
    });

    expect(result).toMatchObject({ generatedGoals: 0, updatedGoals: 1, questions: 0 });
    expect(createGoalMock).not.toHaveBeenCalled();
    expect(createGoalLinkMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      goalId: "manual-goal",
      entityType: "BrainSource",
      entityId: "source-1",
    }));
  });

  it("keeps lower-confidence goals as company-understanding questions", async () => {
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        goals: [
          {
            title: "Expand enterprise support",
            summary: "Possible direction but unclear ownership.",
            horizon: "long",
            confidence: 0.42,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }],
          },
        ],
      },
    });

    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    const result = await runCompanyUnderstandingSynthesis({
      workspaceId: "workspace-1",
      agentRunId: "run-1",
      sourceId: "source-1",
      model: "gpt-4o-mini",
    });

    expect(result).toMatchObject({ generatedGoals: 0, questions: 1 });
    expect(createGoalMock).not.toHaveBeenCalled();
    expect(createQuestionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: "workspace-1",
      memberId: "member-1",
      questionText: "Should this become a company goal: Expand enterprise support?",
    }));
  });

  it("creates evidence-backed context-map proposed diffs and asks questions when evidence is missing", async () => {
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        mapProposals: [
          {
            title: "Support ownership",
            mapType: "org",
            confidence: 0.78,
            evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1", quote: "support ownership" }],
            objects: [
              { ref: "support", objectType: "Team", title: "Support", summary: "Handles support requests." },
              { ref: "lead", objectType: "Role", title: "Support Lead", summary: "Owns support quality." },
            ],
            relationships: [
              { sourceRef: "lead", targetRef: "support", relationshipType: "owns", summary: "Owns the team." },
            ],
          },
          {
            title: "Unsupported agent governance",
            mapType: "agent-governance",
            confidence: 0.81,
            evidenceRefs: [],
            objects: [{ ref: "agent", objectType: "Agent", title: "Unknown agent" }],
          },
        ],
      },
    });

    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    const result = await runCompanyUnderstandingSynthesis({
      workspaceId: "workspace-1",
      agentRunId: "run-1",
      sourceId: "source-1",
      model: "gpt-4o-mini",
    });

    expect(result).toMatchObject({ mapProposals: 1, questions: 1 });
    expect(createDiffMock).toHaveBeenCalledWith(expect.objectContaining({ label: "company-understanding" }), expect.objectContaining({
      workspaceId: "workspace-1",
      reason: "Company understanding proposal: org: Support ownership",
      diff: expect.objectContaining({
        objects: expect.arrayContaining([
          expect.objectContaining({ objectType: "Team", title: "Support", sourceEntityId: "source-1" }),
        ]),
        relationships: expect.arrayContaining([
          expect.objectContaining({ relationshipType: "owns", sourceRef: "lead", targetRef: "support" }),
        ]),
      }),
    }));
    expect(createQuestionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      questionText: "What evidence should CORGTEX use before proposing the agent-governance map item \"Unsupported agent governance\"?",
    }));
  });

  it("propagates every prompt input and its captured roots to goals, questions, and map diffs", async () => {
    const source = (await prismaMock.brainSource.findMany())[0];
    prismaMock.brainSource.findMany.mockResolvedValue([source, { ...source, id: "source-2", title: "Operating plan" }]);
    prismaMock.goal.findMany.mockResolvedValue([
      { id: "existing-goal", title: "Existing annual goal", cadence: "ANNUAL", status: "ACTIVE", parentGoalId: null, links: [] },
    ]);
    currentRootsMock.mockImplementation(async (_db, _workspaceId, input) => input.kind === "BrainArticle"
      ? [{ kind: "BrainSource", id: "transitive-source", fingerprint: "captured-transitive-fingerprint" }]
      : []);
    modelGatewayMock.extract.mockResolvedValue({ output: {
      goals: [{ title: "Launch onboarding", cadence: "QUARTERLY", confidence: 0.9, evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }] }],
      openQuestions: [{ questionText: "Who owns onboarding?", confidence: 0.8 }],
      mapProposals: [{ title: "Support ownership", mapType: "org", confidence: 0.9,
        evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }],
        objects: [{ ref: "support", objectType: "Team", title: "Support" }] }],
    } });
    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    await runCompanyUnderstandingSynthesis({ workspaceId: "workspace-1", agentRunId: "run-1", model: "synthetic" });

    const completeInputs = [
      { kind: "BrainSource", id: "source-1" },
      { kind: "BrainSource", id: "source-2" },
      { kind: "BrainArticle", id: "article-1" },
      { kind: "Goal", id: "existing-goal" },
    ];
    for (const writer of [createGoalMock, createGoalLinkMock, createQuestionMock, createDiffMock]) {
      expect(writer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        lineageInputs: completeInputs,
        lineageRoots: expect.arrayContaining([
          { kind: "BrainSource", id: "source-2", fingerprint: "source-fingerprint:source-2" },
          { kind: "BrainArticle", id: "article-1", fingerprint: "BrainArticle-fingerprint:article-1" },
          { kind: "Goal", id: "existing-goal", fingerprint: "Goal-fingerprint:existing-goal" },
          { kind: "BrainSource", id: "transitive-source", fingerprint: "captured-transitive-fingerprint" },
        ]),
      }));
    }
  });

  it("excludes restricted sources and unknown or unauthorized artifact lineage from the prompt", async () => {
    const source = (await prismaMock.brainSource.findMany())[0];
    prismaMock.brainSource.findMany.mockResolvedValue([source, { ...source, id: "finance-source", accessDomain: "FINANCE", content: "Synthetic restricted finance notes" }]);
    const article = (await prismaMock.brainArticle.findMany())[0];
    prismaMock.brainArticle.findMany.mockResolvedValue([article, { ...article, id: "unknown-article", bodyMd: "Synthetic unknown content" }]);
    prismaMock.goal.findMany.mockResolvedValue([{ id: "unknown-goal", title: "Synthetic unknown goal" }]);
    readableArtifactIdsMock.mockImplementation(async (_actor, _workspaceId, kind) => new Set(kind === "BrainArticle" ? ["article-1"] : []));
    modelGatewayMock.extract.mockResolvedValue({ output: { goals: [{ title: "Unsupported goal", confidence: 0.9,
      evidenceRefs: [{ sourceType: "BrainSource", sourceId: "finance-source" }] }] } });
    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    await runCompanyUnderstandingSynthesis({ workspaceId: "workspace-1", agentRunId: "run-1", model: "synthetic" });

    const prompt = JSON.parse(modelGatewayMock.extract.mock.calls[0][0].input);
    expect(prompt.sources.map((row: { id: string }) => row.id)).toEqual(["source-1"]);
    expect(prompt.articles.map((row: { id: string }) => row.id)).toEqual(["article-1"]);
    expect(prompt.existingGoals).toEqual([]);
    expect(modelGatewayMock.extract.mock.calls[0][0].input).not.toContain("Synthetic restricted");
    expect(createGoalMock).not.toHaveBeenCalled();
    expect(createGoalLinkMock).not.toHaveBeenCalled();
    expect(createQuestionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      questionText: "What evidence supports this possible company goal: Unsupported goal?",
    }));
  });

  it("does not send an artifact whose manifest disappeared during input capture to the model", async () => {
    releaseProofMock.mockRejectedValueOnce(new AppError(409, "SOURCE_CHANGED", "Original manifest changed."));
    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    await expect(runCompanyUnderstandingSynthesis({ workspaceId: "workspace-1", agentRunId: "run-1", model: "synthetic" }))
      .resolves.toEqual({ skipped: true, reason: "input_changed" });
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(createGoalMock).not.toHaveBeenCalled();
  });


  it("keeps the pre-model snapshot when an uncited input changes and aborts on writer validation", async () => {
    const source = (await prismaMock.brainSource.findMany())[0];
    const uncitedSource = { ...source, id: "source-2", content: "Original synthetic operating notes" };
    prismaMock.brainSource.findMany.mockResolvedValue([source, uncitedSource]);
    sourceFingerprintMock.mockImplementation((record) => `${record.id}:${record.content}`);
    modelGatewayMock.extract.mockImplementation(async () => {
      uncitedSource.content = "Changed synthetic operating notes";
      return { output: {
        goals: [{ title: "Launch onboarding", confidence: 0.9,
          evidenceRefs: [{ sourceType: "BrainSource", sourceId: "source-1" }] }],
        openQuestions: [{ questionText: "Who owns onboarding?" }],
      } };
    });
    const sourceChanged = new Error("SOURCE_CHANGED");
    createGoalMock.mockImplementation(async (_actor, params) => {
      expect(params.lineageRoots).toContainEqual({
        kind: "BrainSource", id: "source-2", fingerprint: "source-2:Original synthetic operating notes",
      });
      throw sourceChanged;
    });
    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    await expect(runCompanyUnderstandingSynthesis({ workspaceId: "workspace-1", agentRunId: "run-1", model: "synthetic" }))
      .rejects.toBe(sourceChanged);
    expect(createGoalLinkMock).not.toHaveBeenCalled();
    expect(createQuestionMock).not.toHaveBeenCalled();
    expect(createDiffMock).not.toHaveBeenCalled();
  });


  it("excludes unknown copied Brain sources before the synthesis prompt", async () => {
    const source = (await prismaMock.brainSource.findMany())[0];
    prismaMock.brainSource.findMany.mockResolvedValue([source, { ...source, id: "unknown-copy", sourceType: "CONVERSATION", content: "Synthetic unproven copied content" }]);
    readableSourcesMock.mockResolvedValue(new Set([source.id]));
    modelGatewayMock.extract.mockResolvedValue({ output: {} });
    const { runCompanyUnderstandingSynthesis } = await import("./company-understanding");
    await runCompanyUnderstandingSynthesis({ workspaceId: "workspace-1", agentRunId: "run-1", model: "synthetic" });
    const prompt = JSON.parse(modelGatewayMock.extract.mock.calls[0][0].input);
    expect(prompt.sources.map((row: { id: string }) => row.id)).toEqual(["source-1"]);
    expect(modelGatewayMock.extract.mock.calls[0][0].input).not.toContain("unproven copied");
  });

it("collects only bounded newest permitted synthesis samples including existing goals", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const fixtures = [
    [prismaMock.brainSource.findMany, "source", 140, 20],
    [prismaMock.brainArticle.findMany, "article", 160, 40],
    [prismaMock.goal.findMany, "goal", 320, 200],
  ] as const;
  for (const [load, prefix, count] of fixtures) {
    const rows = Array.from({length: count}, (_, index) => ({id: `${prefix}-${String(index).padStart(4,"0")}`,
      createdAt: now, updatedAt: now, accessDomain: "WORKSPACE", archivedAt: null, content: "original", bodyMd: "original",
      sourceIds: [], title: "Original", links: []}));
    load.mockImplementation(async args => {
      expect(args.take).toBeLessThanOrEqual(100);
      expect(args.orderBy).toHaveLength(2);
      const after = args.where.OR?.[1]?.id?.gt;
      return rows.filter(row => !after || row.id > after).slice(0,args.take);
    });
  }
  readableSourcesMock.mockImplementation(async (_a,_w,rows) => new Set(rows.filter(row=>Number(row.id.split("-")[1])>=110).map(row=>row.id)));
  readableArtifactIdsMock.mockImplementation(async (_a,_w,_k,rows) => new Set(rows.filter(row=>Number(row.id.split("-")[1])>=110).map(row=>row.id)));
  modelGatewayMock.extract.mockResolvedValue({output:{}});
  const {runCompanyUnderstandingSynthesis}=await import("./company-understanding");
  await runCompanyUnderstandingSynthesis({workspaceId:"workspace-1",agentRunId:"run",model:"synthetic"});
  const input=JSON.parse(modelGatewayMock.extract.mock.calls.at(-1)![0].input);
  expect(input.sources).toHaveLength(20);expect(input.articles).toHaveLength(40);expect(input.existingGoals).toHaveLength(200);
  expect(input.sources[0].id).toBe("source-0110");expect(input.articles[0].id).toBe("article-0110");
  expect(prismaMock.goal.findMany.mock.calls.at(-1)![0].include.links.take).toBe(1);
});

  it("checks selected original proofs after the last pre-model configuration await", async () => {
    getApplyModeMock.mockImplementationOnce(async()=>{
      releaseProofMock.mockRejectedValueOnce(new AppError(409,"SOURCE_CHANGED","Revoked while awaiting configuration"));
      return "AUTO";
    });
    const {runCompanyUnderstandingSynthesis}=await import("./company-understanding");
    await expect(runCompanyUnderstandingSynthesis({workspaceId:"workspace-1",agentRunId:"run",model:"synthetic"})).resolves.toEqual({skipped:true,reason:"input_changed"});
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
  });

});
