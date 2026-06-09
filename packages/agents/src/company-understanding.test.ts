import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  modelGatewayMock,
  createGoalMock,
  createGoalLinkMock,
  createQuestionMock,
  createDiffMock,
} = vi.hoisted(() => ({
  prismaMock: {
    brainSource: { findMany: vi.fn() },
    brainArticle: { findMany: vi.fn() },
    goal: { findMany: vi.fn() },
    member: { findFirst: vi.fn() },
    checkIn: { findFirst: vi.fn() },
    contextGraphProposedDiff: { findFirst: vi.fn() },
  },
  modelGatewayMock: {
    extract: vi.fn(),
  },
  createGoalMock: vi.fn(),
  createGoalLinkMock: vi.fn(),
  createQuestionMock: vi.fn(),
  createDiffMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: modelGatewayMock,
}));

vi.mock("@corgtex/domain", () => ({
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
}));

describe("company understanding synthesis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.brainSource.findMany.mockResolvedValue([
      {
        id: "source-1",
        sourceType: "DOC",
        tier: 1,
        title: "Company plan",
        content: "Launch onboarding and document support ownership.",
        ingestionGuidanceMd: null,
        absorbedAt: new Date(),
      },
    ]);
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
    prismaMock.checkIn.findFirst.mockResolvedValue(null);
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue(null);
    createGoalMock.mockResolvedValue({ id: "goal-1" });
    createGoalLinkMock.mockResolvedValue({ id: "link-1" });
    createQuestionMock.mockResolvedValue({ id: "question-1" });
    createDiffMock.mockResolvedValue({ id: "diff-1" });
  });

  it("creates an active evidence-backed goal at high confidence", async () => {
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        goals: [
          {
            title: "Launch onboarding",
            summary: "Ship the onboarding flow this quarter.",
            horizon: "short",
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
});
