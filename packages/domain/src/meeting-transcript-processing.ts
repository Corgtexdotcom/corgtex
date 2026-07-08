import type {
  MeetingTranscriptProcessingProgress,
  MeetingTranscriptProcessingStage,
  MeetingTranscriptProcessingStageStatus,
  Prisma,
  WorkflowJobStatus,
} from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError } from "./errors";

export type {
  MeetingTranscriptProcessingStage,
  MeetingTranscriptProcessingStageStatus,
};

export const MEETING_TRANSCRIPT_PROCESSING_STAGES: MeetingTranscriptProcessingStage[] = [
  "UPLOADED",
  "SUMMARIZING",
  "EXTRACTING_INSIGHTS",
  "SYNCING_OUTPUTS",
  "INDEXING_BRAIN",
  "READY",
];

export const MEETING_TRANSCRIPT_PROCESSING_JOB_TYPES = [
  "agent.meeting-summary",
  "meeting.insights.extract",
  "agent.action-extraction",
  "meeting.summary.post",
  "knowledge.sync.meeting",
] as const;

type MeetingTranscriptProcessingJobType = typeof MEETING_TRANSCRIPT_PROCESSING_JOB_TYPES[number];

export type MeetingTranscriptProcessingStageDetail = {
  status: MeetingTranscriptProcessingStageStatus;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  skippedAt: string | null;
  updatedAt: string | null;
  workflowJobId: string | null;
  workflowJobType: string | null;
  workflowJobStatus: WorkflowJobStatus | null;
  attempts: number | null;
  chunkIndex: number | null;
  chunkCount: number | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
};

export type MeetingTranscriptProcessingState = {
  currentStage: MeetingTranscriptProcessingStage;
  stages: Array<{
    stage: MeetingTranscriptProcessingStage;
    detail: MeetingTranscriptProcessingStageDetail;
  }>;
  diagnostics: Array<{
    workflowJobId: string;
    workflowJobType: string;
    status: WorkflowJobStatus;
    attempts: number;
    updatedAt: Date | string | null;
    safeErrorCode: string | null;
    safeErrorMessage: string | null;
    retrySupported: boolean;
  }>;
};

export type MeetingTranscriptProcessingJobSnapshot = {
  id: string;
  type: string;
  status: WorkflowJobStatus;
  attempts: number;
  error?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
};

type ProgressClient = {
  meetingTranscriptProcessingProgress: {
    findUnique(args: {
      where: { meetingId: string };
      select?: Record<string, unknown>;
    }): Promise<MeetingTranscriptProcessingProgress | null>;
    upsert(args: {
      where: { meetingId: string };
      update: Prisma.MeetingTranscriptProcessingProgressUpdateInput;
      create: Prisma.MeetingTranscriptProcessingProgressCreateInput;
    }): Promise<MeetingTranscriptProcessingProgress>;
  };
};

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dateIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function emptyStageDetail(status: MeetingTranscriptProcessingStageStatus = "PENDING"): MeetingTranscriptProcessingStageDetail {
  return {
    status,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    skippedAt: null,
    updatedAt: null,
    workflowJobId: null,
    workflowJobType: null,
    workflowJobStatus: null,
    attempts: null,
    chunkIndex: null,
    chunkCount: null,
    safeErrorCode: null,
    safeErrorMessage: null,
  };
}

function defaultStageStatuses() {
  return Object.fromEntries(
    MEETING_TRANSCRIPT_PROCESSING_STAGES.map((stage) => [stage, emptyStageDetail()])
  ) as Record<MeetingTranscriptProcessingStage, MeetingTranscriptProcessingStageDetail>;
}

