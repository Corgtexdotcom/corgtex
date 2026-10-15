import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { appendEvents } from "./events";
import { currentArtifactInputRoots, recordArtifactInputLineage, readableArtifactIds, type LineageInput, type LineageRoot,
  assertArtifactInputWriteFence, captureArtifactInputProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable } from "./source-lineage";
import { AppError } from "./errors";
import { captureReadableDigestInputs, DigestReadRelease, mergeArtifactInputProofs } from "./digest-lineage";
import { prepareProducerLineage, finishProducerLineage } from "./producer-lineage";

const COMPANY_UNDERSTANDING_TYPE = "COMPANY_UNDERSTANDING";
const COMPANY_KNOWLEDGE_POLICY = "COMPANY_KNOWLEDGE";
const MEMBER_CHECKIN_POLICY = "MEMBER_CHECKIN";
const DAILY_COMPANY_QUESTION_CAP = 3;

const DAILY_COMPANY_QUESTION_TEMPLATES = [
  {
    questionText: "What decision or blocker should CORGTEX understand before it updates company direction?",
    priority: 4,
    confidence: 0.62,
    metadata: { category: "decision_or_blocker", generatedFrom: "daily-check-in" },
  },
  {
    questionText: "What document, customer note, or working file would give CORGTEX the most useful company context today?",
    priority: 3,
    confidence: 0.58,
    metadata: { category: "missing_evidence", generatedFrom: "daily-check-in" },
  },
  {
    questionText: "Which goal, project, or owner relationship is unclear enough that CORGTEX should ask before treating it as company truth?",
    priority: 2,
    confidence: 0.56,
    metadata: { category: "ownership_gap", generatedFrom: "daily-check-in" },
  },
];

function normalizeConfidence(value: number | null | undefined) {
  if (value === undefined || value === null) return null;
  invariant(Number.isFinite(value), 400, "INVALID_INPUT", "Confidence must be a number.");
  invariant(value >= 0 && value <= 1, 400, "INVALID_INPUT", "Confidence must be between 0 and 1.");
  return value;
}

function normalizePriority(value: number | null | undefined) {
  if (value === undefined || value === null) return 0;
  invariant(Number.isFinite(value), 400, "INVALID_INPUT", "Priority must be a number.");
  return Math.max(0, Math.round(value));
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export async function createCheckIn(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  questionText: string;
  questionSource: string;
  questionType?: string;
  priority?: number | null;
  confidence?: number | null;
  metadata?: Prisma.InputJsonValue;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  relatedConversationId?: string | null;
  responseUsePolicy?: string | null;
  lineageInputs?: LineageInput[];
  lineageRoots?: LineageRoot[];
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  
  const questionText = params.questionText.trim();
  invariant(questionText.length > 0, 400, "INVALID_INPUT", "Question text is required.");
  const questionType = params.questionType?.trim() || "WELLBEING";
  const questionSource = params.questionSource.trim() || "AI";

  return prisma.$transaction(async (tx) => {
    const question = await tx.checkIn.create({
    data: {
      workspaceId: params.workspaceId,
      memberId: params.memberId,
      questionText,
      questionSource,
      questionType,
      priority: normalizePriority(params.priority),
      confidence: normalizeConfidence(params.confidence),
      metadata: params.metadata,
      relatedEntityType: params.relatedEntityType?.trim() || null,
      relatedEntityId: params.relatedEntityId?.trim() || null,
      relatedConversationId: params.relatedConversationId?.trim() || null,
      responseUsePolicy: params.responseUsePolicy?.trim()
        || (questionType === COMPANY_UNDERSTANDING_TYPE ? COMPANY_KNOWLEDGE_POLICY : MEMBER_CHECKIN_POLICY),
    },
    });
    if (params.lineageInputs || params.lineageRoots || actor.kind === "user") {
      await recordArtifactInputLineage({
        tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "CheckIn", id: question.id }, content: question,
        origin: params.lineageInputs?.length || params.lineageRoots?.length ? "DERIVED" : "HUMAN_ORIGINAL",
        inputs: params.lineageInputs ?? [], inheritedRoots: params.lineageRoots,
      });
    }
    return question;
  });
}

