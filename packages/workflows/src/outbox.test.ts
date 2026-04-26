import { describe, expect, it } from "vitest";
import { calculateRetryDelayMs } from "./outbox";
import { deriveJobsForEvent, triageBucketStart } from "./derive-jobs";
import { deriveNotificationsForEvent } from "./derive-notifications";

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

    expect(jobs).toHaveLength(5);
    expect(jobs.map((job) => job.type)).toEqual([
      "knowledge.sync.proposal",
      "agent.constitution-update-trigger",
      "agent.constitution-synthesis",
      "governance.score",
      "knowledge.sync.event",
    ]);
  });

  it("creates triage jobs for submitted work", () => {
    const createdAt = new Date("2026-04-03T12:03:30.000Z");
    const jobs = deriveJobsForEvent({
      id: "event-2",
      type: "spend.submitted",
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

    expect(jobs).toHaveLength(5);
    expect(jobs.map((job) => job.type)).toEqual([
      "knowledge.sync.meeting",
      "agent.meeting-summary",
      "agent.action-extraction",
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

    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.type).toBe("knowledge.sync.document");
    expect(jobs[1]?.type).toBe("knowledge.sync.event");
  });

  it("creates reconciliation prep jobs for paid spends", () => {
    const jobs = deriveJobsForEvent({
      id: "event-5",
      type: "spend.paid",
      workspaceId: "workspace-1",
      payload: {
        spendId: "spend-1",
      },
    });

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      type: "agent.finance-reconciliation-prep",
      payload: {
        spendId: "spend-1",
      },
    });
    expect(jobs[1]?.type).toBe("knowledge.sync.event");
  });

  it("caps retry backoff at five minutes", () => {
    expect(calculateRetryDelayMs(1)).toBe(5_000);
    expect(calculateRetryDelayMs(2)).toBe(10_000);
    expect(calculateRetryDelayMs(20)).toBe(300_000);
  });
});

describe("deriveNotificationsForEvent", () => {
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
        title: "Proposal for review: Adopt async standup policy",
        bodyMd: "The proposal **Adopt async standup policy** is awaiting approval.",
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
        title: "Proposal submitted for review",
        bodyMd: "A proposal is awaiting approval in the workspace dashboard.",
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
        title: "Proposal for review: Hire a PM for growth",
        bodyMd: "The proposal **Hire a PM for growth** is awaiting approval.",
      },
    ]);
  });

  it("creates a notification for spend.opened events", () => {
    const notifications = deriveNotificationsForEvent({
      type: "spend.opened",
      workspaceId: "workspace-1",
      aggregateType: "SpendRequest",
      aggregateId: "spend-1",
      payload: {
        spendId: "spend-1",
        title: "AWS hosting for Q3",
      },
    });

    expect(notifications).toEqual([
      {
        type: "spend.opened",
        entityType: "SpendRequest",
        entityId: "spend-1",
        title: "Spend review: AWS hosting for Q3",
        bodyMd: "The spend request **AWS hosting for Q3** is awaiting finance review.",
      },
    ]);
  });

  it("uses payload titles for created actions", () => {
    const notifications = deriveNotificationsForEvent({
      type: "action.created",
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
});
