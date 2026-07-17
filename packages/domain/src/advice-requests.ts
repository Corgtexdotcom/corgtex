import type {
  AdviceRequestAudienceType,
  AdviceRequestPreferredChannel,
  AdviceRequestStatus,
  MemberRole,
  Prisma,
} from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { appendEvents } from "./events";
import { AppError, invariant } from "./errors";

export type AdviceSubjectType = "PROPOSAL" | "TENSION" | "ACTION";

export type AdviceRequestCountSummary = {
  adviceRequestCount: number;
  activeAdviceRequestCount: number;
  inputRequestCount: number;
  activeInputRequestCount: number;
};

type AdviceSubject = {
  type: AdviceSubjectType;
  id: string;
  title: string;
  circleId: string | null;
  ownerMemberId: string | null;
  authorUserId: string;
  assigneeMemberId?: string | null;
};

type AdviceRequestPayload = {
  adviceRequestId: string;
  processId: string;
  subjectType: AdviceSubjectType;
  subjectId: string;
  subjectTitle: string;
  requestedByUserId: string;
  audienceType: AdviceRequestAudienceType;
  targetCircleId: string | null;
  recipientMemberIds: string[];
  deadlineAt: string | null;
  reminderAt: string | null;
  preferredChannel: AdviceRequestPreferredChannel;
  messageMd: string;
};

const VALID_SUBJECT_TYPES = new Set<AdviceSubjectType>(["PROPOSAL", "TENSION", "ACTION"]);
const VALID_CHANNELS = new Set<AdviceRequestPreferredChannel>(["IN_APP", "SLACK", "EMAIL", "COPY"]);
const ADVICE_REMINDER_JOB_TYPE = "advice.request.reminder";

function emptyAdviceRequestCountSummary(): AdviceRequestCountSummary {
  return {
    adviceRequestCount: 0,
    activeAdviceRequestCount: 0,
    inputRequestCount: 0,
    activeInputRequestCount: 0,
  };
}

export async function loadAdviceRequestCountSummaries(
  workspaceId: string,
  subjectType: AdviceSubjectType,
  subjectIds: string[],
) {
  const uniqueSubjectIds = uniqueStrings(subjectIds);
  const summaries = new Map<string, AdviceRequestCountSummary>(
    uniqueSubjectIds.map((subjectId) => [subjectId, emptyAdviceRequestCountSummary()]),
  );
  if (uniqueSubjectIds.length === 0) return summaries;

  const processes = await prisma.adviceProcess.findMany({
    where: {
      workspaceId,
      subjectType,
      subjectId: { in: uniqueSubjectIds },
    },
    select: {
      subjectId: true,
      requests: {
        select: { status: true },
      },
    },
  });

  for (const process of processes) {
    const summary = summaries.get(process.subjectId) ?? emptyAdviceRequestCountSummary();
    const total = process.requests.length;
    const active = process.requests.filter((request) => request.status === "ACTIVE").length;
    summary.adviceRequestCount += total;
    summary.activeAdviceRequestCount += active;
    summary.inputRequestCount += total;
    summary.activeInputRequestCount += active;
    summaries.set(process.subjectId, summary);
  }

  return summaries;
}

function normalizeSubjectType(subjectType: string): AdviceSubjectType {
  const normalized = subjectType.trim().toUpperCase();
  invariant(VALID_SUBJECT_TYPES.has(normalized as AdviceSubjectType), 400, "INVALID_INPUT", "Unsupported advice subject type.");
  return normalized as AdviceSubjectType;
}

function normalizePreferredChannel(preferredChannel?: AdviceRequestPreferredChannel | null): AdviceRequestPreferredChannel {
  const normalized = preferredChannel ?? "IN_APP";
  invariant(VALID_CHANNELS.has(normalized), 400, "INVALID_INPUT", "Unsupported advice request channel.");
  return normalized;
}