export async function createCompanyUnderstandingQuestion(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  questionText: string;
  questionSource?: string;
  priority?: number | null;
  confidence?: number | null;
  metadata?: Prisma.InputJsonValue;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  relatedConversationId?: string | null;
  lineageInputs?: LineageInput[];
  lineageRoots?: LineageRoot[];
}) {
  return createCheckIn(actor, {
    ...params,
    questionSource: params.questionSource ?? "AI",
    questionType: COMPANY_UNDERSTANDING_TYPE,
    responseUsePolicy: COMPANY_KNOWLEDGE_POLICY,
  });
}

async function releaseCompanyUnderstandingQuestions<T extends { id: string }>(actor: AppActor,
  workspaceId: string, questions: T[], take: number) {
  const release = new DigestReadRelease(actor, workspaceId);
  const captured = await release.observeRead(() => captureReadableDigestInputs({
    actor, workspaceId, kind: "CheckIn", records: questions,
  }));
  const selected = captured.records.slice(0, take);
  // Preserve the selected rows' original bodies, caller epochs and observed
  // heads across the complete admission scan, then replay before releasing.
  for (const question of selected) release.add(captured.proofs.get(question.id)!);
  return release.finish(selected);
}

export async function listCompanyUnderstandingQuestions(actor: AppActor, params: {
  workspaceId: string;
  memberId?: string | null;
  status?: string | null;
  take?: number;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const memberId = params.memberId?.trim() || membership?.id;
  invariant(memberId, 400, "INVALID_INPUT", "Member id is required for company understanding questions.");

  const questions = await prisma.checkIn.findMany({
    where: {
      workspaceId: params.workspaceId,
      memberId,
      questionType: COMPANY_UNDERSTANDING_TYPE,
      status: params.status?.trim() || "OPEN",
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });
  return releaseCompanyUnderstandingQuestions(actor, params.workspaceId, questions,
    Math.min(Math.max(params.take ?? 20, 1), 50));
}

export async function listDailyCompanyUnderstandingQuestions(actor: AppActor, params: {
  workspaceId: string;
  take?: number;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(membership, 401, "AUTH_REQUIRED", "Company understanding questions require a member.");

  const questions = await prisma.checkIn.findMany({
    where: {
      workspaceId: params.workspaceId,
      memberId: membership.id,
      questionType: COMPANY_UNDERSTANDING_TYPE,
      status: "OPEN",
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });
  return releaseCompanyUnderstandingQuestions(actor, params.workspaceId, questions,
    Math.min(Math.max(params.take ?? DAILY_COMPANY_QUESTION_CAP, 1), DAILY_COMPANY_QUESTION_CAP));
}

export async function createDailyCompanyUnderstandingQuestions(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  now?: Date;
  lineageRoots?: readonly LineageRoot[];
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.$transaction(async (tx) => {
    await assertArtifactInputWriteFence(tx);
    // The quota and every question receipt share one transaction and recipient lock.
    await tx.$executeRaw`SELECT "id" FROM "Member" WHERE "id" = ${params.memberId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const member = await tx.member.findUnique({ where: { id: params.memberId },
      include: { user: { select: { id: true, email: true, displayName: true } } } });
    invariant(member?.isActive && member.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found.");
    const recipient: AppActor = { kind: "user", user: { id: member.user.id, email: member.user.email, displayName: member.user.displayName } };
    const nativeRoots = await captureArtifactInputProof(actor, params.workspaceId, [
      { kind: "Workspace", id: params.workspaceId }, { kind: "Member", id: member.id, snapshot: member },
      { kind: "User", id: member.user.id, snapshot: member.user },
    ], tx);
    const baseRoots = mergeArtifactInputProofs(nativeRoots, [...(params.lineageRoots ?? [])]);
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, baseRoots, tx)
      && await isArtifactInputProofReadable(recipient, params.workspaceId, baseRoots, tx),
    409, "SOURCE_CHANGED", "Daily question inputs are not currently available to the recipient.");
    const todayStart = startOfUtcDay(params.now);
    const existingQuestions = await tx.checkIn.findMany({ where: {
      workspaceId: params.workspaceId, memberId: params.memberId, questionType: COMPANY_UNDERSTANDING_TYPE,
      OR: [{ status: "OPEN" }, { createdAt: { gte: todayStart } }],
    }, orderBy: { id: "asc" }, take: 5001 });
    invariant(existingQuestions.length <= 5000, 503, "SOURCE_READ_SCAN_LIMIT", "Daily question permission scan exceeds its supported size.");
    const safeQuestions = [];
    const quotaProofs: LineageRoot[][] = [];
    for (const question of existingQuestions) {
      try {
        const proof = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "CheckIn", id: question.id, snapshot: question }], tx);
        if (!await isArtifactInputProofReadable(recipient, params.workspaceId, proof, tx)) continue;
        safeQuestions.push(question); quotaProofs.push(proof);
      } catch (error) {
        if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
      }
    }
    const liveRoots = mergeArtifactInputProofs(baseRoots, ...quotaProofs);
    const recipeRoots = await captureImmutableArtifactInputProof(actor, params.workspaceId, liveRoots, tx);
    const createdToday = safeQuestions.filter((question) => question.createdAt >= todayStart).length;
    const remaining = Math.max(DAILY_COMPANY_QUESTION_CAP - createdToday, 0);
    const existingText = new Set(safeQuestions.map((question) => question.questionText.trim().toLowerCase()));
    const candidates = DAILY_COMPANY_QUESTION_TEMPLATES.filter((template) => !existingText.has(template.questionText.toLowerCase()));
    const created = [];
    for (const template of candidates.slice(0, remaining)) {
      invariant(await isArtifactInputProofReadable(actor, params.workspaceId, liveRoots, tx)
        && await isArtifactInputProofReadable(recipient, params.workspaceId, liveRoots, tx),
      409, "SOURCE_CHANGED", "Daily question inputs changed before persistence.");
      const question = await tx.checkIn.create({ data: {
        workspaceId: params.workspaceId, memberId: member.id, questionText: template.questionText,
        questionSource: "daily-check-in", questionType: COMPANY_UNDERSTANDING_TYPE, status: "OPEN",
        priority: template.priority, confidence: template.confidence, metadata: template.metadata,
        responseUsePolicy: COMPANY_KNOWLEDGE_POLICY,
      } });
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "CheckIn", id: question.id }, content: question, origin: "DERIVED", inputs: [], inheritedRoots: recipeRoots });
      created.push(question);
    }
    const outcomeRoots = created.length ? await captureArtifactInputProof(actor, params.workspaceId,
      created.map((question) => ({ kind: "CheckIn" as const, id: question.id, snapshot: question })), tx) : [];
    invariant(await isArtifactInputProofReadable(recipient, params.workspaceId, mergeArtifactInputProofs(liveRoots, outcomeRoots), tx),
      409, "SOURCE_CHANGED", "Daily question outputs are no longer available to the recipient.");
    return { created: created.length, cap: DAILY_COMPANY_QUESTION_CAP,
      lineageRoots: mergeArtifactInputProofs(liveRoots, outcomeRoots) };
  });
}

export async function startCompanyUnderstandingQuestionConversation(actor: AppActor, params: {
  workspaceId: string;
  checkInId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(membership, 401, "AUTH_REQUIRED", "Company understanding questions require a member.");
  return prisma.$transaction(async (tx) => {
    await assertArtifactInputWriteFence(tx);
    await tx.$executeRaw`SELECT "id" FROM "CheckIn" WHERE "id" = ${params.checkInId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const checkIn = await tx.checkIn.findUnique({ where: { id: params.checkInId } });
    invariant(checkIn && checkIn.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Question not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "CheckIn", [checkIn], tx)).has(checkIn.id), 404, "NOT_FOUND", "Question not found.");
    invariant(checkIn.memberId === membership.id, 403, "FORBIDDEN", "You can only open your own questions.");
    invariant(checkIn.questionType === COMPANY_UNDERSTANDING_TYPE, 400, "INVALID_INPUT", "Only company understanding questions can open a linked chat.");
    invariant(checkIn.status === "OPEN", 400, "INVALID_STATE", "Only open questions can open a linked chat.");
    const questionProof = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "CheckIn", id: checkIn.id, snapshot: checkIn }], tx);
    const readableConversation = async (id: string) => {
      const session = await tx.conversationSession.findUnique({ where: { id }, include: { turns: { orderBy: { sequenceNumber: "asc" } } } });
      invariant(session && session.workspaceId === params.workspaceId && session.userId === membership.userId,
        404, "NOT_FOUND", "Linked conversation not found.");
      invariant((await readableArtifactIds(actor, params.workspaceId, "ConversationSession", [session], tx)).has(session.id),
        404, "NOT_FOUND", "Linked conversation not found.");
      const turnIds = await readableArtifactIds(actor, params.workspaceId, "ConversationTurn", session.turns, tx);
      const turns = session.turns.filter((turn) => turnIds.has(turn.id));
      const proof = await captureArtifactInputProof(actor, params.workspaceId, [
        { kind: "ConversationSession", id: session.id, snapshot: session },
        ...turns.map((turn) => ({ kind: "ConversationTurn" as const, id: turn.id, snapshot: turn })),
      ], tx);
      invariant(await isArtifactInputProofReadable(actor, params.workspaceId, proof, tx), 409, "SOURCE_CHANGED", "Conversation inputs changed before reading.");
      // Hidden legacy turns must not disclose their existence through sequence gaps.
      return { ...session, turns: turns.map((turn, index) => ({ ...turn, sequenceNumber: index + 1 })) };
    };
    if (checkIn.relatedConversationId) return readableConversation(checkIn.relatedConversationId);
    const immutableRoots = await captureImmutableArtifactInputProof(actor, params.workspaceId, questionProof, tx);
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "CheckIn", id: checkIn.id }, before: checkIn });
    const policy = "Your answer is saved as company knowledge for this workspace.";
    const conversation = await tx.conversationSession.create({ data: {
      workspaceId: params.workspaceId, userId: membership.userId, agentKey: "company-understanding",
      topic: checkIn.questionText.slice(0, 64),
      systemPrompt: `Help the employee answer this company-understanding question. Treat their answer as company knowledge evidence, and do not ask for private journaling.\n\nQuestion: ${checkIn.questionText}`,
    } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "ConversationSession", id: conversation.id }, content: conversation, origin: "DERIVED", inputs: [], inheritedRoots: immutableRoots });
    const prompt = await tx.conversationPromptInput.create({ data: { workspaceId: params.workspaceId, sessionId: conversation.id,
      userId: membership.userId, content: "Open company understanding question" } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "ConversationPromptInput", id: prompt.id }, content: prompt, origin: "DERIVED", inputs: [], inheritedRoots: immutableRoots });
    const turn = await tx.conversationTurn.create({ data: { conversationId: conversation.id, sequenceNumber: 1, promptInputId: prompt.id,
      userMessage: prompt.content, assistantMessage: `${checkIn.questionText}\n\n${policy}` } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "ConversationTurn", id: turn.id }, content: turn, origin: "DERIVED", inputs: [], inheritedRoots: immutableRoots });
    const updated = await tx.checkIn.update({ where: { id: checkIn.id }, data: { relatedConversationId: conversation.id } });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "CheckIn", id: updated.id }, content: updated, receipt });
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, immutableRoots, tx),
      409, "SOURCE_CHANGED", "Question inputs changed before opening the conversation.");
    return readableConversation(conversation.id);
  });
}

