import { BRAIN_MAINTENANCE_JOB, MaintenanceDeferred } from "./brain-maintenance-jobs";
import { registerClaimedMeetingTranscriptWorkflow, revokeMeetingTranscriptWorkflowClaim, type MeetingTranscriptWorkflowClaim } from "../../domain/src/native-meeting-workflow-claim";
import { captureCurrentAdviceNotification } from "./notification-event-lineage";
import { enqueueCrmLineageJob } from "./crm-job-lineage";
import type { EventStatus, NewspaperCadence, Prisma, WorkflowJobStatus } from "@prisma/client";
import { logger, prisma, type AppActor } from "@corgtex/shared";
import { withWorkspaceSupportExecution, withMcpConnectionExecution, withMeetingTranscriptWorker, isMeetingTranscriptWorkerJob } from "@corgtex/domain";
import { deriveJobsForEvent } from "./derive-jobs";
import { handleReleaseDiagnostic } from "./release-diagnostic-handler";
import { deriveDispatchNotifications } from "./derive-notifications";
import { createActionAssignmentNotification } from "./action-assignment-notifications";
import { recordWorkflowJobProcessedMetric } from "./job-metrics";
import { handleKnowledgeSync, handleMeetingKnowledgeSync, handleDocumentKnowledgeSync, handleExternalResourceKnowledgeSync, handleExternalContentKnowledgeSync, handleEventKnowledgeSync, handleTensionKnowledgeSync, handleActionKnowledgeSync, handleCircleKnowledgeSync, handleRoleKnowledgeSync, handleSlackMessageKnowledgeSync, handleCalendarSync, handleOAuthDocumentsSync, handleOAuthEmailSync, handleContextGraphSync, handleContextGraphStalenessSweep, handleContextGraphReconcile, handleSourceLineageRebuild } from "./handlers";
import { FINANCE_REPORT_IMPORT_EXTRACTION_JOB_TYPE, FINANCE_REPORT_IMPORT_PROPOSAL_JOB_TYPE, handleGovernanceScoring,
  runFinanceReportImportExtractionJob, runFinanceReportImportProposalJob } from "./handlers";
import { runAgentWorkflowJob } from "./handlers";
import { syncBrainArticleKnowledge } from "@corgtex/knowledge";

import { runDailyDigest, runSlackAgent, runSlackContextSummary, runSlackProactiveScan, sendDemoWelcomeNewspaper } from "@corgtex/agents";
import {
  createWebhookDeliveries,
  RELEASE_DIAGNOSTIC_JOB_TYPE,
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
  slackPublicArchiveEnabled,
  reportPendingAiUsageToStripe,
  createRoleOnboardingIntro,
  runEnterpriseAppHealthCheckJob,
  createNotificationIntent,
  deliverNotificationDelivery,
  NOTIFICATION_DELIVERY_JOB_TYPE,
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
  CRM_INQUIRY_ACKNOWLEDGEMENT_JOB_TYPE,
  sendCrmInquiryAcknowledgement,
} from "@corgtex/domain";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_JOB_CONCURRENCY = 5;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;
const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MEETING_RECORDER_RECONCILE_INTERVAL_MS = 10 * 60 * 1_000;

type ClaimedEvent = {
  mcpOrigin?: unknown;
  supportOriginUserId?: string | null;
  supportGrantVersion?: number | null;
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
  meetingClaim?: MeetingTranscriptWorkflowClaim;
  startedAt: Date;
  lockedBy: string;
  lockedAt: Date;
  mcpOrigin?: unknown;
  supportOriginUserId?: string | null;
  supportGrantVersion?: number | null;
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
  opts?: { error?: unknown; actor?: AppActor },
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
    workerActor: opts?.actor,
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
  const crm = await enqueueCrmLineageJob(tx, params);
  if (crm.handled) return { scheduled: crm.scheduled };
  await tx.workflowJob.upsert({
    where: { dedupeKey: params.dedupeKey },
    update: {},
    create: toWorkflowJobCreateInput(params),
  });
  return { scheduled: true };
}

