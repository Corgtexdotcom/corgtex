import type { Prisma } from "@prisma/client";
import { lineageContentFingerprint } from "../../domain/src/source-lineage";
import { describe, expect, it, vi } from "vitest";
import { calculateRetryDelayMs, createNotificationsForEvent, deriveAdviceNotificationContent, notificationActorUserIdForEvent } from "./outbox";
import { deriveJobsForEvent, triageBucketStart } from "./derive-jobs";
import { deriveDispatchNotifications, deriveNotificationsForEvent } from "./derive-notifications";

function actionSource(title = "Current action title") {
  return { id: "action-1", workspaceId: "workspace-1", title, bodyMd: "Current body", status: "OPEN", isPrivate: false,
    archivedAt: null, duplicateOfActionId: null, authorUserId: "publisher-1", assigneeMemberId: "member-2", version: 1 };
}
function lineageStore(action: ReturnType<typeof actionSource>) {
  const manifests: Record<string, any>[] = [{ id: "action-original", workspaceId: action.workspaceId,
    artifactType: "Action", artifactId: action.id, revision: 1,
    origin: "HUMAN_ORIGINAL", inputsJson: [], rootsJson: [], contentHash: lineageContentFingerprint("Action", action) }];
  const select = ({ where, orderBy, take }: any) => {
    const matches = (actual: unknown, expected: any) => expected && typeof expected === "object" && "in" in expected
      ? expected.in.includes(actual) : actual === expected;
    const found = manifests.filter(row => Object.entries(where ?? {}).every(([key, value]) => matches(row[key], value)));
    if (orderBy?.revision) found.sort((a, b) => (a.revision - b.revision) * (orderBy.revision === "desc" ? -1 : 1));
    return found.slice(0, take ?? found.length);
  };
  return {
    findFirst: vi.fn(async (args): Promise<Record<string, any> | null> => select(args)[0] ?? null),
    findMany: vi.fn(async args => select(args)),
    create: vi.fn(async ({ data }) => { const row = { id: `manifest-${manifests.length}`, ...data }; manifests.push(row); return row; }),
  };
}

/** Synthetic SQL storage only; current permission and receipt helpers remain real. */
function epochTransport(lockRow = vi.fn().mockResolvedValue([]), manifests?: ReturnType<typeof lineageStore>) {
  const epochs = new Map<string, bigint>();
  return {
    $executeRaw: vi.fn(async (query: Prisma.Sql) => {
      if (query.sql?.includes('INSERT INTO "SourcePermissionEpoch"')) {
        for (let index = 0; index < query.values.length; index += 4) {
          const [, workspaceId, kind, id] = query.values.slice(index, index + 4);
          const key = JSON.stringify([workspaceId, kind, id]);
          if (!epochs.has(key)) epochs.set(key, 0n);
        }
      }
      return 1;
    }),
    $queryRaw: vi.fn(async (query: Prisma.Sql, ...values: unknown[]) => {
      if (query.sql?.includes('FROM "ArtifactInputLineage"') && manifests) {
        const [workspaceId, artifactType, ...ids] = query.values;
        const rows = await manifests.findMany({ where: { workspaceId, artifactType, artifactId: { in: ids } }, orderBy: { revision: "desc" } });
        return [...new Set(rows.map(row => row.artifactId))].map(id => rows.find(row => row.artifactId === id));
      }
      if (!query.sql?.includes('FROM "SourcePermissionEpoch"')) return lockRow(query, ...values);
      const [workspaceId, ...identities] = query.values;
      const rows = [];
      for (let index = 0; index < identities.length; index += 2) {
        const [sourceKind, sourceId] = identities.slice(index, index + 2);
        const epoch = epochs.get(JSON.stringify([workspaceId, sourceKind, sourceId]));
        if (epoch !== undefined) rows.push({ sourceKind, sourceId, epoch });
      }
      return rows;
    }),
  };
}