export function normalizeMeetingTranscriptStageStatuses(value: unknown) {
  const details = defaultStageStatuses();
  if (!isObjectRecord(value)) return details;

  for (const stage of MEETING_TRANSCRIPT_PROCESSING_STAGES) {
    const raw = value[stage];
    if (!isObjectRecord(raw)) continue;
    const status = raw.status;
    details[stage] = {
      ...details[stage],
      status: status === "ACTIVE" || status === "COMPLETED" || status === "FAILED" || status === "SKIPPED"
        ? status
        : "PENDING",
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
      failedAt: typeof raw.failedAt === "string" ? raw.failedAt : null,
      skippedAt: typeof raw.skippedAt === "string" ? raw.skippedAt : null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
      workflowJobId: typeof raw.workflowJobId === "string" ? raw.workflowJobId : null,
      workflowJobType: typeof raw.workflowJobType === "string" ? raw.workflowJobType : null,
      workflowJobStatus: raw.workflowJobStatus === "PENDING"
        || raw.workflowJobStatus === "RUNNING"
        || raw.workflowJobStatus === "COMPLETED"
        || raw.workflowJobStatus === "FAILED"
        || raw.workflowJobStatus === "CANCELLED"
        ? raw.workflowJobStatus
        : null,
      attempts: typeof raw.attempts === "number" ? raw.attempts : null,
      chunkIndex: typeof raw.chunkIndex === "number" ? raw.chunkIndex : null,
      chunkCount: typeof raw.chunkCount === "number" ? raw.chunkCount : null,
      safeErrorCode: typeof raw.safeErrorCode === "string" ? raw.safeErrorCode : null,
      safeErrorMessage: typeof raw.safeErrorMessage === "string" ? raw.safeErrorMessage : null,
    };
  }

  return details;
}

function safeErrorFromUnknown(error: unknown) {
  if (error instanceof AppError) {
    return {
      safeErrorCode: error.code,
      safeErrorMessage: error.message.slice(0, 240),
    };
  }

  return {
    safeErrorCode: "WORKFLOW_JOB_FAILED",
    safeErrorMessage: "The background job failed. Retry it or review workflow logs.",
  };
}

function safeErrorFromStoredMessage(message: string | null | undefined) {
  if (!message) {
    return {
      safeErrorCode: null,
      safeErrorMessage: null,
    };
  }

  return {
    safeErrorCode: "WORKFLOW_JOB_FAILED",
    safeErrorMessage: "The background job failed. Retry it or review workflow logs.",
  };
}

export function meetingTranscriptProcessingStageForJobType(type: string): MeetingTranscriptProcessingStage | null {
  if (type === "agent.meeting-summary") return "SUMMARIZING";
  if (type === "meeting.insights.extract") return "EXTRACTING_INSIGHTS";
  if (type === "agent.action-extraction" || type === "meeting.summary.post") return "SYNCING_OUTPUTS";
  if (type === "knowledge.sync.meeting") return "INDEXING_BRAIN";
  return null;
}

export function meetingIdFromWorkflowJobPayload(payload: unknown) {
  if (!isObjectRecord(payload)) return null;
  const meetingId = payload.meetingId;
  return typeof meetingId === "string" && meetingId.trim().length > 0 ? meetingId.trim() : null;
}

function stageStatusForWorkflowJob(status: WorkflowJobStatus): MeetingTranscriptProcessingStageStatus {
  if (status === "RUNNING") return "ACTIVE";
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "FAILED") return "FAILED";
  if (status === "CANCELLED") return "SKIPPED";
  return "PENDING";
}

function currentStageFromDetails(details: Record<MeetingTranscriptProcessingStage, MeetingTranscriptProcessingStageDetail>) {
  const failed = MEETING_TRANSCRIPT_PROCESSING_STAGES.find((stage) => details[stage].status === "FAILED");
  if (failed) return failed;
  const active = MEETING_TRANSCRIPT_PROCESSING_STAGES.find((stage) => details[stage].status === "ACTIVE");
  if (active) return active;
  return MEETING_TRANSCRIPT_PROCESSING_STAGES.find((stage) => details[stage].status === "PENDING") ?? "READY";
}

