import { describe, expect, it } from "vitest";
import {
  dealPipelineSort,
  dealStageAgeDays,
  dealStageStartedAt,
  dealTransitionKey,
  dealsGroupedByStage,
  nextDealFollowUp,
} from "./deal-pipeline";

describe("deal pipeline helpers", () => {
  it("groups deals by known stage and preserves unexpected stages", () => {
    const deals = [
      { id: "deal-1", stage: "LEAD" },
      { id: "deal-2", stage: "PROPOSAL" },
      { id: "deal-3", stage: "RENEWAL" },
    ];

    const grouped = dealsGroupedByStage(deals);

    expect(grouped.LEAD).toEqual([deals[0]]);
    expect(grouped.PROPOSAL).toEqual([deals[1]]);
    expect(grouped.CLOSED_WON).toEqual([]);
    expect(grouped.RENEWAL).toEqual([deals[2]]);
  });

  it("uses the shared kanban transition-key contract", () => {
    expect(dealTransitionKey("deal-1", "CLOSED_WON")).toBe("deal-1:CLOSED_WON");
  });

  it("uses latest stage transition for stage age and date sorting", () => {
    const deal = {
      id: "deal-1",
      title: "Pilot",
      stage: "PROPOSAL",
      createdAt: "2026-06-01T00:00:00.000Z",
      valueCents: 2500000,
      stageTransitions: [
        {
          id: "transition-1",
          fromStage: "QUALIFIED",
          toStage: "PROPOSAL",
          createdAt: "2026-06-15T00:00:00.000Z",
        },
      ],
    };

    expect(dealStageStartedAt(deal)).toBe("2026-06-15T00:00:00.000Z");
    expect(dealStageAgeDays(deal, new Date("2026-06-18T00:00:00.000Z"))).toBe(3);
    expect(dealPipelineSort(deal)).toEqual({
      priority: 2500000,
      date: "2026-06-15T00:00:00.000Z",
      alpha: "Pilot",
    });
  });

  it("prefers the tracked next follow-up for date sorting", () => {
    const deal = {
      id: "deal-1",
      title: "Pilot",
      stage: "PROPOSAL",
      createdAt: "2026-06-01T00:00:00.000Z",
      activities: [
        {
          id: "activity-1",
          title: "Send revised pilot terms",
          type: "TASK",
          createdAt: "2026-06-17T00:00:00.000Z",
        },
      ],
    };

    expect(nextDealFollowUp(deal)).toEqual(deal.activities[0]);
    expect(dealPipelineSort(deal).date).toBe("2026-06-17T00:00:00.000Z");
  });
});
