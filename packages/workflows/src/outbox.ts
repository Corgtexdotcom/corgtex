import type { EventStatus, Prisma, WorkflowJobStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { runAgentWorkflowJob, runDailyDigest } from "@corgtex/agents";
import { syncBrainArticleKnowledge, syncKnowledgeForSource } from "@corgtex/knowledge";
import { recordGovernanceScore, createWebhookDeliveries, deliverWebhook, fetchCalendarEvents } from "@corgtex/domain";

const DEFAULT_BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;
const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const TRIAGE_COALESCE_WINDOW_MS = 5 * 60 * 1_000;
const TRIAGE_EVENT_TYPES = new Set([
  "proposal.submitted",
  "spend.submitted",
  "meeting.created",
  "action.created",
  "tension.created",
  "advice-process.initiated",
  "advice-process.executed",
  "checkin.response_received",
]);

const KNOWLEDGE_PULSE_EVENT_TYPES = new Set([
  "proposal.submitted",
  "proposal.approved",
  "document.created",
  "spend.created",
  "spend.submitted",
  "spend.paid",
  "meeting.created",
  "approval.finalized",
  "advice-process.advice-recorded",
]);

type ClaimedEvent = {
  id: string;
  workspaceId: string | null;
  type: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: unknown;
  attempts: number;
  createdAt: Date;
};

type ClaimedJob = {
  id: string;
  workspaceId: string | null;
  type: string;
  payload: unknown;
  attempts: number;
};

type NotificationDraft = {
  type: string;
  entityType: string | null;
  entityId: string | null;
  title: string;
  bodyMd: string | null;
};

class RetryableWorkflowJobError extends Error {}

export async function enqueueJob(tx: Prisma.TransactionClient, params: {
  workspaceId?: string | null;
  eventId: string;
  type: string;
  payload: Prisma.InputJsonObject;
  dedupeKey: string;
  dependsOnJobId?: string | null;
}) {
  await tx.workflowJob.upsert({
    where: { dedupeKey: params.dedupeKey },
    update: {},
    create: {
      workspaceId: params.workspaceId ?? null,
      eventId: params.eventId,
      type: params.type,
      payload: params.payload,
      dedupeKey: params.dedupeKey,
      dependsOnJobId: params.dependsOnJobId ?? null,
    },
  });
}

async function resolveDedupeKeyToJobId(tx: Prisma.TransactionClient, dedupeKey: string): Promise<string | null> {
  const job = await tx.workflowJob.findUnique({
    where: { dedupeKey },
    select: { id: true },
  });
  return job?.id ?? null;
}

export function calculateRetryDelayMs(attempt: number) {
  const normalizedAttempt = Math.max(1, attempt);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (normalizedAttempt - 1), RETRY_MAX_DELAY_MS);
}

function nextRetryTime(attempt: number) {
  return new Date(Date.now() + calculateRetryDelayMs(attempt));
}

