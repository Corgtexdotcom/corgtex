import { describe, expect, it } from "vitest";

import {
  capDashboardUnreadNotificationCount,
  isDashboardUnreadNotificationCountCapped,
  selectDashboardActionItems,
  selectDashboardFeedItems,
  selectDashboardKnowledgeArticles,
  selectDashboardNotificationPreviewLimit,
  selectDashboardOpenProposals,
  selectLatestMeetingRecap,
} from "./dashboard-briefing";

function article(params: {
  id: string;
  type?: string;
  authority?: string;
  isPrivate?: boolean;
  createdAt: string;
  updatedAt?: string;
}) {
  return {
    id: params.id,
    title: params.id,
    slug: params.id,
    type: params.type ?? "REFERENCE",
    authority: params.authority ?? "REFERENCE",
    isPrivate: params.isPrivate ?? false,
    bodyMd: `${params.id} body`,
    createdAt: new Date(params.createdAt),
    updatedAt: new Date(params.updatedAt ?? params.createdAt),
  };
}

function meeting(params: {
  id: string;
  recordedAt: string;
  summaryMd?: string | null;
  title?: string | null;
}) {
  return {
    id: params.id,
    recordedAt: new Date(params.recordedAt),
    summaryMd: params.summaryMd ?? "Weekly recap",
    title: params.title ?? params.id,
    participantIds: [],
  };
}

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

  it("ranks newly created articles ahead of old articles that were only updated recently", () => {
    const now = new Date("2026-05-27T12:00:00.000Z");
    const selected = selectDashboardKnowledgeArticles([
      {
        id: "old-recently-updated",
        authority: "REFERENCE",
        isPrivate: false,
        createdAt: new Date("2026-03-01T12:00:00.000Z"),
        updatedAt: new Date("2026-05-27T11:00:00.000Z"),
      },
      {
        id: "new-article",
        authority: "REFERENCE",
        isPrivate: false,
        createdAt: new Date("2026-05-26T12:00:00.000Z"),
        updatedAt: new Date("2026-05-26T12:00:00.000Z"),
      },
    ], now, 2);

    expect(selected.map((article) => article.id)).toEqual(["new-article", "old-recently-updated"]);
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

describe("selectDashboardFeedItems", () => {
  it("keeps the latest meeting in the first two items even when fresher articles exist", () => {
    const items = selectDashboardFeedItems({
      now: new Date("2026-05-27T12:00:00.000Z"),
      limit: 5,
      articles: [
        article({ id: "article-1", createdAt: "2026-05-27T10:00:00.000Z" }),
        article({ id: "article-2", createdAt: "2026-05-26T10:00:00.000Z" }),
        article({ id: "article-3", createdAt: "2026-05-25T10:00:00.000Z" }),
      ],
      meetings: [
        meeting({ id: "weekly", recordedAt: "2026-05-20T10:00:00.000Z" }),
      ],
    });

    expect(items.slice(0, 2).map((item) => item.id)).toContain("weekly");
    expect(items.map((item) => item.id)).toEqual([
      "article-1",
      "weekly",
      "article-2",
      "article-3",
    ]);
  });

  it("uses freshness order after the meeting boost", () => {
    const items = selectDashboardFeedItems({
      now: new Date("2026-05-27T12:00:00.000Z"),
      limit: 5,
      articles: [
        article({ id: "freshest", createdAt: "2026-05-27T09:00:00.000Z" }),
        article({ id: "third", createdAt: "2026-05-25T09:00:00.000Z" }),
        article({ id: "second", createdAt: "2026-05-26T09:00:00.000Z" }),
      ],
      meetings: [
        meeting({ id: "older-meeting", recordedAt: "2026-05-20T09:00:00.000Z" }),
      ],
    });

    expect(items.map((item) => item.id)).toEqual([
      "freshest",
      "older-meeting",
      "second",
      "third",
    ]);
  });

  it("keeps recently updated old articles below new articles and the latest meeting", () => {
    const items = selectDashboardFeedItems({
      now: new Date("2026-05-27T12:00:00.000Z"),
      limit: 5,
      articles: [
        article({
          id: "old-recently-updated",
          createdAt: "2026-03-01T09:00:00.000Z",
          updatedAt: "2026-05-27T11:00:00.000Z",
        }),
        article({
          id: "new-article",
          createdAt: "2026-05-26T09:00:00.000Z",
        }),
      ],
      meetings: [
        meeting({ id: "weekly", recordedAt: "2026-05-20T09:00:00.000Z" }),
      ],
    });

    expect(items.map((item) => item.id)).toEqual([
      "new-article",
      "weekly",
      "old-recently-updated",
    ]);
  });

  it("ranks fresh public Brain articles before older stable articles", () => {
    const items = selectDashboardFeedItems({
      now: new Date("2026-05-27T12:00:00.000Z"),
      limit: 2,
      articles: [
        article({
          id: "old-authoritative",
          authority: "AUTHORITATIVE",
          createdAt: "2026-03-01T12:00:00.000Z",
        }),
        article({
          id: "fresh-incident",
          type: "INCIDENT",
          authority: "DRAFT",
          createdAt: "2026-05-26T12:00:00.000Z",
        }),
      ],
      meetings: [],
    });

    expect(items.map((item) => item.id)).toEqual(["fresh-incident", "old-authoritative"]);
  });

  it("falls back to stable reference articles when no fresh public article exists", () => {
    const items = selectDashboardFeedItems({
      now: new Date("2026-05-27T12:00:00.000Z"),
      limit: 1,
      articles: [
        article({
          id: "private-fresh",
          isPrivate: true,
          createdAt: "2026-05-26T12:00:00.000Z",
        }),
        article({
          id: "old-reference",
          authority: "REFERENCE",
          createdAt: "2026-03-01T12:00:00.000Z",
        }),
      ],
      meetings: [],
    });

    expect(items.map((item) => item.id)).toEqual(["old-reference"]);
  });
});

describe("dashboard work rail selectors", () => {
  it("keeps team-wide public open actions even when they are not assigned to the current user", () => {
    const selected = selectDashboardActionItems([
      {
        id: "team-action",
        status: "OPEN",
        isPrivate: false,
        archivedAt: null,
        dueAt: null,
        createdAt: new Date("2026-05-26T12:00:00.000Z"),
      },
    ]);

    expect(selected.map((action) => action.id)).toEqual(["team-action"]);
  });

  it("excludes private, archived, and completed actions", () => {
    const selected = selectDashboardActionItems([
      {
        id: "private",
        status: "OPEN",
        isPrivate: true,
        archivedAt: null,
        dueAt: null,
        createdAt: new Date("2026-05-26T12:00:00.000Z"),
      },
      {
        id: "archived",
        status: "OPEN",
        isPrivate: false,
        archivedAt: new Date("2026-05-27T12:00:00.000Z"),
        dueAt: null,
        createdAt: new Date("2026-05-26T12:00:00.000Z"),
      },
      {
        id: "completed",
        status: "COMPLETED",
        isPrivate: false,
        archivedAt: null,
        dueAt: null,
        createdAt: new Date("2026-05-26T12:00:00.000Z"),
      },
    ]);

    expect(selected).toEqual([]);
  });

  it("sorts due actions before undated actions, then newest undated first", () => {
    const selected = selectDashboardActionItems([
      {
        id: "new-undated",
        status: "OPEN",
        isPrivate: false,
        archivedAt: null,
        dueAt: null,
        createdAt: new Date("2026-05-26T12:00:00.000Z"),
      },
      {
        id: "due-later",
        status: "IN_PROGRESS",
        isPrivate: false,
        archivedAt: null,
        dueAt: new Date("2026-06-02T12:00:00.000Z"),
        createdAt: new Date("2026-05-20T12:00:00.000Z"),
      },
      {
        id: "due-sooner",
        status: "OPEN",
        isPrivate: false,
        archivedAt: null,
        dueAt: new Date("2026-05-28T12:00:00.000Z"),
        createdAt: new Date("2026-05-19T12:00:00.000Z"),
      },
      {
        id: "old-undated",
        status: "OPEN",
        isPrivate: false,
        archivedAt: null,
        dueAt: null,
        createdAt: new Date("2026-05-20T12:00:00.000Z"),
      },
    ]);

    expect(selected.map((action) => action.id)).toEqual([
      "due-sooner",
      "due-later",
      "new-undated",
      "old-undated",
    ]);
  });

  it("keeps only public open proposals", () => {
    const selected = selectDashboardOpenProposals([
      {
        id: "open-public",
        status: "OPEN",
        isPrivate: false,
        archivedAt: null,
        createdAt: new Date("2026-05-26T12:00:00.000Z"),
      },
      {
        id: "private",
        status: "OPEN",
        isPrivate: true,
        archivedAt: null,
        createdAt: new Date("2026-05-27T12:00:00.000Z"),
      },
      {
        id: "resolved",
        status: "RESOLVED",
        isPrivate: false,
        archivedAt: null,
        createdAt: new Date("2026-05-27T12:00:00.000Z"),
      },
      {
        id: "archived",
        status: "OPEN",
        isPrivate: false,
        archivedAt: new Date("2026-05-27T12:00:00.000Z"),
        createdAt: new Date("2026-05-27T12:00:00.000Z"),
      },
    ]);

    expect(selected.map((proposal) => proposal.id)).toEqual(["open-public"]);
  });
});

describe("dashboard briefing presentation helpers", () => {
  it("caps large unread notification counts for the homepage summary", () => {
    expect(capDashboardUnreadNotificationCount(133)).toBe(99);
    expect(isDashboardUnreadNotificationCountCapped(133)).toBe(true);
    expect(capDashboardUnreadNotificationCount(12)).toBe(12);
    expect(isDashboardUnreadNotificationCountCapped(12)).toBe(false);
  });

  it("shows fewer notification previews when the unread pile is large", () => {
    expect(selectDashboardNotificationPreviewLimit(133)).toBe(2);
    expect(selectDashboardNotificationPreviewLimit(20)).toBe(3);
  });
});