async function enqueueJobBatch(tx: Prisma.TransactionClient, jobs: EnqueueJobParams[]) {
  if (jobs.length === 0) {
    return 0;
  }

  let scheduled = 0;
  const remaining: EnqueueJobParams[] = [];
  for (const job of jobs) {
    const crm = await enqueueCrmLineageJob(tx, job);
    if (crm.handled) scheduled += Number(crm.scheduled);
    else remaining.push(job);
  }
  if (!remaining.length) return scheduled;
  const result = await tx.workflowJob.createMany({
    data: remaining.map(toWorkflowJobCreateInput),
    skipDuplicates: true,
  });

  return scheduled + result.count;
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
          AND (
            (event.type IN ('brain-source.created', 'meeting.created', 'meeting.transcript-uploaded') AND event."availableAt" <= (NOW() AT TIME ZONE 'UTC'))
            OR (event.type NOT IN ('brain-source.created', 'meeting.created', 'meeting.transcript-uploaded') AND event."availableAt" <= NOW())
          )
          AND (event."lockedAt" IS NULL OR (
            (event.type IN ('meeting.created', 'meeting.transcript-uploaded')
              AND event."lockedAt" < (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes')
            OR (event.type NOT IN ('meeting.created', 'meeting.transcript-uploaded') AND event."lockedAt" < ${staleBefore})
          ))
          AND NOT EXISTS (
            SELECT 1 FROM "WorkspaceFeatureFlag" AS flag
            WHERE flag."workspaceId" = event."workspaceId"
              AND flag.flag = ${OPERATOR_IMPORT_INACTIVE_FLAG} AND flag.enabled = true
          )
        ORDER BY event."createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "Event" AS event
      SET
        "lockedAt" = CASE WHEN event.type IN ('meeting.created', 'meeting.transcript-uploaded')
          THEN (clock_timestamp() AT TIME ZONE 'UTC') ELSE NOW()::timestamp END,
        "lockedBy" = ${workerId},
        "attempts" = event."attempts" + 1,
        "error" = NULL
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING
        event.id,
        event."supportOriginUserId",
        event."mcpOrigin",
        event."supportGrantVersion",
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

  const captured = await captureCurrentAdviceNotification(tx, event);
  if (!captured) return true;
  const adviceRequestId = captured.adviceRequestId;
  const excludeUserIds = new Set<string>();
  if (event.type === "advice.reply_posted") {
    if (captured.authorUserId) excludeUserIds.add(captured.authorUserId);
  } else excludeUserIds.add(captured.requestedByUserId);

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

  const notification = deriveAdviceNotificationContent({ type: event.type, payload: captured });
  await createNotificationIntent(tx, {
    workspaceId: event.workspaceId,
    lineageActor: captured.lineageActor, lineageRoots: captured.lineageRoots,
    type: event.type,
    recipientUserIds: targets.map((target) => target.userId),
    actorUserId: Array.from(excludeUserIds)[0] ?? null,
    entityType: notification.entityType,
    entityId: notification.entityId,
    title: notification.title,
    bodyMd: notification.bodyMd,
    priority: "HIGH",
  });

  return true;
}

export async function notificationActorUserIdForEvent(
  tx: Prisma.TransactionClient,
  event: Pick<ClaimedEvent, "type" | "workspaceId" | "aggregateType" | "aggregateId" | "payload">,
): Promise<string | null> {
  if (event.type === "action.published" || event.type === "action.assigned" || event.type === "tension.published") {
    const payload = event.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload) && "actorUserId" in payload) {
      const actorUserId = payload.actorUserId;
      if (actorUserId === null || (typeof actorUserId === "string" && actorUserId.length > 0)) {
        return actorUserId;
      }
    }
  }

  // Events created before publication actor attribution retain the old audit fallback.
  const actorAudit = event.workspaceId && event.aggregateType && event.aggregateId
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
  return actorAudit?.actorUserId ?? null;
}

