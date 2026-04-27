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

    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("knowledge.sync.brain-article");
    expect(jobs[0].payload).toEqual({ articleId: "art-1" });
    expect(jobs[0].workspaceId).toBe("ws-1");
  });

  it("derives knowledge.sync.brain-article for brain-article.created event", () => {
    const jobs = deriveJobsForEvent({
      id: "event-2",
      type: "brain-article.created",
      workspaceId: "ws-1",
      payload: { articleId: "art-1" },
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("knowledge.sync.brain-article");
  });
});
