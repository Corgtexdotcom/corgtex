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
  purgeExpiredCommunicationMessagesMock,
  syncSlackPublicArchiveForWorkspaceMock,
  runMeetingAgendaThreadEditMock,
  runControlPlaneFleetSnapshotJobMock,
  runControlPlaneReleaseDeployJobMock,
  syncRecorderCalendarSourceMock,
  isAgentEnabledMock,
  getWorkspaceNewspaperCadenceMock,
} = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    workflowJob: {
      update: vi.fn(),
      upsert: vi.fn(),
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
    },
    customerDeployment: {
      findMany: vi.fn(),
    },
  },
  txMock: {
    $queryRaw: vi.fn(),
    workflowJob: {
      upsert: vi.fn(),
    },
  },
  loggerMock: {
    info: vi.fn(),
    error: vi.fn(),
  },
  runAgentWorkflowJobMock: vi.fn(),
  runDailyDigestMock: vi.fn(),
  runSlackAgentMock: vi.fn(),
  runSlackContextSummaryMock: vi.fn(),
  runSlackProactiveScanMock: vi.fn(),
  sendDemoWelcomeNewspaperMock: vi.fn(),
  processSlackInboundEventMock: vi.fn(),
  purgeExpiredCommunicationMessagesMock: vi.fn(),
  syncSlackPublicArchiveForWorkspaceMock: vi.fn(),
  runMeetingAgendaThreadEditMock: vi.fn(),
  runControlPlaneFleetSnapshotJobMock: vi.fn(),
  runControlPlaneReleaseDeployJobMock: vi.fn(),
  syncRecorderCalendarSourceMock: vi.fn(),
  isAgentEnabledMock: vi.fn(),
  getWorkspaceNewspaperCadenceMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  logger: loggerMock,
  prisma: prismaMock,
  toInputJson: (value: unknown) => value,
}));

vi.mock("./handlers/agent-dispatch", () => ({
  runAgentWorkflowJob: runAgentWorkflowJobMock,
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
  purgeExpiredCommunicationMessages: purgeExpiredCommunicationMessagesMock,
  syncSlackPublicArchiveForWorkspace: syncSlackPublicArchiveForWorkspaceMock,
  runMeetingAgendaThreadEdit: runMeetingAgendaThreadEditMock,
  CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE: "control-plane.fleet-snapshot",
  runControlPlaneFleetSnapshotJob: runControlPlaneFleetSnapshotJobMock,
  CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE: "control-plane.release.deploy-latest",
  runControlPlaneReleaseDeployJob: runControlPlaneReleaseDeployJobMock,
  syncRecorderCalendarSource: syncRecorderCalendarSourceMock,
  isAgentEnabled: isAgentEnabledMock,
  getWorkspaceNewspaperCadence: getWorkspaceNewspaperCadenceMock,
}));

import { runPendingJobs, scheduleDailyJobs, schedulePeriodicJobs } from "./outbox";

afterEach(() => {
  vi.useRealTimers();
  delete process.env.WORKER_DAILY_JOB_START_HOUR_UTC;
});

describe("runPendingJobs", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    prismaMock.workflowJob.update.mockReset().mockResolvedValue({ id: "job-1" });
    prismaMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-next" });
    prismaMock.workspace.findMany.mockReset().mockResolvedValue([]);
    prismaMock.member.findMany.mockReset().mockResolvedValue([]);
    prismaMock.externalDataSource.findMany.mockReset().mockResolvedValue([]);
    prismaMock.communicationInstallation.findMany.mockReset().mockResolvedValue([]);
    prismaMock.customerDeployment.findMany.mockReset().mockResolvedValue([]);
    txMock.$queryRaw.mockReset().mockResolvedValue([]);
    txMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-1" });
    runAgentWorkflowJobMock.mockReset();
    runDailyDigestMock.mockReset().mockResolvedValue({ success: true });
    runSlackAgentMock.mockReset();
    runSlackContextSummaryMock.mockReset().mockResolvedValue({ summarized: true });
    runSlackProactiveScanMock.mockReset().mockResolvedValue({ agendaJobs: 0, nudges: 0, drafts: 0 });
    sendDemoWelcomeNewspaperMock.mockReset().mockResolvedValue({ success: true });
    processSlackInboundEventMock.mockReset();
    purgeExpiredCommunicationMessagesMock.mockReset();
    syncSlackPublicArchiveForWorkspaceMock.mockReset();
    runMeetingAgendaThreadEditMock.mockReset();
    runControlPlaneFleetSnapshotJobMock.mockReset().mockResolvedValue({ refreshed: true });
    runControlPlaneReleaseDeployJobMock.mockReset().mockResolvedValue({ status: "deployed" });
    syncRecorderCalendarSourceMock.mockReset().mockResolvedValue({ action: "synced" });
    isAgentEnabledMock.mockReset().mockResolvedValue(false);
    getWorkspaceNewspaperCadenceMock.mockReset().mockResolvedValue("DAILY");
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
        releaseImageTag: "release-new",
        releaseVersion: "0.2.0",
        webImage: "ghcr.io/corgtex/web:new",
        workerImage: "ghcr.io/corgtex/worker:new",
      },
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
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
});

