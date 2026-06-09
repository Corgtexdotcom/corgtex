import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { appendEvents } from "./events";

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
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  
  const questionText = params.questionText.trim();
  invariant(questionText.length > 0, 400, "INVALID_INPUT", "Question text is required.");
  const questionType = params.questionType?.trim() || "WELLBEING";
  const questionSource = params.questionSource.trim() || "AI";

  return prisma.checkIn.create({
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
}) {
  return createCheckIn(actor, {
    ...params,
    questionSource: params.questionSource ?? "AI",
    questionType: COMPANY_UNDERSTANDING_TYPE,
    responseUsePolicy: COMPANY_KNOWLEDGE_POLICY,
  });
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

  return prisma.checkIn.findMany({
    where: {
      workspaceId: params.workspaceId,
      memberId,
      questionType: COMPANY_UNDERSTANDING_TYPE,
      status: params.status?.trim() || "OPEN",
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(params.take ?? 20, 1), 50),
  });
}

export async function listDailyCompanyUnderstandingQuestions(actor: AppActor, params: {
  workspaceId: string;
  take?: number;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(membership, 401, "AUTH_REQUIRED", "Company understanding questions require a member.");

  return prisma.checkIn.findMany({
    where: {
      workspaceId: params.workspaceId,
      memberId: membership.id,
      questionType: COMPANY_UNDERSTANDING_TYPE,
      status: "OPEN",
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(params.take ?? DAILY_COMPANY_QUESTION_CAP, 1), DAILY_COMPANY_QUESTION_CAP),
  });
}

export async function createDailyCompanyUnderstandingQuestions(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  now?: Date;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const member = await prisma.member.findUnique({
    where: { id: params.memberId },
    select: { id: true, workspaceId: true, isActive: true },
  });
  invariant(member?.isActive && member.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found.");

  const todayStart = startOfUtcDay(params.now);
  const [createdToday, existingQuestions] = await Promise.all([
    prisma.checkIn.count({
      where: {
        workspaceId: params.workspaceId,
        memberId: params.memberId,
        questionType: COMPANY_UNDERSTANDING_TYPE,
        createdAt: { gte: todayStart },
      },
    }),
    prisma.checkIn.findMany({
      where: {
        workspaceId: params.workspaceId,
        memberId: params.memberId,
        questionType: COMPANY_UNDERSTANDING_TYPE,
        OR: [{ status: "OPEN" }, { createdAt: { gte: todayStart } }],
      },
      select: { questionText: true },
    }),
  ]);

  const remaining = Math.max(DAILY_COMPANY_QUESTION_CAP - createdToday, 0);
  if (remaining === 0) return { created: 0, cap: DAILY_COMPANY_QUESTION_CAP };

  const existingText = new Set(existingQuestions.map((question) => question.questionText.trim().toLowerCase()));
  const candidates = DAILY_COMPANY_QUESTION_TEMPLATES.filter((template) => !existingText.has(template.questionText.toLowerCase()));
  const created = [];
  for (const template of candidates.slice(0, remaining)) {
    created.push(await createCompanyUnderstandingQuestion(actor, {
      workspaceId: params.workspaceId,
      memberId: params.memberId,
      questionText: template.questionText,
      questionSource: "daily-check-in",
      priority: template.priority,
      confidence: template.confidence,
      metadata: template.metadata,
    }));
  }

  return { created: created.length, cap: DAILY_COMPANY_QUESTION_CAP };
}

export async function startCompanyUnderstandingQuestionConversation(actor: AppActor, params: {
  workspaceId: string;
  checkInId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(membership, 401, "AUTH_REQUIRED", "Company understanding questions require a member.");

  return prisma.$transaction(async (tx) => {
    const checkIn = await tx.checkIn.findUnique({ where: { id: params.checkInId } });
    invariant(checkIn && checkIn.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Question not found.");
    invariant(checkIn.memberId === membership.id, 403, "FORBIDDEN", "You can only open your own questions.");
    invariant(checkIn.questionType === COMPANY_UNDERSTANDING_TYPE, 400, "INVALID_INPUT", "Only company understanding questions can open a linked chat.");
    invariant(checkIn.status === "OPEN", 400, "INVALID_STATE", "Only open questions can open a linked chat.");

    if (checkIn.relatedConversationId) {
      const existing = await tx.conversationSession.findUnique({
        where: { id: checkIn.relatedConversationId },
        include: { turns: { orderBy: { sequenceNumber: "asc" } } },
      });
      invariant(existing && existing.workspaceId === params.workspaceId && existing.userId === membership.userId, 404, "NOT_FOUND", "Linked conversation not found.");
      return existing;
    }

    const policy = "Your answer is saved as company knowledge for this workspace.";
    const conversation = await tx.conversationSession.create({
      data: {
        workspaceId: params.workspaceId,
        userId: membership.userId,
        agentKey: "company-understanding",
        topic: checkIn.questionText.slice(0, 64),
        systemPrompt: `Help the employee answer this company-understanding question. Treat their answer as company knowledge evidence, and do not ask for private journaling.\n\nQuestion: ${checkIn.questionText}`,
      },
    });
    await tx.conversationTurn.create({
      data: {
        conversationId: conversation.id,
        sequenceNumber: 1,
        userMessage: "Open company understanding question",
        assistantMessage: `${checkIn.questionText}\n\n${policy}`,
      },
    });
    await tx.checkIn.update({
      where: { id: checkIn.id },
      data: { relatedConversationId: conversation.id },
    });

    return tx.conversationSession.findUniqueOrThrow({
      where: { id: conversation.id },
      include: { turns: { orderBy: { sequenceNumber: "asc" } } },
    });
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
    const checkIn = await tx.checkIn.findUnique({
      where: { id: params.checkInId },
    });

    invariant(checkIn && checkIn.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Check-in not found.");
    invariant(membership && checkIn.memberId === membership.id, 403, "FORBIDDEN", "You can only respond to your own check-ins.");
    if (checkIn.questionType === COMPANY_UNDERSTANDING_TYPE) {
      invariant(checkIn.status === "OPEN", 400, "INVALID_STATE", "Only open company understanding questions can be answered.");
    }

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

    const events: Parameters<typeof appendEvents>[1] = [];

    if (checkIn.questionType === COMPANY_UNDERSTANDING_TYPE) {
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

    return updated;
  });
}

export async function skipCompanyUnderstandingQuestion(actor: AppActor, params: {
  workspaceId: string;
  checkInId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const checkIn = await tx.checkIn.findUnique({
      where: { id: params.checkInId },
    });

    invariant(checkIn && checkIn.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Check-in not found.");
    invariant(checkIn.questionType === COMPANY_UNDERSTANDING_TYPE, 400, "INVALID_INPUT", "Only company understanding questions can be skipped.");
    invariant(membership && checkIn.memberId === membership.id, 403, "FORBIDDEN", "You can only skip your own company understanding questions.");
    invariant(checkIn.status === "OPEN", 400, "INVALID_STATE", "Only open questions can be skipped.");

    const skipped = await tx.checkIn.update({
      where: { id: checkIn.id },
      data: { status: "SKIPPED" },
    });

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