function uniqueStrings(values: string[] | undefined) {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function assertFutureDate(value: Date | null | undefined, label: string) {
  if (!value) return;
  invariant(!Number.isNaN(value.getTime()), 400, "INVALID_INPUT", `${label} must be a valid date.`);
  invariant(value.getTime() > Date.now(), 400, "INVALID_INPUT", `${label} must be in the future.`);
}

async function findActiveMemberForUser(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
  return tx.member.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId,
      },
    },
    select: {
      id: true,
      userId: true,
      role: true,
      isActive: true,
    },
  });
}

async function resolveSubjectOwnerMemberId(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
  const member = await findActiveMemberForUser(tx, workspaceId, userId);
  return member?.isActive ? member.id : null;
}

async function resolveAdviceSubject(
  tx: Prisma.TransactionClient,
  params: { workspaceId: string; subjectType: AdviceSubjectType; subjectId: string },
): Promise<AdviceSubject> {
  if (params.subjectType === "PROPOSAL") {
    const proposal = await tx.proposal.findUnique({
      where: { id: params.subjectId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        status: true,
        circleId: true,
        authorUserId: true,
        ownerMemberId: true,
        archivedAt: true,
      },
    });

    invariant(proposal && proposal.workspaceId === params.workspaceId && !proposal.archivedAt, 404, "NOT_FOUND", "Proposal not found.");
    invariant(proposal.status === "OPEN", 400, "INVALID_STATE", "Advice can only be requested for open proposals.");

    return {
      type: "PROPOSAL",
      id: proposal.id,
      title: proposal.title,
      circleId: proposal.circleId,
      ownerMemberId: proposal.ownerMemberId ?? await resolveSubjectOwnerMemberId(tx, params.workspaceId, proposal.authorUserId),
      authorUserId: proposal.authorUserId,
    };
  }

  if (params.subjectType === "TENSION") {
    const tension = await tx.tension.findUnique({
      where: { id: params.subjectId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        status: true,
        circleId: true,
        authorUserId: true,
        assigneeMemberId: true,
        raisedByMemberId: true,
        archivedAt: true,
        isPrivate: true,
      },
    });

    invariant(tension && tension.workspaceId === params.workspaceId && !tension.archivedAt, 404, "NOT_FOUND", "Tension not found.");
    invariant(tension.status === "OPEN", 400, "INVALID_STATE", "Input can only be requested for open tensions.");
    invariant(!tension.isPrivate, 400, "INVALID_STATE", "Input cannot be requested for private tensions.");

    return {
      type: "TENSION",
      id: tension.id,
      title: tension.title,
      circleId: tension.circleId,
      ownerMemberId: tension.raisedByMemberId ?? await resolveSubjectOwnerMemberId(tx, params.workspaceId, tension.authorUserId),
      authorUserId: tension.authorUserId,
      assigneeMemberId: tension.assigneeMemberId,
    };
  }

  const action = await tx.action.findUnique({
    where: { id: params.subjectId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      status: true,
      circleId: true,
      authorUserId: true,
      assigneeMemberId: true,
      archivedAt: true,
      isPrivate: true,
    },
  });

  invariant(action && action.workspaceId === params.workspaceId && !action.archivedAt, 404, "NOT_FOUND", "Action not found.");
  invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "Input can only be requested for open or in-progress actions.");
  invariant(!action.isPrivate, 400, "INVALID_STATE", "Input cannot be requested for private actions.");

  return {
    type: "ACTION",
    id: action.id,
    title: action.title,
    circleId: action.circleId,
    ownerMemberId: action.assigneeMemberId ?? await resolveSubjectOwnerMemberId(tx, params.workspaceId, action.authorUserId),
    authorUserId: action.authorUserId,
    assigneeMemberId: action.assigneeMemberId,
  };
}

function assertCanRequestAdvice(params: {
  actorUserId: string;
  actorMemberId: string;
  actorRole: MemberRole;
  subject: AdviceSubject;
}) {
  const isAdmin = params.actorRole === "ADMIN";
  const isAuthor = params.subject.authorUserId === params.actorUserId;
  const isOwner = params.subject.ownerMemberId === params.actorMemberId;
  const isAssignee = params.subject.assigneeMemberId === params.actorMemberId;

  invariant(
    isAdmin || isAuthor || isOwner || isAssignee,
    403,
    "FORBIDDEN",
    "Only the subject owner, assignee, author, or a workspace admin can request input.",
  );
}

