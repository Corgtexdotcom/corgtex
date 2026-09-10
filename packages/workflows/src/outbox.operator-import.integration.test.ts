import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@corgtex/shared";
import { finalizeExpiredApprovalFlows } from "@corgtex/domain";
import { scheduleDailyJobs, schedulePeriodicJobs } from "./outbox";

const workspaceIds: string[] = [];

describe("operator import scheduler exclusion", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("test")) {
      throw new Error("Scheduler integration tests require a local test database.");
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workflowJob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    workspaceIds.length = 0;
  });

  it("enqueues no due work for an atomically marked import while another workspace progresses", async () => {
    // Monday after the newspaper send time exercises weekly reconciliation too.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T20:15:00Z"));
    const inertId = randomUUID();
    const activeId = randomUUID();
    workspaceIds.push(inertId, activeId);
    await prisma.$transaction(async (tx) => {
      for (const [id, inactive] of [[inertId, true], [activeId, false]] as const) {
        await tx.workspace.create({ data: {
          id, name: "Synthetic scheduler fixture", slug: `scheduler-${id}`,
          featureFlags: { create: { flag: "operator_import_inactive", enabled: inactive } },
        } });
        // The marker is deliberately limited to the all-workspace scan. These
        // independent integration scans retain their existing disabled controls.
        await tx.meetingSeries.create({ data: {
          workspaceId: id, title: "Synthetic series", startsAt: new Date(),
          recurrenceRule: "FREQ=WEEKLY", archivedAt: inactive ? new Date() : null,
        } });
        await tx.communicationInstallation.create({ data: {
          workspaceId: id, provider: "SLACK", externalWorkspaceId: `synthetic-${id}`,
          status: inactive ? "DISCONNECTED" : "ACTIVE", scopes: ["channels:history"],
        } });
        await tx.externalDataSource.create({ data: {
          workspaceId: id, label: "Synthetic source", connectionStringEnc: "synthetic-no-credential",
          isActive: !inactive,
        } });
      }
    });

    await scheduleDailyJobs();
    await schedulePeriodicJobs();
    expect(await prisma.workflowJob.count({ where: { workspaceId: inertId } })).toBe(0);
    const activeJobs = await prisma.workflowJob.findMany({ where: { workspaceId: activeId } });
    expect(activeJobs.map((job) => job.type).sort()).toEqual([
      "brain.daily-digest", "communication.raw-retention", "communication.slack.proactive-scan",
      "communication.slack.public-archive", "context-graph.reconcile", "context-graph.staleness-sweep",
      "data-source.sync", "meeting.series.materialize",
    ].sort());
    await scheduleDailyJobs();
    await schedulePeriodicJobs();
    expect(await prisma.workflowJob.count({ where: { workspaceId: activeId } })).toBe(activeJobs.length);
    expect(await prisma.workflowJob.count({ where: { workspaceId: inertId } })).toBe(0);

    // Owner-controlled activation only changes the internal marker. It does not
    // restore any staged integration or pending source work.
    await prisma.workspaceFeatureFlag.update({
      where: { workspaceId_flag: { workspaceId: inertId, flag: "operator_import_inactive" } },
      data: { enabled: false },
    });
    await scheduleDailyJobs();
    const activatedJobs = await prisma.workflowJob.findMany({ where: { workspaceId: inertId } });
    expect(activatedJobs.map((job) => job.type).sort()).toEqual([
      "brain.daily-digest", "communication.raw-retention", "context-graph.reconcile", "context-graph.staleness-sweep",
    ].sort());
    expect(await prisma.workflowJob.count({ where: { workspaceId: activeId } })).toBe(activeJobs.length);
  });

  it("preserves imported active approvals while due approvals in another tenant finish", async () => {
    const inertId = randomUUID();
    const activeId = randomUUID();
    workspaceIds.push(inertId, activeId);
    const flowIds: string[] = [];
    await prisma.$transaction(async (tx) => {
      for (const [id, inactive] of [[inertId, true], [activeId, false]] as const) {
        await tx.workspace.create({ data: {
          id, name: "Synthetic approval fixture", slug: `approval-${id}`,
          featureFlags: { create: { flag: "operator_import_inactive", enabled: inactive } },
        } });
        const flow = await tx.approvalFlow.create({ data: {
          workspaceId: id, subjectType: "ACTION", subjectId: randomUUID(),
          mode: "CONSENT", status: "ACTIVE", closesAt: new Date("2020-01-01T00:00:00Z"),
        } });
        flowIds.push(flow.id);
      }
    });
    await finalizeExpiredApprovalFlows();
    expect((await prisma.approvalFlow.findUniqueOrThrow({ where: { id: flowIds[0] } })).status).toBe("ACTIVE");
    expect((await prisma.approvalFlow.findUniqueOrThrow({ where: { id: flowIds[1] } })).status).not.toBe("ACTIVE");
    expect(await prisma.event.count({ where: { workspaceId: inertId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { workspaceId: inertId } })).toBe(0);
    await prisma.workspaceFeatureFlag.update({
      where: { workspaceId_flag: { workspaceId: inertId, flag: "operator_import_inactive" } },
      data: { enabled: false },
    });
    await finalizeExpiredApprovalFlows();
    expect((await prisma.approvalFlow.findUniqueOrThrow({ where: { id: flowIds[0] } })).status).not.toBe("ACTIVE");
    expect(await prisma.event.count({ where: { workspaceId: inertId } })).toBe(2);
  });
});
