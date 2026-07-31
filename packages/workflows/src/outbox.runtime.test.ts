import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  txMock,
  loggerMock,
  runAgentWorkflowJobMock,
  runDailyDigestMock,
  runSlackAgentMock,
  runSlackContextSummaryMock,
  runSlackProactiveScanMock,
  sendDemoWelcomeNewspaperMock,
  processSlackInboundEventMock,
  captureReferencesForSourceMock,
  purgeExpiredCommunicationMessagesMock,
  syncSlackPublicArchiveForWorkspaceMock,
  runMeetingAgendaThreadEditMock,
  runMeetingAgendaPreparationMock,
  ensureMeetingSeriesOccurrencesMock,
  runControlPlaneClientMigrationWorkerVerificationJobMock,
  runControlPlaneFleetSnapshotJobMock,
  runControlPlaneReleaseDeployJobMock,
  runEnterpriseAppHealthCheckJobMock,
  syncRecorderCalendarSourceMock,
  runMeetingAudioAssetTranscriptionMock,
  getWorkspaceDigestSettingsMock,
  getNewspaperLocalDatePartsMock,
  isNewspaperScheduleDueMock,
  recordMeetingTranscriptProcessingStageMock,
  markMeetingTranscriptProcessingReadyMock,
  createNotificationIntentMock,
  deliverNotificationDeliveryMock,
  runFinanceReportImportExtractionJobMock,
} = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    workflowJob: {
      update: vi.fn(),
      upsert: vi.fn(),
      createMany: vi.fn(),
    },
    meetingSeries: {
      findMany: vi.fn(),
    },
    workspace: {
      findMany: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    externalDataSource: {
      findMany: vi.fn(),
    },
    communicationInstallation: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    customerDeployment: {
      findMany: vi.fn(),
    },
    appRuntime: {
      findMany: vi.fn(),
    },
  },
  txMock: {
    $queryRaw: vi.fn(),
    workflowJob: {
      upsert: vi.fn(),
      createMany: vi.fn(),
    },
  },
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  runAgentWorkflowJobMock: vi.fn(),
  runDailyDigestMock: vi.fn(),
  runSlackAgentMock: vi.fn(),
  runSlackContextSummaryMock: vi.fn(),
  runSlackProactiveScanMock: vi.fn(),
  sendDemoWelcomeNewspaperMock: vi.fn(),
  processSlackInboundEventMock: vi.fn(),
  captureReferencesForSourceMock: vi.fn(),
  purgeExpiredCommunicationMessagesMock: vi.fn(),
  syncSlackPublicArchiveForWorkspaceMock: vi.fn(),
  runMeetingAgendaThreadEditMock: vi.fn(),
  runMeetingAgendaPreparationMock: vi.fn(),
  ensureMeetingSeriesOccurrencesMock: vi.fn(),
  runControlPlaneClientMigrationWorkerVerificationJobMock: vi.fn(),
  runControlPlaneFleetSnapshotJobMock: vi.fn(),
  runControlPlaneReleaseDeployJobMock: vi.fn(),
  runEnterpriseAppHealthCheckJobMock: vi.fn(),
  syncRecorderCalendarSourceMock: vi.fn(),
  runMeetingAudioAssetTranscriptionMock: vi.fn(),
  getWorkspaceDigestSettingsMock: vi.fn(),
  getNewspaperLocalDatePartsMock: vi.fn(),
  isNewspaperScheduleDueMock: vi.fn(),
  recordMeetingTranscriptProcessingStageMock: vi.fn(),
  markMeetingTranscriptProcessingReadyMock: vi.fn(),
  createNotificationIntentMock: vi.fn(),
  deliverNotificationDeliveryMock: vi.fn(),
  runFinanceReportImportExtractionJobMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  logger: loggerMock,
  prisma: prismaMock,
  toInputJson: (value: unknown) => value,
}));

vi.mock("./handlers/agent-dispatch", () => ({
  runAgentWorkflowJob: runAgentWorkflowJobMock,
}));

vi.mock("./handlers/finance-report-import", () => ({
  FINANCE_REPORT_IMPORT_EXTRACTION_JOB_TYPE: "finance-report-import.extract",
  runFinanceReportImportExtractionJob: runFinanceReportImportExtractionJobMock,
}));

vi.mock("@corgtex/agents", () => ({
  runDailyDigest: runDailyDigestMock,
  runAgentWorkflowJob: runAgentWorkflowJobMock,
  runSlackAgent: runSlackAgentMock,
  runSlackContextSummary: runSlackContextSummaryMock,
  runSlackProactiveScan: runSlackProactiveScanMock,
  sendDemoWelcomeNewspaper: sendDemoWelcomeNewspaperMock,
}));