describe("schedulePeriodicJobs", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    txMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-1" });
    prismaMock.externalDataSource.findMany.mockReset().mockResolvedValue([]);
    prismaMock.communicationInstallation.findMany.mockReset().mockResolvedValue([
      { id: "install-1", workspaceId: "ws-1" },
    ]);
    prismaMock.customerDeployment.findMany.mockReset().mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T20:15:00Z"));
  });

  it("schedules hourly proactive scans for public Slack installations", async () => {
    await expect(schedulePeriodicJobs()).resolves.toBe(1);

    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        eventId: null,
        type: "communication.slack.proactive-scan",
        payload: { installationId: "install-1" },
        dedupeKey: "install-1:slack-proactive-scan:493748",
      }),
    }));
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
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: null,
        eventId: null,
        type: "control-plane.fleet-snapshot",
        payload: expect.objectContaining({
          deploymentId: "inst-1",
          reason: "Scheduled Control Plane fleet sweep.",
        }),
        dedupeKey: "inst-1:control-plane-fleet-snapshot:493748",
      }),
    }));
  });
});

describe("scheduleDailyJobs", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    prismaMock.workspace.findMany.mockReset().mockResolvedValue([
      { id: "ws-1" },
      { id: "ws-2" },
    ]);
    prismaMock.member.findMany.mockReset().mockImplementation(async ({ where }: { where: { workspaceId: string } }) => (
      where.workspaceId === "ws-1"
        ? [{ newspaperCadence: null }]
        : []
    ));
    prismaMock.communicationInstallation.findMany.mockReset().mockResolvedValue([
      { workspaceId: "ws-1" },
    ]);
    txMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-1" });
    isAgentEnabledMock.mockReset().mockImplementation(async (workspaceId: string) => workspaceId === "ws-1");
    getWorkspaceNewspaperCadenceMock.mockReset().mockResolvedValue("DAILY");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T20:15:00Z"));
  });

  it("schedules retention, digest, and Slack archive jobs once the daily window has opened", async () => {
    await expect(scheduleDailyJobs()).resolves.toBe(4);

    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        eventId: null,
        type: "communication.raw-retention",
        dedupeKey: "ws-1:communication-retention:2026-04-29",
      }),
    }));
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-2",
        eventId: null,
        type: "communication.raw-retention",
        dedupeKey: "ws-2:communication-retention:2026-04-29",
      }),
    }));
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        eventId: null,
        type: "brain.daily-digest",
        payload: { dateISO: "2026-04-29T20:15:00.000Z", cadence: "DAILY" },
        dedupeKey: "ws-1:daily-digest:2026-04-29",
      }),
    }));
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        eventId: null,
        type: "communication.slack.public-archive",
        dedupeKey: "ws-1:slack-public-archive:2026-04-29",
      }),
    }));
  });

  it("does not schedule daily jobs before the configured UTC start hour", async () => {
    vi.setSystemTime(new Date("2026-04-29T10:59:00Z"));

    await expect(scheduleDailyJobs()).resolves.toBe(0);

    expect(txMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it("schedules weekly newspaper jobs on Monday UTC for weekly recipients", async () => {
    vi.setSystemTime(new Date("2026-05-04T20:15:00Z"));
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("WEEKLY");

    await expect(scheduleDailyJobs()).resolves.toBe(4);

    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "brain.daily-digest",
        payload: { dateISO: "2026-05-04T20:15:00.000Z", cadence: "WEEKLY" },
        dedupeKey: "ws-1:weekly-digest:2026-05-04",
      }),
    }));
    expect(txMock.workflowJob.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "brain.daily-digest",
        dedupeKey: "ws-1:daily-digest:2026-05-04",
      }),
    }));
  });

  it("does not schedule newspapers when all effective cadences are off", async () => {
    getWorkspaceNewspaperCadenceMock.mockResolvedValue("OFF");
    prismaMock.member.findMany.mockResolvedValue([
      { newspaperCadence: null },
      { newspaperCadence: "OFF" },
    ]);

    await expect(scheduleDailyJobs()).resolves.toBe(3);

    expect(txMock.workflowJob.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "brain.daily-digest",
      }),
    }));
    expect(loggerMock.info).toHaveBeenCalledWith("newspaper_schedule_skipped", expect.objectContaining({
      workspaceId: "ws-1",
      cadence: "DAILY",
      reason: "no_daily_recipients",
    }));
  });
});
