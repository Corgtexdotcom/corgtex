import { describe, it, expect } from "vitest";
import { generateMemberBriefing } from "./member-briefing";
import type { AppActor } from "@corgtex/shared";

describe("generateMemberBriefing", () => {
  it("should return a mocked briefing for a member", async () => {
    const mockActor: AppActor = {
      kind: "user",
      user: { id: "user-1", email: "test@example.com", displayName: "Test" },
    };

    const result = await generateMemberBriefing(mockActor, "workspace-1", "member-1");

    expect(result.summary).toBeDefined();
    expect(result.priorities.length).toBeGreaterThan(0);
    expect(result.followUps.length).toBeGreaterThan(0);
    expect(result.insights.length).toBeGreaterThan(0);
  });
});
