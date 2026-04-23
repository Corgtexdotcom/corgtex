import { describe, expect, it } from "vitest";
import { deriveJobsForEvent, triageBucketStart } from "./derive-jobs";
import { deriveNotificationsForEvent } from "./derive-notifications";

describe("deriveJobsForEvent edge cases", () => {
  it("returns empty for unknown event types", () => {
    const jobs = deriveJobsForEvent({
      id: "evt-1",
      type: "something.unknown",
      workspaceId: "ws-1",
      payload: {},
    });

    expect(jobs).toHaveLength(0);
  });

  it("creates triage jobs for action and tension events", () => {
    const actionJobs = deriveJobsForEvent({
      id: "evt-2",
      type: "action.created",
      workspaceId: "ws-1",
      payload: { actionId: "act-1" },
    });
    const tensionJobs = deriveJobsForEvent({
      id: "evt-3",
      type: "tension.created",
      workspaceId: "ws-1",
      payload: { tensionId: "ten-1" },
    });

    expect(actionJobs.some((job) => job.type === "agent.inbox-triage")).toBe(true);
    expect(tensionJobs.some((job) => job.type === "agent.inbox-triage")).toBe(true);
  });

  it("creates constitution-synthesis and governance.score jobs for proposal.approved", () => {
    const jobs = deriveJobsForEvent({
      id: "evt-gov",
      type: "proposal.approved",
      workspaceId: "ws-1",
      payload: { subjectId: "prop-1" },
    });

    expect(jobs.some((j) => j.type === "agent.constitution-synthesis")).toBe(true);
    expect(jobs.some((j) => j.type === "governance.score")).toBe(true);
    expect(jobs.some((j) => j.type === "knowledge.sync.proposal")).toBe(true);
    expect(jobs.some((j) => j.type === "agent.constitution-update-trigger")).toBe(true);
  });

  it("does not create knowledge sync job for proposal.approved without subjectId", () => {
    const jobs = deriveJobsForEvent({
      id: "evt-4",
      type: "proposal.approved",
      workspaceId: "ws-1",
      payload: {},
    });

    expect(jobs.filter((job) => job.type === "knowledge.sync.proposal")).toHaveLength(0);
  });

  it("coalesces triage jobs into a shared five-minute bucket", () => {
    const firstTime = new Date("2026-04-03T12:01:00.000Z");
    const secondTime = new Date("2026-04-03T12:04:59.000Z");

    const firstJobs = deriveJobsForEvent({
      id: "evt-5",
      type: "proposal.submitted",
      workspaceId: "ws-1",
      payload: {},
      createdAt: firstTime,
    });
    const secondJobs = deriveJobsForEvent({
      id: "evt-6",
      type: "spend.submitted",
      workspaceId: "ws-1",
      payload: {},
      createdAt: secondTime,
    });

    expect(firstJobs[0]?.dedupeKey).toBe(`ws-1:triage:${triageBucketStart(firstTime).toISOString()}`);
    expect(secondJobs[0]?.dedupeKey).toBe(firstJobs[0]?.dedupeKey);
  });

  it("creates a new triage key when events cross the coalescing window", () => {
    const firstJobs = deriveJobsForEvent({
      id: "evt-7",
      type: "proposal.submitted",
      workspaceId: "ws-1",
      payload: {},
      createdAt: new Date("2026-04-03T12:04:59.000Z"),
    });
    const secondJobs = deriveJobsForEvent({
      id: "evt-8",
      type: "proposal.submitted",
      workspaceId: "ws-1",
      payload: {},
      createdAt: new Date("2026-04-03T12:05:00.000Z"),
    });

    expect(firstJobs[0]?.dedupeKey).not.toBe(secondJobs[0]?.dedupeKey);
  });

  it("makes action-extraction depend on meeting-summary", () => {
    const jobs = deriveJobsForEvent({
      id: "evt-dep",
      type: "meeting.created",
      workspaceId: "ws-1",
      payload: { meetingId: "mtg-1" },
    });

    const summaryJob = jobs.find((j) => j.type === "agent.meeting-summary");
    const extractionJob = jobs.find((j) => j.type === "agent.action-extraction");

    expect(summaryJob).toBeDefined();
    expect(extractionJob).toBeDefined();
    expect(extractionJob?.dependsOnDedupeKey).toBe(summaryJob?.dedupeKey);
  });

  it("creates replay triage jobs with their own dedupe key", () => {
    const jobs = deriveJobsForEvent({
      id: "evt-9",
      type: "proposal.submitted",
      workspaceId: "ws-1",
      payload: {
        runtimeMeta: {
          replayOfEventId: "evt-1",
        },
      },
      createdAt: new Date("2026-04-03T12:03:00.000Z"),
    });

    expect(jobs[0]).toMatchObject({
      type: "agent.inbox-triage",
      dedupeKey: "ws-1:triage:replay:evt-9",
      payload: {
        replayOfEventId: "evt-1",
      },
    });
  });
});

describe("deriveNotificationsForEvent edge cases", () => {
  it("returns empty for unknown event types", () => {
    const notifications = deriveNotificationsForEvent({
      type: "something.unknown",
      workspaceId: "ws-1",
      aggregateType: null,
      aggregateId: null,
      payload: {},
    });

    expect(notifications).toHaveLength(0);
  });

  it("skips notification creation for replayed events", () => {
    const notifications = deriveNotificationsForEvent({
      type: "meeting.created",
      workspaceId: "ws-1",
      aggregateType: "Meeting",
      aggregateId: "meeting-1",
      payload: {
        meetingId: "meeting-1",
        title: "Weekly sync",
        runtimeMeta: {
          replayOfEventId: "evt-1",
        },
      },
    });

    expect(notifications).toHaveLength(0);
  });
});
