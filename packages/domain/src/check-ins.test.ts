import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCheckIn,
  createDailyCompanyUnderstandingQuestions,
  createCompanyUnderstandingQuestion,
  getOverwhelmSignals,
  listCompanyUnderstandingQuestions,
  listDailyCompanyUnderstandingQuestions,
  respondToCheckIn,
  startCompanyUnderstandingQuestionConversation,
  skipCompanyUnderstandingQuestion,
} from "./check-ins";
import { prisma } from "@corgtex/shared";
import { appendEvents } from "./events";
import { captureArtifactInputProof, isArtifactInputProofReadable, withArtifactCountReleaseSnapshot } from "./source-lineage";
import { requireWorkspaceMembership } from "./auth";
import { AppError } from "./errors";

type LineageGroupByMock = ReturnType<typeof vi.mocked<typeof prisma.artifactInputLineage.groupBy>>;
type LineageGroupByImplementation = Parameters<LineageGroupByMock["mockImplementation"]>[0];

vi.mock("@corgtex/shared", () => ({
  prisma: {
    checkIn: {
      create: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    $executeRaw: vi.fn(),
    artifactInputLineage: { groupBy: vi.fn() },
    brainSource: {
      create: vi.fn(),
    },
    conversationSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    conversationTurn: {
      create: vi.fn(),
    },
    conversationPromptInput: { create: vi.fn() },
    $transaction: vi.fn((fn) => fn(prisma)),
  },
  AppActor: {},
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "member-1", userId: "user-1" }),
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn().mockResolvedValue(true),
}));

vi.mock("./source-lineage", () => ({
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({ value: await read(), heads: new Map() }),
  mergeLineageInputRoot: (_previous: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: vi.fn(async (_actor, _workspaceId, _roots, remote, finish) => { await remote(); return finish(prisma); }),
  assertArtifactInputWriteFence: vi.fn(),
  captureArtifactInputProof: vi.fn(async (_actor, _ws, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }))),
  captureArtifactInputSnapshotProof: vi.fn(async (_actor, _ws, input) => [{ kind: "ArtifactInputSnapshot", id: `snapshot-${input.id}`, fingerprint: "a".repeat(64) }]),
  captureImmutableArtifactInputProof: vi.fn(async (_actor, _ws, roots) => roots),
  // Legacy/human-original fixtures do not mint a governed derived-edit receipt.
  captureHumanArtifactInputAdvance: vi.fn().mockResolvedValue(undefined),
  advanceHumanArtifactInputLineage: vi.fn(),
  invalidateArtifactInputLineage: vi.fn(),
  isArtifactInputProofReadable: vi.fn(async () => true),
  recordArtifactInputLineage: vi.fn(),
  currentArtifactInputRoots: vi.fn(async () => []),
  readableArtifactIds: vi.fn(async (_actor: unknown, _workspaceId: string, _kind: string, records: Array<{ id: string }>) =>
    new Set(records.map((record) => record.id))),
}));

