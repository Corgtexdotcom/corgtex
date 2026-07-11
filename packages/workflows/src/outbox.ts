import type { EventStatus, NewspaperCadence, Prisma, WorkflowJobStatus } from "@prisma/client";
import { logger, prisma } from "@corgtex/shared";
import { deriveJobsForEvent } from "./derive-jobs";
import { deriveNotificationsForEvent } from "./derive-notifications";
import { recordWorkflowJobProcessedMetric } from "./job-metrics";
import { handleKnowledgeSync, handleMeetingKnowledgeSync, handleDocumentKnowledgeSync, handleExternalResourceKnowledgeSync, handleExternalContentKnowledgeSync, handleEventKnowledgeSync, handleTensionKnowledgeSync, handleActionKnowledgeSync, handleCircleKnowledgeSync, handleRoleKnowledgeSync, handleSlackMessageKnowledgeSync, handleCalendarSync, handleOAuthDocumentsSync, handleOAuthEmailSync, handleContextGraphSync, handleContextGraphStalenessSweep, handleContextGraphReconcile } from "./handlers";
import { handleGovernanceScoring } from "./handlers";
import { runAgentWorkflowJob } from "./handlers";
import { syncBrainArticleKnowledge } from "@corgtex/knowledge";

import { runDailyDigest, runSlackAgent, runSlackContextSummary, runSlackProactiveScan, sendDemoWelcomeNewspaper } from "@corgtex/agents";
import {
  createWebhookDeliveries,
  captureReferencesForSource,
  CONTROL_PLANE_CLIENT_MIGRATION_VERIFY_JOB_TYPE,
  ENTERPRISE_APP_HEALTH_CHECK_JOB_TYPE,
  CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE,
  CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE,
  deliverWebhook,
  postMeetingSummaryToAgendaThread,
  processSlackInboundEvent,
  purgeExpiredCommunicationMessages,
  reconcileMeetingRecorders,
  syncRecorderCalendarSource,
  runMeetingAgendaPreparation,
  ensureMeetingSeriesOccurrences,
  runMeetingAgendaThreadEdit,
  runMeetingInsightsExtraction,
  runControlPlaneFleetSnapshotJob,
  runControlPlaneClientMigrationWorkerVerificationJob,
  runControlPlaneReleaseDeployJob,
  syncSlackPublicArchiveForWorkspace,
  reportPendingAiUsageToStripe,
  createRoleOnboardingIntro,
  runEnterpriseAppHealthCheckJob,
  resolveAdviceRequestRecipientUsers,
  resolveAdviceRequestRequesterUsers,
  runAdviceRequestReminderJob,
  markMeetingTranscriptProcessingReady,
  MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE,
  meetingIdFromWorkflowJobPayload,
  meetingTranscriptProcessingStageForJobType,
  recordMeetingTranscriptProcessingStage,
  runMeetingAudioAssetTranscription,
  type ControlPlaneReleaseTarget,
  type SlackAgentJobPayload,
} from "@corgtex/domain";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_JOB_CONCURRENCY = 5;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;
const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const TRIAGE_COALESCE_WINDOW_MS = 5 * 60 * 1_000;
const MEETING_RECORDER_RECONCILE_INTERVAL_MS = 10 * 60 * 1_000;
const TRIAGE_EVENT_TYPES = new Set([
  "proposal.submitted",
  "meeting.created",
  "meeting.transcript-uploaded",
  "action.created",
  "tension.created",
  "checkin.response_received",
]);