vi.mock("@corgtex/knowledge", () => ({
  syncKnowledgeForSource: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  recordGovernanceScore: vi.fn(),
  createWebhookDeliveries: vi.fn(),
  deliverWebhook: vi.fn(),
  syncBrainArticleKnowledge: vi.fn(),
  fetchCalendarEvents: vi.fn(),
  processSlackInboundEvent: processSlackInboundEventMock,
  captureReferencesForSource: captureReferencesForSourceMock,
  purgeExpiredCommunicationMessages: purgeExpiredCommunicationMessagesMock,
  syncSlackPublicArchiveForWorkspace: syncSlackPublicArchiveForWorkspaceMock,
  runMeetingAgendaThreadEdit: runMeetingAgendaThreadEditMock,
  runMeetingAgendaPreparation: runMeetingAgendaPreparationMock,
  ensureMeetingSeriesOccurrences: ensureMeetingSeriesOccurrencesMock,
  CONTROL_PLANE_CLIENT_MIGRATION_VERIFY_JOB_TYPE: "control-plane.client-migration.verify",
  runControlPlaneClientMigrationWorkerVerificationJob: runControlPlaneClientMigrationWorkerVerificationJobMock,
  CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE: "control-plane.fleet-snapshot",
  runControlPlaneFleetSnapshotJob: runControlPlaneFleetSnapshotJobMock,
  CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE: "control-plane.release.deploy-latest",
  runControlPlaneReleaseDeployJob: runControlPlaneReleaseDeployJobMock,
  ENTERPRISE_APP_HEALTH_CHECK_JOB_TYPE: "enterprise-app.health.check",
  runEnterpriseAppHealthCheckJob: runEnterpriseAppHealthCheckJobMock,
  syncRecorderCalendarSource: syncRecorderCalendarSourceMock,
  MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE: "meeting-audio.transcribe",
  runMeetingAudioAssetTranscription: runMeetingAudioAssetTranscriptionMock,
  getWorkspaceDigestSettings: getWorkspaceDigestSettingsMock,
  getNewspaperLocalDateParts: getNewspaperLocalDatePartsMock,
  meetingIdFromWorkflowJobPayload: (payload: unknown) => (
    payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as { meetingId?: unknown }).meetingId === "string"
      ? (payload as { meetingId: string }).meetingId
      : null
  ),
  meetingTranscriptProcessingStageForJobType: (type: string) => {
    if (type === "agent.meeting-summary") return "SUMMARIZING";
    if (type === "meeting.insights.extract") return "EXTRACTING_INSIGHTS";
    if (type === "agent.action-extraction" || type === "meeting.summary.post") return "SYNCING_OUTPUTS";
    if (type === "knowledge.sync.meeting") return "INDEXING_BRAIN";
    return null;
  },
  recordMeetingTranscriptProcessingStage: recordMeetingTranscriptProcessingStageMock,
  markMeetingTranscriptProcessingReady: markMeetingTranscriptProcessingReadyMock,
  createNotificationIntent: createNotificationIntentMock,
  deliverNotificationDelivery: deliverNotificationDeliveryMock,
  NOTIFICATION_DELIVERY_JOB_TYPE: "notification.delivery",
  isHumanNewspaperRecipientIdentity: (identity: { kind?: string | null; user?: { email?: string | null; displayName?: string | null } | null; email?: string | null; displayName?: string | null }) => {
    const user = identity.user ?? identity;
    const email = user.email?.trim().toLowerCase() ?? "";
    const displayName = user.displayName?.trim().toLowerCase() ?? "";
    if (identity.kind === "SYSTEM") return false;
    return Boolean(email) && !email.startsWith("system+") && !email.startsWith("support+") && displayName !== "corgtex support";
  },
  isNewspaperScheduleDue: isNewspaperScheduleDueMock,
}));

import { runPendingJobs, scheduleDailyJobs, schedulePeriodicJobs } from "./outbox";
import { resetWorkflowJobMetricsForTest, snapshotWorkflowJobMetrics } from "./job-metrics";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function resetCreateManyMock() {
  txMock.workflowJob.createMany.mockReset().mockImplementation(async (params: { data: unknown[] }) => ({
    count: params.data.length,
  }));
}

function createdWorkflowJobs() {
  return txMock.workflowJob.createMany.mock.calls.flatMap(([params]) => params.data);
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.WORKER_DAILY_JOB_START_HOUR_UTC;
});

