import { describe, expect, it } from "vitest";
import { deriveJobsForEvent } from "./derive-jobs";

describe("webhook delivery integration with outbox", () => {
  it("deriveJobsForEvent still works correctly for standard events", () => {
    const jobs = deriveJobsForEvent({
      id: "evt-wh-1",
      type: "proposal.submitted",
      workspaceId: "ws-1",
      payload: {},
      createdAt: new Date("2026-04-04T10:00:00.000Z"),
    });

    // Should have the triage job
    expect(jobs.some((j) => j.type === "agent.inbox-triage")).toBe(true);
    // Webhook delivery jobs are created at dispatch time (not in deriveJobsForEvent),
    // so they should not appear here
    expect(jobs.filter((j) => j.type === "webhook.deliver")).toHaveLength(0);
  });

  it("proposal.approved still creates all expected jobs", () => {
    const jobs = deriveJobsForEvent({
      id: "evt-wh-2",
      type: "proposal.approved",
      workspaceId: "ws-1",
      payload: { subjectId: "prop-1" },
    });

    const types = jobs.map((j) => j.type);
    expect(types).toContain("knowledge.sync.proposal");
    expect(types).toContain("agent.constitution-update-trigger");
    expect(types).toContain("agent.constitution-synthesis");
    expect(types).toContain("governance.score");
  });

  it("meeting.created still creates summary and extraction with dependency", () => {
    const jobs = deriveJobsForEvent({
      id: "evt-wh-3",
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
});