export function triageBucketStart(date: Date) {
  return new Date(Math.floor(date.getTime() / TRIAGE_COALESCE_WINDOW_MS) * TRIAGE_COALESCE_WINDOW_MS);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPayloadString(payload: unknown, key: string) {
  if (!isObjectRecord(payload)) {
    return null;
  }

  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isReplayEvent(payload: unknown) {
  if (!isObjectRecord(payload)) {
    return false;
  }

  const runtimeMeta = payload.runtimeMeta;
  if (!isObjectRecord(runtimeMeta)) {
    return false;
  }

  return typeof runtimeMeta.replayOfEventId === "string" && runtimeMeta.replayOfEventId.trim().length > 0;
}

export function deriveNotificationsForEvent(event: {
  type: string;
  workspaceId: string | null;
  aggregateType?: string | null;
  aggregateId?: string | null;
  payload: unknown;
}) {
  if (!event.workspaceId || isReplayEvent(event.payload)) {
    return [] satisfies NotificationDraft[];
  }

  const entityType = event.aggregateType ?? null;
  const entityId = event.aggregateId ?? null;
  const title = readPayloadString(event.payload, "title");

  if (event.type === "proposal.submitted") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: "Proposal submitted for review",
      bodyMd: "A proposal is awaiting approval in the workspace dashboard.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "spend.submitted") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: "Spend request submitted for review",
      bodyMd: "A spend request is awaiting finance review in the workspace dashboard.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "meeting.created") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: title ? `Meeting added: ${title}` : "New meeting added",
      bodyMd: "Meeting summary and action extraction will run automatically.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "action.created") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: title ? `New action: ${title}` : "New action created",
      bodyMd: "An action item was added to the workspace.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "tension.created") {
    return [{
      type: event.type,
      entityType,
      entityId,
      title: title ? `New tension: ${title}` : "New tension raised",
      bodyMd: "A new tension was captured in the workspace.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "advice-process.initiated") {
    return [{
      type: event.type,
      entityType: "AdviceProcess",
      entityId,
      title: title ? `Context required: ${title}` : "Advice process initiated",
      bodyMd: "A new proposal is seeking advice before execution.",
    }] satisfies NotificationDraft[];
  }

  if (event.type === "advice-process.advice-recorded") {
    return [{
      type: event.type,
      entityType: "AdviceRecord",
      entityId,
      title: title ? `Advice recorded on: ${title}` : "New advice recorded",
      bodyMd: "A peer has left advice on an active proposal.",
    }] satisfies NotificationDraft[];
  }

  return [] satisfies NotificationDraft[];
}

export function deriveJobsForEvent(event: {
  id: string;
  type: string;
  workspaceId: string | null;
  payload: unknown;
  createdAt?: Date;
  aggregateId?: string | null;
  aggregateType?: string | null;
}) {
  const jobs: Array<{
    workspaceId?: string | null;
    eventId: string;
    type: string;
    payload: Prisma.InputJsonObject;
    dedupeKey: string;
    dependsOnDedupeKey?: string;
  }> = [];

  if (event.type === "proposal.approved") {
    const payload = event.payload as { subjectId?: string };
    if (payload.subjectId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.proposal",
        payload: {
          proposalId: payload.subjectId,
        },
        dedupeKey: `${event.id}:knowledge-sync`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.constitution-update-trigger",
        payload: {
          proposalId: payload.subjectId,
        },
        dedupeKey: `${event.id}:constitution-update-trigger`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.constitution-synthesis",
        payload: {},
        dedupeKey: `${event.id}:constitution-synthesis`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "governance.score",
        payload: {},
        dedupeKey: `${event.id}:governance-score`,
      });
    }
  }

  if (event.type === "advice-process.initiated") {
    const payload = event.payload as { proposalId?: string };
    if (payload.proposalId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.advice-routing",
        payload: {
          proposalId: payload.proposalId,
        },
        dedupeKey: `${event.id}:advice-routing`,
      });
    }
  }

  if (event.type === "advice-process.executed") {
    const payload = event.payload as { proposalId?: string };
    if (event.aggregateId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.process-linting",
        payload: {
          processId: event.aggregateId,
        },
        dedupeKey: `${event.id}:process-linting`,
      });
      if (payload.proposalId) {
        jobs.push({
          workspaceId: event.workspaceId,
          eventId: event.id,
          type: "knowledge.sync.proposal",
          payload: {
            proposalId: payload.proposalId,
          },
          dedupeKey: `${event.id}:knowledge-sync`,
        });
      }
    }
  }

  if (event.type === "meeting.created") {
    const payload = event.payload as { meetingId?: string };
    if (payload.meetingId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.meeting",
        payload: {
          meetingId: payload.meetingId,
        },
        dedupeKey: `${event.id}:meeting-knowledge-sync`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.meeting-summary",
        payload: {
          meetingId: payload.meetingId,
        },
        dedupeKey: `${event.id}:meeting-summary`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.action-extraction",
        payload: {
          meetingId: payload.meetingId,
        },
        dependsOnDedupeKey: `${event.id}:meeting-summary`,
        dedupeKey: `${event.id}:action-extraction`,
      });
    }
  }

  if (event.type === "brain-source.created") {
    const payload = event.payload as { sourceId?: string };
    if (payload.sourceId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.brain-absorb",
        payload: { sourceId: payload.sourceId },
        dedupeKey: `${event.id}:brain-absorb`,
      });
    }
  }

  if (event.type === "brain-article.created" || event.type === "brain-article.updated") {
    const payload = event.payload as { articleId?: string };
    if (payload.articleId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.brain-article",
        payload: { articleId: payload.articleId },
        dedupeKey: `${event.id}:brain-article-knowledge-sync`,
      });
    }
  }

  if (event.type === "document.created") {
    const payload = event.payload as { documentId?: string };
    if (payload.documentId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.document",
        payload: {
          documentId: payload.documentId,
        },
        dedupeKey: `${event.id}:document-knowledge-sync`,
      });
    }
  }

  if (event.type === "spend.paid") {
    const payload = event.payload as { spendId?: string };
    if (payload.spendId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.finance-reconciliation-prep",
        payload: {
          spendId: payload.spendId,
        },
        dedupeKey: `${event.id}:finance-reconciliation-prep`,
      });
    }
  }

  if (event.type === "tension.created" || event.type === "tension.updated") {
    const payload = event.payload as { tensionId?: string };
    if (payload.tensionId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.tension",
        payload: { tensionId: payload.tensionId },
        dedupeKey: `${event.id}:tension-knowledge-sync`,
      });
    }
  }

  if (event.type === "action.created" || event.type === "action.updated") {
    const payload = event.payload as { actionId?: string };
    if (payload.actionId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.action",
        payload: { actionId: payload.actionId },
        dedupeKey: `${event.id}:action-knowledge-sync`,
      });
    }
  }

  if (event.type === "circle.created" || event.type === "circle.updated") {
    const payload = event.payload as { circleId?: string };
    if (payload.circleId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.circle",
        payload: { circleId: payload.circleId },
        dedupeKey: `${event.id}:circle-knowledge-sync`,
      });
    }
  }

  if (event.type === "role.created" || event.type === "role.updated") {
    const payload = event.payload as { roleId?: string };
    if (payload.roleId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.role",
        payload: { roleId: payload.roleId },
        dedupeKey: `${event.id}:role-knowledge-sync`,
      });
    }
  }

  if (event.type === "checkin.response_received") {
    const payload = event.payload as { checkInId?: string; memberId?: string };
    if (payload.memberId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.checkin-analysis",
        payload: {
          memberId: payload.memberId,
          checkInId: payload.checkInId,
        },
        dedupeKey: `${event.id}:checkin-analysis`,
      });
    }
  }

  if (event.workspaceId && TRIAGE_EVENT_TYPES.has(event.type)) {
    const payload = (event.payload ?? {}) as { runtimeMeta?: { replayOfEventId?: string } };
    const replayOfEventId = payload.runtimeMeta?.replayOfEventId;
    const bucketStart = triageBucketStart(event.createdAt ?? new Date()).toISOString();
    const dedupeKey = replayOfEventId
      ? `${event.workspaceId}:triage:replay:${event.id}`
      : `${event.workspaceId}:triage:${bucketStart}`;

    jobs.push({
      workspaceId: event.workspaceId,
      eventId: event.id,
      type: "agent.inbox-triage",
      payload: {
        eventType: event.type,
        bucketStart,
        replayOfEventId: replayOfEventId ?? null,
      },
      dedupeKey,
    });
  }

  if (event.workspaceId && KNOWLEDGE_PULSE_EVENT_TYPES.has(event.type) && !isReplayEvent(event.payload)) {
    jobs.push({
      workspaceId: event.workspaceId,
      eventId: event.id,
      type: "knowledge.sync.event",
      payload: {
        eventId: event.id,
      },
      dedupeKey: `${event.id}:knowledge-sync-event`,
    });
  }

  return jobs;
}

