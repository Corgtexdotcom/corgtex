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