describe("getOverwhelmSignals", () => {
  const workspaceId = "ws-1";
  const memberId = "member-1";
  const actor = {
    kind: "user",
    user: { id: "user-1", email: "user@example.com", displayName: "User" },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.checkIn.findMany).mockReset();
    vi.mocked(captureArtifactInputProof).mockReset().mockImplementation(async (_actor, _ws, inputs) => inputs.map(input => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
    vi.mocked(isArtifactInputProofReadable).mockReset().mockResolvedValue(true);
    vi.mocked(prisma.artifactInputLineage.groupBy).mockReset().mockImplementation((async (args) =>
      ((args.where?.artifactId as { in: string[] }).in).map(artifactId => ({ artifactId }))) as LineageGroupByImplementation);
    vi.mocked((prisma as any).$transaction).mockImplementation(async (fn: any) => fn(prisma));
    vi.mocked((prisma as any).member.findUnique).mockResolvedValue({ id: memberId, workspaceId, userId: "user-1", role: "CONTRIBUTOR", isActive: true, joinedAt: new Date(), user: { id: "user-1", email: "user@example.com", displayName: "User" } });
  });

  it("getOverwhelmSignals flags member with 3+ negative responses in 7 days", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([
      { sentiment: "NEGATIVE" } as any,
      { sentiment: "NEGATIVE" } as any,
      { sentiment: "NEGATIVE" } as any,
    ]);

    const result = await getOverwhelmSignals(workspaceId, memberId);

    expect(result.isOverwhelmed).toBe(true);
    expect(result.recentNegativeCount).toBe(3);
  });

  it("getOverwhelmSignals flags member with 1 OVERWHELMED response", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([
      { sentiment: "OVERWHELMED" } as any,
    ]);

    const result = await getOverwhelmSignals(workspaceId, memberId);

    expect(result.isOverwhelmed).toBe(true);
    expect(result.recentNegativeCount).toBe(1);
  });

  it("getOverwhelmSignals returns clean for member with positive history", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([]);

    const result = await getOverwhelmSignals(workspaceId, memberId);

    expect(result.isOverwhelmed).toBe(false);
    expect(result.recentNegativeCount).toBe(0);
  });

  it("creates company understanding questions with company-knowledge defaults", async () => {
    vi.mocked(prisma.checkIn.create).mockResolvedValueOnce({ id: "checkin-1" } as any);

    await createCompanyUnderstandingQuestion(actor, {
      workspaceId,
      memberId,
      questionText: "What decision is blocking the onboarding process?",
      confidence: 0.72,
      priority: 3,
      relatedEntityType: "BrainSource",
      relatedEntityId: "source-1",
      metadata: { reason: "missing_decision" },
    });

    expect(prisma.checkIn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId,
        memberId,
        questionType: "COMPANY_UNDERSTANDING",
        questionSource: "AI",
        responseUsePolicy: "COMPANY_KNOWLEDGE",
        confidence: 0.72,
        priority: 3,
        relatedEntityType: "BrainSource",
        relatedEntityId: "source-1",
      }),
    }));
  });

  it("keeps regular check-ins under the member check-in response policy", async () => {
    vi.mocked(prisma.checkIn.create).mockResolvedValueOnce({ id: "checkin-1" } as any);

    await createCheckIn(actor, {
      workspaceId,
      memberId,
      questionText: "How are you feeling about your assigned tensions today?",
      questionSource: "AI",
    });

    expect(prisma.checkIn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        questionType: "WELLBEING",
        responseUsePolicy: "MEMBER_CHECKIN",
      }),
    }));
  });

  it("creates at most three daily company understanding questions and dedupes existing prompts", async () => {
    vi.mocked((prisma as any).checkIn.count).mockResolvedValueOnce(1);
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([
      { id: "existing-question", createdAt: new Date("2026-06-08"), questionText: "What document, customer note, or working file would give CORGTEX the most useful company context today?" },
    ] as any);
    vi.mocked(prisma.checkIn.create).mockResolvedValue({ id: "checkin-new" } as any);

    const result = await createDailyCompanyUnderstandingQuestions(actor, {
      workspaceId,
      memberId,
      now: new Date("2026-06-09T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ created: 2, cap: 3 });
    expect(prisma.checkIn.create).toHaveBeenCalledTimes(2);
    expect(prisma.checkIn.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        questionText: "What document, customer note, or working file would give CORGTEX the most useful company context today?",
      }),
    }));
  });

  it("does not create daily questions after the same-day cap is reached", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([1, 2, 3].map((number) => ({
      id: `question-${number}`,
      questionText: `Existing ${number}`,
      createdAt: new Date("2026-06-09T09:00:00.000Z"),
    })) as any);

    const result = await createDailyCompanyUnderstandingQuestions(actor, {
      workspaceId,
      memberId,
      now: new Date("2026-06-09T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ created: 0, cap: 3 });
    expect(prisma.checkIn.create).not.toHaveBeenCalled();
  });

  it("pages past 5001 unreadable quota candidates and dedupes only readable old prompts", async () => {
    const old = new Date("2026-06-08");
    const template = "What document, customer note, or working file would give CORGTEX the most useful company context today?";
    const rows = Array.from({ length: 5001 }, (_, index) => ({ id: `denied-${String(index).padStart(5, "0")}`, createdAt: old, questionText: template }));
    rows.push({ id: "tail-template", createdAt: old, questionText: `  ${template.toUpperCase()}  ` });
    vi.mocked(prisma.checkIn.findMany).mockImplementation((async (args) => {
      const after = (args?.where?.id as { gt?: string } | undefined)?.gt;
      return rows.filter(row => !after || row.id > after).slice(0, args?.take ?? rows.length) as any;
    }) as typeof prisma.checkIn.findMany);
    vi.mocked(prisma.artifactInputLineage.groupBy).mockImplementation((async (args) =>
      ((args.where?.artifactId as { in: string[] }).in).filter(id => id === "tail-template").map(artifactId => ({ artifactId }))) as LineageGroupByImplementation);
    vi.mocked(prisma.checkIn.create).mockResolvedValue({ id: "new" } as any);
    const result = await createDailyCompanyUnderstandingQuestions(actor, { workspaceId, memberId, now: new Date("2026-06-09") });
    expect(result.created).toBe(2);
    expect(prisma.checkIn.findMany).toHaveBeenCalledTimes(51);
    expect(prisma.artifactInputLineage.groupBy).toHaveBeenCalledTimes(51);
    expect(captureArtifactInputProof).toHaveBeenCalledTimes(3);
    expect(prisma.checkIn.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ workspaceId, memberId, id: { gt: "denied-00099" }, OR: expect.any(Array) }),
      orderBy: { id: "asc" }, take: 100,
    }));
    expect(result.lineageRoots.filter(root => root.kind === "CheckIn").map(root => root.id)).toEqual(["tail-template", "new"]);
    expect(prisma.checkIn.create).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ questionText: template }) }));
  });

  it("does not stop at three old unrelated readable questions and ignores recipient-denied quota rows", async () => {
    const old = Array.from({ length: 100 }, (_, index) => ({ id: `old-${index}`, questionText: `Unrelated ${index}`, createdAt: new Date("2026-06-08") }));
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce(old as any).mockResolvedValueOnce([
      { id: "denied-today", questionText: "Denied", createdAt: new Date("2026-06-09") },
      { id: "today", questionText: "Actual quota", createdAt: new Date("2026-06-09") },
    ] as any);
    // Base actor/recipient and 100 historical admissions precede the denied recipient.
    for (let index = 0; index < 102; index++) vi.mocked(isArtifactInputProofReadable).mockResolvedValueOnce(true);
    vi.mocked(isArtifactInputProofReadable).mockResolvedValueOnce(false);
    vi.mocked(prisma.checkIn.create).mockResolvedValue({ id: "new" } as any);
    const result = await createDailyCompanyUnderstandingQuestions(actor, { workspaceId, memberId, now: new Date("2026-06-09") });
    expect(result.created).toBe(2);
    expect(prisma.checkIn.findMany).toHaveBeenCalledTimes(2);
    expect(result.lineageRoots.filter(root => root.kind === "CheckIn").map(root => root.id)).toEqual(["today", "new"]);
  });

  it("stops quota discovery at three readable questions today without hydrating later pages", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({
      id: `today-${index}`, questionText: `Today ${index}`, createdAt: new Date("2026-06-09"),
    })) as any);
    const result = await createDailyCompanyUnderstandingQuestions(actor, { workspaceId, memberId, now: new Date("2026-06-09") });
    expect(result.created).toBe(0);
    expect(prisma.checkIn.findMany).toHaveBeenCalledTimes(1);
    expect(captureArtifactInputProof).toHaveBeenCalledTimes(4);
    expect(prisma.checkIn.create).not.toHaveBeenCalled();
  });

  it("stops once all old template prompts are present without consuming today's quota", async () => {
    const texts = [
      "What decision or blocker should CORGTEX understand before it updates company direction?",
      "What document, customer note, or working file would give CORGTEX the most useful company context today?",
      "Which goal, project, or owner relationship is unclear enough that CORGTEX should ask before treating it as company truth?",
    ];
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({
      id: `old-${index}`, questionText: texts[index] ?? "Unrelated", createdAt: new Date("2026-06-08"),
    })) as any);
    const result = await createDailyCompanyUnderstandingQuestions(actor, { workspaceId, memberId, now: new Date("2026-06-09") });
    expect(result.created).toBe(0);
    expect(prisma.checkIn.findMany).toHaveBeenCalledTimes(1);
    expect(captureArtifactInputProof).toHaveBeenCalledTimes(4);
    expect(result.lineageRoots.filter(root => root.kind === "CheckIn").map(root => root.id)).toEqual(["old-0", "old-1", "old-2"]);
    expect(prisma.checkIn.create).not.toHaveBeenCalled();
  });

  it("retains the original quota contributor proof through the final write fence", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([{ id: "quota-original", questionText: "Quota", createdAt: new Date("2026-06-09") }] as any);
    vi.mocked(isArtifactInputProofReadable).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(createDailyCompanyUnderstandingQuestions(actor, { workspaceId, memberId, now: new Date("2026-06-09") })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(isArtifactInputProofReadable).toHaveBeenLastCalledWith(actor, workspaceId, expect.arrayContaining([
      { kind: "CheckIn", id: "quota-original", fingerprint: "a".repeat(64) },
    ]), prisma);
    expect(prisma.checkIn.create).not.toHaveBeenCalled();
  });

  it("lists open company understanding questions for the signed-in member", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([{ id: "checkin-1" }] as any);

    const result = await listCompanyUnderstandingQuestions(actor, { workspaceId });

    expect(result).toEqual([{ id: "checkin-1" }]);
    expect(prisma.checkIn.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId,
        memberId,
        questionType: "COMPANY_UNDERSTANDING",
        status: "OPEN",
      }),
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: 100,
    }));
  });

  it("filters restricted questions before applying the daily limit", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([
      { id: "restricted", questionText: "Restricted" },
      { id: "safe", questionText: "Safe" },
    ] as any);
    vi.mocked(captureArtifactInputProof).mockRejectedValueOnce(new AppError(409, "UNKNOWN_LINEAGE", "Restricted input"));
    const questions = await listCompanyUnderstandingQuestions(actor, { workspaceId, take: 1 });
    expect(questions.map((question) => question.id)).toEqual(["safe"]);
    expect(prisma.checkIn.findMany).toHaveBeenCalledWith(expect.not.objectContaining({ take: 1 }));
  });

  it("releases only selected original proofs while preserving daily question limits", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `daily-${i}`, questionText: `Question ${i}` }));
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce(rows as any);
    expect(await listDailyCompanyUnderstandingQuestions(actor, { workspaceId, take: 100 })).toEqual(rows.slice(0, 3));
    expect(captureArtifactInputProof).toHaveBeenCalledWith(actor, workspaceId, [
      { kind: "CheckIn", id: rows[0].id, snapshot: rows[0] },
    ], undefined);
    const call = vi.mocked(withArtifactCountReleaseSnapshot).mock.calls.at(-1)!;
    expect(call[2].map(root => root.id)).toEqual(rows.slice(0, 3).map(row => row.id));
    expect(call[5]).toBeInstanceOf(Map);
    expect(requireWorkspaceMembership).toHaveBeenLastCalledWith({ actor, workspaceId, tx: prisma });
  });

  it("checks current membership even when the readable question list is empty", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([]);
    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({ id: memberId } as any)
      .mockRejectedValueOnce(new AppError(403, "NOT_A_MEMBER", "Departed"));
    await expect(listCompanyUnderstandingQuestions(actor, { workspaceId })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(requireWorkspaceMembership).toHaveBeenLastCalledWith({ actor, workspaceId, tx: prisma });
  });

  it("marks regular check-ins answered when a member responds", async () => {
    vi.mocked(prisma.checkIn.findUnique).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      questionType: "WELLBEING",
    } as any);
    vi.mocked(prisma.checkIn.update).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      status: "ANSWERED",
    } as any);

    await respondToCheckIn(actor, {
      workspaceId,
      checkInId: "checkin-1",
      responseMd: "The operations lead owns this.",
    });

    expect(prisma.checkIn.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "checkin-1" },
      data: expect.objectContaining({
        responseMd: "The operations lead owns this.",
        status: "ANSWERED",
      }),
    }));
    expect(appendEvents).toHaveBeenCalledWith(prisma, expect.arrayContaining([
      expect.objectContaining({ type: "checkin.response_received" }),
    ]));
    expect((prisma as any).brainSource.create).not.toHaveBeenCalled();
  });

  it("saves company understanding answers as brain sources", async () => {
    vi.mocked(prisma.checkIn.findUnique).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      questionType: "COMPANY_UNDERSTANDING",
      questionText: "Who owns onboarding?",
      status: "OPEN",
      relatedConversationId: null,
    } as any);
    vi.mocked(prisma.checkIn.update).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      status: "ANSWERED",
      relatedConversationId: "conversation-1",
    } as any);
    vi.mocked((prisma as any).brainSource.create).mockResolvedValueOnce({ id: "source-1" });

    await respondToCheckIn(actor, {
      workspaceId,
      checkInId: "checkin-1",
      responseMd: "The operations lead owns onboarding.",
      relatedConversationId: "conversation-1",
    });

    expect((prisma as any).brainSource.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId,
        sourceType: "CONVERSATION_INSIGHT",
        authorMemberId: memberId,
        channel: "daily-question",
        metadata: expect.objectContaining({
          checkInId: "checkin-1",
          relatedConversationId: "conversation-1",
          responseUsePolicy: "COMPANY_KNOWLEDGE",
        }),
      }),
    }));
    expect(appendEvents).toHaveBeenCalledWith(prisma, expect.arrayContaining([
      expect.objectContaining({ type: "brain-source.created", aggregateId: "source-1" }),
      expect.objectContaining({ type: "checkin.response_received" }),
    ]));
  });

  it("starts a linked conversation for open company understanding questions", async () => {
    vi.mocked(prisma.checkIn.findUnique).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      questionType: "COMPANY_UNDERSTANDING",
      questionText: "Which goal is unclear?",
      status: "OPEN",
      relatedConversationId: null,
    } as any);
    vi.mocked((prisma as any).conversationSession.create).mockResolvedValueOnce({ id: "conversation-1" });
    vi.mocked((prisma as any).conversationPromptInput.create).mockResolvedValueOnce({ id: "prompt-1", content: "Open company understanding question" });
    vi.mocked((prisma as any).conversationTurn.create).mockResolvedValueOnce({ id: "turn-1" });
    vi.mocked(prisma.checkIn.update).mockResolvedValueOnce({ id: "checkin-1" } as any);
    vi.mocked((prisma as any).conversationSession.findUnique).mockResolvedValueOnce({
      id: "conversation-1", workspaceId, userId: "user-1",
      turns: [{ id: "turn-1" }],
    });

    const result = await startCompanyUnderstandingQuestionConversation(actor, {
      workspaceId,
      checkInId: "checkin-1",
    });

    expect(result).toEqual(expect.objectContaining({ id: "conversation-1" }));
    expect((prisma as any).conversationTurn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        assistantMessage: expect.stringContaining("Which goal is unclear?"),
      }),
    }));
    expect(prisma.checkIn.update).toHaveBeenCalledWith({
      where: { id: "checkin-1" },
      data: { relatedConversationId: "conversation-1" },
    });
  });

  it("skips open company understanding questions", async () => {
    vi.mocked(prisma.checkIn.findUnique).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      questionType: "COMPANY_UNDERSTANDING",
      status: "OPEN",
    } as any);
    vi.mocked(prisma.checkIn.update).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      status: "SKIPPED",
    } as any);

    await skipCompanyUnderstandingQuestion(actor, {
      workspaceId,
      checkInId: "checkin-1",
    });

    expect(prisma.checkIn.update).toHaveBeenCalledWith({
      where: { id: "checkin-1" },
      data: { status: "SKIPPED" },
    });
    expect(appendEvents).toHaveBeenCalledWith(prisma, expect.arrayContaining([
      expect.objectContaining({ type: "checkin.skipped" }),
    ]));
  });
});