export async function respondToCheckIn(actor: AppActor, params: {
  workspaceId: string;
  checkInId: string;
  responseMd: string;
  sentiment?: string;
  relatedConversationId?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const responseMd = params.responseMd.trim();
  invariant(responseMd.length > 0, 400, "INVALID_INPUT", "Response is required.");

  return prisma.$transaction(async (tx) => {
    await assertArtifactInputWriteFence(tx);
    const checkIn = await tx.checkIn.findUnique({
      where: { id: params.checkInId },
    });

    invariant(checkIn && checkIn.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Check-in not found.");
    if (checkIn.questionType === COMPANY_UNDERSTANDING_TYPE) {
      invariant((await readableArtifactIds(actor, params.workspaceId, "CheckIn", [checkIn], tx)).has(checkIn.id),
        404, "NOT_FOUND", "Check-in not found.");
    }
    invariant(membership && checkIn.memberId === membership.id, 403, "FORBIDDEN", "You can only respond to your own check-ins.");
    if (checkIn.questionType === COMPANY_UNDERSTANDING_TYPE) {
      invariant(checkIn.status === "OPEN", 400, "INVALID_STATE", "Only open company understanding questions can be answered.");
    }

    const questionRoots = checkIn.questionType === COMPANY_UNDERSTANDING_TYPE
      ? await currentArtifactInputRoots(tx, params.workspaceId, { kind: "CheckIn", id: checkIn.id }, checkIn) : null;
    if (checkIn.questionType === COMPANY_UNDERSTANDING_TYPE) invariant(questionRoots, 409, "UNKNOWN_LINEAGE", "Question inputs cannot be verified.");
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "CheckIn", id: checkIn.id }, before: checkIn });
    const updated = await tx.checkIn.update({
      where: { id: checkIn.id },
      data: {
        responseMd,
        sentiment: params.sentiment,
        status: "ANSWERED",
        respondedAt: new Date(),
        relatedConversationId: params.relatedConversationId?.trim() || checkIn.relatedConversationId,
      },
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "CheckIn", id: updated.id }, content: updated, receipt });
    const events: Parameters<typeof appendEvents>[1] = [];

    if (checkIn.questionType === COMPANY_UNDERSTANDING_TYPE) {
      // The employee explicitly elects to contribute the answer as company knowledge.
      // Carry the question's permission-bearing inputs, not its recipient-only envelope.

      const source = await tx.brainSource.create({
        data: {
          workspaceId: params.workspaceId,
          sourceType: "CONVERSATION_INSIGHT",
          tier: 2,
          title: `Answer: ${checkIn.questionText.slice(0, 90)}`,
          content: [
            "# Company understanding answer",
            "",
            `Question: ${checkIn.questionText}`,
            "",
            `Answer: ${responseMd}`,
          ].join("\n"),
          channel: "daily-question",
          authorMemberId: membership.id,
          ingestionGuidanceMd: "Use this employee answer as company knowledge evidence. Re-run company-understanding synthesis after absorption.",
          metadata: {
            checkInId: checkIn.id,
            relatedConversationId: updated.relatedConversationId,
            responseUsePolicy: COMPANY_KNOWLEDGE_POLICY,
            generatedFrom: "company-understanding-question",
          },
        },
      });
      await recordArtifactInputLineage({
        tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "BrainSource", id: source.id }, content: source,
        origin: questionRoots!.length ? "DERIVED" : "HUMAN_ORIGINAL",
        inputs: [], inheritedRoots: questionRoots!,
      });

      events.push({
        workspaceId: params.workspaceId,
        type: "brain-source.created",
        aggregateType: "BrainSource",
        aggregateId: source.id,
        payload: { sourceId: source.id, checkInId: checkIn.id },
      });
    }

    events.push(
      {
        workspaceId: params.workspaceId,
        type: "checkin.response_received",
        aggregateType: "CheckIn",
        aggregateId: updated.id,
        payload: { checkInId: updated.id, memberId: updated.memberId },
      },
    );

    await appendEvents(tx, events);

    return (await readableArtifactIds(actor, params.workspaceId, "CheckIn", [updated], tx)).has(updated.id)
      ? updated : { id: updated.id, status: updated.status, contentWithheld: true };
  });
}

