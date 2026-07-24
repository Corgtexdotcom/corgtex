import { describe, expect, it } from "vitest";

import {
  compactSummaryMatches,
  meetingDetailUrl,
  normalizeBaseUrl,
  rectsOverlap,
  selectMeetingForSmoke,
} from "./meeting-processing-spine-smoke.mjs";

describe("meeting processing spine smoke helpers", () => {
  it("normalizes base URLs and meeting detail URLs", () => {
    expect(normalizeBaseUrl("https://app.corgtex.com/")).toBe("https://app.corgtex.com");
    expect(meetingDetailUrl("https://app.corgtex.com/", "ws-1", "meeting-1")).toBe(
      "https://app.corgtex.com/workspaces/ws-1/meetings/meeting-1",
    );
  });

  it("matches complete and review-needed compact summary copy", () => {
    expect(compactSummaryMatches("Ready · All processing steps complete · Show steps")).toBe(true);
    expect(compactSummaryMatches("Ready · 3 extracted items need review · Review items · Show steps")).toBe(true);
    expect(compactSummaryMatches("Transcript processing · Summarizing meeting is in progress · Hide steps")).toBe(false);
  });

  it("selects the deterministic completed transcript meeting first", () => {
    const meetings = [
      { id: "meeting-empty", title: "Innovation & AI Working Group Kickoff", transcript: null, aiProcessedAt: null, summaryMd: null },
      { id: "meeting-other", title: "Other", transcript: "Transcript", aiProcessedAt: "2026-07-24T10:00:00.000Z", summaryMd: "Summary" },
      { id: "meeting-target", title: "Innovation & AI Working Group Kickoff", transcript: "Transcript", aiProcessedAt: "2026-07-24T10:00:00.000Z", summaryMd: "Summary" },
    ];

    expect(selectMeetingForSmoke(meetings)?.id).toBe("meeting-target");
    expect(selectMeetingForSmoke(meetings, { meetingId: "meeting-other" })?.id).toBe("meeting-other");
  });

  it("falls back to any completed transcript meeting when the target title is absent", () => {
    expect(selectMeetingForSmoke([
      { id: "meeting-1", title: "No transcript", transcript: null, aiProcessedAt: "2026-07-24T10:00:00.000Z" },
      { id: "meeting-2", title: "Ready", transcript: "Transcript", aiProcessedAt: null, summaryMd: "Summary" },
    ])?.id).toBe("meeting-2");
  });

  it("detects real rectangle overlap with tolerance", () => {
    expect(rectsOverlap(
      { left: 0, top: 0, right: 100, bottom: 40 },
      { left: 98, top: 10, right: 160, bottom: 50 },
    )).toBe(false);
    expect(rectsOverlap(
      { left: 0, top: 0, right: 100, bottom: 40 },
      { left: 80, top: 10, right: 160, bottom: 50 },
    )).toBe(true);
  });
});