describe("deriveJobsForEvent", () => {
  it("creates a knowledge sync job for approved proposals", () => {
    const jobs = deriveJobsForEvent({
      id: "event-1",
      type: "proposal.approved",
      workspaceId: "workspace-1",
      payload: {
        subjectId: "proposal-1",
      },
    });

    expect(jobs).toHaveLength(6);
    expect(jobs.map((job) => job.type)).toEqual([
      "knowledge.sync.proposal",
      "context-graph.sync",
      "agent.constitution-update-trigger",
      "agent.constitution-synthesis",
      "governance.score",
      "knowledge.sync.event",
    ]);
  });

  it("creates triage jobs for submitted proposals", () => {
    const createdAt = new Date("2026-04-03T12:03:30.000Z");
    const jobs = deriveJobsForEvent({
      id: "event-2",
      type: "proposal.submitted",
      workspaceId: "workspace-1",
      payload: {},
      createdAt,
    });

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      type: "agent.inbox-triage",
      dedupeKey: `workspace-1:triage:${triageBucketStart(createdAt).toISOString()}`,
    });
    expect(jobs[1]?.type).toBe("knowledge.sync.event");
  });

  it("creates knowledge sync and triage jobs for meetings", () => {
    const jobs = deriveJobsForEvent({
      id: "event-3",
      type: "meeting.created",
      workspaceId: "workspace-1",
      payload: {
        meetingId: "meeting-1",
      },
    });

    expect(jobs).toHaveLength(8);
    expect(jobs.map((job) => job.type)).toEqual([
      "agent.meeting-summary",
      "meeting.insights.extract",
      "agent.action-extraction",
      "meeting.summary.post",
      "knowledge.sync.meeting",
      "context-graph.sync",
      "agent.inbox-triage",
      "knowledge.sync.event",
    ]);
    const postJob = jobs.find((job) => job.type === "meeting.summary.post");
    const knowledgeJob = jobs.find((job) => job.type === "knowledge.sync.meeting");
    const contextGraphJob = jobs.find((job) => job.type === "context-graph.sync");
    expect(knowledgeJob?.dependsOnDedupeKey).toBe(postJob?.dedupeKey);
    expect(contextGraphJob?.dependsOnDedupeKey).toBe("event-3:meeting-insights-extract");
  });

  it("does not run meeting agents for scheduled meetings without transcripts", () => {
    const jobs = deriveJobsForEvent({
      id: "event-scheduled",
      type: "meeting.created",
      workspaceId: "workspace-1",
      payload: {
        meetingId: "meeting-1",
        status: "SCHEDULED",
        hasTranscript: false,
      },
    });

    expect(jobs.map((job) => job.type)).toEqual([
      "knowledge.sync.meeting",
      "context-graph.sync",
      "agent.inbox-triage",
      "knowledge.sync.event",
    ]);
  });

  it("creates knowledge sync jobs for documents", () => {
    const jobs = deriveJobsForEvent({
      id: "event-4",
      type: "document.created",
      workspaceId: "workspace-1",
      payload: {
        documentId: "document-1",
      },
    });

    expect(jobs).toHaveLength(3);
    expect(jobs[0]?.type).toBe("knowledge.sync.document");
    expect(jobs[1]?.type).toBe("context-graph.sync");
    expect(jobs[2]?.type).toBe("knowledge.sync.event");
  });

  it("derives one batch-stable Finance report extraction job", () => {
    const event = {
      id: "event-finance-upload",
      type: "finance-report-import.uploaded",
      workspaceId: "workspace-1",
      aggregateType: "FinanceImportBatch",
      aggregateId: "batch-1",
      payload: { batchId: "batch-1" },
    };

    expect(deriveJobsForEvent(event)).toEqual([{
      workspaceId: "workspace-1",
      eventId: "event-finance-upload",
      type: "finance-report-import.extract",
      payload: { batchId: "batch-1" },
      dedupeKey: "finance-report-import:workspace-1:batch-1:extract:v1",
    }]);
    expect(deriveJobsForEvent({ ...event, id: "replayed-event" })[0]?.dedupeKey)
      .toBe("finance-report-import:workspace-1:batch-1:extract:v1");
  });

  it("ignores malformed Finance report upload events", () => {
    const base = {
      id: "event-finance-upload",
      type: "finance-report-import.uploaded",
      workspaceId: "workspace-1",
      aggregateType: "FinanceImportBatch",
      aggregateId: "batch-1",
      payload: { batchId: "batch-1" },
    };
    expect(deriveJobsForEvent({ ...base, workspaceId: null })).toEqual([]);
    expect(deriveJobsForEvent({ ...base, aggregateType: "Document" })).toEqual([]);
    expect(deriveJobsForEvent({ ...base, aggregateId: "batch-2" })).toEqual([]);
    expect(deriveJobsForEvent({ ...base, payload: {} })).toEqual([]);
  });

  it("derives one versioned interpretation job only from an exact extraction event", () => {
    const event = { id: "event-finance-extracted", type: "finance-report-import.extracted", workspaceId: "workspace-1",
      aggregateType: "FinanceImportBatch", aggregateId: "batch-1", payload: { batchId: "batch-1", expectedVersion: 3 } };
    expect(deriveJobsForEvent(event)).toEqual([{ workspaceId: "workspace-1", eventId: "event-finance-extracted",
      type: "finance-report-import.interpret", payload: { batchId: "batch-1", expectedVersion: 3 },
      dedupeKey: "finance-report-import:workspace-1:batch-1:interpret:v1" }]);
    expect(deriveJobsForEvent({ ...event, id: "replay" })[0]?.dedupeKey).toContain(":interpret:v1");
    expect(deriveJobsForEvent({ ...event, payload: { batchId: "batch-1", expectedVersion: 0 } })).toEqual([]);
    expect(deriveJobsForEvent({ ...event, aggregateId: "batch-2" })).toEqual([]);
  });

  it("rebuilds permitted descendants after brain source absorption", () => {
    const jobs = deriveJobsForEvent({
      id: "event-brain-source",
      type: "brain-source.created",
      workspaceId: "workspace-1",
      payload: {
        sourceId: "source-1",
      },
    });

    expect(jobs).toEqual([
      {
        workspaceId: "workspace-1",
        eventId: "event-brain-source",
        type: "agent.brain-absorb",
        payload: { sourceId: "source-1" },
        dedupeKey: "event-brain-source:brain-absorb",
      },
      {
        workspaceId: "workspace-1",
        eventId: "event-brain-source",
        type: "source-lineage.rebuild",
        payload: { eventId: "event-brain-source" },
        dependsOnDedupeKey: "event-brain-source:brain-absorb",
        dedupeKey: "event-brain-source:source-lineage-rebuild",
      },
    ]);
  });

  it("indexes proposals when they are opened", () => {
    const jobs = deriveJobsForEvent({
      id: "event-proposal-opened",
      type: "proposal.opened",
      workspaceId: "workspace-1",
      payload: {
        proposalId: "proposal-1",
      },
    });

    expect(jobs.map((job) => job.type)).toEqual([
      "knowledge.sync.proposal",
      "context-graph.sync",
      "knowledge.sync.event",
    ]);
    expect(jobs[0]).toMatchObject({
      payload: { proposalId: "proposal-1" },
      dedupeKey: "event-proposal-opened:knowledge-sync",
    });
  });

  it("creates CRM email extraction jobs for inbound reply qualifications", () => {
    const jobs = deriveJobsForEvent({
      id: "event-crm-email",
      type: "crm.qualification.submitted",
      workspaceId: "workspace-1",
      aggregateType: "CrmQualification",
      aggregateId: "qualification-1",
      payload: {
        qualificationId: "qualification-1",
        email: "lead@example.com",
        channel: "email_reply",
      },
    });

    expect(jobs).toEqual([
      {
        workspaceId: "workspace-1",
        eventId: "event-crm-email",
        type: "agent.crm-email-extraction",
        payload: {
          eventId: "event-crm-email",
          aggregateId: "qualification-1",
          qualificationId: "qualification-1",
        },
        dedupeKey: "event-crm-email:crm-email-extraction",
      },
    ]);
  });

  it("does not create CRM email extraction jobs for form qualifications", () => {
    const jobs = deriveJobsForEvent({
      id: "event-crm-form",
      type: "crm.qualification.submitted",
      workspaceId: "workspace-1",
      aggregateType: "CrmQualification",
      aggregateId: "qualification-1",
      payload: {
        qualificationId: "qualification-1",
        email: "lead@example.com",
      },
    });

    expect(jobs).toEqual([]);
  });

  it("creates CRM enrichment jobs for approved qualifications", () => {
    const jobs = deriveJobsForEvent({
      id: "event-crm-approved",
      type: "crm.qualification.approved",
      workspaceId: "workspace-1",
      aggregateType: "CrmQualification",
      aggregateId: "qualification-1",
      payload: {
        qualificationId: "qualification-1",
        email: "lead@example.com",
      },
    });

    expect(jobs).toEqual([
      {
        workspaceId: "workspace-1",
        eventId: "event-crm-approved",
        type: "agent.crm-lead-enrichment",
        payload: {
          eventId: "event-crm-approved",
          aggregateId: "qualification-1",
          email: "lead@example.com",
        },
        dedupeKey: "event-crm-approved:crm-enrichment",
      },
    ]);
  });

  it("caps retry backoff at five minutes", () => {
    expect(calculateRetryDelayMs(1)).toBe(5_000);
    expect(calculateRetryDelayMs(2)).toBe(10_000);
    expect(calculateRetryDelayMs(20)).toBe(300_000);
  });
});

