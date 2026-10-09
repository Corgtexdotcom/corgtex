import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";

const mocks = vi.hoisted(() => ({
  locale: "en" as "en" | "es",
  completed: [] as Array<Record<string, unknown>>,
  scheduled: [] as Array<Record<string, unknown>>,
  listMeetings: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor: async () => ({ kind: "user", user: { id: "synthetic-user" } }),
}));
vi.mock("@corgtex/domain", () => ({
  requireWorkspaceMembership: async () => ({ role: "CONTRIBUTOR" }),
  listMeetings: mocks.listMeetings,
  listMeetingRecordings: async () => [],
  listHumanMembers: async () => [],
  getMeetingRecorderConfig: async () => null,
  deriveMeetingEvidenceState: ({ meeting }: { meeting: { id: string; transcript: string | null } }) => {
    if (meeting.transcript?.trim()) return { state: "ready", action: "none" };
    if (meeting.id === "recovery") return { state: "provider_recovery_pending", action: "upload_transcript" };
    if (meeting.id === "future") return { state: "upcoming_recordable", action: "schedule_recorder" };
    return { state: "needs_transcript", action: "upload_transcript" };
  },
}));
vi.mock("@/lib/workspace-feature-flags", () => ({
  getWorkspaceFeatureFlags: async () => ({ MEETING_RECORDERS: false }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "meetings" | "common" | "workItems") => createTranslator({
    locale: mocks.locale,
    messages: mocks.locale === "es" ? esMessages : enMessages,
    namespace,
  }),
}));
vi.mock("../actions", () => ({
  archiveMeetingAction: vi.fn(),
  cancelMeetingRecordingAction: vi.fn(),
  createMeetingSeriesAction: vi.fn(),
  importMeetingInviteAction: vi.fn(),
  scheduleMeetingRecordingAction: vi.fn(),
}));
vi.mock("./MeetingArchiveDialog", () => ({ MeetingArchiveDialog: () => null }));
vi.mock("./MeetingAttendeePicker", () => ({ MeetingAttendeePicker: () => null }));
vi.mock("@/lib/components/TimeZoneSelect", () => ({ TimeZoneSelect: () => null }));
vi.mock("@/lib/components/MarkdownRenderer", () => ({
  MarkdownExcerpt: ({ markdown }: { markdown: string }) => React.createElement("span", null, markdown),
}));
vi.mock("@/lib/components/ui/ItemActions", () => ({
  ItemActions: ({ primary, more }: { primary: React.ReactNode; more: React.ReactNode }) => (
    React.createElement("div", null, primary, more)
  ),
}));
vi.mock("./MeetingTranscriptUploadForm", () => ({
  MeetingTranscriptUploadForm: ({ hiddenFields = [], labels }: {
    hiddenFields?: Array<{ name: string; value: string }>;
    labels: { submit: string };
  }) => React.createElement("form", null,
    ...hiddenFields.map((field) => React.createElement("input", {
      key: field.name, type: "hidden", name: field.name, value: field.value,
    })),
    React.createElement("button", { type: "submit" }, labels.submit),
  ),
}));

import MeetingsPage from "./page";

function meeting(id: string, status: "COMPLETED" | "SCHEDULED", transcript: string | null, day: number) {
  return {
    id,
    status,
    transcript,
    recordedAt: new Date(`2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`),
    scheduledEndAt: null,
    title: id,
    source: "SYNTHETIC",
    summaryMd: null,
    agendaPostedAt: null,
    meetingUrl: null,
  };
}

async function render(search: Record<string, string | string[] | undefined> = {}) {
  return renderToStaticMarkup(await MeetingsPage({
    params: Promise.resolve({ workspaceId: "synthetic-workspace" }),
    searchParams: Promise.resolve(search),
  }));
}