async function validateAdviceAudience(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  audienceType: AdviceRequestAudienceType;
  targetCircleId?: string | null;
  memberIds: string[];
}) {
  if (params.audienceType === "MEMBERS") {
    invariant(params.memberIds.length > 0, 400, "INVALID_INPUT", "Choose at least one person to request input from.");
    invariant(!params.targetCircleId, 400, "INVALID_INPUT", "Do not choose a circle when requesting input from selected people.");

    const members = await tx.member.findMany({
      where: {
        workspaceId: params.workspaceId,
        isActive: true,
        id: { in: params.memberIds },
      },
      select: { id: true },
    });
    invariant(members.length === params.memberIds.length, 400, "INVALID_INPUT", "Every selected recipient must be an active workspace member.");
    return;
  }

  invariant(params.memberIds.length === 0, 400, "INVALID_INPUT", "Selected people are only supported with the MEMBERS audience.");

  if (params.audienceType === "CIRCLE") {
    invariant(params.targetCircleId, 400, "INVALID_INPUT", "Choose a circle to request input from.");
    const circle = await tx.circle.findUnique({
      where: { id: params.targetCircleId },
      select: { workspaceId: true, archivedAt: true },
    });
    invariant(circle && circle.workspaceId === params.workspaceId && !circle.archivedAt, 400, "INVALID_INPUT", "Target circle must belong to this workspace.");
    return;
  }

  invariant(params.audienceType === "WORKSPACE", 400, "INVALID_INPUT", "Unsupported advice request audience.");
  invariant(!params.targetCircleId, 400, "INVALID_INPUT", "Do not choose a circle when requesting input from everyone.");
}

async function findOrCreateAdviceProcess(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  subject: AdviceSubject;
  requesterMemberId: string;
  deadlineAt?: Date | null;
}) {
  const existing = await tx.adviceProcess.findFirst({
    where: {
      workspaceId: params.workspaceId,
      subjectType: params.subject.type,
      subjectId: params.subject.id,
    },
  });

  if (existing) {
    invariant(existing.status === "GATHERING" || existing.status === "READY", 400, "INVALID_STATE", "Advice is not open for this subject.");
    return existing;
  }

  return tx.adviceProcess.create({
    data: {
      workspaceId: params.workspaceId,
      proposalId: params.subject.type === "PROPOSAL" ? params.subject.id : null,
      authorMemberId: params.requesterMemberId,
      ownerMemberId: params.subject.ownerMemberId,
      subjectType: params.subject.type,
      subjectId: params.subject.id,
      status: "GATHERING",
      adviceDeadline: params.deadlineAt ?? null,
    },
  });
}

function buildAdviceRequestPayload(params: {
  requestId: string;
  processId: string;
  subject: AdviceSubject;
  requestedByUserId: string;
  audienceType: AdviceRequestAudienceType;
  targetCircleId: string | null;
  recipientMemberIds: string[];
  deadlineAt?: Date | null;
  reminderAt?: Date | null;
  preferredChannel: AdviceRequestPreferredChannel;
  messageMd: string;
}): AdviceRequestPayload {
  return {
    adviceRequestId: params.requestId,
    processId: params.processId,
    subjectType: params.subject.type,
    subjectId: params.subject.id,
    subjectTitle: params.subject.title,
    requestedByUserId: params.requestedByUserId,
    audienceType: params.audienceType,
    targetCircleId: params.targetCircleId,
    recipientMemberIds: params.recipientMemberIds,
    deadlineAt: params.deadlineAt?.toISOString() ?? null,
    reminderAt: params.reminderAt?.toISOString() ?? null,
    preferredChannel: params.preferredChannel,
    messageMd: params.messageMd,
  };
}