const KNOWLEDGE_PULSE_EVENT_TYPES = new Set([
  "proposal.submitted",
  "proposal.approved",
  "document.created",
  "meeting.created",
  "meeting.transcript-uploaded",
  "approval.finalized",
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

type EnqueueJobParams = {
  workspaceId?: string | null;
  eventId?: string | null;
  type: string;
  payload: Prisma.InputJsonObject;
  dedupeKey: string;
  dependsOnJobId?: string | null;
};

function releaseTargetFromPayload(value: unknown): ControlPlaneReleaseTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (typeof target.releaseImageTag !== "string" || typeof target.webImage !== "string" || typeof target.workerImage !== "string") {
    return null;
  }
  return {
    cloudProvider: target.cloudProvider === "AZURE" ? "AZURE" : "RAILWAY",
    releaseImageTag: target.releaseImageTag,
    releaseVersion: typeof target.releaseVersion === "string" ? target.releaseVersion : null,
    releaseGitSha: typeof target.releaseGitSha === "string" ? target.releaseGitSha : null,
    webImage: target.webImage,
    workerImage: target.workerImage,
    webRevision: typeof target.webRevision === "string" ? target.webRevision : null,
    workerRevision: typeof target.workerRevision === "string" ? target.workerRevision : null,
    migrationJobStatus: typeof target.migrationJobStatus === "string" ? target.migrationJobStatus : null,
    healthStatus: typeof target.healthStatus === "string" ? target.healthStatus : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSlackInvalidAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const dataError = isRecord(error) && isRecord(error.data) && typeof error.data.error === "string"
    ? error.data.error
    : "";
  return message.includes("invalid_auth") || dataError === "invalid_auth";
}

function meetingProgressContextForJob(job: ClaimedJob) {
  if (!job.workspaceId) return null;
  const meetingId = meetingIdFromWorkflowJobPayload(job.payload);
  if (!meetingId) return null;
  const stage = meetingTranscriptProcessingStageForJobType(job.type);
  if (!stage) return null;
  return {
    workspaceId: job.workspaceId,
    meetingId,
    stage,
  };
}

function resultWasSkipped(result: unknown) {
  return isRecord(result) && result.skipped === true;
}

async function recordMeetingProgressForJob(
  job: ClaimedJob,
  status: "ACTIVE" | "COMPLETED" | "FAILED" | "SKIPPED",
  opts?: { error?: unknown },
) {
  const context = meetingProgressContextForJob(job);
  if (!context) return;

  if (context.stage === "INDEXING_BRAIN" && status === "COMPLETED") {
    await markMeetingTranscriptProcessingReady({
      workspaceId: context.workspaceId,
      meetingId: context.meetingId,
      workflowJobId: job.id,
      workflowJobType: job.type,
      attempts: job.attempts,
    });
    return;
  }

  await recordMeetingTranscriptProcessingStage({
    workspaceId: context.workspaceId,
    meetingId: context.meetingId,
    stage: context.stage,
    status,
    workflowJobId: job.id,
    workflowJobType: job.type,
    workflowJobStatus: status === "ACTIVE" ? "RUNNING" : status === "FAILED" ? "FAILED" : "COMPLETED",
    attempts: job.attempts,
    error: opts?.error,
  });
}

async function markSlackProactiveScanReauthRequired(job: ClaimedJob, installationId: string, error: unknown) {
  if (!job.workspaceId || !isSlackInvalidAuthError(error)) return false;

  const result = await prisma.communicationInstallation.updateMany({
    where: {
      id: installationId,
      workspaceId: job.workspaceId,
      provider: "SLACK",
    },
    data: {
      status: "ERROR",
      disconnectedAt: new Date(),
      lastError: "invalid_auth",
    },
  });

  return result.count > 0;
}

class RetryableWorkflowJobError extends Error {}

function toWorkflowJobCreateInput(params: EnqueueJobParams): Prisma.WorkflowJobCreateManyInput {
  return {
    workspaceId: params.workspaceId ?? null,
    eventId: params.eventId ?? null,
    type: params.type,
    payload: params.payload,
    dedupeKey: params.dedupeKey,
    dependsOnJobId: params.dependsOnJobId ?? null,
  };
}

export async function enqueueJob(tx: Prisma.TransactionClient, params: EnqueueJobParams) {
  await tx.workflowJob.upsert({
    where: { dedupeKey: params.dedupeKey },
    update: {},
    create: toWorkflowJobCreateInput(params),
  });
}

async function enqueueJobBatch(tx: Prisma.TransactionClient, jobs: EnqueueJobParams[]) {
  if (jobs.length === 0) {
    return 0;
  }

  const result = await tx.workflowJob.createMany({
    data: jobs.map(toWorkflowJobCreateInput),
    skipDuplicates: true,
  });

  return result.count;
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

function readNewspaperCadence(value: unknown): NewspaperCadence {
  if (value === "DAILY" || value === "WEEKLY" || value === "OFF") {
    return value;
  }
  return "WEEKLY";
}

const TARGETED_ADVICE_NOTIFICATION_EVENTS = new Set([
  "advice.requested",
  "advice.reminder_due",
  "advice.reply_posted",
]);

function subjectEntityType(value: unknown) {
  if (value === "PROPOSAL") return "Proposal";
  if (value === "TENSION") return "Tension";
  if (value === "ACTION") return "Action";
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

export function deriveAdviceNotificationContent(event: { type: string; payload: unknown }) {
  const payload = isRecord(event.payload) ? event.payload : {};
  const subjectTitle = typeof payload.subjectTitle === "string" && payload.subjectTitle.trim().length > 0
    ? payload.subjectTitle.trim()
    : null;
  const messageMd = typeof payload.messageMd === "string" && payload.messageMd.trim().length > 0
    ? payload.messageMd.trim()
    : null;
  const deadlineAt = typeof payload.deadlineAt === "string" && payload.deadlineAt.trim().length > 0
    ? payload.deadlineAt.trim()
    : null;
  const subjectType = subjectEntityType(payload.subjectType ?? payload.parentType);
  const subjectId = typeof payload.subjectId === "string" && payload.subjectId.trim().length > 0
    ? payload.subjectId.trim()
    : typeof payload.parentId === "string" && payload.parentId.trim().length > 0
      ? payload.parentId.trim()
      : null;
  const deadlineLine = deadlineAt ? `Deadline: ${deadlineAt}` : null;

  if (event.type === "advice.reminder_due") {
    return {
      entityType: subjectType,
      entityId: subjectId,
      title: subjectTitle ? `Reminder: input requested for ${subjectTitle}` : "Reminder: input requested",
      bodyMd: [messageMd ?? "Your input is still requested.", deadlineLine].filter(Boolean).join("\n\n") || null,
    };
  }

  if (event.type === "advice.reply_posted") {
    return {
      entityType: subjectType,
      entityId: subjectId,
      title: subjectTitle ? `Input received for ${subjectTitle}` : "Input received",
      bodyMd: "Someone replied to an input request you own.",
    };
  }

  return {
    entityType: subjectType,
    entityId: subjectId,
    title: subjectTitle ? `Input requested: ${subjectTitle}` : "Input requested",
    bodyMd: [messageMd, deadlineLine].filter(Boolean).join("\n\n") || "Your input was requested.",
  };
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

async function createAdviceNotificationsForEvent(tx: Prisma.TransactionClient, event: ClaimedEvent) {
  if (!event.workspaceId || !TARGETED_ADVICE_NOTIFICATION_EVENTS.has(event.type)) {
    return false;
  }

  const payload = isRecord(event.payload) ? event.payload : {};
  const adviceRequestId = typeof payload.adviceRequestId === "string" && payload.adviceRequestId.trim().length > 0
    ? payload.adviceRequestId.trim()
    : event.aggregateType === "AdviceRequest" && event.aggregateId
      ? event.aggregateId
      : null;
  if (!adviceRequestId) {
    return true;
  }

  const excludeUserIds = new Set<string>();
  const requestedByUserId = typeof payload.requestedByUserId === "string" ? payload.requestedByUserId : null;
  const authorUserId = typeof payload.authorUserId === "string" ? payload.authorUserId : null;
  if (event.type === "advice.reply_posted") {
    if (authorUserId) excludeUserIds.add(authorUserId);
  } else if (requestedByUserId) {
    excludeUserIds.add(requestedByUserId);
  }

  const targets = event.type === "advice.reply_posted"
    ? await resolveAdviceRequestRequesterUsers(tx, {
      workspaceId: event.workspaceId,
      adviceRequestId,
      excludeUserIds: Array.from(excludeUserIds),
    })
    : await resolveAdviceRequestRecipientUsers(tx, {
      workspaceId: event.workspaceId,
      adviceRequestId,
      excludeUserIds: Array.from(excludeUserIds),
    });

  if (targets.length === 0) {
    return true;
  }

  const notification = deriveAdviceNotificationContent(event);
  await tx.notification.createMany({
    data: targets.map((target) => ({
      workspaceId: event.workspaceId as string,
      userId: target.userId,
      type: event.type,
      entityType: notification.entityType,
      entityId: notification.entityId,
      title: notification.title,
      bodyMd: notification.bodyMd,
    })),
  });

  return true;
}

async function createNotificationsForEvent(tx: Prisma.TransactionClient, event: ClaimedEvent) {
  if (!event.workspaceId) {
    return;
  }

  if (await createAdviceNotificationsForEvent(tx, event)) {
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

function normalizeJobConcurrency(concurrency: number, jobCount: number) {
  if (jobCount <= 0) return 0;
  if (!Number.isFinite(concurrency)) return Math.min(DEFAULT_JOB_CONCURRENCY, jobCount);
  return Math.min(Math.max(1, Math.floor(concurrency)), jobCount);
}

async function runWithBoundedConcurrency<T>(
  items: T[],
  concurrency: number,
  processItem: (item: T) => Promise<void>,
) {
  const workerCount = normalizeJobConcurrency(concurrency, items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await processItem(item);
    }
  });

  const results = await Promise.allSettled(workers);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) {
    throw rejected.reason;
  }
}

async function scheduleRecurringRecorderCalendarSync(workspaceId: string, sourceId: string) {
  const runAfter = new Date(Date.now() + MEETING_RECORDER_RECONCILE_INTERVAL_MS);
  const dedupeBucket = Math.floor(runAfter.getTime() / MEETING_RECORDER_RECONCILE_INTERVAL_MS);
  await prisma.workflowJob.upsert({
    where: {
      dedupeKey: `meeting-recorders:calendar-sync:${sourceId}:${dedupeBucket}`,
    },
    update: {},
    create: {
      workspaceId,
      type: "meeting-recorders.calendar.sync",
      payload: { sourceId, reason: "recurring" },
      runAfter,
      dedupeKey: `meeting-recorders:calendar-sync:${sourceId}:${dedupeBucket}`,
    },
  });
}

async function handleJob(job: ClaimedJob) {
  const payload = job.payload as Record<string, unknown>;

  if (job.type === CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE) {
    await runControlPlaneFleetSnapshotJob({
      deploymentId: typeof payload.deploymentId === "string" ? payload.deploymentId : null,
      snapshotKinds: Array.isArray(payload.snapshotKinds) ? payload.snapshotKinds.filter((kind): kind is string => typeof kind === "string") : null,
      reason: typeof payload.reason === "string" ? payload.reason : null,
      limit: typeof payload.limit === "number" ? payload.limit : null,
      concurrency: typeof payload.concurrency === "number" ? payload.concurrency : null,
    });
    return;
  }

  if (job.type === CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE) {
    if (typeof payload.deploymentId !== "string") {
      throw new Error("Control Plane deploy-latest job is missing deploymentId.");
    }
    await runControlPlaneReleaseDeployJob({
      deploymentId: payload.deploymentId,
      reason: typeof payload.reason === "string" ? payload.reason : null,
      force: typeof payload.force === "boolean" ? payload.force : null,
      target: releaseTargetFromPayload(payload.target),
    });
    return;
  }

  if (job.type === CONTROL_PLANE_CLIENT_MIGRATION_VERIFY_JOB_TYPE) {
    if (typeof payload.migrationRunId !== "string") {
      throw new Error("Control Plane client migration verification job is missing migrationRunId.");
    }
    await runControlPlaneClientMigrationWorkerVerificationJob({
      migrationRunId: payload.migrationRunId,
      destinationDeploymentId: typeof payload.destinationDeploymentId === "string" ? payload.destinationDeploymentId : null,
      verificationSummary: payload.verificationSummary,
      idMaps: payload.idMaps,
      reason: typeof payload.reason === "string" ? payload.reason : null,
    });
    return;
  }

  if (job.type === ENTERPRISE_APP_HEALTH_CHECK_JOB_TYPE) {
    if (typeof payload.runtimeId !== "string") {
      throw new Error("Enterprise app health check job is missing runtimeId.");
    }
    await runEnterpriseAppHealthCheckJob({
      runtimeId: payload.runtimeId,
      reason: typeof payload.reason === "string" ? payload.reason : null,
    });
    return;
  }

  if (!job.workspaceId) {
    if (job.type === "billing.ai-usage.report") {
      await reportPendingAiUsageToStripe({ limit: typeof payload.limit === "number" ? payload.limit : undefined });
    }
    return;
  }

  if (job.type === "billing.ai-usage.report") {
    await reportPendingAiUsageToStripe({ limit: typeof payload.limit === "number" ? payload.limit : undefined });
    return;
  }

  if (job.type === "advice.request.reminder") {
    const adviceRequestId = (payload as { adviceRequestId?: string }).adviceRequestId;
    if (!adviceRequestId) {
      throw new Error("Advice reminder job is missing adviceRequestId.");
    }
    await runAdviceRequestReminderJob({
      workspaceId: job.workspaceId,
      adviceRequestId,
    });
    return;
  }

  if (job.type === "knowledge.sync.proposal") {
    await handleKnowledgeSync(job.id, payload as { proposalId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "knowledge.sync.meeting") {
    return handleMeetingKnowledgeSync(job.id, payload as { meetingId?: string }, job.workspaceId);
  }

  if (job.type === "knowledge.sync.document") {
    await handleDocumentKnowledgeSync(job.id, payload as { documentId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "knowledge.sync.external-resource") {
    await handleExternalResourceKnowledgeSync(job.id, payload as { resourceId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "knowledge.sync.external-content") {
    await handleExternalContentKnowledgeSync(job.id, payload as { sourceId?: string }, job.workspaceId);
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

  if (job.type === "knowledge.sync.slack-message") {
    await handleSlackMessageKnowledgeSync(job.id, payload as { messageId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "context-graph.sync") {
    await handleContextGraphSync(job.id, payload as { sourceType?: string; sourceId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "context-graph.staleness-sweep") {
    await handleContextGraphStalenessSweep(job.id, payload as { staleAfterDays?: number }, job.workspaceId);
    return;
  }

  if (job.type === "context-graph.reconcile") {
    await handleContextGraphReconcile(job.id, payload as { dateISO?: string }, job.workspaceId);
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

  if (job.type === "oauth.documents.sync") {
    await handleOAuthDocumentsSync(job.id, payload as { connectionId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "oauth.email.sync") {
    await handleOAuthEmailSync(job.id, payload as { connectionId?: string }, job.workspaceId);
    return;
  }

  if (job.type === "meeting-recorders.reconcile") {
    await reconcileMeetingRecorders(job.workspaceId);
    const runAfter = new Date(Date.now() + MEETING_RECORDER_RECONCILE_INTERVAL_MS);
    await prisma.workflowJob.upsert({
      where: {
        dedupeKey: `meeting-recorders:reconcile:${job.workspaceId}:${Math.floor(runAfter.getTime() / MEETING_RECORDER_RECONCILE_INTERVAL_MS)}`,
      },
      update: {},
      create: {
        workspaceId: job.workspaceId,
        type: "meeting-recorders.reconcile",
        payload: {},
        runAfter,
        dedupeKey: `meeting-recorders:reconcile:${job.workspaceId}:${Math.floor(runAfter.getTime() / MEETING_RECORDER_RECONCILE_INTERVAL_MS)}`,
      },
    });
    return;
  }

  if (job.type === "meeting-recorders.calendar.sync") {
    const sourceId = (payload as { sourceId?: string }).sourceId;
    if (sourceId) {
      let result: Awaited<ReturnType<typeof syncRecorderCalendarSource>>;
      try {
        result = await syncRecorderCalendarSource({
          workspaceId: job.workspaceId,
          sourceId,
          workflowJobId: job.id,
        });
      } catch (error) {
        await scheduleRecurringRecorderCalendarSync(job.workspaceId, sourceId);
        throw error;
      }
      if (result.action === "skipped" && result.reason === "source_unavailable") {
        return;
      }
      await scheduleRecurringRecorderCalendarSync(job.workspaceId, sourceId);
    }
    return;
  }

  if (job.type === "meeting.agenda.prepare") {
    const targetDateISO = (payload as { targetDateISO?: string }).targetDateISO;
    await runMeetingAgendaPreparation({
      workspaceId: job.workspaceId,
      workflowJobId: job.id,
      targetDateISO,
    });
    return;
  }

  if (job.type === "meeting.series.materialize") {
    await ensureMeetingSeriesOccurrences({
      workspaceId: job.workspaceId,
      reason: typeof payload.reason === "string" ? payload.reason : "workflow-job",
    });
    return;
  }

  if (job.type === "meeting.insights.extract") {
    const meetingId = (payload as { meetingId?: string }).meetingId;
    if (meetingId) {
      return runMeetingInsightsExtraction({ workspaceId: job.workspaceId, meetingId, workflowJobId: job.id });
    }
    return;
  }

  if (job.type === "meeting.agenda.edit") {
    const editPayload = payload as {
      meetingId?: string;
      actorUserId?: string;
      installationId?: string;
      channelId?: string;
      threadTs?: string;
      messageTs?: string;
      messageText?: string;
    };
    if (
      editPayload.meetingId
      && editPayload.actorUserId
      && editPayload.installationId
      && editPayload.channelId
      && editPayload.threadTs
      && editPayload.messageTs
      && editPayload.messageText
    ) {
      await runMeetingAgendaThreadEdit({
        workspaceId: job.workspaceId,
        workflowJobId: job.id,
        meetingId: editPayload.meetingId,
        actorUserId: editPayload.actorUserId,
        installationId: editPayload.installationId,
        channelId: editPayload.channelId,
        threadTs: editPayload.threadTs,
        messageTs: editPayload.messageTs,
        messageText: editPayload.messageText,
      });
    }
    return;
  }

  if (job.type === "meeting.summary.post") {
    const meetingId = (payload as { meetingId?: string }).meetingId;
    if (meetingId) {
      return postMeetingSummaryToAgendaThread({ workspaceId: job.workspaceId, meetingId });
    }
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

  if (job.type === "communication.slack.public-archive") {
    await syncSlackPublicArchiveForWorkspace(job.workspaceId);
    return;
  }

  if (job.type === "communication.slack.context-summary") {
    const summaryPayload = payload as {
      installationId?: string;
      channelId?: string;
      threadTs?: string | null;
      dayISO?: string;
    };
    if (summaryPayload.installationId && summaryPayload.channelId && summaryPayload.dayISO) {
      await runSlackContextSummary({
        workspaceId: job.workspaceId,
        workflowJobId: job.id,
        installationId: summaryPayload.installationId,
        channelId: summaryPayload.channelId,
        threadTs: summaryPayload.threadTs ?? null,
        dayISO: summaryPayload.dayISO,
      });
    }
    return;
  }

  if (job.type === "external-resource.capture-source") {
    const capturePayload = payload as { sourceType?: string; sourceId?: string };
    if (capturePayload.sourceType && capturePayload.sourceId) {
      await captureReferencesForSource(capturePayload.sourceType, capturePayload.sourceId);
    }
    return;
  }

  if (job.type === MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE) {
    const audioAssetId = (payload as { audioAssetId?: string }).audioAssetId;
    if (audioAssetId) {
      await runMeetingAudioAssetTranscription({
        workspaceId: job.workspaceId,
        audioAssetId,
        workflowJobId: job.id,
      });
    }
    return;
  }

  if (job.type === "communication.slack.proactive-scan") {
    const proactivePayload = payload as { installationId?: string };
    if (proactivePayload.installationId) {
      try {
        await runSlackProactiveScan({
          workspaceId: job.workspaceId,
          workflowJobId: job.id,
          installationId: proactivePayload.installationId,
        });
      } catch (error) {
        if (await markSlackProactiveScanReauthRequired(job, proactivePayload.installationId, error)) {
          return;
        }
        throw error;
      }
    }
    return;
  }

  if (job.type === "agent.inbox-triage") {
    const result = await runAgentWorkflowJob(job);
    if (result && typeof result === "object" && "skipped" in result && result.reason === "concurrency_limit") {
      throw new RetryableWorkflowJobError("Agent concurrency limit reached.");
    }
    return result;
  }

  if (job.type === "agent.role-onboarding-intro") {
    const onboardingSessionId = (payload as { onboardingSessionId?: string }).onboardingSessionId;
    if (onboardingSessionId) {
      await createRoleOnboardingIntro({
        workspaceId: job.workspaceId,
        onboardingSessionId,
      });
    }
    return;
  }

  if (job.type === "brain.daily-digest") {
    const dateISO = (payload as { dateISO?: string }).dateISO;
    const dateKey = (payload as { dateKey?: string }).dateKey;
    if (dateISO && job.workspaceId) {
      await runDailyDigest({
        workspaceId: job.workspaceId,
        workflowJobId: job.id,
        dateISO,
        dateKey,
        cadence: readNewspaperCadence(payload.cadence),
      });
    }
    return;
  }

  if (job.type === "email.demo-welcome-newspaper") {
    const demoLeadId = (payload as { demoLeadId?: string }).demoLeadId;
    if (demoLeadId && job.workspaceId) {
      await sendDemoWelcomeNewspaper({
        workspaceId: job.workspaceId,
        demoLeadId,
        workflowJobId: job.id,
      });
    }
    return;
  }

  if (job.type.startsWith("agent.")) {
    const result = await runAgentWorkflowJob(job);
    if (result && typeof result === "object" && "skipped" in result && result.reason === "concurrency_limit") {
      throw new RetryableWorkflowJobError("Agent concurrency limit reached.");
    }
    return result;
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
          const deliveries = await createWebhookDeliveries(tx, {
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

async function processClaimedJob(workerId: string, job: ClaimedJob) {
  const startedAt = Date.now();
  let failed = false;
  let failure: unknown = null;
  try {
    await recordMeetingProgressForJob(job, "ACTIVE");
    const result = await handleJob(job);
    await recordMeetingProgressForJob(job, resultWasSkipped(result) ? "SKIPPED" : "COMPLETED");
    await completeJob(job.id);
  } catch (error) {
    failed = true;
    failure = error;
    if (job.attempts >= MAX_ATTEMPTS) {
      await recordMeetingProgressForJob(job, "FAILED", { error });
    }
    await failJob(job, error);
  }

  // Emit per-job timing outside the try/catch so a logging error can never be
  // mistaken for a job failure (and a completed job re-marked as failed).
  const durationMs = Date.now() - startedAt;
  const outcome = failed ? "failed" : "completed";
  recordWorkflowJobProcessedMetric({
    type: job.type,
    outcome,
    durationMs,
  });

  const fields = {
    workerId,
    jobId: job.id,
    type: job.type,
    workspaceId: job.workspaceId,
    attempts: job.attempts,
    durationMs,
  };
  if (failed) {
    logger.warn("workflow_job_processed", {
      ...fields,
      outcome,
      error: failure instanceof Error ? failure.message : "Unknown worker error.",
    });
  } else {
    logger.info("workflow_job_processed", { ...fields, outcome });
  }
}

export async function runPendingJobs(workerId: string, batchSize = DEFAULT_BATCH_SIZE, concurrency = DEFAULT_JOB_CONCURRENCY) {
  const jobs = await claimPendingJobs(workerId, batchSize);
  await runWithBoundedConcurrency(jobs, concurrency, (job) => processClaimedJob(workerId, job));
  return jobs.length;
}

export async function scheduleDripCampaigns() {
  if (process.env.CRM_DRIP_ENABLED !== "true") {
    return 0;
  }

  const now = new Date();
  const currentHourUTC = now.getUTCHours();

  if (currentHourUTC !== 10) {
    return 0; // Only run at 10:00 UTC
  }

  const todayISO = now.toISOString().split("T")[0];
  let scheduledCount = 0;

  const dripIntervalDays = Number(process.env.CRM_DRIP_INTERVAL_DAYS || "3");
  const maxFollowUps = Number(process.env.CRM_DRIP_MAX_FOLLOWUPS || "3");

  const targetDate = new Date(now);
  targetDate.setDate(targetDate.getDate() - dripIntervalDays);

  const pendingLeads = await prisma.demoLead.findMany({
    where: {
      convertedAt: null,
      followUpCount: { lt: maxFollowUps },
      OR: [
        {
          lastFollowUpAt: { lte: targetDate },
        },
        {
          lastFollowUpAt: null,
          createdAt: { lte: targetDate },
        }
      ]
    },
    select: { id: true, workspaceId: true, followUpCount: true },
  });

  await prisma.$transaction(async (tx) => {
    for (const lead of pendingLeads) {
      await enqueueJob(tx, {
        workspaceId: lead.workspaceId,
        eventId: null,
        type: "agent.crm-drip-followup",
        payload: {
          demoLeadId: lead.id,
          followUpNumber: lead.followUpCount + 1,
        },
        dedupeKey: `${lead.workspaceId}:drip:${lead.id}:${todayISO}`,
      });
      scheduledCount++;
    }
  });

  return scheduledCount;
}

export async function schedulePeriodicJobs() {
  const now = new Date();
  
  const fleetSweepBatchSizeRaw = Number(process.env.CONTROL_PLANE_FLEET_SWEEP_BATCH_SIZE ?? 50);
  const fleetSweepBatchSize = Math.min(Math.max(Number.isFinite(fleetSweepBatchSizeRaw) ? fleetSweepBatchSizeRaw : 50, 1), 500);
  const appHealthBatchSizeRaw = Number(process.env.ENTERPRISE_APP_HEALTH_SWEEP_BATCH_SIZE ?? 100);
  const appHealthBatchSize = Math.min(Math.max(Number.isFinite(appHealthBatchSizeRaw) ? appHealthBatchSizeRaw : 100, 1), 500);
  const appHealthIntervalMinutesRaw = Number(process.env.ENTERPRISE_APP_HEALTH_SWEEP_INTERVAL_MINUTES ?? 15);
  const appHealthIntervalMinutes = Math.min(Math.max(Number.isFinite(appHealthIntervalMinutesRaw) ? appHealthIntervalMinutesRaw : 15, 5), 240);
  const aiUsageLedgerEntryDelegate = (prisma as typeof prisma & { aiUsageLedgerEntry?: typeof prisma.aiUsageLedgerEntry }).aiUsageLedgerEntry;
  const [sources, slackInstallations, customerDeployments, appRuntimes, pendingAiUsage] = await Promise.all([
    prisma.externalDataSource.findMany({
      where: { isActive: true },
      select: { id: true, workspaceId: true, pullCadenceMinutes: true, lastSyncAt: true }
    }),
    prisma.communicationInstallation.findMany({
      where: {
        provider: "SLACK",
        status: "ACTIVE",
        scopes: { has: "channels:history" },
      },
      select: { id: true, workspaceId: true },
    }),
    prisma.customerDeployment.findMany({
      where: {
        customerAccountId: { not: null },
        deploymentStatus: { notIn: ["RETIRED", "SUSPENDED"] },
      },
      orderBy: [
        { lastHealthCheck: "asc" },
        { createdAt: "asc" },
      ],
      take: fleetSweepBatchSize,
      select: { id: true },
    }),
    prisma.appRuntime.findMany({
      where: {
        status: { not: "DISABLED" },
        OR: [
          { healthUrl: { not: null } },
          { baseUrl: { not: null } },
        ],
      },
      orderBy: [
        { lastHealthAt: "asc" },
        { createdAt: "asc" },
      ],
      take: appHealthBatchSize,
      select: { id: true },
    }),
    aiUsageLedgerEntryDelegate
      ? aiUsageLedgerEntryDelegate.findMany({
          where: {
            status: "PENDING",
            workspace: {
              billingProfile: {
                is: {
                  billingStatus: "ACTIVE",
                  stripeSubscriptionItemId: { not: null },
                },
              },
            },
          },
          distinct: ["workspaceId"],
          take: 200,
          select: { workspaceId: true },
        })
      : Promise.resolve([]),
  ]);

  const jobs: EnqueueJobParams[] = [];

  for (const source of sources) {
    if (!source.lastSyncAt || (now.getTime() - source.lastSyncAt.getTime()) / 60000 >= source.pullCadenceMinutes) {
      const dedupeKey = `sync-${source.id}-${Math.floor(now.getTime() / (source.pullCadenceMinutes * 60000))}`;
      jobs.push({
        workspaceId: source.workspaceId,
        type: "data-source.sync",
        payload: { sourceId: source.id },
        dedupeKey,
      });
    }
  }

  const hourlyBucket = Math.floor(now.getTime() / (60 * 60 * 1000));
  const appHealthBucket = Math.floor(now.getTime() / (appHealthIntervalMinutes * 60 * 1000));
  for (const installation of slackInstallations) {
    jobs.push({
      workspaceId: installation.workspaceId,
      type: "communication.slack.proactive-scan",
      payload: { installationId: installation.id },
      dedupeKey: `${installation.id}:slack-proactive-scan:${hourlyBucket}`,
    });
  }

  for (const deployment of customerDeployments) {
    jobs.push({
      workspaceId: null,
      eventId: null,
      type: CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE,
      payload: {
        deploymentId: deployment.id,
        snapshotKinds: ["HEALTH", "RELEASE", "CONNECTOR", "CONTEXT", "INTEGRATION", "SUPPORT_READY"],
        reason: "Scheduled Control Plane fleet sweep.",
      },
      dedupeKey: `${deployment.id}:control-plane-fleet-snapshot:${hourlyBucket}`,
    });
  }

  for (const runtime of appRuntimes) {
    jobs.push({
      workspaceId: null,
      eventId: null,
      type: ENTERPRISE_APP_HEALTH_CHECK_JOB_TYPE,
      payload: {
        runtimeId: runtime.id,
        reason: "Scheduled enterprise app health sweep.",
      },
      dedupeKey: `${runtime.id}:enterprise-app-health:${appHealthBucket}`,
    });
  }

  if (pendingAiUsage.length > 0) {
    jobs.push({
      workspaceId: null,
      eventId: null,
      type: "billing.ai-usage.report",
      payload: { limit: 500 },
      dedupeKey: `billing:ai-usage-report:${hourlyBucket}`,
    });
  }

  await prisma.$transaction(async (tx) => {
    await enqueueJobBatch(tx, jobs);
  });

  return jobs.length;
}

export async function scheduleDailyJobs() {
  const now = new Date();
  const todayISO = now.toISOString().split("T")[0];
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  const recurringSeriesWorkspaces = await prisma.meetingSeries.findMany({
    where: {
      archivedAt: null,
      recurrenceRule: { not: null },
    },
    distinct: ["workspaceId"],
    select: { workspaceId: true },
  });
  const slackArchiveWorkspaces = await prisma.communicationInstallation.findMany({
    where: {
      provider: "SLACK",
      status: "ACTIVE",
      scopes: { has: "channels:history" },
    },
    distinct: ["workspaceId"],
    select: { workspaceId: true },
  });
  const {
    getNewspaperLocalDateParts,
    getWorkspaceDigestSettings,
    isHumanNewspaperRecipientIdentity,
    isNewspaperScheduleDue,
  } = await import("@corgtex/domain");
  const newspaperSchedules: Array<{
    workspaceId: string;
    cadence: Exclude<NewspaperCadence, "OFF">;
    dateKey: string;
    dedupeKey: string;
  }> = [];
  const isWeeklyWindow = now.getUTCDay() === 1;

  // Batched reads: one digest-settings lookup and one member lookup for all
  // workspaces, rather than three sequential queries per workspace. This scan
  // runs on worker ticks and checks each workspace's local newspaper window.
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const [digestSettings, activeMembers] = await Promise.all([
    getWorkspaceDigestSettings(workspaceIds),
    prisma.member.findMany({
      where: { workspaceId: { in: workspaceIds }, isActive: true },
      select: {
        workspaceId: true,
        kind: true,
        newspaperCadence: true,
        user: {
          select: {
            email: true,
            displayName: true,
          },
        },
      },
    }),
  ]);
  const membersByWorkspace = new Map<string, typeof activeMembers>();
  for (const member of activeMembers) {
    const existing = membersByWorkspace.get(member.workspaceId);
    if (existing) {
      existing.push(member);
    } else {
      membersByWorkspace.set(member.workspaceId, [member]);
    }
  }

  for (const workspace of workspaces) {
    const setting = digestSettings.get(workspace.id);
    if (!setting?.enabled) {
      logger.info("newspaper_schedule_skipped", {
        workspaceId: workspace.id,
        reason: setting?.disabledReason ?? "agent_disabled",
      });
      continue;
    }

    const workspaceCadence = setting.cadence;
    const workspaceMembers = (membersByWorkspace.get(workspace.id) ?? []).filter((member) => (
      isHumanNewspaperRecipientIdentity(member)
    ));
    const localDateKey = getNewspaperLocalDateParts(now, setting.timeZone).dateKey;

    const hasDailyRecipients = workspaceMembers.some((member) => (
      (member.newspaperCadence ?? workspaceCadence) === "DAILY"
    ));
    const hasWeeklyRecipients = workspaceMembers.some((member) => (
      (member.newspaperCadence ?? workspaceCadence) === "WEEKLY"
    ));

    if (hasDailyRecipients && isNewspaperScheduleDue({ now, schedule: setting, cadence: "DAILY" })) {
      newspaperSchedules.push({
        workspaceId: workspace.id,
        cadence: "DAILY",
        dateKey: localDateKey,
        dedupeKey: `${workspace.id}:daily-digest:${localDateKey}`,
      });
    } else {
      logger.info("newspaper_schedule_skipped", {
        workspaceId: workspace.id,
        cadence: "DAILY",
        reason: hasDailyRecipients ? "outside_schedule_window" : "no_daily_recipients",
      });
    }

    if (hasWeeklyRecipients && isNewspaperScheduleDue({ now, schedule: setting, cadence: "WEEKLY" })) {
      newspaperSchedules.push({
        workspaceId: workspace.id,
        cadence: "WEEKLY",
        dateKey: localDateKey,
        dedupeKey: `${workspace.id}:weekly-digest:${localDateKey}`,
      });
    } else if (isWeeklyWindow || hasWeeklyRecipients) {
      logger.info("newspaper_schedule_skipped", {
        workspaceId: workspace.id,
        cadence: "WEEKLY",
        reason: hasWeeklyRecipients ? "outside_schedule_window" : "no_weekly_recipients",
      });
    }
  }

  const jobs: EnqueueJobParams[] = [];

  for (const workspace of workspaces) {
    jobs.push({
      workspaceId: workspace.id,
      type: "context-graph.staleness-sweep",
      payload: {},
      dedupeKey: `${workspace.id}:context-graph-staleness:${todayISO}`,
    });

    if (isWeeklyWindow) {
      jobs.push({
        workspaceId: workspace.id,
        type: "context-graph.reconcile",
        payload: { dateISO: todayISO },
        dedupeKey: `${workspace.id}:context-graph-reconcile:${todayISO}`,
      });
    }

    jobs.push({
      workspaceId: workspace.id,
      type: "communication.raw-retention",
      payload: { dateISO: now.toISOString() },
      dedupeKey: `${workspace.id}:communication-retention:${todayISO}`,
    });
  }

  for (const seriesWorkspace of recurringSeriesWorkspaces) {
    jobs.push({
      workspaceId: seriesWorkspace.workspaceId,
      type: "meeting.series.materialize",
      payload: { reason: "daily-recurring-series-repair" },
      dedupeKey: `meeting-series-materialize:${seriesWorkspace.workspaceId}:${todayISO}`,
    });
  }

  for (const schedule of newspaperSchedules) {
    jobs.push({
      workspaceId: schedule.workspaceId,
      type: "brain.daily-digest",
      payload: { dateISO: now.toISOString(), dateKey: schedule.dateKey, cadence: schedule.cadence },
      dedupeKey: schedule.dedupeKey,
    });
    logger.info("newspaper_schedule_created", {
      workspaceId: schedule.workspaceId,
      cadence: schedule.cadence,
      dedupeKey: schedule.dedupeKey,
    });
  }

  for (const installation of slackArchiveWorkspaces) {
    jobs.push({
      workspaceId: installation.workspaceId,
      type: "communication.slack.public-archive",
      payload: { dateISO: now.toISOString() },
      dedupeKey: `${installation.workspaceId}:slack-public-archive:${todayISO}`,
    });
  }

  await prisma.$transaction(async (tx) => {
    await enqueueJobBatch(tx, jobs);
  });

  const scheduledCount = workspaces.length + newspaperSchedules.length + slackArchiveWorkspaces.length + recurringSeriesWorkspaces.length;
  return scheduledCount;
}