describe("Meetings filters", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    mocks.locale = "en";
    mocks.completed = [
      meeting("ready", "COMPLETED", "Transcript content", 5),
      meeting("missing", "COMPLETED", null, 4),
    ];
    mocks.scheduled = [
      meeting("recovery", "SCHEDULED", null, 3),
      meeting("future", "SCHEDULED", null, 9),
    ];
    mocks.listMeetings.mockReset().mockImplementation(async (_workspaceId, options: { status: string }) => (
      options.status === "COMPLETED" ? mocks.completed : mocks.scheduled
    ));
  });

  it("defaults to transcript-ready rows and keeps counts and filter links honest", async () => {
    const html = await render();

    expect(html).toContain("Meetings with transcripts");
    expect(html).toContain("ready");
    expect(html).not.toContain('href="/workspaces/synthetic-workspace/meetings/missing"');
    expect(html).not.toContain('href="/workspaces/synthetic-workspace/meetings/recovery"');
    expect(html).not.toContain('href="/workspaces/synthetic-workspace/meetings/future"');
    expect(html).toContain("All (1)");
    expect(html).toContain("Transcript needed (2)");
    expect(html).toContain("Scheduled meetings (1)");
    expect(html).toContain('aria-label="Filter meetings"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="?status=TRANSCRIPT_NEEDED"');
  });

  it("shows completed missing and provider recovery rows with upload actions only under Transcript needed", async () => {
    const html = await render({ status: "TRANSCRIPT_NEEDED" });

    expect(html).toContain('href="/workspaces/synthetic-workspace/meetings/missing"');
    expect(html).toContain('href="/workspaces/synthetic-workspace/meetings/recovery"');
    expect(html).toContain('name="meetingId" value="missing"');
    expect(html).toContain('name="meetingId" value="recovery"');
    expect(html).toContain("Upload transcript");
    expect(html).not.toContain('href="/workspaces/synthetic-workspace/meetings/ready"');
    expect(html).not.toContain('href="/workspaces/synthetic-workspace/meetings/future"');
    expect(html).toContain('name="status" value="TRANSCRIPT_NEEDED"');
  });

  it("preserves Scheduled and Completed views when switching filters", async () => {
    const scheduled = await render({ status: "SCHEDULED", memberId: "member-1", recordedFrom: "2026-10-01" });
    expect(scheduled).toContain('href="/workspaces/synthetic-workspace/meetings/future"');
    expect(scheduled).not.toContain('href="/workspaces/synthetic-workspace/meetings/recovery"');
    expect(scheduled).toContain('name="status" value="SCHEDULED"');
    expect(scheduled).toContain('href="?status=TRANSCRIPT_NEEDED&amp;memberId=member-1&amp;recordedFrom=2026-10-01"');

    const completed = await render({ status: "COMPLETED" });
    expect(completed).toContain('href="/workspaces/synthetic-workspace/meetings/ready"');
    expect(completed).not.toContain('href="/workspaces/synthetic-workspace/meetings/missing"');
  });

  it("keeps legacy scheduled meetings with transcripts visible without an invalid upload action", async () => {
    mocks.completed = [];
    mocks.scheduled = [meeting("scheduled-ready", "SCHEDULED", "Already available", 8)];

    const all = await render();
    expect(all).toContain('href="/workspaces/synthetic-workspace/meetings/scheduled-ready"');
    expect(all).toContain("1 meeting(s) recorded");

    const scheduled = await render({ status: "SCHEDULED" });
    expect(scheduled).toContain('href="/workspaces/synthetic-workspace/meetings/scheduled-ready"');
    expect(scheduled).not.toContain('name="meetingId" value="scheduled-ready"');
    expect(scheduled).not.toContain('<summary class="nr-hide-marker nr-action-summary secondary small">Upload transcript</summary>');
  });

  it("uses localized filter and empty-state text without showing hidden sections", async () => {
    mocks.locale = "es";
    mocks.completed = [];
    mocks.scheduled = [];

    const all = await render();
    expect(all).toContain("Reuniones con transcripción");
    expect(all).toContain("Aún no hay reuniones con transcripción");
    expect(all).not.toContain("Ninguna reunión necesita transcripción");

    const needed = await render({ status: "TRANSCRIPT_NEEDED" });
    expect(needed).toContain("Se necesita transcripción (0)");
    expect(needed).toContain("Ninguna reunión necesita transcripción");
    expect(needed).not.toContain("Aún no hay reuniones con transcripción");
  });

});