async function claimPendingEvents(workerId: string, batchSize: number) {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);

  return prisma.$transaction(async (tx) => {
    return tx.$queryRaw<ClaimedEvent[]>`
      WITH candidates AS (
        SELECT event.id
        FROM "Event" AS event
        WHERE event.status = 'PENDING'
          AND event."availableAt" <= NOW()
          AND (event."lockedAt" IS NULL OR event."lockedAt" < ${staleBefore})
        ORDER BY event."createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "Event" AS event
      SET
        "lockedAt" = NOW(),
        "lockedBy" = ${workerId},
        "attempts" = event."attempts" + 1,
        "error" = NULL
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING
        event.id,
        event."workspaceId" AS "workspaceId",
        event.type,
        event."aggregateType" AS "aggregateType",
        event."aggregateId" AS "aggregateId",
        event.payload,
        event.attempts,
        event."createdAt" AS "createdAt"
    `;
  });
}

async function createNotificationsForEvent(tx: Prisma.TransactionClient, event: ClaimedEvent) {
  if (!event.workspaceId) {
    return;
  }

  const notifications = deriveNotificationsForEvent(event);
  if (notifications.length === 0) {
    return;
  }

  const actorAudit = event.aggregateType && event.aggregateId
    ? await tx.auditLog.findFirst({
      where: {
        workspaceId: event.workspaceId,
        action: event.type,
        entityType: event.aggregateType,
        entityId: event.aggregateId,
      },
      orderBy: { createdAt: "desc" },
      select: { actorUserId: true },
    })
    : null;

  const members = await tx.member.findMany({
    where: {
      workspaceId: event.workspaceId,
      isActive: true,
      ...(actorAudit?.actorUserId ? { userId: { not: actorAudit.actorUserId } } : {}),
    },
    select: { userId: true },
  });

  if (members.length === 0) {
    return;
  }

  await tx.notification.createMany({
    data: notifications.flatMap((notification) => (
      members.map((member) => ({
        workspaceId: event.workspaceId as string,
        userId: member.userId,
        type: notification.type,
        entityType: notification.entityType,
        entityId: notification.entityId,
        title: notification.title,
        bodyMd: notification.bodyMd,
      }))
    )),
  });
}