describe("runPendingJobs", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    prismaMock.workflowJob.update.mockReset().mockResolvedValue({ id: "job-1" });
    prismaMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-next" });
    prismaMock.meetingSeries.findMany.mockReset().mockResolvedValue([]);
    prismaMock.workspace.findMany.mockReset().mockResolvedValue([]);
    prismaMock.member.findMany.mockReset().mockResolvedValue([]);
    prismaMock.externalDataSource.findMany.mockReset().mockResolvedValue([]);
    prismaMock.communicationInstallation.findMany.mockReset().mockResolvedValue([]);
    prismaMock.communicationInstallation.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.customerDeployment.findMany.mockReset().mockResolvedValue([]);
    prismaMock.appRuntime.findMany.mockReset().mockResolvedValue([]);
    txMock.$queryRaw.mockReset().mockResolvedValue([]);
    txMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-1" });
    resetCreateManyMock();
    runAgentWorkflowJobMock.mockReset();
    runDailyDigestMock.mockReset().mockResolvedValue({ success: true });
    runSlackAgentMock.mockReset();
    runSlackContextSummaryMock.mockReset().mockResolvedValue({ summarized: true });
    runSlackProactiveScanMock.mockReset().mockResolvedValue({ agendaJobs: 0, nudges: 0, drafts: 0 });
    sendDemoWelcomeNewspaperMock.mockReset().mockResolvedValue({ success: true });
    processSlackInboundEventMock.mockReset();
    captureReferencesForSourceMock.mockReset().mockResolvedValue({ captured: 1 });
    purgeExpiredCommunicationMessagesMock.mockReset();
    syncSlackPublicArchiveForWorkspaceMock.mockReset();
    runMeetingAgendaThreadEditMock.mockReset();
    runMeetingAgendaPreparationMock.mockReset().mockResolvedValue({ posted: 0 });
    ensureMeetingSeriesOccurrencesMock.mockReset().mockResolvedValue({ meetingCount: 0, createdCount: 0 });
    runControlPlaneClientMigrationWorkerVerificationJobMock.mockReset().mockResolvedValue({ id: "mig-1", status: "import_verified" });
    runControlPlaneFleetSnapshotJobMock.mockReset().mockResolvedValue({ refreshed: true });
    runControlPlaneReleaseDeployJobMock.mockReset().mockResolvedValue({ status: "deployed" });
    runEnterpriseAppHealthCheckJobMock.mockReset().mockResolvedValue({ status: "ok" });
    syncRecorderCalendarSourceMock.mockReset().mockResolvedValue({ action: "synced" });
    runMeetingAudioAssetTranscriptionMock.mockReset().mockResolvedValue({ status: "ingested", meetingId: "meeting-1" });
    getWorkspaceDigestSettingsMock.mockReset().mockResolvedValue(new Map());
    recordMeetingTranscriptProcessingStageMock.mockReset().mockResolvedValue(undefined);
    markMeetingTranscriptProcessingReadyMock.mockReset().mockResolvedValue(undefined);
    deliverNotificationDeliveryMock.mockReset().mockResolvedValue({ status: "SENT" });
    createNotificationIntentMock.mockReset().mockResolvedValue({ count: 1 });
    runFinanceReportImportExtractionJobMock.mockReset().mockResolvedValue({ skipped: false });
    getNewspaperLocalDatePartsMock.mockReset().mockReturnValue({
      dateKey: "2026-04-29",
      weekday: "WEDNESDAY",
      hour: 20,
      minute: 15,
      timeZone: "UTC",
    });
    isNewspaperScheduleDueMock.mockReset().mockReturnValue(true);
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    resetWorkflowJobMetricsForTest();
  });

  it("requeues agent jobs when execution is skipped by the concurrency gate", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "agent.meeting-summary",
        payload: { meetingId: "meeting-1" },
        attempts: 1,
      },
    ]);
    runAgentWorkflowJobMock.mockResolvedValue({
      skipped: true,
      reason: "concurrency_limit",
    });

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runAgentWorkflowJobMock).toHaveBeenCalledWith({
      id: "job-1",
      workspaceId: "ws-1",
      type: "agent.meeting-summary",
      payload: { meetingId: "meeting-1" },
      attempts: 1,
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "PENDING",
        error: "Agent concurrency limit reached.",
        lockedAt: null,
        lockedBy: null,
      }),
    });
  });

  it("dispatches only a well-formed Finance report extraction job", async () => {
    txMock.$queryRaw.mockResolvedValueOnce([{
      id: "job-1", workspaceId: "ws-1", type: "finance-report-import.extract",
      payload: { batchId: "batch-1" }, attempts: 5,
    }]);
    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);
    expect(runFinanceReportImportExtractionJobMock).toHaveBeenCalledWith({
      workspaceId: "ws-1", batchId: "batch-1", workflowJobId: "job-1",
      attempts: 5, isFinalAttempt: true,
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-1" }, data: expect.objectContaining({ status: "COMPLETED" }),
    }));

    vi.clearAllMocks();
    prismaMock.workflowJob.update.mockResolvedValue({ id: "job-2" });
    txMock.$queryRaw.mockResolvedValueOnce([{
      id: "job-2", workspaceId: "ws-1", type: "finance-report-import.extract",
      payload: null, attempts: 1,
    }]);
    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);
    expect(runFinanceReportImportExtractionJobMock).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-2" }, data: expect.objectContaining({ status: "PENDING" }),
    }));
  });

  it("records meeting transcript progress around completed meeting jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "agent.meeting-summary",
        payload: { meetingId: "meeting-1" },
        attempts: 1,
      },
    ]);
    runAgentWorkflowJobMock.mockResolvedValue({ meetingId: "meeting-1" });

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(recordMeetingTranscriptProcessingStageMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId: "ws-1",
      meetingId: "meeting-1",
      stage: "SUMMARIZING",
      status: "ACTIVE",
      workflowJobId: "job-1",
      workflowJobType: "agent.meeting-summary",
      workflowJobStatus: "RUNNING",
    }));
    expect(recordMeetingTranscriptProcessingStageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workspaceId: "ws-1",
      meetingId: "meeting-1",
      stage: "SUMMARIZING",
      status: "COMPLETED",
      workflowJobId: "job-1",
      workflowJobType: "agent.meeting-summary",
      workflowJobStatus: "COMPLETED",
    }));
  });

  it("dispatches Slack communication event jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-1" },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(processSlackInboundEventMock).toHaveBeenCalledWith("inbound-1");
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches external resource capture jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "external-resource.capture-source",
        payload: { sourceType: "SLACK_MESSAGE", sourceId: "message-1" },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(captureReferencesForSourceMock).toHaveBeenCalledWith("SLACK_MESSAGE", "message-1");
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches meeting audio transcription jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "meeting-audio.transcribe",
        payload: { audioAssetId: "audio-1" },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runMeetingAudioAssetTranscriptionMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      audioAssetId: "audio-1",
      workflowJobId: "job-1",
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("starts independent jobs concurrently when the cap allows it", async () => {
    const firstJob = deferred();
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-1" },
        attempts: 1,
      },
      {
        id: "job-2",
        workspaceId: "ws-1",
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-2" },
        attempts: 1,
      },
    ]);
    processSlackInboundEventMock.mockImplementation((inboundEventId: string) => (
      inboundEventId === "inbound-1" ? firstJob.promise : Promise.resolve()
    ));

    const pendingRun = runPendingJobs("worker-1", 2, 2);

    await vi.waitFor(() => {
      expect(processSlackInboundEventMock).toHaveBeenCalledTimes(2);
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-2" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });

    firstJob.resolve();
    await expect(pendingRun).resolves.toBe(2);
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("does not start more jobs than the concurrency cap", async () => {
    const firstJob = deferred();
    const secondJob = deferred();
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-1" },
        attempts: 1,
      },
      {
        id: "job-2",
        workspaceId: "ws-1",
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-2" },
        attempts: 1,
      },
      {
        id: "job-3",
        workspaceId: "ws-1",
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-3" },
        attempts: 1,
      },
    ]);
    processSlackInboundEventMock.mockImplementation((inboundEventId: string) => {
      if (inboundEventId === "inbound-1") return firstJob.promise;
      if (inboundEventId === "inbound-2") return secondJob.promise;
      return Promise.resolve();
    });

    const pendingRun = runPendingJobs("worker-1", 3, 2);

    await vi.waitFor(() => {
      expect(processSlackInboundEventMock).toHaveBeenCalledTimes(2);
    });
    expect(processSlackInboundEventMock).not.toHaveBeenCalledWith("inbound-3");

    firstJob.resolve();
    await vi.waitFor(() => {
      expect(processSlackInboundEventMock).toHaveBeenCalledWith("inbound-3");
    });
    secondJob.resolve();

    await expect(pendingRun).resolves.toBe(3);
  });

  it("logs per-job timing and a completed outcome for successful jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-1" },
        attempts: 2,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(loggerMock.info).toHaveBeenCalledWith("workflow_job_processed", expect.objectContaining({
      workerId: "worker-1",
      jobId: "job-1",
      type: "communication.slack.event",
      workspaceId: "ws-1",
      attempts: 2,
      outcome: "completed",
      durationMs: expect.any(Number),
    }));
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(snapshotWorkflowJobMetrics()).toEqual([
      expect.objectContaining({
        type: "communication.slack.event",
        outcome: "completed",
        count: 1,
        durationMsSum: expect.any(Number),
      }),
    ]);
  });

  it("logs per-job timing and a failed outcome when a job throws", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-1" },
        attempts: 1,
      },
    ]);
    processSlackInboundEventMock.mockRejectedValueOnce(new Error("boom"));

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(loggerMock.warn).toHaveBeenCalledWith("workflow_job_processed", expect.objectContaining({
      workerId: "worker-1",
      jobId: "job-1",
      type: "communication.slack.event",
      outcome: "failed",
      error: "boom",
      durationMs: expect.any(Number),
    }));
    expect(loggerMock.info).not.toHaveBeenCalledWith("workflow_job_processed", expect.anything());
    expect(snapshotWorkflowJobMetrics()).toEqual([
      expect.objectContaining({
        type: "communication.slack.event",
        outcome: "failed",
        count: 1,
        durationMsSum: expect.any(Number),
      }),
    ]);
  });

  it("dispatches recorder calendar sync jobs and schedules the recurring follow-up", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "meeting-recorders.calendar.sync",
        payload: { sourceId: "source-1" },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(syncRecorderCalendarSourceMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sourceId: "source-1",
      workflowJobId: "job-1",
    });
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "meeting-recorders.calendar.sync",
        payload: { sourceId: "source-1", reason: "recurring" },
      }),
    }));
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("does not schedule recurring recorder calendar sync jobs for unavailable sources", async () => {
    syncRecorderCalendarSourceMock.mockResolvedValueOnce({ action: "skipped", reason: "source_unavailable" });
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "meeting-recorders.calendar.sync",
        payload: { sourceId: "source-disabled" },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(syncRecorderCalendarSourceMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sourceId: "source-disabled",
      workflowJobId: "job-1",
    });
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("keeps recorder calendar sync recurrence alive after provider failures", async () => {
    syncRecorderCalendarSourceMock.mockRejectedValueOnce(new Error("Microsoft Graph unavailable"));
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "meeting-recorders.calendar.sync",
        payload: { sourceId: "source-flaky" },
        attempts: 5,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "meeting-recorders.calendar.sync",
        payload: { sourceId: "source-flaky", reason: "recurring" },
      }),
    }));
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "FAILED",
        error: "Microsoft Graph unavailable",
      }),
    });
  });

  it("dispatches control-plane fleet snapshot jobs without a workspace id", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: null,
        type: "control-plane.fleet-snapshot",
        payload: {
          deploymentId: "inst-1",
          snapshotKinds: ["HEALTH", "RELEASE"],
          reason: "Scheduled sweep.",
        },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runControlPlaneFleetSnapshotJobMock).toHaveBeenCalledWith({
      deploymentId: "inst-1",
      snapshotKinds: ["HEALTH", "RELEASE"],
      reason: "Scheduled sweep.",
      limit: null,
      concurrency: null,
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches control-plane deploy-latest jobs without a workspace id", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: null,
        type: "control-plane.release.deploy-latest",
        payload: {
          deploymentId: "inst-1",
          reason: "Queued rollout.",
          force: true,
          target: {
            releaseImageTag: "release-new",
            releaseVersion: "0.2.0",
            webImage: "ghcr.io/corgtex/web:new",
            workerImage: "ghcr.io/corgtex/worker:new",
          },
        },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runControlPlaneReleaseDeployJobMock).toHaveBeenCalledWith({
      deploymentId: "inst-1",
      reason: "Queued rollout.",
      force: true,
      target: {
        cloudProvider: "RAILWAY",
        releaseImageTag: "release-new",
        releaseVersion: "0.2.0",
        releaseGitSha: null,
        webImage: "ghcr.io/corgtex/web:new",
        workerImage: "ghcr.io/corgtex/worker:new",
        webRevision: null,
        workerRevision: null,
        migrationJobStatus: null,
        healthStatus: null,
      },
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches control-plane client migration verification jobs without a workspace id", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: null,
        type: "control-plane.client-migration.verify",
        payload: {
          migrationRunId: "mig-1",
          destinationDeploymentId: "dep-destination",
          verificationSummary: { verified: true },
          idMaps: [{ entityType: "Member", sourceId: "member-1", destinationId: "member-a" }],
          reason: "Queued worker verification.",
        },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runControlPlaneClientMigrationWorkerVerificationJobMock).toHaveBeenCalledWith({
      migrationRunId: "mig-1",
      destinationDeploymentId: "dep-destination",
      verificationSummary: { verified: true },
      idMaps: [{ entityType: "Member", sourceId: "member-1", destinationId: "member-a" }],
      reason: "Queued worker verification.",
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("fails malformed control-plane client migration verification jobs without mutating migration state", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: null,
        type: "control-plane.client-migration.verify",
        payload: {
          destinationDeploymentId: "dep-destination",
        },
        attempts: 5,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runControlPlaneClientMigrationWorkerVerificationJobMock).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "FAILED",
        error: "Control Plane client migration verification job is missing migrationRunId.",
      }),
    });
  });

  it("dispatches demo welcome newspaper jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "email.demo-welcome-newspaper",
        payload: { demoLeadId: "lead-1" },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(sendDemoWelcomeNewspaperMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      demoLeadId: "lead-1",
      workflowJobId: "job-1",
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches notification delivery jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "notification.delivery",
        payload: { deliveryId: "delivery-1" },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(deliverNotificationDeliveryMock).toHaveBeenCalledWith("delivery-1");
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches Slack public archive jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.public-archive",
        payload: {},
        attempts: 1,
      },
    ]);
    syncSlackPublicArchiveForWorkspaceMock.mockResolvedValue({
      workspaceId: "ws-1",
      channelsSeen: 1,
      messagesUpserted: 1,
    });

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(syncSlackPublicArchiveForWorkspaceMock).toHaveBeenCalledWith("ws-1");
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches enterprise app health check jobs without a workspace id", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: null,
        type: "enterprise-app.health.check",
        payload: {
          runtimeId: "runtime-1",
          reason: "Scheduled enterprise app health sweep.",
        },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runEnterpriseAppHealthCheckJobMock).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
      reason: "Scheduled enterprise app health sweep.",
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches Slack agent jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.agent",
        payload: {
          source: "slash_command",
          installationId: "install-1",
          workspaceId: "ws-1",
          actorUserId: "user-1",
          externalUserId: "U1",
          prompt: "Create an action",
        },
        attempts: 1,
      },
    ]);
    runSlackAgentMock.mockResolvedValue({ status: "COMPLETED" });

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runSlackAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "slash_command",
      installationId: "install-1",
      workspaceId: "ws-1",
      actorUserId: "user-1",
      externalUserId: "U1",
      prompt: "Create an action",
      workflowJobId: "job-1",
    }));
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches Slack agenda edit jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "meeting.agenda.edit",
        payload: {
          meetingId: "meeting-1",
          actorUserId: "user-1",
          installationId: "install-1",
          channelId: "C1",
          threadTs: "1710000000.000100",
          messageTs: "1710000001.000100",
          messageText: "Add Bob's detail",
        },
        attempts: 1,
      },
    ]);
    runMeetingAgendaThreadEditMock.mockResolvedValue({ edited: true });

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runMeetingAgendaThreadEditMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      meetingId: "meeting-1",
      actorUserId: "user-1",
      installationId: "install-1",
      channelId: "C1",
      threadTs: "1710000000.000100",
      messageTs: "1710000001.000100",
      messageText: "Add Bob's detail",
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches meeting series materialization jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "meeting.series.materialize",
        payload: { reason: "daily-recurring-series-repair" },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(ensureMeetingSeriesOccurrencesMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      reason: "daily-recurring-series-repair",
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches Slack context summary jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.context-summary",
        payload: {
          installationId: "install-1",
          channelId: "C1",
          threadTs: "1710000000.000100",
          dayISO: "2026-04-29",
        },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runSlackContextSummaryMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      installationId: "install-1",
      channelId: "C1",
      threadTs: "1710000000.000100",
      dayISO: "2026-04-29",
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches Slack proactive scan jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.proactive-scan",
        payload: {
          installationId: "install-1",
        },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runSlackProactiveScanMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      installationId: "install-1",
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("marks Slack installations reauth-required when proactive scans fail with invalid_auth", async () => {
    const invalidAuthError = new Error("An API error occurred: invalid_auth");
    runSlackProactiveScanMock.mockRejectedValueOnce(invalidAuthError);
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.proactive-scan",
        payload: {
          installationId: "install-1",
        },
        attempts: 5,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(prismaMock.communicationInstallation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "install-1",
        workspaceId: "ws-1",
        provider: "SLACK",
      },
      data: expect.objectContaining({
        status: "ERROR",
        disconnectedAt: expect.any(Date),
        lastError: "invalid_auth",
      }),
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });
});

