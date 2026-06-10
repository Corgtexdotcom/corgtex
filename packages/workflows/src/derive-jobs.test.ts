import { describe, it, expect } from "vitest";
import { deriveJobsForEvent } from "./derive-jobs";

describe("deriveJobsForEvent", () => {
  it("derives knowledge.sync.brain-article for brain-article.published event", () => {
    const jobs = deriveJobsForEvent({
      id: "event-1",
      type: "brain-article.published",
      workspaceId: "ws-1",
      payload: { articleId: "art-1" },
    });

    expect(jobs).toHaveLength(2);
    expect(jobs[0].type).toBe("knowledge.sync.brain-article");
    expect(jobs[0].payload).toEqual({ articleId: "art-1" });
    expect(jobs[0].workspaceId).toBe("ws-1");
    expect(jobs[1]).toMatchObject({
      type: "context-graph.sync",
      payload: { sourceType: "BRAIN_ARTICLE", sourceId: "art-1" },
      dependsOnDedupeKey: "event-1:brain-article-knowledge-sync",
    });
  });

  it("derives knowledge.sync.brain-article for brain-article.created event", () => {
    const jobs = deriveJobsForEvent({
      id: "event-2",
      type: "brain-article.created",
      workspaceId: "ws-1",
      payload: { articleId: "art-1" },
    });

    expect(jobs).toHaveLength(2);
    expect(jobs[0].type).toBe("knowledge.sync.brain-article");
    expect(jobs[1].type).toBe("context-graph.sync");
  });

  it("derives an idempotent welcome newspaper job for demo lead captures", () => {
    const jobs = deriveJobsForEvent({
      id: "event-demo-1",
      type: "demo-lead.captured",
      workspaceId: "ws-1",
      payload: { demoLeadId: "lead-1", email: "lead@example.com" },
    });

    expect(jobs).toEqual([
      {
        workspaceId: "ws-1",
        eventId: "event-demo-1",
        type: "email.demo-welcome-newspaper",
        payload: { demoLeadId: "lead-1" },
        dedupeKey: "ws-1:demo-welcome-newspaper:lead-1",
      },
    ]);
  });

  it("derives a role onboarding intro job for role assignments", () => {
    const jobs = deriveJobsForEvent({
      id: "event-role-1",
      type: "role.assigned",
      workspaceId: "ws-1",
      payload: { onboardingSessionId: "onboarding-1" },
    });

    expect(jobs).toEqual([
      {
        workspaceId: "ws-1",
        eventId: "event-role-1",
        type: "agent.role-onboarding-intro",
        payload: { onboardingSessionId: "onboarding-1" },
        dedupeKey: "event-role-1:role-onboarding-intro:onboarding-1",
      },
    ]);
  });

  it("derives member context graph sync jobs for member lifecycle events", () => {
    for (const type of ["member.created", "member.updated", "member.deactivated", "member.reactivated"]) {
      const jobs = deriveJobsForEvent({
        id: `event-${type}`,
        type,
        workspaceId: "ws-1",
        payload: { memberId: "member-1" },
      });

      expect(jobs).toEqual([
        {
          workspaceId: "ws-1",
          eventId: `event-${type}`,
          type: "context-graph.sync",
          payload: { sourceType: "MEMBER", sourceId: "member-1" },
          dedupeKey: `event-${type}:context-graph-sync:MEMBER:member-1`,
          dependsOnDedupeKey: undefined,
        },
      ]);
    }
  });

  it("derives member context graph sync jobs for role assignment changes", () => {
    const assigned = deriveJobsForEvent({
      id: "event-assign-1",
      type: "role.assigned",
      workspaceId: "ws-1",
      payload: { roleId: "role-1", memberId: "member-1" },
    });
    expect(assigned).toContainEqual(expect.objectContaining({
      type: "context-graph.sync",
      payload: { sourceType: "MEMBER", sourceId: "member-1" },
    }));

    const unassigned = deriveJobsForEvent({
      id: "event-unassign-1",
      type: "role.unassigned",
      workspaceId: "ws-1",
      payload: { roleId: "role-1", memberId: "member-1", assignmentId: "assignment-1" },
    });
    expect(unassigned).toContainEqual(expect.objectContaining({
      type: "context-graph.sync",
      payload: { sourceType: "MEMBER", sourceId: "member-1" },
    }));
  });

  it("derives goal context graph sync jobs for goal events", () => {
    for (const type of ["goal.created", "goal.updated"]) {
      const jobs = deriveJobsForEvent({
        id: `event-${type}`,
        type,
        workspaceId: "ws-1",
        payload: { goalId: "goal-1", fields: ["title"] },
      });

      expect(jobs).toEqual([
        expect.objectContaining({
          type: "context-graph.sync",
          payload: { sourceType: "GOAL", sourceId: "goal-1" },
          dedupeKey: `event-${type}:context-graph-sync:GOAL:goal-1`,
        }),
      ]);
    }
  });
});