describe("deriveNotificationsForEvent", () => {
  it("attributes queued republish events to each publisher instead of the latest audit", async () => {
    const findFirst = vi.fn().mockResolvedValue({ actorUserId: "user-b" });
    const tx = { auditLog: { findFirst } } as unknown as Prisma.TransactionClient;
    const publication = { type: "action.published", workspaceId: "workspace-1", aggregateType: "Action", aggregateId: "action-1" };

    expect(await notificationActorUserIdForEvent(tx, { ...publication, payload: { actorUserId: "user-a" } })).toBe("user-a");
    expect(await notificationActorUserIdForEvent(tx, { ...publication, payload: { actorUserId: "user-b" } })).toBe("user-b");
    expect(await notificationActorUserIdForEvent(tx, {
      ...publication, type: "tension.published", aggregateType: "Tension", payload: { actorUserId: null },
    })).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();

    expect(await notificationActorUserIdForEvent(tx, { ...publication, payload: {} })).toBe("user-b");
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it("creates a notification for submitted proposals with title", () => {
    const notifications = deriveNotificationsForEvent({
      type: "proposal.submitted",
      workspaceId: "workspace-1",
      aggregateType: "Proposal",
      aggregateId: "proposal-1",
      payload: {
        proposalId: "proposal-1",
        title: "Adopt async standup policy",
      },
    });

    expect(notifications).toEqual([
      {
        type: "proposal.submitted",
        entityType: "Proposal",
        entityId: "proposal-1",
        title: "Review requested: Adopt async standup policy",
        bodyMd: "The proposal **Adopt async standup policy** is open for advisory review.",
      },
    ]);
  });

  it("falls back to generic text when proposal title is missing", () => {
    const notifications = deriveNotificationsForEvent({
      type: "proposal.submitted",
      workspaceId: "workspace-1",
      aggregateType: "Proposal",
      aggregateId: "proposal-1",
      payload: {
        proposalId: "proposal-1",
      },
    });

    expect(notifications).toEqual([
      {
        type: "proposal.submitted",
        entityType: "Proposal",
        entityId: "proposal-1",
        title: "Proposal review requested",
        bodyMd: "A proposal is open for advisory review in the workspace dashboard.",
      },
    ]);
  });

  it("creates a notification for proposal.opened events (the actual domain event)", () => {
    const notifications = deriveNotificationsForEvent({
      type: "proposal.opened",
      workspaceId: "workspace-1",
      aggregateType: "Proposal",
      aggregateId: "proposal-1",
      payload: {
        proposalId: "proposal-1",
        flowId: "flow-1",
        title: "Hire a PM for growth",
      },
    });

    expect(notifications).toEqual([
      {
        type: "proposal.opened",
        entityType: "Proposal",
        entityId: "proposal-1",
        title: "Review requested: Hire a PM for growth",
        bodyMd: "The proposal **Hire a PM for growth** is open for advisory review.",
      },
    ]);
  });

  it("does not notify the workspace about private draft creation", () => {
    for (const type of ["action.created", "tension.created"]) {
      expect(deriveNotificationsForEvent({
        type,
        workspaceId: "workspace-1",
        aggregateId: "private-draft",
        payload: { title: "Confidential draft" },
      })).toEqual([]);
    }
  });

  it("notifies the workspace when an action is published", () => {
    const notifications = deriveNotificationsForEvent({
      type: "action.published",
      workspaceId: "workspace-1",
      aggregateType: "Action",
      aggregateId: "action-1",
      payload: {
        actionId: "action-1",
        title: "Ship the notification worker",
      },
    });

    expect(notifications).toEqual([
      {
        type: "action.created",
        entityType: "Action",
        entityId: "action-1",
        title: "New action: Ship the notification worker",
        bodyMd: "An action item was added to the workspace.",
      },
    ]);
  });

  it("checks current workspace visibility before notifying about a publication", async () => {
    const action = actionSource("Visible action");
    const actionFindFirst = vi.fn().mockResolvedValue(action);
    const tensionFindFirst = vi.fn().mockResolvedValue(null);
    const lockRow = vi.fn().mockResolvedValue([]);
    const tx = {
      ...epochTransport(lockRow),
      artifactInputLineage: lineageStore(action),
      action: { findFirst: actionFindFirst },
      tension: { findFirst: tensionFindFirst },
    } as unknown as Prisma.TransactionClient;

    expect(await deriveDispatchNotifications(tx, {
      type: "action.published", workspaceId: "workspace-1", aggregateId: "action-1",
      aggregateType: "Action", payload: {},
    })).toEqual([{
      type: "action.created", entityType: "Action", entityId: "action-1",
      title: "New action: Visible action", bodyMd: "An action item was added to the workspace.",
      lineageActor: expect.objectContaining({ workspaceIds: ["workspace-1"] }),
      lineageRoots: [expect.objectContaining({ kind: "Action", id: action.id, fingerprint: lineageContentFingerprint("Action", action),
        permissionEpochs: expect.objectContaining({ version: 1, entries: expect.arrayContaining([
          { kind: "Action", id: action.id, epoch: "0" }, { kind: "Workspace", id: action.workspaceId, epoch: "0" },
        ]) }),
      })],
    }]);
    expect(actionFindFirst).toHaveBeenCalledWith({
      where: {
        id: "action-1", workspaceId: "workspace-1", isPrivate: false,
        status: { not: "DRAFT" }, archivedAt: null, duplicateOfActionId: null,
      },
    });

    expect(await deriveDispatchNotifications(tx, {
      type: "tension.published", workspaceId: "workspace-1", aggregateId: "tension-1",
      aggregateType: "Tension", payload: {},
    })).toEqual([]);
    expect(tensionFindFirst).toHaveBeenCalledWith({
      where: {
        id: "tension-1", workspaceId: "workspace-1", isPrivate: false,
        status: { not: "DRAFT" }, archivedAt: null,
      },
    });
    const readsBeforeIgnoredEvents = actionFindFirst.mock.calls.length;
    expect(await deriveDispatchNotifications(tx, {
      type: "action.published", workspaceId: "workspace-1", aggregateId: null,
      aggregateType: "Action", payload: {},
    })).toEqual([]);
    expect(await deriveDispatchNotifications(tx, {
      type: "action.published", workspaceId: "workspace-1", aggregateId: "action-1",
      aggregateType: "Action", payload: { runtimeMeta: { replayOfEventId: "original" } },
    })).toEqual([]);
    expect(actionFindFirst).toHaveBeenCalledTimes(readsBeforeIgnoredEvents);
    expect(lockRow).toHaveBeenCalledTimes(2);
    expect(lockRow.mock.invocationCallOrder[0]).toBeLessThan(actionFindFirst.mock.invocationCallOrder[0]);
    expect(lockRow.mock.invocationCallOrder[1]).toBeLessThan(tensionFindFirst.mock.invocationCallOrder[0]);
  });

  it("waits for a concurrent visibility change before reading the publication", async () => {
    let releaseLock: (() => void) | undefined;
    const lockRow = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { releaseLock = resolve; }));
    const actionFindFirst = vi.fn().mockResolvedValue(null);
    const tx = { $queryRaw: lockRow, action: { findFirst: actionFindFirst } } as unknown as Prisma.TransactionClient;
    const pending = deriveDispatchNotifications(tx, {
      type: "action.published", workspaceId: "workspace-1", aggregateId: "action-1",
      aggregateType: "Action", payload: { title: "Previously public title" },
    });

    expect(actionFindFirst).not.toHaveBeenCalled();
    releaseLock?.();
    expect(await pending).toEqual([]);
    expect(actionFindFirst).toHaveBeenCalledOnce();
  });
});