function applyJobToStageDetails(
  details: Record<MeetingTranscriptProcessingStage, MeetingTranscriptProcessingStageDetail>,
  job: MeetingTranscriptProcessingJobSnapshot,
) {
  const stage = meetingTranscriptProcessingStageForJobType(job.type);
  if (!stage) return;
  const status = stageStatusForWorkflowJob(job.status);
  const safeError = safeErrorFromStoredMessage(job.status === "FAILED" ? job.error : null);
  const updatedAt = dateIso(job.updatedAt ?? job.completedAt ?? job.startedAt ?? job.createdAt);
  details[stage] = {
    ...details[stage],
    status,
    startedAt: dateIso(job.startedAt) ?? details[stage].startedAt,
    completedAt: job.status === "COMPLETED" ? dateIso(job.completedAt ?? job.updatedAt) : details[stage].completedAt,
    failedAt: job.status === "FAILED" ? dateIso(job.updatedAt) : details[stage].failedAt,
    skippedAt: job.status === "CANCELLED" ? dateIso(job.updatedAt) : details[stage].skippedAt,
    updatedAt: updatedAt ?? details[stage].updatedAt,
    workflowJobId: job.id,
    workflowJobType: job.type,
    workflowJobStatus: job.status,
    attempts: job.attempts,
    safeErrorCode: safeError.safeErrorCode,
    safeErrorMessage: safeError.safeErrorMessage,
  };
}

export function deriveMeetingTranscriptProcessingState(params: {
  meeting: {
    transcript: string | null;
    summaryMd?: string | null;
    aiProcessedAt?: Date | string | null;
    insightCount?: number | null;
  };
  progress?: Pick<MeetingTranscriptProcessingProgress, "currentStage" | "stageStatuses"> | null;
  jobs?: MeetingTranscriptProcessingJobSnapshot[];
}): MeetingTranscriptProcessingState | null {
  if (!params.meeting.transcript) return null;

  const details = params.progress
    ? normalizeMeetingTranscriptStageStatuses(params.progress.stageStatuses)
    : defaultStageStatuses();

  if (!params.progress) {
    details.UPLOADED = {
      ...details.UPLOADED,
      status: "COMPLETED",
    };

    if (params.meeting.aiProcessedAt) {
      details.SUMMARIZING.status = "COMPLETED";
      details.EXTRACTING_INSIGHTS.status = "COMPLETED";
      details.SYNCING_OUTPUTS.status = "COMPLETED";
      details.INDEXING_BRAIN.status = "COMPLETED";
      details.READY.status = "COMPLETED";
    } else if (params.meeting.summaryMd || (params.meeting.insightCount ?? 0) > 0) {
      details.SUMMARIZING.status = "COMPLETED";
      details.EXTRACTING_INSIGHTS.status = (params.meeting.insightCount ?? 0) > 0 ? "COMPLETED" : "ACTIVE";
      details.SYNCING_OUTPUTS.status = (params.meeting.insightCount ?? 0) > 0 ? "ACTIVE" : "PENDING";
    } else {
      details.SUMMARIZING.status = "ACTIVE";
    }
  }

  for (const job of params.jobs ?? []) {
    applyJobToStageDetails(details, job);
  }

  if (params.meeting.aiProcessedAt) {
    const hasBrainSyncJob = (params.jobs ?? []).some((job) => job.type === "knowledge.sync.meeting");
    const hasOutputSyncJob = (params.jobs ?? []).some((job) =>
      job.type === "agent.action-extraction" || job.type === "meeting.summary.post"
    );
    details.SUMMARIZING.status = details.SUMMARIZING.status === "FAILED" ? "FAILED" : "COMPLETED";
    details.EXTRACTING_INSIGHTS.status = details.EXTRACTING_INSIGHTS.status === "FAILED" ? "FAILED" : "COMPLETED";
    if (!hasOutputSyncJob && details.SYNCING_OUTPUTS.status !== "FAILED") {
      details.SYNCING_OUTPUTS.status = "COMPLETED";
    }
    if (details.INDEXING_BRAIN.status === "FAILED") {
      details.READY.status = "PENDING";
    } else if (details.INDEXING_BRAIN.status === "ACTIVE" || (details.INDEXING_BRAIN.status === "PENDING" && hasBrainSyncJob)) {
      details.READY.status = "PENDING";
    } else {
      details.INDEXING_BRAIN.status = "COMPLETED";
      details.READY.status = "COMPLETED";
    }
  }

  const diagnostics = (params.jobs ?? [])
    .filter((job) => meetingTranscriptProcessingStageForJobType(job.type))
    .map((job) => {
      const safeError = safeErrorFromStoredMessage(job.error);
      return {
        workflowJobId: job.id,
        workflowJobType: job.type,
        status: job.status,
        attempts: job.attempts,
        updatedAt: job.updatedAt ?? job.completedAt ?? job.startedAt ?? job.createdAt ?? null,
        safeErrorCode: safeError.safeErrorCode,
        safeErrorMessage: safeError.safeErrorMessage,
        retrySupported: job.status === "FAILED",
      };
    });

  return {
    currentStage: params.progress?.currentStage ?? currentStageFromDetails(details),
    stages: MEETING_TRANSCRIPT_PROCESSING_STAGES.map((stage) => ({
      stage,
      detail: details[stage],
    })),
    diagnostics,
  };
}