async function claimPendingJobs(workerId: string, batchSize: number) {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);

  return prisma.$transaction(async (tx) => {
    return tx.$queryRaw<ClaimedJob[]>`
      WITH candidates AS (
        SELECT job.id
        FROM "WorkflowJob" AS job
        LEFT JOIN "WorkflowJob" AS dep ON dep.id = job."dependsOnJobId"
        WHERE (
          (job.status = 'PENDING' AND job."runAfter" <= NOW())
          OR (job.status = 'RUNNING' AND job."lockedAt" IS NOT NULL AND job."lockedAt" < ${staleBefore})
        )
        AND (job."dependsOnJobId" IS NULL OR dep.status = 'COMPLETED')
        ORDER BY job."createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE OF job SKIP LOCKED
      )
      UPDATE "WorkflowJob" AS job
      SET
        status = 'RUNNING',
        "startedAt" = NOW(),
        "lockedAt" = NOW(),
        "lockedBy" = ${workerId},
        "attempts" = job."attempts" + 1,
        "error" = NULL
      FROM candidates
      WHERE job.id = candidates.id
      RETURNING
        job.id,
        job."workspaceId" AS "workspaceId",
        job.type,
        job.payload,
        job.attempts
    `;
  });
}

async function failEvent(event: ClaimedEvent, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown event dispatch error.";
  const status: EventStatus = event.attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING";

  await prisma.event.update({
    where: { id: event.id },
    data: {
      status,
      error: message,
      availableAt: status === "PENDING" ? nextRetryTime(event.attempts) : new Date(),
      lockedAt: null,
      lockedBy: null,
    },
  });
}