export async function createAdviceRequest(actor: AppActor, params: {
  workspaceId: string;
  subjectType: string;
  subjectId: string;
  audienceType: AdviceRequestAudienceType;
  memberIds?: string[];
  targetCircleId?: string | null;
  messageMd: string;
  deadlineAt?: Date | null;
  reminderAt?: Date | null;
  preferredChannel?: AdviceRequestPreferredChannel | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can request input.");

  const subjectType = normalizeSubjectType(params.subjectType);
  const messageMd = params.messageMd.trim();
  const preferredChannel = normalizePreferredChannel(params.preferredChannel);
  const memberIds = uniqueStrings(params.memberIds);
  invariant(messageMd.length > 0, 400, "INVALID_INPUT", "Input request message cannot be empty.");
  assertFutureDate(params.deadlineAt, "Deadline");
  assertFutureDate(params.reminderAt, "Reminder");
  if (params.deadlineAt && params.reminderAt) {
    invariant(params.reminderAt <= params.deadlineAt, 400, "INVALID_INPUT", "Reminder must be before or at the deadline.");
  }

  return prisma.$transaction(async (tx) => {
    const requesterMember = await findActiveMemberForUser(tx, params.workspaceId, actor.user.id);
    invariant(requesterMember?.isActive, 403, "NOT_A_MEMBER", "Only active workspace members can request input.");

    const subject = await resolveAdviceSubject(tx, {
      workspaceId: params.workspaceId,
      subjectType,
      subjectId: params.subjectId,
    });

    assertCanRequestAdvice({
      actorUserId: actor.user.id,
      actorMemberId: requesterMember.id,
      actorRole: (membership?.role ?? requesterMember.role) as MemberRole,
      subject,
    });

    await validateAdviceAudience(tx, {
      workspaceId: params.workspaceId,
      audienceType: params.audienceType,
      targetCircleId: params.targetCircleId,
      memberIds,
    });

    const process = await findOrCreateAdviceProcess(tx, {
      workspaceId: params.workspaceId,
      subject,
      requesterMemberId: requesterMember.id,
      deadlineAt: params.deadlineAt,
    });

    const request = await tx.adviceRequest.create({
      data: {
        workspaceId: params.workspaceId,
        processId: process.id,
        requestedByUserId: actor.user.id,
        audienceType: params.audienceType,
        targetCircleId: params.audienceType === "CIRCLE" ? params.targetCircleId : null,
        messageMd,
        deadlineAt: params.deadlineAt ?? null,
        reminderAt: params.reminderAt ?? null,
        preferredChannel,
      },
    });

    if (params.audienceType === "MEMBERS") {
      await tx.adviceRequestRecipient.createMany({
        data: memberIds.map((memberId) => ({
          requestId: request.id,
          memberId,
        })),
        skipDuplicates: true,
      });
    }

    if (params.reminderAt) {
      await tx.workflowJob.upsert({
        where: {
          dedupeKey: `${ADVICE_REMINDER_JOB_TYPE}:${request.id}:${params.reminderAt.toISOString()}`,
        },
        update: {},
        create: {
          workspaceId: params.workspaceId,
          type: ADVICE_REMINDER_JOB_TYPE,
          payload: {
            adviceRequestId: request.id,
          },
          runAfter: params.reminderAt,
          dedupeKey: `${ADVICE_REMINDER_JOB_TYPE}:${request.id}:${params.reminderAt.toISOString()}`,
        },
      });
    }

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "advice.requested",
      entityType: "AdviceRequest",
      entityId: request.id,
      meta: {
        processId: process.id,
        subjectType: subject.type,
        subjectId: subject.id,
        audienceType: params.audienceType,
        targetCircleId: params.targetCircleId ?? null,
        recipientMemberIds: memberIds,
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "advice.requested",
        aggregateType: "AdviceRequest",
        aggregateId: request.id,
        payload: buildAdviceRequestPayload({
          requestId: request.id,
          processId: process.id,
          subject,
          requestedByUserId: actor.user.id,
          audienceType: params.audienceType,
          targetCircleId: params.audienceType === "CIRCLE" ? params.targetCircleId ?? null : null,
          recipientMemberIds: memberIds,
          deadlineAt: params.deadlineAt,
          reminderAt: params.reminderAt,
          preferredChannel,
          messageMd,
        }),
      },
    ]);

    return request;
  });
}