export async function resetMeetingTranscriptProcessingProgress(
  client: ProgressClient,
  params: { workspaceId: string; meetingId: string; now?: Date },
) {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const stageStatuses = defaultStageStatuses();
  stageStatuses.UPLOADED = {
    ...stageStatuses.UPLOADED,
    status: "COMPLETED",
    completedAt: nowIso,
    updatedAt: nowIso,
  };
  stageStatuses.SUMMARIZING = {
    ...stageStatuses.SUMMARIZING,
    status: "ACTIVE",
    startedAt: nowIso,
    updatedAt: nowIso,
  };

  return client.meetingTranscriptProcessingProgress.upsert({
    where: { meetingId: params.meetingId },
    update: {
      workspace: { connect: { id: params.workspaceId } },
      currentStage: "SUMMARIZING",
      stageStatuses: jsonInput(stageStatuses),
      currentWorkflowJobId: null,
      currentWorkflowJobType: null,
      currentWorkflowJobStatus: null,
      attemptCount: 0,
      safeErrorCode: null,
      safeErrorMessage: null,
      startedAt: now,
      completedAt: null,
      failedAt: null,
    },
    create: {
      workspace: { connect: { id: params.workspaceId } },
      meeting: { connect: { id: params.meetingId } },
      currentStage: "SUMMARIZING",
      stageStatuses: jsonInput(stageStatuses),
      startedAt: now,
    },
  });
}

export async function markMeetingTranscriptProcessingStage(params: {
  client?: ProgressClient;
  workspaceId: string;
  meetingId: string;
  stage: MeetingTranscriptProcessingStage;
  status: MeetingTranscriptProcessingStageStatus;
  workflowJobId?: string | null;
  workflowJobType?: string | null;
  workflowJobStatus?: WorkflowJobStatus | null;
  attempts?: number | null;
  chunkIndex?: number | null;
  chunkCount?: number | null;
  error?: unknown;
  now?: Date;
}) {
  const client = params.client ?? prisma;
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const existing = await client.meetingTranscriptProcessingProgress.findUnique({
    where: { meetingId: params.meetingId },
  });
  const stageStatuses = normalizeMeetingTranscriptStageStatuses(existing?.stageStatuses);
  const current = stageStatuses[params.stage];
  const safeError = params.status === "FAILED"
    ? safeErrorFromUnknown(params.error)
    : { safeErrorCode: null, safeErrorMessage: null };

  stageStatuses[params.stage] = {
    ...current,
    status: params.status,
    startedAt: params.status === "ACTIVE" || params.status === "COMPLETED" || params.status === "FAILED"
      ? current.startedAt ?? nowIso
      : current.startedAt,
    completedAt: params.status === "COMPLETED" ? nowIso : current.completedAt,
    failedAt: params.status === "FAILED" ? nowIso : current.failedAt,
    skippedAt: params.status === "SKIPPED" ? nowIso : current.skippedAt,
    updatedAt: nowIso,
    workflowJobId: params.workflowJobId ?? current.workflowJobId,
    workflowJobType: params.workflowJobType ?? current.workflowJobType,
    workflowJobStatus: params.workflowJobStatus ?? current.workflowJobStatus,
    attempts: params.attempts ?? current.attempts,
    chunkIndex: params.chunkIndex ?? current.chunkIndex,
    chunkCount: params.chunkCount ?? current.chunkCount,
    safeErrorCode: safeError.safeErrorCode,
    safeErrorMessage: safeError.safeErrorMessage,
  };

  const updateData: Prisma.MeetingTranscriptProcessingProgressUpdateInput = {
    workspace: { connect: { id: params.workspaceId } },
    currentStage: params.stage,
    stageStatuses: jsonInput(stageStatuses),
    currentWorkflowJobId: params.workflowJobId ?? existing?.currentWorkflowJobId ?? null,
    currentWorkflowJobType: params.workflowJobType ?? existing?.currentWorkflowJobType ?? null,
    currentWorkflowJobStatus: params.workflowJobStatus ?? existing?.currentWorkflowJobStatus ?? null,
    attemptCount: params.attempts ?? existing?.attemptCount ?? 0,
    safeErrorCode: safeError.safeErrorCode,
    safeErrorMessage: safeError.safeErrorMessage,
    startedAt: existing?.startedAt ?? now,
    completedAt: params.stage === "READY" && params.status === "COMPLETED" ? now : existing?.completedAt ?? null,
    failedAt: params.status === "FAILED" ? now : existing?.failedAt ?? null,
  };

  return client.meetingTranscriptProcessingProgress.upsert({
    where: { meetingId: params.meetingId },
    update: updateData,
    create: {
      workspace: { connect: { id: params.workspaceId } },
      meeting: { connect: { id: params.meetingId } },
      currentStage: params.stage,
      stageStatuses: jsonInput(stageStatuses),
      currentWorkflowJobId: params.workflowJobId ?? null,
      currentWorkflowJobType: params.workflowJobType ?? null,
      currentWorkflowJobStatus: params.workflowJobStatus ?? null,
      attemptCount: params.attempts ?? 0,
      safeErrorCode: safeError.safeErrorCode,
      safeErrorMessage: safeError.safeErrorMessage,
      startedAt: now,
      completedAt: params.stage === "READY" && params.status === "COMPLETED" ? now : null,
      failedAt: params.status === "FAILED" ? now : null,
    },
  });
}