describe("schedulePeriodicJobs", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    txMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-1" });
    resetCreateManyMock();
    prismaMock.externalDataSource.findMany.mockReset().mockResolvedValue([]);
    prismaMock.communicationInstallation.findMany.mockReset().mockResolvedValue([
      { id: "install-1", workspaceId: "ws-1" },
    ]);
    prismaMock.customerDeployment.findMany.mockReset().mockResolvedValue([]);
    prismaMock.appRuntime.findMany.mockReset().mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T20:15:00Z"));
  });

  it("schedules hourly proactive scans for public Slack installations", async () => {
    await expect(schedulePeriodicJobs()).resolves.toBe(1);

    expect(txMock.workflowJob.createMany).toHaveBeenCalledTimes(1);
    expect(txMock.workflowJob.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "ws-1",
          type: "communication.slack.proactive-scan",
          payload: { installationId: "install-1" },
          dedupeKey: "install-1:slack-proactive-scan:493748",
        }),
      ]),
      skipDuplicates: true,
    });
  });

  it("schedules bounded control-plane fleet snapshot jobs", async () => {
    prismaMock.communicationInstallation.findMany.mockResolvedValue([]);
    prismaMock.customerDeployment.findMany.mockResolvedValue([
      { id: "inst-1" },
      { id: "inst-2" },
    ]);

    await expect(schedulePeriodicJobs()).resolves.toBe(2);

    expect(prismaMock.customerDeployment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        customerAccountId: { not: null },
        deploymentStatus: { notIn: ["RETIRED", "SUSPENDED"] },
      },
      take: 50,
      select: { id: true },
    }));
    expect(txMock.workflowJob.createMany).toHaveBeenCalledTimes(1);
    expect(createdWorkflowJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: null,
        eventId: null,
        type: "control-plane.fleet-snapshot",
        payload: expect.objectContaining({
          deploymentId: "inst-1",
          reason: "Scheduled Control Plane fleet sweep.",
        }),
        dedupeKey: "inst-1:control-plane-fleet-snapshot:493748",
      }),
    ]));
  });

  it("schedules bounded enterprise app health jobs", async () => {
    prismaMock.communicationInstallation.findMany.mockResolvedValue([]);
    prismaMock.appRuntime.findMany.mockResolvedValue([
      { id: "runtime-1" },
      { id: "runtime-2" },
    ]);

    await expect(schedulePeriodicJobs()).resolves.toBe(2);

    expect(prismaMock.appRuntime.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: { not: "DISABLED" },
        OR: [
          { healthUrl: { not: null } },
          { baseUrl: { not: null } },
        ],
      },
      take: 100,
      select: { id: true },
    }));
    expect(txMock.workflowJob.createMany).toHaveBeenCalledTimes(1);
    expect(createdWorkflowJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: null,
        eventId: null,
        type: "enterprise-app.health.check",
        payload: expect.objectContaining({
          runtimeId: "runtime-1",
          reason: "Scheduled enterprise app health sweep.",
        }),
        dedupeKey: "runtime-1:enterprise-app-health:1974993",
      }),
    ]));
  });
});