export async function listAdviceRequests(actor: AppActor, params: {
  workspaceId: string;
  subjectType?: string;
  subjectId?: string;
  processId?: string;
  status?: AdviceRequestStatus;
  take?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const subjectType = params.subjectType ? normalizeSubjectType(params.subjectType) : undefined;

  return prisma.adviceRequest.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(params.processId ? { processId: params.processId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(subjectType || params.subjectId
        ? {
          process: {
            ...(subjectType ? { subjectType } : {}),
            ...(params.subjectId ? { subjectId: params.subjectId } : {}),
          },
        }
        : {}),
    },
    include: {
      requestedBy: {
        select: { id: true, displayName: true, email: true },
      },
      targetCircle: {
        select: { id: true, name: true },
      },
      recipients: {
        include: {
          member: {
            include: {
              user: {
                select: { id: true, displayName: true, email: true },
              },
            },
          },
        },
      },
      process: true,
    },
    orderBy: { createdAt: "desc" },
    take: params.take ?? 50,
  });
}

async function assertCanManageRequest(tx: Prisma.TransactionClient, actor: AppActor, params: {
  workspaceId: string;
  requestId: string;
  membershipRole?: MemberRole | null;
}) {
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can manage advice requests.");

  const request = await tx.adviceRequest.findUnique({
    where: { id: params.requestId },
    include: {
      process: {
        include: {
          ownerMember: {
            select: { userId: true },
          },
        },
      },
    },
  });

  invariant(request && request.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Advice request not found.");
  invariant(request.status === "ACTIVE", 400, "INVALID_STATE", "Only active advice requests can be changed.");

  const isAdmin = params.membershipRole === "ADMIN";
  const isRequester = request.requestedByUserId === actor.user.id;
  const isOwner = request.process.ownerMember?.userId === actor.user.id;
  invariant(isAdmin || isRequester || isOwner, 403, "FORBIDDEN", "Only the requester, subject owner, or a workspace admin can manage this advice request.");

  return request;
}

export async function closeAdviceRequest(actor: AppActor, params: {
  workspaceId: string;
  requestId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const request = await assertCanManageRequest(tx, actor, {
      workspaceId: params.workspaceId,
      requestId: params.requestId,
      membershipRole: membership?.role,
    });

    const updated = await tx.adviceRequest.update({
      where: { id: params.requestId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "advice.request.completed",
      entityType: "AdviceRequest",
      entityId: request.id,
      meta: { processId: request.processId },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "advice.request.completed",
        aggregateType: "AdviceRequest",
        aggregateId: request.id,
        payload: {
          adviceRequestId: request.id,
          processId: request.processId,
        },
      },
    ]);

    return updated;
  });
}

export async function withdrawAdviceRequest(actor: AppActor, params: {
  workspaceId: string;
  requestId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const request = await assertCanManageRequest(tx, actor, {
      workspaceId: params.workspaceId,
      requestId: params.requestId,
      membershipRole: membership?.role,
    });

    const updated = await tx.adviceRequest.update({
      where: { id: params.requestId },
      data: {
        status: "CANCELED",
        canceledAt: new Date(),
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "advice.request.withdrawn",
      entityType: "AdviceRequest",
      entityId: request.id,
      meta: { processId: request.processId },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "advice.request.withdrawn",
        aggregateType: "AdviceRequest",
        aggregateId: request.id,
        payload: {
          adviceRequestId: request.id,
          processId: request.processId,
        },
      },
    ]);

    return updated;
  });
}

function uniqueUserTargets(rows: Array<{ memberId?: string; userId: string }>, excludeUserIds: Set<string>) {
  const seen = new Set<string>();
  const targets: Array<{ memberId?: string; userId: string }> = [];
  for (const row of rows) {
    if (excludeUserIds.has(row.userId) || seen.has(row.userId)) continue;
    seen.add(row.userId);
    targets.push(row);
  }
  return targets;
}