async function completeJob(jobId: string) {
  await prisma.workflowJob.update({
    where: { id: jobId },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      error: null,
      lockedAt: null,
      lockedBy: null,
    },
  });
}

async function failJob(job: ClaimedJob, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown worker error.";
  const status: WorkflowJobStatus = job.attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING";

  await prisma.workflowJob.update({
    where: { id: job.id },
    data: {
      status,
      error: message,
      completedAt: status === "FAILED" ? new Date() : null,
      runAfter: status === "PENDING" ? nextRetryTime(job.attempts) : undefined,
      lockedAt: null,
      lockedBy: null,
    },
  });
}

async function handleKnowledgeSync(jobId: string, payload: { proposalId?: string }, workspaceId: string) {
  if (!payload.proposalId) {
    return;
  }

  const proposal = await prisma.proposal.findUnique({
    where: { id: payload.proposalId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      summary: true,
      bodyMd: true,
      status: true,
    },
  });

  if (!proposal || proposal.workspaceId !== workspaceId) {
    return;
  }

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "PROPOSAL",
    sourceId: proposal.id,
    sourceTitle: proposal.title,
    content: [proposal.title, proposal.summary, proposal.bodyMd].filter(Boolean).join("\n\n"),
    metadata: {
      status: proposal.status,
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}

async function handleMeetingKnowledgeSync(jobId: string, payload: { meetingId?: string }, workspaceId: string) {
  if (!payload.meetingId) {
    return;
  }

  const meeting = await prisma.meeting.findUnique({
    where: { id: payload.meetingId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      source: true,
      transcript: true,
      summaryMd: true,
      recordedAt: true,
    },
  });

  if (!meeting || meeting.workspaceId !== workspaceId) {
    return;
  }

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "MEETING",
    sourceId: meeting.id,
    sourceTitle: meeting.title,
    content: [meeting.title, meeting.summaryMd, meeting.transcript].filter(Boolean).join("\n\n"),
    metadata: {
      source: meeting.source,
      recordedAt: meeting.recordedAt.toISOString(),
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}

async function handleDocumentKnowledgeSync(jobId: string, payload: { documentId?: string }, workspaceId: string) {
  if (!payload.documentId) {
    return;
  }

  const document = await prisma.document.findUnique({
    where: { id: payload.documentId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      source: true,
      mimeType: true,
      storageKey: true,
      textContent: true,
    },
  });

  if (!document || document.workspaceId !== workspaceId) {
    return;
  }

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "DOCUMENT",
    sourceId: document.id,
    sourceTitle: document.title,
    content: [document.title, document.textContent].filter(Boolean).join("\n\n"),
    metadata: {
      source: document.source,
      mimeType: document.mimeType,
      storageKey: document.storageKey,
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}

async function handleEventKnowledgeSync(jobId: string, payload: { eventId?: string }, workspaceId: string) {
  if (!payload.eventId) {
    return;
  }

  const event = await prisma.event.findUnique({
    where: { id: payload.eventId },
    select: {
      id: true,
      workspaceId: true,
      type: true,
      aggregateType: true,
      aggregateId: true,
      payload: true,
      createdAt: true,
    },
  });

  if (!event || event.workspaceId !== workspaceId) {
    return;
  }

  const title = `Event: ${event.type}`;
  const content = [
    `An event of type '${event.type}' occurred on ${event.createdAt.toISOString()}.`,
    `Payload details:`,
    JSON.stringify(event.payload, null, 2),
  ].join("\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "EVENT",
    sourceId: event.id,
    sourceTitle: title,
    content,
    metadata: {
      eventType: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}

async function handleTensionKnowledgeSync(jobId: string, payload: { tensionId?: string }, workspaceId: string) {
  if (!payload.tensionId) return;
  const tension = await prisma.tension.findUnique({
    where: { id: payload.tensionId },
    include: { author: { select: { displayName: true } }, assigneeMember: { include: { user: { select: { displayName: true } } } }, circle: { select: { name: true } } },
  });
  if (!tension || tension.workspaceId !== workspaceId) return;

  const content = [
    `# Tension: ${tension.title}`,
    `**Status:** ${tension.status} | **Priority:** ${tension.priority}`,
    `**Author:** ${tension.author.displayName || "Unknown"}`,
    `**Circle:** ${tension.circle?.name || "None"} | **Assigned to:** ${tension.assigneeMember?.user.displayName || "Unassigned"}`,
    `**Created:** ${tension.createdAt.toISOString()}`,
    tension.bodyMd ? `\n${tension.bodyMd}` : "",
  ].filter(Boolean).join("\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "TENSION",
    sourceId: tension.id,
    sourceTitle: tension.title,
    content,
    metadata: { status: tension.status, workflowJobId: jobId },
    workflowJobId: jobId,
  });
}

async function handleActionKnowledgeSync(jobId: string, payload: { actionId?: string }, workspaceId: string) {
  if (!payload.actionId) return;
  const action = await prisma.action.findUnique({
    where: { id: payload.actionId },
    include: { author: { select: { displayName: true } }, assigneeMember: { include: { user: { select: { displayName: true } } } }, circle: { select: { name: true } } },
  });
  if (!action || action.workspaceId !== workspaceId) return;

  const content = [
    `# Action: ${action.title}`,
    `**Status:** ${action.status} | **Due:** ${action.dueAt ? action.dueAt.toISOString() : "None"}`,
    `**Author:** ${action.author.displayName || "Unknown"}`,
    `**Circle:** ${action.circle?.name || "None"} | **Assigned to:** ${action.assigneeMember?.user.displayName || "Unassigned"}`,
    `**Created:** ${action.createdAt.toISOString()}`,
    action.bodyMd ? `\n${action.bodyMd}` : "",
  ].filter(Boolean).join("\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "ACTION",
    sourceId: action.id,
    sourceTitle: action.title,
    content,
    metadata: { status: action.status, workflowJobId: jobId },
    workflowJobId: jobId,
  });
}

async function handleCircleKnowledgeSync(jobId: string, payload: { circleId?: string }, workspaceId: string) {
  if (!payload.circleId) return;
  const circle = await prisma.circle.findUnique({
    where: { id: payload.circleId },
  });
  if (!circle || circle.workspaceId !== workspaceId) return;

  const content = [
    `# Circle: ${circle.name}`,
    `**Purpose:**\n${circle.purposeMd || "Not specified"}`,
    `**Domain:**\n${circle.domainMd || "Not specified"}`,
  ].filter(Boolean).join("\n\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "CIRCLE",
    sourceId: circle.id,
    sourceTitle: circle.name,
    content,
    metadata: { workflowJobId: jobId },
    workflowJobId: jobId,
  });
}

async function handleRoleKnowledgeSync(jobId: string, payload: { roleId?: string }, workspaceId: string) {
  if (!payload.roleId) return;
  const role = await prisma.role.findUnique({
    where: { id: payload.roleId },
    include: { circle: { select: { name: true, workspaceId: true } } },
  });
  if (!role || role.circle.workspaceId !== workspaceId) return;

  const content = [
    `# Role: ${role.name}`,
    `**Circle:** ${role.circle.name}`,
    `**Purpose:**\n${role.purposeMd || "Not specified"}`,
    `**Accountabilities:**\n${role.accountabilities.length > 0 ? role.accountabilities.map(a => "- " + a).join("\n") : "None"}`,
  ].filter(Boolean).join("\n\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "ROLE",
    sourceId: role.id,
    sourceTitle: role.name,
    content,
    metadata: { workflowJobId: jobId },
    workflowJobId: jobId,
  });
}

async function handleGovernanceScoring(workspaceId: string) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await recordGovernanceScore(workspaceId, thirtyDaysAgo, now);
}

