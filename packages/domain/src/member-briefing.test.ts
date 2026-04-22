import { describe, it, expect } from "vitest";
import { generateMemberBriefing } from "./member-briefing";
import type { AppActor } from "@corgtex/shared";

describe("generateMemberBriefing", () => {
  it("returns the default briefing shape for a member", async () => {
    const mockActor: AppActor = {
      kind: "user",
      user: { id: "user-1", email: "test@example.com", displayName: "Test" },
    };

    const result = await generateMemberBriefing(mockActor, "workspace-1", "member-1");

    expect(result).toEqual({
      summary: "This is a generated AI summary for the member, synthesizing their recent priorities, meetings, and insights.",
      priorities: ["Resolve outstanding proposals", "Schedule sync for next quarter"],
      followUps: ["Review Q3 budget tension"],
      insights: ["Highly active in Governance cluster"],
    });
  });
});
