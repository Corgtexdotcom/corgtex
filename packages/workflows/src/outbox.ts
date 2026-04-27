import type { EventStatus, Prisma, WorkflowJobStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { deriveJobsForEvent } from "./derive-jobs";
import { deriveNotificationsForEvent } from "./derive-notifications";
import { handleKnowledgeSync, handleMeetingKnowledgeSync, handleDocumentKnowledgeSync, handleEventKnowledgeSync, handleTensionKnowledgeSync, handleActionKnowledgeSync, handleCircleKnowledgeSync, handleRoleKnowledgeSync, handleCalendarSync } from "./handlers";
import { handleGovernanceScoring } from "./handlers";
import { runAgentWorkflowJob } from "./handlers";
import { syncBrainArticleKnowledge } from "@corgtex/knowledge";

import { runDailyDigest, runSlackAgent } from "@corgtex/agents";
import { createWebhookDeliveries, deliverWebhook, processSlackInboundEvent, purgeExpiredCommunicationMessages, type SlackAgentJobPayload } from "@corgtex/domain";

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

  if (job.type === "communication.slack.event") {
    const inboundEventId = (payload as { inboundEventId?: string }).inboundEventId;
    if (inboundEventId) {
      await processSlackInboundEvent(inboundEventId);
    }
    return;
  }

  if (job.type === "communication.slack.agent") {
    const slackPayload = payload as SlackAgentJobPayload;
    const result = await runSlackAgent({
      ...slackPayload,
      workspaceId: job.workspaceId,
      workflowJobId: job.id,
    });
    if (result && typeof result === "object" && "skipped" in result && result.reason === "concurrency_limit") {
      throw new RetryableWorkflowJobError("Agent concurrency limit reached.");
    }
    return;
  }

  if (job.type === "communication.raw-retention") {
    await purgeExpiredCommunicationMessages(job.workspaceId);
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
      await enqueueJob(tx, {
        workspaceId: workspace.id,
        eventId,
        type: "communication.raw-retention",
        payload: { dateISO: now.toISOString() },
        dedupeKey: `${workspace.id}:communication-retention:${todayISO}`,
      });
      scheduledCount++;
    }
  });

  return scheduledCount;
}