describe("Action assignment dispatch", () => {
  function fixture() {
    const recipients = [
      { userId: "user-2", user: { id: "user-2", email: "assignee@example.com", displayName: "Assignee" } },
      { userId: "user-3", user: { id: "user-3", email: "other@example.com", displayName: "Other" } },
    ];
    const action = actionSource();
    const notifications = new Map<string, any>();
    const create = vi.fn().mockImplementation(async ({ data }) => {
      const row = { id: `notification-${data.userId}-${data.type}`, ...data }; notifications.set(row.id, row); return row;
    });
    const preferences = vi.fn().mockResolvedValue([]);
    const manifests = lineageStore(action);
    const tx = {
      ...epochTransport(undefined, manifests),
      artifactInputLineage: manifests,
      workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) },
      user: { findUnique: vi.fn(async ({ where }) => recipients.find(row => row.userId === where.id)?.user ?? null) },
      action: { findFirst: vi.fn().mockResolvedValue(action) },
      member: {
        findUnique: vi.fn(async ({ where }) => {
          const key = where.workspaceId_userId;
          const recipient = key.workspaceId === "workspace-1" && recipients.find(row => row.userId === key.userId);
          return recipient ? { id: recipient.userId.replace("user-", "member-"), workspaceId: key.workspaceId,
            userId: recipient.userId, role: "CONTRIBUTOR", isActive: true } : null;
        }),
        findFirst: vi.fn().mockResolvedValue({ id: "member-2", workspaceId: "workspace-1", userId: "user-2", isActive: true }),
        findMany: vi.fn().mockImplementation(async ({ where }: { where: { userId?: { in?: string[] } } }) => (
          where.userId?.in
            ? recipients.filter((recipient) => where.userId?.in?.includes(recipient.userId))
            : recipients.map(({ userId }) => ({ userId }))
        )),
      },
      notificationPreference: { findMany: preferences },
      notification: { create, findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn(async ({ where }) => notifications.get(where.id) ?? null) },
    } as unknown as Prisma.TransactionClient;
    const event = {
      id: "event-publication", type: "action.published", workspaceId: "workspace-1",
      aggregateType: "Action", aggregateId: "action-1",
      payload: { actionId: "action-1", assigneeMemberId: "member-2", actorUserId: "publisher-1" },
      attempts: 0, createdAt: new Date("2026-10-05T00:00:00Z"),
    };
    return { tx, event, create, preferences, manifests };
  }

  it("sends one targeted assignment notice and broadcasts to other members with atomic receipts", async () => {
    const { tx, event, create, manifests } = fixture();
    await createNotificationsForEvent(tx, event);
    expect(create.mock.calls.map(([args]) => args.data)).toEqual([
      expect.objectContaining({ userId: "user-2", type: "action.assigned", dedupeKey: "action-assigned:event-publication:user-2" }),
      expect.objectContaining({ userId: "user-3", type: "action.created", title: "New action: Current action title" }),
    ]);
    expect(manifests.create.mock.calls.map(([args]) => args.data)).toEqual([
      expect.objectContaining({ artifactType: "Notification", origin: "DERIVED", rootsJson: [expect.objectContaining({ kind: "Action" }), expect.objectContaining({ kind: "Member" })] }),
      expect.objectContaining({ artifactType: "Notification", origin: "DERIVED", rootsJson: [expect.objectContaining({ kind: "Action" })] }),
    ]);
  });

  it("keeps the generic publication notice when assignment notices are off", async () => {
    const { tx, event, create, preferences } = fixture();
    preferences.mockImplementation(async ({ where }: { where: { notifType: { in: string[] } } }) => (
      where.notifType.in.includes("action.assigned")
        ? [{ userId: "user-2", notifType: "action.assigned", channel: "OFF" }]
        : []
    ));
    await createNotificationsForEvent(tx, event);
    expect(create.mock.calls.map(([args]) => args.data)).toEqual([
      expect.objectContaining({ userId: "user-2", type: "action.created" }),
      expect.objectContaining({ userId: "user-3", type: "action.created" }),
    ]);
  });

  it("sends only a targeted notice after public reassignment", async () => {
    const { tx, event, create } = fixture();
    await createNotificationsForEvent(tx, { ...event, id: "event-reassignment", type: "action.assigned" });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-2", type: "action.assigned" }) });
  });

  it("withholds an original receipt missing its input declaration instead of copying event text", async () => {
    const { tx, event, create, manifests } = fixture();
    const findOriginal = manifests.findFirst.getMockImplementation()!;
    manifests.findFirst.mockImplementation(async args => {
      const row = await findOriginal(args);
      return row && { ...row, inputsJson: undefined };
    });
    await createNotificationsForEvent(tx, { ...event, payload: { ...event.payload, title: "Stale event title" } });
    expect(create).not.toHaveBeenCalled();
    expect(manifests.create).not.toHaveBeenCalled();
  });

  it("withholds unknown current sources instead of copying stale event text", async () => {
    const { tx, event, create, manifests } = fixture();
    manifests.findFirst.mockResolvedValue(null);
    await createNotificationsForEvent(tx, { ...event, payload: { ...event.payload, title: "Old permitted title" } });
    expect(create).not.toHaveBeenCalled();
    expect(manifests.create).not.toHaveBeenCalled();
  });
});

