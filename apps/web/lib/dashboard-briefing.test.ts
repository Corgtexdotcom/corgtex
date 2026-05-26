import { describe, expect, it } from "vitest";

import { selectDashboardKnowledgeArticles, selectLatestMeetingRecap } from "./dashboard-briefing";

describe("selectDashboardKnowledgeArticles", () => {
  it("prefers fresh public Brain articles over older authoritative articles", () => {
    const now = new Date("2026-05-26T12:00:00.000Z");
    const selected = selectDashboardKnowledgeArticles([
      {
        id: "old-authoritative",
        authority: "AUTHORITATIVE",
        isPrivate: false,
        createdAt: new Date("2026-03-01T12:00:00.000Z"),
        updatedAt: new Date("2026-03-02T12:00:00.000Z"),
      },
      {
        id: "fresh-reference",
        authority: "REFERENCE",
        isPrivate: false,
        createdAt: new Date("2026-05-25T12:00:00.000Z"),
        updatedAt: new Date("2026-05-25T12:00:00.000Z"),
      },
    ], now, 1);

    expect(selected.map((article) => article.id)).toEqual(["fresh-reference"]);
  });

  it("falls back to stable public authoritative or reference articles", () => {
    const now = new Date("2026-05-26T12:00:00.000Z");
    const selected = selectDashboardKnowledgeArticles([
      {
        id: "old-draft",
        authority: "DRAFT",
        isPrivate: false,
        createdAt: new Date("2026-03-01T12:00:00.000Z"),
        updatedAt: new Date("2026-03-01T12:00:00.000Z"),
      },
      {
        id: "old-reference",
        authority: "REFERENCE",
        isPrivate: false,
        createdAt: new Date("2026-04-01T12:00:00.000Z"),
        updatedAt: new Date("2026-04-01T12:00:00.000Z"),
      },
      {
        id: "private-authoritative",
        authority: "AUTHORITATIVE",
        isPrivate: true,
        createdAt: new Date("2026-05-25T12:00:00.000Z"),
        updatedAt: new Date("2026-05-25T12:00:00.000Z"),
      },
    ], now, 1);

    expect(selected.map((article) => article.id)).toEqual(["old-reference"]);
  });
});

describe("selectLatestMeetingRecap", () => {
  it("uses the latest meeting with a summary even when participant ids are empty", () => {
    const selected = selectLatestMeetingRecap([
      {
        id: "latest-no-summary",
        recordedAt: new Date("2026-05-26T12:00:00.000Z"),
        summaryMd: null,
        participantIds: [],
      },
      {
        id: "latest-summary",
        recordedAt: new Date("2026-05-20T12:00:00.000Z"),
        summaryMd: "Weekly recap",
        participantIds: [],
      },
    ]);

    expect(selected?.id).toBe("latest-summary");
  });
});
