import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@corgtex/shared";
import { finalizeExpiredApprovalFlows } from "@corgtex/domain";
import { dispatchPendingEvents, runPendingJobs, scheduleDailyJobs, scheduleDripCampaigns, schedulePeriodicJobs } from "./outbox";

const workspaceIds: string[] = [];
const globalJobIds: string[] = [];
const globalEventIds: string[] = [];

describe("operator import scheduler exclusion", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("test")) {
      throw new Error("Scheduler integration tests require a local test database.");
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await prisma.workflowJob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workflowJob.deleteMany({ where: { id: { in: globalJobIds } } });
    await prisma.event.deleteMany({ where: { OR: [{ workspaceId: { in: workspaceIds } }, { id: { in: globalEventIds } }] } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    workspaceIds.length = 0;
    globalJobIds.length = 0;
    globalEventIds.length = 0;
  });

  it.each(["delete", "disable"])("holds consumers without mutating rows until the owner explicitly chooses to %s the marker", async (release) => {
    const held = randomUUID(), active = randomUUID(), disabled = randomUUID();
    workspaceIds.push(held, active, disabled);
    for (const id of workspaceIds) await prisma.workspace.create({ data: {
      id, slug: `consumer-${id}`, name: "Synthetic consumer fixture",
      ...(id === active ? {} : { featureFlags: { create: { flag: "operator_import_inactive", enabled: id === held } } }),
    } });
    const past = new Date("2020-01-01T00:00:00Z");
    const future = new Date("2099-01-01T00:00:00Z");
    // Unknown synthetic types exercise the real claims and completion paths but
    // have no handler, provider, notification or email side effects.
    const event = async (workspaceId: string | null, leased = false) => {
      const row = await prisma.event.create({ data: {
        workspaceId, type: "synthetic.consumer-hold", payload: { preserved: true },
        availableAt: past, createdAt: workspaceId === held ? past : new Date(), attempts: 2, error: "preserve while held",
        ...(leased ? { lockedAt: past, lockedBy: "synthetic-old-worker" } : {}),
      } });
      if (workspaceId === null) globalEventIds.push(row.id);
      return row;
    };
    const job = async (workspaceId: string | null, status: "PENDING" | "RUNNING" | "FAILED" = "PENDING", dependsOnJobId?: string) => {
      const row = await prisma.workflowJob.create({ data: {
        workspaceId, type: "synthetic.consumer-hold", payload: { preserved: true }, status,
        dedupeKey: randomUUID(), dependsOnJobId, runAfter: past, attempts: 2, error: "preserve while held",
        createdAt: workspaceId === held ? past : new Date(),
        ...(status === "RUNNING" ? { lockedAt: past, lockedBy: "synthetic-old-worker", startedAt: past } : {}),
      } });
      if (workspaceId === null) globalJobIds.push(row.id);
      return row;
    };
    await event(held); await event(held, true);
    const parent = await job(held);
    const stale = await job(held, "RUNNING");
    const child = await job(held, "PENDING", parent.id);
    const failed = await job(held, "FAILED");
    const blocked = await job(held, "PENDING", failed.id);
    const notDue = await job(held);
    await prisma.workflowJob.update({ where: { id: notDue.id }, data: { runAfter: future } });
    const freshLease = await job(held, "RUNNING");
    await prisma.workflowJob.update({ where: { id: freshLease.id }, data: { lockedAt: future } });
    const heldEvents = await prisma.event.findMany({ where: { workspaceId: held }, orderBy: { id: "asc" } });
    const heldJobs = await prisma.workflowJob.findMany({ where: { workspaceId: held }, orderBy: { id: "asc" } });
    const controls = [];
    for (const workspaceId of [active, disabled, null]) {
      controls.push({ event: await event(workspaceId), pending: await job(workspaceId), stale: await job(workspaceId, "RUNNING") });
    }
    // Held oldest rows must not consume a batch slot or starve another tenant.
    for (let i = 0; i < 3; i++) expect(await dispatchPendingEvents("synthetic-consumer", 1)).toBe(1);
    expect(await dispatchPendingEvents("synthetic-consumer", 1)).toBe(0);
    for (let i = 0; i < 6; i++) expect(await runPendingJobs("synthetic-consumer", 1, 1)).toBe(1);
    expect(await runPendingJobs("synthetic-consumer", 1, 1)).toBe(0);
    for (const control of controls) {
      expect(await prisma.event.findUniqueOrThrow({ where: { id: control.event.id } })).toMatchObject({ status: "DISPATCHED", attempts: 3, lockedAt: null, lockedBy: null });
      for (const row of [control.pending, control.stale]) expect(await prisma.workflowJob.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "COMPLETED", attempts: 3, lockedAt: null, lockedBy: null });
    }
    expect(await prisma.event.findMany({ where: { workspaceId: held }, orderBy: { id: "asc" } })).toEqual(heldEvents);
    expect(await prisma.workflowJob.findMany({ where: { workspaceId: held }, orderBy: { id: "asc" } })).toEqual(heldJobs);
    const where = { workspaceId_flag: { workspaceId: held, flag: "operator_import_inactive" } };
    expect((await prisma.workspaceFeatureFlag.findUniqueOrThrow({ where })).enabled).toBe(true);
    if (release === "delete") await prisma.workspaceFeatureFlag.delete({ where });
    else await prisma.workspaceFeatureFlag.update({ where, data: { enabled: false } });
    expect(await dispatchPendingEvents("synthetic-consumer", 10)).toBe(2);
    expect(await runPendingJobs("synthetic-consumer", 10, 1)).toBe(2);
    expect(await runPendingJobs("synthetic-consumer", 10, 1)).toBe(1);
    expect(await runPendingJobs("synthetic-consumer", 10, 1)).toBe(0);
    for (const row of [parent, stale, child]) expect(await prisma.workflowJob.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "COMPLETED", attempts: 3 });
    for (const id of [failed.id, blocked.id, notDue.id, freshLease.id]) expect(await prisma.workflowJob.findUniqueOrThrow({ where: { id } })).toEqual(heldJobs.find((row) => row.id === id));
  });

  it.each(["absent", "disabled"])("excludes inactive imports from enabled drip while an active tenant with %s marker progresses", async (marker) => {
    vi.stubEnv("CRM_DRIP_ENABLED", "true");
    vi.stubEnv("CRM_DRIP_INTERVAL_DAYS", "3");
    vi.stubEnv("CRM_DRIP_MAX_FOLLOWUPS", "3");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T10:15:00Z"));
    const inertId = randomUUID();
    const activeId = randomUUID();
    workspaceIds.push(inertId, activeId);
    const leads = await prisma.$transaction(async (tx) => {
      const created = [];
      for (const [id, inactive] of [[inertId, true], [activeId, false]] as const) {
        await tx.workspace.create({ data: {
          id, name: "Synthetic drip fixture", slug: `drip-${id}`,
          ...(inactive || marker === "disabled" ? {
            featureFlags: { create: { flag: "operator_import_inactive", enabled: inactive } },
          } : {}),
        } });
        created.push(await tx.demoLead.create({ data: {
          workspaceId: id, email: `lead-${id}@example.invalid`,
          createdAt: new Date("2026-09-01T00:00:00Z"), followUpCount: 1,
        } }));
      }
      return created;
    });

    expect(await scheduleDripCampaigns()).toBe(1);
    expect(await prisma.workflowJob.count({ where: { workspaceId: inertId } })).toBe(0);
    const activeJobs = await prisma.workflowJob.findMany({ where: { workspaceId: activeId } });
    expect(activeJobs).toHaveLength(1);
    expect(activeJobs[0]).toMatchObject({
      type: "agent.crm-drip-followup", status: "PENDING",
      payload: { demoLeadId: leads[1].id, followUpNumber: 2 },
      dedupeKey: `${activeId}:drip:${leads[1].id}:2026-09-14`,
    });
    await scheduleDripCampaigns();
    expect(await prisma.workflowJob.findMany({ where: { workspaceId: activeId } })).toEqual(activeJobs);
    expect(await prisma.workflowJob.count({ where: { workspaceId: inertId } })).toBe(0);
    expect((await prisma.workspaceFeatureFlag.findUniqueOrThrow({
      where: { workspaceId_flag: { workspaceId: inertId, flag: "operator_import_inactive" } },
    })).enabled).toBe(true);
    for (const lead of leads) {
      expect(await prisma.demoLead.findUniqueOrThrow({ where: { id: lead.id } })).toEqual(lead);
    }
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
        // Preserve a live recurrence, as in the actual imported source. The
        // marker must exclude it from the independent recurrence scan too.
        await tx.meetingSeries.create({ data: {
          workspaceId: id, title: "Synthetic series", startsAt: new Date(),
          recurrenceRule: "FREQ=WEEKLY", archivedAt: null,
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
      "brain.daily-digest", "communication.raw-retention", "context-graph.reconcile", "context-graph.staleness-sweep", "meeting.series.materialize",
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