describe("current advice notification dispatch", () => {
  async function fixture() {
    const action = actionSource();
    const request = { id: "request-1", workspaceId: action.workspaceId, processId: "process-1", requestedByUserId: "requester-1",
      status: "ACTIVE", audienceType: "WORKSPACE", messageMd: "Current advice request", deadlineAt: new Date("2026-10-15T12:00:00Z") };
    const manifests = lineageStore(action);
    await manifests.create({ data: { workspaceId: action.workspaceId, artifactType: "AdviceRequest", artifactId: request.id, revision: 1,
      origin: "HUMAN_ORIGINAL", inputsJson: [], rootsJson: [], contentHash: lineageContentFingerprint("AdviceRequest", request) } });
    manifests.create.mockClear();
    const notifications = new Map<string, any>();
    const create = vi.fn(async ({ data }) => {
      const row = { id: "notification-advice", ...data }; notifications.set(row.id, row); return row;
    });
    const findTargets = vi.fn().mockResolvedValue(request);
    const tx = {
      ...epochTransport(), artifactInputLineage: manifests,
      adviceRequest: { findFirst: vi.fn().mockResolvedValue(request), findUnique: findTargets },
      adviceProcess: { findFirst: vi.fn().mockResolvedValue({ id: request.processId, workspaceId: action.workspaceId, subjectType: "ACTION", subjectId: action.id }) },
      action: { findFirst: vi.fn().mockResolvedValue(action) },
      member: { findMany: vi.fn().mockResolvedValue([{ id: "member-2", userId: "user-2" }]) },
      notificationPreference: { findMany: vi.fn().mockResolvedValue([]) }, notification: { create, findFirst: vi.fn(async ({ where }) => notifications.get(where.id) ?? null) },
    } as unknown as Prisma.TransactionClient;
    const event = { id: "advice-event", workspaceId: action.workspaceId, type: "advice.requested", aggregateType: "AdviceRequest", aggregateId: request.id,
      payload: { adviceRequestId: request.id, subjectTitle: "Old revoked title", messageMd: "Old revoked message", deadlineAt: "old deadline", requestedByUserId: "old-requester" },
      attempts: 0, createdAt: new Date("2026-10-12") };
    return { tx, event, create, findTargets, manifests, action, request };
  }

  it("renders current subject, request and deadline and passes both receipts through persistence", async () => {
    const { tx, event, create, manifests, action, request } = await fixture();
    await createNotificationsForEvent(tx, event);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: "user-2", title: `Input requested: ${action.title}`,
      bodyMd: `${request.messageMd}\n\nDeadline: ${request.deadlineAt.toISOString()}`,
    }) });
    expect(manifests.create).toHaveBeenCalledWith({ data: expect.objectContaining({ artifactType: "Notification", origin: "DERIVED",
      rootsJson: [expect.objectContaining({ kind: "AdviceRequest", id: request.id }), expect.objectContaining({ kind: "Action", id: action.id })],
    }) });
    expect(JSON.stringify(create.mock.calls)).not.toContain("Old revoked");
  });

  it("does not resolve recipients or write notifications when the current request has unknown lineage", async () => {
    const { tx, event, create, findTargets, manifests } = await fixture();
    manifests.findFirst.mockResolvedValue(null);
    await createNotificationsForEvent(tx, event);
    expect(findTargets).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("deriveAdviceNotificationContent", () => {
  it("builds input-requested notification content for the parent entity", () => {
    expect(deriveAdviceNotificationContent({
      type: "advice.requested",
      payload: {
        subjectType: "TENSION",
        subjectId: "tension-1",
        subjectTitle: "Clarify launch owner",
        messageMd: "Please confirm who owns this.",
        deadlineAt: "2026-06-26T12:00:00.000Z",
      },
    })).toEqual({
      entityType: "Tension",
      entityId: "tension-1",
      title: "Input requested: Clarify launch owner",
      bodyMd: "Please confirm who owns this.\n\nDeadline: 2026-06-26T12:00:00.000Z",
    });
  });

  it("builds reminder notification content", () => {
    expect(deriveAdviceNotificationContent({
      type: "advice.reminder_due",
      payload: {
        subjectType: "PROPOSAL",
        subjectId: "proposal-1",
        subjectTitle: "Adopt async standups",
        messageMd: "Please advise before Friday.",
      },
    })).toEqual({
      entityType: "Proposal",
      entityId: "proposal-1",
      title: "Reminder: input requested for Adopt async standups",
      bodyMd: "Please advise before Friday.",
    });
  });
});
