import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { appendEvents } from "./events";

const COMPANY_UNDERSTANDING_TYPE = "COMPANY_UNDERSTANDING";
const COMPANY_KNOWLEDGE_POLICY = "COMPANY_KNOWLEDGE";
const MEMBER_CHECKIN_POLICY = "MEMBER_CHECKIN";

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

export async function respondToCheckIn(actor: AppActor, params: {
  workspaceId: string;
  checkInId: string;
  responseMd: string;
  sentiment?: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const checkIn = await tx.checkIn.findUnique({
      where: { id: params.checkInId },
    });

    invariant(checkIn && checkIn.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Check-in not found.");
    invariant(membership && checkIn.memberId === membership.id, 403, "FORBIDDEN", "You can only respond to your own check-ins.");

    const updated = await tx.checkIn.update({
      where: { id: checkIn.id },
      data: {
        responseMd: params.responseMd.trim() || null,
        sentiment: params.sentiment,
        status: "ANSWERED",
        respondedAt: new Date(),
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "checkin.response_received",
        aggregateType: "CheckIn",
        aggregateId: updated.id,
        payload: { checkInId: updated.id, memberId: updated.memberId },
      },
    ]);

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