export async function recordMeetingTranscriptProcessingStage(params: Parameters<typeof markMeetingTranscriptProcessingStage>[0]) {
  try {
    await markMeetingTranscriptProcessingStage(params);
  } catch (error) {
    void error;
  }
}

export async function markMeetingTranscriptProcessingReady(params: {
  workspaceId: string;
  meetingId: string;
  workflowJobId?: string | null;
  workflowJobType?: string | null;
  attempts?: number | null;
}) {
  await recordMeetingTranscriptProcessingStage({
    ...params,
    stage: "INDEXING_BRAIN",
    status: "COMPLETED",
    workflowJobStatus: "COMPLETED",
  });
  await recordMeetingTranscriptProcessingStage({
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    stage: "READY",
    status: "COMPLETED",
    workflowJobId: params.workflowJobId,
    workflowJobType: params.workflowJobType,
    workflowJobStatus: "COMPLETED",
    attempts: params.attempts,
  });
}

export async function getMeetingTranscriptProcessingState(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const [meeting, progress, jobs] = await Promise.all([
    prisma.meeting.findFirst({
      where: {
        id: params.meetingId,
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: {
        transcript: true,
        summaryMd: true,
        aiProcessedAt: true,
        _count: {
          select: { insights: true },
        },
      },
    }),
    prisma.meetingTranscriptProcessingProgress.findUnique({
      where: { meetingId: params.meetingId },
    }),
    prisma.workflowJob.findMany({
      where: {
        workspaceId: params.workspaceId,
        type: { in: [...MEETING_TRANSCRIPT_PROCESSING_JOB_TYPES] },
        payload: {
          path: ["meetingId"],
          equals: params.meetingId,
        },
      },
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        error: true,
        createdAt: true,
        updatedAt: true,
        startedAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  if (!meeting) return null;

  return deriveMeetingTranscriptProcessingState({
    meeting: {
      transcript: meeting.transcript,
      summaryMd: meeting.summaryMd,
      aiProcessedAt: meeting.aiProcessedAt,
      insightCount: meeting._count.insights,
    },
    progress,
    jobs,
  });
}

export function isMeetingTranscriptProcessingJobType(type: string): type is MeetingTranscriptProcessingJobType {
  return MEETING_TRANSCRIPT_PROCESSING_JOB_TYPES.includes(type as MeetingTranscriptProcessingJobType);
}
