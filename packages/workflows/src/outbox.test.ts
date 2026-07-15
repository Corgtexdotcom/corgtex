import { describe, expect, it } from "vitest";
import { calculateRetryDelayMs, deriveAdviceNotificationContent } from "./outbox";
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

  it("runs company understanding after brain source absorption", () => {
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
        type: "agent.company-understanding",
        payload: { sourceId: "source-1" },
        dependsOnDedupeKey: "event-brain-source:brain-absorb",
        dedupeKey: "event-brain-source:company-understanding",
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