describe("scheduleDailyJobs", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    prismaMock.workspace.findMany.mockReset().mockResolvedValue([
      { id: "ws-1" },
      { id: "ws-2" },
    ]);
    prismaMock.member.findMany.mockReset().mockResolvedValue([
      { workspaceId: "ws-1", newspaperCadence: null, user: { email: "member@example.com", displayName: "Member One" } },
    ]);
    prismaMock.communicationInstallation.findMany.mockReset().mockResolvedValue([
      { workspaceId: "ws-1" },
    ]);
    prismaMock.meetingSeries.findMany.mockReset().mockResolvedValue([]);
    txMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-1" });
    resetCreateManyMock();
    getWorkspaceDigestSettingsMock.mockReset().mockResolvedValue(new Map([
      ["ws-1", { enabled: true, cadence: "DAILY", weekday: "MONDAY", localTime: "08:00", timeZone: "UTC" }],
      ["ws-2", { enabled: false, cadence: "DAILY", weekday: "MONDAY", localTime: "08:00", timeZone: "UTC" }],
    ]));
    getNewspaperLocalDatePartsMock.mockReset().mockReturnValue({
      dateKey: "2026-04-29",
      weekday: "WEDNESDAY",
      hour: 20,
      minute: 15,
      timeZone: "UTC",
    });
    isNewspaperScheduleDueMock.mockReset().mockReturnValue(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T20:15:00Z"));
  });

  it("schedules retention, digest, and Slack archive jobs once the daily window has opened", async () => {
    await expect(scheduleDailyJobs()).resolves.toBe(4);

    expect(txMock.workflowJob.createMany).toHaveBeenCalledTimes(1);
    expect(txMock.workflowJob.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "ws-1",
          type: "communication.raw-retention",
          dedupeKey: "ws-1:communication-retention:2026-04-29",
        }),
        expect.objectContaining({
          workspaceId: "ws-2",
          type: "communication.raw-retention",
          dedupeKey: "ws-2:communication-retention:2026-04-29",
        }),
        expect.objectContaining({
          workspaceId: "ws-1",
          type: "brain.daily-digest",
          payload: { dateISO: "2026-04-29T20:15:00.000Z", dateKey: "2026-04-29", cadence: "DAILY" },
          dedupeKey: "ws-1:daily-digest:2026-04-29",
        }),
        expect.objectContaining({
          workspaceId: "ws-1",
          type: "communication.slack.public-archive",
          dedupeKey: "ws-1:slack-public-archive:2026-04-29",
        }),
      ]),
      skipDuplicates: true,
    });
  });

  it("schedules recurring meeting materialization once per workspace per day", async () => {
    prismaMock.meetingSeries.findMany.mockResolvedValue([
      { workspaceId: "ws-1" },
    ]);

    await expect(scheduleDailyJobs()).resolves.toBe(5);

    expect(prismaMock.meetingSeries.findMany).toHaveBeenCalledWith({
      where: {
        archivedAt: null,
        recurrenceRule: { not: null },
      },
      distinct: ["workspaceId"],
      select: { workspaceId: true },
    });
    expect(createdWorkflowJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: "ws-1",
        type: "meeting.series.materialize",
        payload: { reason: "daily-recurring-series-repair" },
        dedupeKey: "meeting-series-materialize:ws-1:2026-04-29",
      }),
    ]));
  });

  it("does not schedule newspapers before the workspace local send time", async () => {
    vi.setSystemTime(new Date("2026-04-29T10:59:00Z"));
    isNewspaperScheduleDueMock.mockReturnValue(false);

    await expect(scheduleDailyJobs()).resolves.toBe(3);

    expect(createdWorkflowJobs()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "brain.daily-digest",
      }),
    ]));
  });

  it("schedules weekly newspaper jobs on Monday UTC for weekly recipients", async () => {
    vi.setSystemTime(new Date("2026-05-04T20:15:00Z"));
    getNewspaperLocalDatePartsMock.mockReturnValue({
      dateKey: "2026-05-04",
      weekday: "MONDAY",
      hour: 20,
      minute: 15,
      timeZone: "UTC",
    });
    getWorkspaceDigestSettingsMock.mockResolvedValue(new Map([
      ["ws-1", { enabled: true, cadence: "WEEKLY", weekday: "MONDAY", localTime: "08:00", timeZone: "UTC" }],
      ["ws-2", { enabled: false, cadence: "WEEKLY", weekday: "MONDAY", localTime: "08:00", timeZone: "UTC" }],
    ]));

    await expect(scheduleDailyJobs()).resolves.toBe(5);

    expect(createdWorkflowJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: "ws-1",
        type: "brain.daily-digest",
        payload: { dateISO: "2026-05-04T20:15:00.000Z", dateKey: "2026-05-04", cadence: "WEEKLY" },
        dedupeKey: "ws-1:weekly-digest:2026-05-04",
      }),
      expect.objectContaining({
        workspaceId: "ws-1",
        type: "brain.daily-digest",
        payload: { dateISO: "2026-05-04T20:15:00.000Z", dateKey: "2026-05-04", cadence: "DAILY" },
        dedupeKey: "ws-1:daily-digest:2026-05-04",
      }),
      expect.objectContaining({
        workspaceId: "ws-1",
        type: "context-graph.reconcile",
        dedupeKey: "ws-1:context-graph-reconcile:2026-05-04",
      }),
    ]));
  });

  it("does not schedule newspapers when all effective cadences are off", async () => {
    getWorkspaceDigestSettingsMock.mockResolvedValue(new Map([
      ["ws-1", { enabled: true, cadence: "OFF", weekday: "MONDAY", localTime: "08:00", timeZone: "UTC" }],
      ["ws-2", { enabled: false, cadence: "OFF", weekday: "MONDAY", localTime: "08:00", timeZone: "UTC" }],
    ]));
    prismaMock.member.findMany.mockResolvedValue([
      { workspaceId: "ws-1", newspaperCadence: null, user: { email: "member@example.com", displayName: "Member One" } },
      { workspaceId: "ws-1", newspaperCadence: "OFF", user: { email: "off@example.com", displayName: "Off Member" } },
    ]);

    await expect(scheduleDailyJobs()).resolves.toBe(3);

    expect(createdWorkflowJobs()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "brain.daily-digest",
      }),
    ]));
    expect(loggerMock.info).toHaveBeenCalledWith("newspaper_schedule_skipped", expect.objectContaining({
      workspaceId: "ws-1",
      cadence: "DAILY",
      reason: "daily_briefing_off",
    }));
  });

  it("does not schedule newspaper jobs when workspace AI usage is paused", async () => {
    getWorkspaceDigestSettingsMock.mockResolvedValue(new Map([
      ["ws-1", { enabled: false, disabledReason: "ai_paused", cadence: "DAILY", weekday: "MONDAY", localTime: "08:00", timeZone: "UTC" }],
      ["ws-2", { enabled: false, cadence: "DAILY", weekday: "MONDAY", localTime: "08:00", timeZone: "UTC" }],
    ]));

    await expect(scheduleDailyJobs()).resolves.toBe(3);

    expect(createdWorkflowJobs()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "brain.daily-digest",
      }),
    ]));
    expect(loggerMock.info).toHaveBeenCalledWith("newspaper_schedule_skipped", expect.objectContaining({
      workspaceId: "ws-1",
      reason: "ai_paused",
    }));
  });

  it("reads digest settings and members in batched queries, not per workspace", async () => {
    await scheduleDailyJobs();

    expect(getWorkspaceDigestSettingsMock).toHaveBeenCalledTimes(1);
    expect(getWorkspaceDigestSettingsMock).toHaveBeenCalledWith(["ws-1", "ws-2"]);
    expect(prismaMock.member.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.member.findMany).toHaveBeenCalledWith({
      where: { workspaceId: { in: ["ws-1", "ws-2"] }, isActive: true },
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
    });
  });
});