export async function skipCompanyUnderstandingQuestion(actor: AppActor, params: {
  workspaceId: string;
  checkInId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    await assertArtifactInputWriteFence(tx);
    const checkIn = await tx.checkIn.findUnique({
      where: { id: params.checkInId },
    });

    invariant(checkIn && checkIn.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Check-in not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "CheckIn", [checkIn], tx)).has(checkIn.id),
      404, "NOT_FOUND", "Check-in not found.");
    invariant(checkIn.questionType === COMPANY_UNDERSTANDING_TYPE, 400, "INVALID_INPUT", "Only company understanding questions can be skipped.");
    invariant(membership && checkIn.memberId === membership.id, 403, "FORBIDDEN", "You can only skip your own company understanding questions.");
    invariant(checkIn.status === "OPEN", 400, "INVALID_STATE", "Only open questions can be skipped.");

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "CheckIn", id: checkIn.id }, before: checkIn });
    const skipped = await tx.checkIn.update({
      where: { id: checkIn.id },
      data: { status: "SKIPPED" },
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "CheckIn", id: skipped.id }, content: skipped, receipt });
    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "checkin.skipped",
        aggregateType: "CheckIn",
        aggregateId: skipped.id,
        payload: { checkInId: skipped.id, memberId: skipped.memberId },
      },
    ]);

    return skipped;
  });
}

export async function getOverwhelmSignals(workspaceId: string, memberId: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const recentCheckIns = await prisma.checkIn.findMany({
    where: {
      workspaceId,
      memberId,
      respondedAt: {
        gte: sevenDaysAgo,
      },
      sentiment: {
        in: ["NEGATIVE", "OVERWHELMED"],
      },
    },
    orderBy: { respondedAt: "desc" },
  });

  const recentNegativeCount = recentCheckIns.length;
  // Flag overwhelm if 3+ negative/overwhelmed signals, or at least 1 explicit OVERWHELMED
  const isOverwhelmed = recentNegativeCount >= 3 || recentCheckIns.some(c => c.sentiment === "OVERWHELMED");

  return {
    isOverwhelmed,
    recentNegativeCount,
    signals: recentCheckIns,
  };
}
