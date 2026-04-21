import { describe, it, expect, vi } from "vitest";
import { generateMemberBriefing } from "./member-briefing";
import * as membersModule from "./members";
import { defaultModelGateway } from "@corgtex/models";

vi.mock("./members", () => ({
  getMemberProfile: vi.fn(),
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    chat: vi.fn(),
  },
}));

describe("generateMemberBriefing", () => {
  it("should return a formatted briefing using the model gateway", async () => {
    // Setup mock profile
    const mockProfile = {
      member: {
        user: { displayName: "Jan Brezina" },
        roleAssignments: [
          { role: { name: "Tech Lead", circle: { name: "General" } } }
        ],
        assignedActions: [
          { title: "Fix the thing", status: "OPEN" }
        ]
      },
      meetings: [
        { title: "Weekly Sync", recordedAt: new Date(), summaryMd: "We talked about stuff" }
      ],
      authoredTensions: [
        { title: "Too many meetings", status: "OPEN" }
      ]
    };
    (membersModule.getMemberProfile as any).mockResolvedValue(mockProfile);

    const actor = { kind: "user", user: { id: "u1", email: "jan@example.com" } } as any;
    
    const briefing = await generateMemberBriefing(actor, "w1", "m1");

    expect(briefing).toEqual({
      summary: "This is a generated AI summary for the member, synthesizing their recent priorities, meetings, and insights.",
      priorities: ["Resolve outstanding proposals", "Schedule sync for next quarter"],
      followUps: ["Review Q3 budget tension"],
      insights: ["Highly active in Governance cluster"]
    });
  });
});