export async function createNotificationsForEvent(tx: Prisma.TransactionClient, event: ClaimedEvent) {
  if (!event.workspaceId) {
    return;
  }

  if (await createAdviceNotificationsForEvent(tx, event)) {
    return;
  }

  if (event.type === "action.assigned") {
    const actorUserId = await notificationActorUserIdForEvent(tx, event);
    await createActionAssignmentNotification(tx, event, actorUserId);
    return;
  }

  const notifications = await deriveDispatchNotifications(tx, event);
  if (notifications.length === 0) {
    return;
  }

  const actorUserId = await notificationActorUserIdForEvent(tx, event);
  const assignedUserId = event.type === "action.published"
    ? await createActionAssignmentNotification(tx, event, actorUserId)
    : null;

  const members = await tx.member.findMany({
    where: {
      workspaceId: event.workspaceId,
      isActive: true,
      ...(actorUserId ? { userId: { not: actorUserId } } : {}),
    },
    select: { userId: true },
  });

  if (members.length === 0) {
    return;
  }

  for (const notification of notifications) {
    await createNotificationIntent(tx, {
      workspaceId: event.workspaceId,
      lineageActor: notification.lineageActor, lineageRoots: notification.lineageRoots,
      type: notification.type,
      recipientUserIds: members.map((member) => member.userId).filter((userId) => userId !== assignedUserId),
      actorUserId,
      entityType: notification.entityType,
      entityId: notification.entityId,
      title: notification.title,
      bodyMd: notification.bodyMd,
      priority: "NORMAL",
    });
  }
}

async function claimPendingJobs(workerId: string, batchSize: number) {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<ClaimedJob[]>`
      WITH candidates AS (
        SELECT job.id
        FROM "WorkflowJob" AS job
        LEFT JOIN "WorkflowJob" AS dep ON dep.id = job."dependsOnJobId"
        WHERE (
          (job.status = 'PENDING' AND (
            (job.type IN ('agent.brain-maintenance', 'agent.brain-absorb', 'agent.meeting-summary', 'meeting.insights.extract', 'agent.action-extraction', 'meeting-audio.transcribe') AND job."runAfter" <= (NOW() AT TIME ZONE 'UTC'))
            OR (job.type NOT IN ('agent.brain-maintenance', 'agent.brain-absorb', 'agent.meeting-summary', 'meeting.insights.extract', 'agent.action-extraction', 'meeting-audio.transcribe') AND job."runAfter" <= NOW())
          ))
          OR (job.status = 'RUNNING' AND job."lockedAt" IS NOT NULL AND (
            (job.type IN ('agent.brain-maintenance', 'agent.brain-absorb', 'agent.meeting-summary', 'meeting.insights.extract', 'agent.action-extraction', 'meeting-audio.transcribe') AND job."lockedAt" < (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes')
            OR (job.type NOT IN ('agent.brain-maintenance', 'agent.brain-absorb', 'agent.meeting-summary', 'meeting.insights.extract', 'agent.action-extraction', 'meeting-audio.transcribe') AND job."lockedAt" < ${staleBefore})
          ))
        )
        AND (job."dependsOnJobId" IS NULL OR dep.status = 'COMPLETED')
        AND NOT EXISTS (
          SELECT 1 FROM "WorkspaceFeatureFlag" AS flag
          WHERE flag."workspaceId" = job."workspaceId"
            AND flag.flag = ${OPERATOR_IMPORT_INACTIVE_FLAG} AND flag.enabled = true
        )
        ORDER BY job."createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE OF job SKIP LOCKED
      )
      UPDATE "WorkflowJob" AS job
      SET
        status = 'RUNNING',
        "startedAt" = NOW(),
        "lockedAt" = CASE WHEN job.type IN ('agent.brain-maintenance', 'agent.brain-absorb', 'agent.meeting-summary', 'meeting.insights.extract', 'agent.action-extraction', 'meeting-audio.transcribe')
          THEN (clock_timestamp() AT TIME ZONE 'UTC') ELSE NOW()::timestamp END,
        "lockedBy" = ${workerId},
        "attempts" = job."attempts" + 1,
        "error" = NULL
      FROM candidates
      WHERE job.id = candidates.id
      RETURNING
        job.id,
        job."supportOriginUserId",
        job."mcpOrigin",
        job."supportGrantVersion",
        job."workspaceId" AS "workspaceId",
        job.type,
        job.payload,
        job.attempts,
        job."lockedBy",
        job."lockedAt",
        job."startedAt"
    `;
    for (const job of claimed) {
      if (isMeetingTranscriptWorkerJob(job.type)) job.meetingClaim = registerClaimedMeetingTranscriptWorkflow(job);
    }
    return claimed;
  });
}