async function handleCalendarSync(jobId: string, payload: { connectionId?: string }, workspaceId: string) {
  if (!payload.connectionId) return;
  const connection = await prisma.oAuthConnection.findUnique({ where: { id: payload.connectionId } });
  if (!connection) return;

  const now = new Date();
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oneMonthAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  try {
    const events = await fetchCalendarEvents(connection.id, oneMonthAgo, oneMonthAhead);
    
    for (const event of events) {
      const sourceId = `calendar-${event.id}`;
      await syncKnowledgeForSource({
        workspaceId,
        sourceType: "MEETING",
        sourceId,
        sourceTitle: event.title,
        content: [event.title, event.description].filter(Boolean).join("\n\n"),
        metadata: {
          connectionId: connection.id,
          recordedAt: event.startTime.toISOString(),
          attendees: event.attendees,
          workflowJobId: jobId,
        },
        workflowJobId: jobId,
      });
    }
  } catch (error) {
    console.warn("Calendar sync failed:", error);
    throw error;
  }
}

async function handleJob(job: ClaimedJob) {
  if (!job.workspaceId) {
    return;
  }

  const payload = job.payload as Record<string, unknown>;

  if (job.type === "knowledge.sync.proposal") {
    await handleKnowledgeSync(job.id, payload as { proposalId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "knowledge.sync.meeting") {
    await handleMeetingKnowledgeSync(job.id, payload as { meetingId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "knowledge.sync.document") {
    await handleDocumentKnowledgeSync(job.id, payload as { documentId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "knowledge.sync.brain-article") {
    const articleId = (payload as { articleId?: string }).articleId;
    if (articleId) {
      await syncBrainArticleKnowledge({ workspaceId: job.workspaceId, articleId });
    }
    return;
  }

  if (job.type === "knowledge.sync.event") {
    await handleEventKnowledgeSync(job.id, payload as { eventId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "data-source.sync") {
    const { syncExternalDataSource } = await import("@corgtex/connectors-sql");
    await syncExternalDataSource((payload as { sourceId: string }).sourceId);
    return;
  }

  if (job.type === "knowledge.sync.tension") {
    await handleTensionKnowledgeSync(job.id, payload as { tensionId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "knowledge.sync.action") {
    await handleActionKnowledgeSync(job.id, payload as { actionId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "knowledge.sync.circle") {
    await handleCircleKnowledgeSync(job.id, payload as { circleId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "knowledge.sync.role") {
    await handleRoleKnowledgeSync(job.id, payload as { roleId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "governance.score") {
    await handleGovernanceScoring(job.workspaceId);
    return;
  }

  if (job.type === "calendar.sync") {
    await handleCalendarSync(job.id, payload as { connectionId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "webhook.deliver") {
    const deliveryId = (payload as { deliveryId?: string }).deliveryId;
    if (deliveryId) {
      await deliverWebhook(deliveryId);
    }
    return;
  }

  if (job.type === "agent.inbox-triage") {
    const result = await runAgentWorkflowJob(job);
    if (result && typeof result === "object" && "skipped" in result && result.reason === "concurrency_limit") {
      throw new RetryableWorkflowJobError("Agent concurrency limit reached.");
    }
    return;
  }

  if (job.type === "brain.daily-digest") {
    const dateISO = (payload as { dateISO?: string }).dateISO;
    if (dateISO && job.workspaceId) {
      await runDailyDigest({ workspaceId: job.workspaceId, workflowJobId: job.id, dateISO });
    }
    return;
  }

  if (job.type.startsWith("agent.")) {
    const result = await runAgentWorkflowJob(job);
    if (result && typeof result === "object" && "skipped" in result && result.reason === "concurrency_limit") {
      throw new RetryableWorkflowJobError("Agent concurrency limit reached.");
    }
  }
}

export async function dispatchPendingEvents(workerId: string, batchSize = DEFAULT_BATCH_SIZE) {
  const events = await claimPendingEvents(workerId, batchSize);

  for (const event of events) {
    try {
      await prisma.$transaction(async (tx) => {
        const derivedJobs = deriveJobsForEvent(event);
        for (const job of derivedJobs) {
          let dependsOnJobId: string | null = null;
          if (job.dependsOnDedupeKey) {
            dependsOnJobId = await resolveDedupeKeyToJobId(tx, job.dependsOnDedupeKey);
          }
          await enqueueJob(tx, { ...job, dependsOnJobId });
        }

        await createNotificationsForEvent(tx, event);

        // Fan out webhook deliveries for active endpoints
        if (event.workspaceId) {
          const deliveries = await createWebhookDeliveries({
            workspaceId: event.workspaceId,
            eventId: event.id,
            eventType: event.type,
            payload: {
              eventId: event.id,
              eventType: event.type,
              workspaceId: event.workspaceId,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              payload: event.payload as Record<string, unknown>,
              createdAt: event.createdAt.toISOString(),
            },
          });

          for (const delivery of deliveries) {
            await enqueueJob(tx, {
              workspaceId: event.workspaceId,
              eventId: event.id,
              type: "webhook.deliver",
              payload: { deliveryId: delivery.id },
              dedupeKey: `${event.id}:webhook:${delivery.id}`,
            });
          }
        }

        await tx.event.update({
          where: { id: event.id },
          data: {
            status: "DISPATCHED",
            dispatchedAt: new Date(),
            error: null,
            lockedAt: null,
            lockedBy: null,
          },
        });
      });
    } catch (error) {
      await failEvent(event, error);
    }
  }

  return events.length;
}

export async function runPendingJobs(workerId: string, batchSize = DEFAULT_BATCH_SIZE) {
  const jobs = await claimPendingJobs(workerId, batchSize);

  for (const job of jobs) {
    try {
      await handleJob(job);
      await completeJob(job.id);
    } catch (error) {
      await failJob(job, error);
    }
  }

  return jobs.length;
}

export async function schedulePeriodicJobs() {
  const now = new Date();
  
  const sources = await prisma.externalDataSource.findMany({
    where: { isActive: true },
    select: { id: true, workspaceId: true, pullCadenceMinutes: true, lastSyncAt: true }
  });

  let scheduledCount = 0;

  await prisma.$transaction(async (tx) => {
    for (const source of sources) {
      if (!source.lastSyncAt || (now.getTime() - source.lastSyncAt.getTime()) / 60000 >= source.pullCadenceMinutes) {
        const dedupeKey = `sync-${source.id}-${Math.floor(now.getTime() / (source.pullCadenceMinutes * 60000))}`;
        await enqueueJob(tx, {
          workspaceId: source.workspaceId,
          eventId: `schedule-${now.getTime()}`,
          type: "data-source.sync",
          payload: { sourceId: source.id },
          dedupeKey,
        });
        scheduledCount++;
      }
    }
  });

  return scheduledCount;
}

export async function scheduleDailyJobs() {
  const now = new Date();
  const currentHourUTC = now.getUTCHours();
  
  if (currentHourUTC !== 11) {
    return 0; // Only run at 11:00 UTC
  }

  const todayISO = now.toISOString().split("T")[0];
  let scheduledCount = 0;

  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  const { isAgentEnabled } = await import("@corgtex/domain");
  const enabledWorkspaces: typeof workspaces = [];

  for (const workspace of workspaces) {
    const enabled = await isAgentEnabled(workspace.id, "daily-digest");
    if (enabled) {
      enabledWorkspaces.push(workspace);
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const workspace of enabledWorkspaces) {
      const eventId = `cron-${now.getTime()}`;
      await enqueueJob(tx, {
        workspaceId: workspace.id,
        eventId,
        type: "brain.daily-digest",
        payload: { dateISO: now.toISOString() },
        dedupeKey: `${workspace.id}:daily-digest:${todayISO}`,
      });
      scheduledCount++;
    }
  });

  return scheduledCount;
}