export async function resolveAdviceRequestRecipientUsers(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  adviceRequestId: string;
  excludeUserIds?: string[];
}) {
  const request = await tx.adviceRequest.findUnique({
    where: { id: params.adviceRequestId },
    include: {
      recipients: {
        select: { memberId: true },
      },
    },
  });

  invariant(request && request.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Advice request not found.");
  const excludeUserIds = new Set(params.excludeUserIds ?? []);

  if (request.audienceType === "MEMBERS") {
    if (request.recipients.length === 0) return [];
    const members = await tx.member.findMany({
      where: {
        workspaceId: params.workspaceId,
        isActive: true,
        id: { in: request.recipients.map((recipient) => recipient.memberId) },
      },
      select: { id: true, userId: true },
    });
    return uniqueUserTargets(members.map((member) => ({ memberId: member.id, userId: member.userId })), excludeUserIds);
  }

  if (request.audienceType === "CIRCLE") {
    if (!request.targetCircleId) return [];
    const members = await tx.member.findMany({
      where: {
        workspaceId: params.workspaceId,
        isActive: true,
        roleAssignments: {
          some: {
            role: {
              circleId: request.targetCircleId,
              archivedAt: null,
              circle: {
                workspaceId: params.workspaceId,
                archivedAt: null,
              },
            },
          },
        },
      },
      select: { id: true, userId: true },
    });
    return uniqueUserTargets(members.map((member) => ({ memberId: member.id, userId: member.userId })), excludeUserIds);
  }

  const members = await tx.member.findMany({
    where: {
      workspaceId: params.workspaceId,
      isActive: true,
    },
    select: { id: true, userId: true },
  });
  return uniqueUserTargets(members.map((member) => ({ memberId: member.id, userId: member.userId })), excludeUserIds);
}

export async function resolveAdviceRequestRequesterUsers(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  adviceRequestId: string;
  excludeUserIds?: string[];
}) {
  const request = await tx.adviceRequest.findUnique({
    where: { id: params.adviceRequestId },
    include: {
      process: {
        include: {
          ownerMember: {
            select: { id: true, userId: true },
          },
        },
      },
    },
  });

  invariant(request && request.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Advice request not found.");
  return uniqueUserTargets([
    { userId: request.requestedByUserId },
    ...(request.process.ownerMember ? [{ memberId: request.process.ownerMember.id, userId: request.process.ownerMember.userId }] : []),
  ], new Set(params.excludeUserIds ?? []));
}

export async function runAdviceRequestReminderJob(params: {
  workspaceId: string;
  adviceRequestId: string;
}) {
  const request = await prisma.adviceRequest.findUnique({
    where: { id: params.adviceRequestId },
    include: {
      process: true,
    },
  });

  if (!request || request.workspaceId !== params.workspaceId) {
    return { skipped: true, reason: "not_found" as const };
  }
  if (request.status !== "ACTIVE") {
    return { skipped: true, reason: "inactive" as const };
  }
  if (!request.reminderAt || request.reminderAt.getTime() > Date.now()) {
    return { skipped: true, reason: "not_due" as const };
  }

  let subject: AdviceSubject;
  try {
    subject = await prisma.$transaction(async (tx) => resolveAdviceSubject(tx, {
      workspaceId: params.workspaceId,
      subjectType: normalizeSubjectType(request.process.subjectType),
      subjectId: request.process.subjectId,
    }));
  } catch (error) {
    if (error instanceof AppError && (error.code === "NOT_FOUND" || error.code === "INVALID_STATE")) {
      return { skipped: true, reason: "subject_unavailable" as const };
    }
    throw error;
  }

  await prisma.event.create({
    data: {
      workspaceId: params.workspaceId,
      type: "advice.reminder_due",
      aggregateType: "AdviceRequest",
      aggregateId: request.id,
      payload: buildAdviceRequestPayload({
        requestId: request.id,
        processId: request.processId,
        subject,
        requestedByUserId: request.requestedByUserId,
        audienceType: request.audienceType,
        targetCircleId: request.targetCircleId,
        recipientMemberIds: [],
        deadlineAt: request.deadlineAt,
        reminderAt: request.reminderAt,
        preferredChannel: request.preferredChannel,
        messageMd: request.messageMd,
      }),
    },
  });

  return { skipped: false as const };
}