function isClaimFencedKnowledgeSyncJob(type: string) {
  return type === "oauth.documents.sync" || type === "oauth.email.sync" || type === "knowledge.sync.event";
}

function isSourceRegenerationJob(type: string) {
  return type === "agent.brain-source-regenerate" || type === "agent.brain-article-variant" || type === "agent.graph-source-variant";
}

function executionAuthorizationRevoked(error: unknown) {
  const revokedCodes = ["SUPPORT_AUTHORIZATION_REVOKED", "MCP_AUTHORIZATION_REVOKED"];
  return error instanceof Error && (revokedCodes.includes((error as Error & { code?: string }).code ?? "") || revokedCodes.includes(error.message));
}

async function failEvent(event: ClaimedEvent, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown event dispatch error.";
  const status: EventStatus = event.attempts >= MAX_ATTEMPTS || executionAuthorizationRevoked(error) ? "FAILED" : "PENDING";

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
  const status: WorkflowJobStatus = job.attempts >= MAX_ATTEMPTS || executionAuthorizationRevoked(error) ? "FAILED" : "PENDING";

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

async function handleJob(job: ClaimedJob, workerId: string, meetingActor?: AppActor) {
  const payload = job.payload as Record<string, unknown>;

  if (job.type === FINANCE_REPORT_IMPORT_EXTRACTION_JOB_TYPE) {
    if (!job.workspaceId || !isRecord(job.payload) || typeof job.payload.batchId !== "string" || !job.payload.batchId.trim()) {
      throw new Error("Finance report extraction job payload is invalid.");
    }
    if (job.lockedBy !== workerId || !(job.lockedAt instanceof Date) || !Number.isFinite(job.lockedAt.getTime())) {
      throw new Error("Finance report job claim is unavailable.");
    }
    return runFinanceReportImportExtractionJob({
      workspaceId: job.workspaceId,
      batchId: job.payload.batchId,
      workflowJobId: job.id,
      attempts: job.attempts,
      isFinalAttempt: job.attempts >= MAX_ATTEMPTS,
      expectedLease: { lockedBy: job.lockedBy, lockedAt: job.lockedAt },
    });
  }

  if (job.type === FINANCE_REPORT_IMPORT_PROPOSAL_JOB_TYPE) {
    if (!job.workspaceId || !isRecord(job.payload) || typeof job.payload.batchId !== "string" || !job.payload.batchId.trim()
      || !Number.isSafeInteger(job.payload.expectedVersion) || Number(job.payload.expectedVersion) < 1) {
      throw new Error("Finance report interpretation job payload is invalid.");
    }
    if (job.lockedBy !== workerId || !(job.lockedAt instanceof Date) || !Number.isFinite(job.lockedAt.getTime())) {
      throw new Error("Finance report job claim is unavailable.");
    }
    return runFinanceReportImportProposalJob({ workspaceId: job.workspaceId, batchId: job.payload.batchId,
      expectedVersion: Number(job.payload.expectedVersion), workflowJobId: job.id, attempts: job.attempts, isFinalAttempt: job.attempts >= MAX_ATTEMPTS,
      expectedLease: { lockedBy: job.lockedBy, lockedAt: job.lockedAt } });
  }

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

  if (job.type === NOTIFICATION_DELIVERY_JOB_TYPE) {
    const deliveryId = (payload as { deliveryId?: string }).deliveryId;
    if (!deliveryId) {
      throw new Error("Notification delivery job is missing deliveryId.");
    }
    await deliverNotificationDelivery(deliveryId);
    return;
  }

  if (job.type === CRM_INQUIRY_ACKNOWLEDGEMENT_JOB_TYPE) {
    const conversationId = (payload as { conversationId?: string }).conversationId;
    if (!conversationId) {
      throw new Error("CRM inquiry acknowledgement job is missing conversationId.");
    }
    await sendCrmInquiryAcknowledgement({
      workspaceId: job.workspaceId,
      conversationId,
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
    await handleEventKnowledgeSync(job.id, payload as { eventId?: string }, job.workspaceId, structuredClone(job));
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
    await handleContextGraphSync(job.id, payload as { sourceType?: string; sourceId?: string }, job.workspaceId, { attempts: job.attempts,
      expectedLease: {lockedBy: job.lockedBy!, lockedAt: job.lockedAt!} });
    return;
  }

  if (job.type === "context-graph.staleness-sweep") {
    await handleContextGraphStalenessSweep(job.id, payload as { staleAfterDays?: number }, job.workspaceId);
    return;
  }

  if (job.type === "context-graph.reconcile") {
    await handleContextGraphReconcile(job.id, payload as { dateISO?: string }, job.workspaceId, { attempts: job.attempts,
      expectedLease: {lockedBy: job.lockedBy!, lockedAt: job.lockedAt!} });
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
    await handleOAuthDocumentsSync(job.id, payload as { connectionId?: string }, job.workspaceId, structuredClone(job));
    return;
  }

  if (job.type === "oauth.email.sync") {
    await handleOAuthEmailSync(job.id, payload as { connectionId?: string }, job.workspaceId, structuredClone(job));
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
      return runMeetingInsightsExtraction({ workspaceId: job.workspaceId, meetingId, workflowJobId: job.id, actor: meetingActor });
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
      expectedLease: {attempts: job.attempts, lockedBy: job.lockedBy!, lockedAt: job.lockedAt!},
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

  if (job.type === "source-lineage.rebuild") {
    return handleSourceLineageRebuild(job.id, payload as { eventId?: string }, job.workspaceId!);
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
        regenerationOnly: payload.regenerationOnly === true,
        rebuildRef: typeof payload.rebuildRef === "string" ? payload.rebuildRef : undefined,
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

  if (isSourceRegenerationJob(job.type)) {
    return runAgentWorkflowJob(job, workerId);
  }

  if (job.type.startsWith("agent.")) {
    const result = job.type === "agent.brain-absorb" || job.type === BRAIN_MAINTENANCE_JOB || isMeetingTranscriptWorkerJob(job.type)
      ? await runAgentWorkflowJob(job, workerId, meetingActor) : await runAgentWorkflowJob(job);
    if (result && typeof result === "object" && "skipped" in result && result.reason === "concurrency_limit") {
      throw new RetryableWorkflowJobError("Agent concurrency limit reached.");
    }
    if (typeof payload.sourceAgentRunId === "string" && payload.sourceAgentRunId &&
      (!result || typeof result !== "object" || !("status" in result) || result.status !== "WAITING_APPROVAL")) {
      throw new RetryableWorkflowJobError("Agent feedback continuation did not reach a review checkpoint.");
    }
    return result;
  }
}

export async function dispatchPendingEvents(workerId: string, batchSize = DEFAULT_BATCH_SIZE) {
  const events = await claimPendingEvents(workerId, batchSize);

  for (const event of events) {
    try {
      await withWorkspaceSupportExecution(event, () => withMcpConnectionExecution(event, () => prisma.$transaction(async (tx) => {
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
      })));
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
  let superseded = false;
  try {
    const diagnostic = job.type === RELEASE_DIAGNOSTIC_JOB_TYPE;
    await withWorkspaceSupportExecution(job, () => withMcpConnectionExecution(job, async () => {
      const execute = async (actor?: AppActor) => {
        try {
          await recordMeetingProgressForJob(job, "ACTIVE", {actor});
          const result = await (diagnostic ? handleReleaseDiagnostic(job, workerId) : handleJob(job, workerId, actor));
          superseded = isSourceRegenerationJob(job.type)
            && !!result && typeof result === "object" && "phase" in result && result.phase === "SUPERSEDED";
          await recordMeetingProgressForJob(job, resultWasSkipped(result) ? "SKIPPED" : "COMPLETED", {actor});
        } catch (error) {
          if (actor && job.attempts >= MAX_ATTEMPTS && !executionAuthorizationRevoked(error)) {
            await recordMeetingProgressForJob(job, "FAILED", {error, actor});
          }
          throw error;
        }
      };
      if (isMeetingTranscriptWorkerJob(job.type)) {
        await withMeetingTranscriptWorker({workspaceId: job.workspaceId!,
          meetingId: meetingIdFromWorkflowJobPayload(job.payload) ?? "", jobId: job.id,
          owner: workerId, attempt: job.attempts, claim: job.meetingClaim}, execute);
      } else await execute();
    }));
    if (!diagnostic) {
      if ((isClaimFencedKnowledgeSyncJob(job.type) || isSourceRegenerationJob(job.type) || job.type === "agent.brain-absorb" || job.type === BRAIN_MAINTENANCE_JOB || isMeetingTranscriptWorkerJob(job.type) || job.type === MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE) && !superseded) {
        // A reclaimed job may still have an older model call in flight.
        await prisma.workflowJob.updateMany({
          where: { id: job.id, workspaceId: job.workspaceId, type: job.type,
            status: "RUNNING", lockedBy: workerId, attempts: job.attempts,
            ...((isClaimFencedKnowledgeSyncJob(job.type) || isMeetingTranscriptWorkerJob(job.type) || job.type === BRAIN_MAINTENANCE_JOB || job.type === MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE) ? {payload: {equals: job.payload as Prisma.InputJsonValue}, lockedAt: {gt: new Date(Date.now() - LOCK_TIMEOUT_MS)}} : {}),
            ...(isClaimFencedKnowledgeSyncJob(job.type) ? {lockedAt: {equals: job.lockedAt, gt: new Date(Date.now() - LOCK_TIMEOUT_MS)}, startedAt: job.startedAt} : {}),
            ...(job.type === MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE ? { startedAt: job.startedAt } : {}) },
          data: { status: "COMPLETED", completedAt: new Date(), error: null, lockedAt: null, lockedBy: null },
        });
      } else if (!superseded) {
        await completeJob(job.id);
      }
    }
  } catch (error) {
    if (job.type === BRAIN_MAINTENANCE_JOB && error instanceof MaintenanceDeferred) {
      const delay = error.reason === "daily_rate_limit" ? 24 * 60 * 60_000
        : ["hourly_rate_limit", "budget_exceeded"].includes(error.reason) ? 60 * 60_000 : 60_000;
      await prisma.workflowJob.updateMany({where: {id: job.id, workspaceId: job.workspaceId, type: job.type,
        status: "RUNNING", lockedBy: workerId, attempts: job.attempts, lockedAt: {equals: job.lockedAt, gt: new Date(Date.now() - LOCK_TIMEOUT_MS)},
        payload: {equals: job.payload as Prisma.InputJsonValue}}, data: {status: "PENDING", attempts: {decrement: 1},
        runAfter: new Date(Date.now() + delay), lockedAt: null, lockedBy: null, error: error.message}});
      logger.info("workflow_job_deferred", {jobId: job.id, type: job.type, reason: error.reason});
      return;
    }
    failed = true;
    failure = error;
    if (!isMeetingTranscriptWorkerJob(job.type) && job.attempts >= MAX_ATTEMPTS && !executionAuthorizationRevoked(error)) {
      await recordMeetingProgressForJob(job, "FAILED", { error });
    }
    if (job.type === RELEASE_DIAGNOSTIC_JOB_TYPE) {
      // An obsolete diagnostic worker must not overwrite a reclaimed/completed job.
      // Fail this operation once; a release runner reconciles it instead of blindly retrying.
      await prisma.workflowJob.updateMany({
        where: { id: job.id, workspaceId: job.workspaceId, type: RELEASE_DIAGNOSTIC_JOB_TYPE, status: "RUNNING", lockedBy: workerId },
        data: { status: "FAILED", lockedAt: null, lockedBy: null, error: "Release diagnostic failed; reconcile the exact operation." },
      });
    } else if (isClaimFencedKnowledgeSyncJob(job.type) || isSourceRegenerationJob(job.type) || job.type === "agent.brain-absorb" || job.type === BRAIN_MAINTENANCE_JOB || isMeetingTranscriptWorkerJob(job.type) || job.type === MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE) {
      const status: WorkflowJobStatus = job.attempts >= MAX_ATTEMPTS || executionAuthorizationRevoked(error) ? "FAILED" : "PENDING";
      await prisma.workflowJob.updateMany({
        where: { id: job.id, workspaceId: job.workspaceId, type: job.type,
          status: "RUNNING", lockedBy: workerId, attempts: job.attempts,
            ...((isClaimFencedKnowledgeSyncJob(job.type) || isMeetingTranscriptWorkerJob(job.type) || job.type === BRAIN_MAINTENANCE_JOB || job.type === MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE) ? {payload: {equals: job.payload as Prisma.InputJsonValue}, lockedAt: {gt: new Date(Date.now() - LOCK_TIMEOUT_MS)}} : {}),
            ...(isClaimFencedKnowledgeSyncJob(job.type) ? {lockedAt: {equals: job.lockedAt, gt: new Date(Date.now() - LOCK_TIMEOUT_MS)}, startedAt: job.startedAt} : {}),
            ...(job.type === MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE ? { startedAt: job.startedAt } : {}) },
        data: { status, error: error instanceof Error ? error.message : "Unknown worker error.",
          completedAt: status === "FAILED" ? new Date() : null,
          runAfter: status === "PENDING" ? nextRetryTime(job.attempts) : undefined,
          lockedAt: null, lockedBy: null },
      });
    } else {
      await failJob(job, error);
    }
  } finally {
    revokeMeetingTranscriptWorkflowClaim(job.meetingClaim);
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
      workspace: { featureFlags: { none: { flag: OPERATOR_IMPORT_INACTIVE_FLAG, enabled: true } } },
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
      const enqueue = await enqueueJob(tx, {
        workspaceId: lead.workspaceId,
        eventId: null,
        type: "agent.crm-drip-followup",
        payload: {
          demoLeadId: lead.id,
          followUpNumber: lead.followUpCount + 1,
        },
        dedupeKey: `${lead.workspaceId}:drip:${lead.id}:${todayISO}`,
      });
      scheduledCount += Number(enqueue.scheduled);
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

  // Only inserted jobs count as work; duplicate schedules must allow idle polling to back off.
  return prisma.$transaction((tx) => enqueueJobBatch(tx, jobs));
}

// Internal operator import marker, written atomically with a new workspace.
// Suppresses scheduling and new consumer claims, not already-claimed work.
// Integrations and pending source work still require separate import staging.
const OPERATOR_IMPORT_INACTIVE_FLAG = "operator_import_inactive";

export async function scheduleDailyJobs(options: { schedulerCadenceMinutes?: 1 | 5 } = {}) {
  const cadenceMinutes = options.schedulerCadenceMinutes ?? 1;
  if (cadenceMinutes !== 1 && cadenceMinutes !== 5) throw new Error("Invalid scheduler cadence");
  const now = new Date();
  const todayISO = now.toISOString().split("T")[0];
  const workspaces = await prisma.workspace.findMany({
    where: {
      featureFlags: { none: { flag: OPERATOR_IMPORT_INACTIVE_FLAG, enabled: true } },
    },
    select: { id: true },
  });
  const recurringSeriesWorkspaces = await prisma.meetingSeries.findMany({
    where: {
      archivedAt: null,
      recurrenceRule: { not: null },
      workspace: { featureFlags: { none: { flag: OPERATOR_IMPORT_INACTIVE_FLAG, enabled: true } } },
    },
    distinct: ["workspaceId"],
    select: { workspaceId: true },
  });
  const slackArchiveInstallations = await prisma.communicationInstallation.findMany({
    where: {
      provider: "SLACK",
      status: "ACTIVE",
      scopes: { has: "channels:history" },
    },
    distinct: ["workspaceId"],
    select: { workspaceId: true, settings: true },
  });
  const slackArchiveWorkspaces = slackArchiveInstallations.filter((installation) => slackPublicArchiveEnabled(installation.settings));
  const {
    getNewspaperLocalDateParts,
    getNewspaperDueOccurrence,
    getWorkspaceDigestSettings,
    isHumanNewspaperRecipientIdentity,
    isNewspaperScheduleDue,
  } = await import("@corgtex/domain");
  const newspaperSchedules: Array<{
    workspaceId: string;
    cadence: Exclude<NewspaperCadence, "OFF">;
    dateKey: string;
    dateISO: string;
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
      continue;
    }

    const workspaceCadence = setting.cadence;
    const workspaceMembers = (membersByWorkspace.get(workspace.id) ?? []).filter((member) => (
      isHumanNewspaperRecipientIdentity(member)
    ));
    const localDateKey = getNewspaperLocalDateParts(now, setting.timeZone).dateKey;

    const hasWeeklyRecipients = workspaceMembers.some((member) => (
      (member.newspaperCadence ?? workspaceCadence) === "WEEKLY"
    ));
    const hasAnyNewspaperRecipient = workspaceMembers.some((member) => (
      (member.newspaperCadence ?? workspaceCadence) !== "OFF"
    ));
    const shouldGenerateDailyBriefing = workspaceCadence !== "OFF" || hasAnyNewspaperRecipient;

    const daily = cadenceMinutes === 5
      ? getNewspaperDueOccurrence({ now, schedule: setting, cadence: "DAILY" })
      : isNewspaperScheduleDue({ now, schedule: setting, cadence: "DAILY" })
        ? { dateKey: localDateKey, scheduledAt: now } : null;
    if (shouldGenerateDailyBriefing && daily) {
      newspaperSchedules.push({
        workspaceId: workspace.id,
        cadence: "DAILY",
        dateKey: daily.dateKey,
        dateISO: daily.scheduledAt.toISOString(),
        dedupeKey: `${workspace.id}:daily-digest:${daily.dateKey}`,
      });
    }

    const weekly = cadenceMinutes === 5
      ? getNewspaperDueOccurrence({ now, schedule: setting, cadence: "WEEKLY" })
      : isNewspaperScheduleDue({ now, schedule: setting, cadence: "WEEKLY" })
        ? { dateKey: localDateKey, scheduledAt: now } : null;
    if (hasWeeklyRecipients && weekly) {
      newspaperSchedules.push({
        workspaceId: workspace.id,
        cadence: "WEEKLY",
        dateKey: weekly.dateKey,
        dateISO: weekly.scheduledAt.toISOString(),
        dedupeKey: `${workspace.id}:weekly-digest:${weekly.dateKey}`,
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
      payload: { dateISO: schedule.dateISO, dateKey: schedule.dateKey, cadence: schedule.cadence },
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

  // Log once after commit and only when scheduling actually inserted work.
  const insertedCount = await prisma.$transaction((tx) => enqueueJobBatch(tx, jobs));
  if (insertedCount > 0) {
    logger.info("daily_jobs_scheduled", { insertedCount });
  }
  return insertedCount;
}
