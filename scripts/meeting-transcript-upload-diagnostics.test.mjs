import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildMeetingTranscriptUploadDiagnostics,
} from "./meeting-transcript-upload-diagnostics.mjs";

function meeting(overrides) {
  return {
    id: "meeting-1",
    title: "Weekly Review",
    source: "transcript-upload",
    recordedAt: new Date("2026-07-15T16:00:00.000Z"),
    createdAt: new Date("2026-07-15T17:00:00.000Z"),
    updatedAt: new Date("2026-07-15T17:00:00.000Z"),
    transcript: "Jan: We discussed follow-up actions.",
    transcriptProcessingProgress: {
      currentStage: "READY",
      currentWorkflowJobStatus: "COMPLETED",
      createdAt: new Date("2026-07-15T17:01:00.000Z"),
      startedAt: new Date("2026-07-15T17:02:00.000Z"),
      failedAt: null,
      updatedAt: new Date("2026-07-15T17:05:00.000Z"),
    },
    ...overrides,
  };
}

describe("meeting transcript upload diagnostics", () => {
  it("runs as a CLI from paths containing spaces", () => {
    const scriptPath = fileURLToPath(new URL("./meeting-transcript-upload-diagnostics.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });

    expect(output).toContain("meeting-transcript-upload-diagnostics.mjs");
  });

  it("flags manual transcript dates that drift far from upload time", () => {
    const summary = buildMeetingTranscriptUploadDiagnostics({
      checkedAt: new Date("2026-07-16T12:00:00.000Z"),
      meetings: [
        meeting({
          id: "bad-historical",
          recordedAt: new Date("2001-07-15T16:00:00.000Z"),
        }),
      ],
    });

    expect(summary.advisories).toEqual([
      expect.objectContaining({
        kind: "manual_transcript_recorded_at_outlier",
        meeting: expect.objectContaining({
          id: "bad-historical",
        }),
        driftDays: expect.any(Number),
      }),
    ]);
  });

  it("flags duplicate manual transcript content without exposing the content", () => {
    const summary = buildMeetingTranscriptUploadDiagnostics({
      checkedAt: new Date("2026-07-16T12:00:00.000Z"),
      meetings: [
        meeting({ id: "meeting-a", source: "customer-interview", transcript: "Jan: Same transcript." }),
        meeting({ id: "meeting-b", source: "Zoom", transcript: "Jan:   Same transcript.\n" }),
      ],
    });

    const duplicate = summary.advisories.find((advisory) => advisory.kind === "duplicate_manual_transcript_content");
    expect(duplicate).toMatchObject({
      kind: "duplicate_manual_transcript_content",
      transcriptHash: expect.any(String),
      meetings: [
        expect.objectContaining({ id: "meeting-a" }),
        expect.objectContaining({ id: "meeting-b" }),
      ],
    });
    expect(JSON.stringify(duplicate)).not.toContain("Same transcript");
  });

  it("excludes provider transcript source records from manual upload diagnostics", () => {
    const summary = buildMeetingTranscriptUploadDiagnostics({
      checkedAt: new Date("2026-07-16T12:00:00.000Z"),
      meetings: [
        meeting({
          id: "provider-import",
          source: "meeting-transcript:fireflies",
          recordedAt: new Date("2001-07-15T16:00:00.000Z"),
        }),
      ],
    });

    expect(summary.advisories).toEqual([]);
  });

  it("flags transcript processing that has not reached READY", () => {
    const summary = buildMeetingTranscriptUploadDiagnostics({
      checkedAt: new Date("2026-07-16T12:00:00.000Z"),
      meetings: [
        meeting({
          id: "stuck-processing",
          createdAt: new Date("2026-07-16T10:00:00.000Z"),
          transcriptProcessingProgress: {
            currentStage: "SUMMARIZING",
            currentWorkflowJobStatus: "PENDING",
            createdAt: new Date("2026-07-16T10:00:00.000Z"),
            startedAt: new Date("2026-07-16T10:01:00.000Z"),
            failedAt: null,
            updatedAt: new Date("2026-07-16T10:01:00.000Z"),
          },
        }),
      ],
    });

    expect(summary.advisories).toContainEqual(expect.objectContaining({
      kind: "transcript_processing_not_ready",
      meeting: expect.objectContaining({ id: "stuck-processing" }),
    }));
  });

  it("does not mark newly started processing stale because the meeting record is old", () => {
    const summary = buildMeetingTranscriptUploadDiagnostics({
      checkedAt: new Date("2026-07-16T12:00:00.000Z"),
      meetings: [
        meeting({
          id: "fresh-processing-existing-meeting",
          createdAt: new Date("2026-06-01T10:00:00.000Z"),
          updatedAt: new Date("2026-07-16T11:59:00.000Z"),
          transcriptProcessingProgress: {
            currentStage: "SUMMARIZING",
            currentWorkflowJobStatus: "PENDING",
            createdAt: new Date("2026-07-16T11:59:00.000Z"),
            startedAt: new Date("2026-07-16T11:59:30.000Z"),
            failedAt: null,
            updatedAt: new Date("2026-07-16T11:59:30.000Z"),
          },
        }),
      ],
    });

    expect(summary.advisories).toEqual([]);
  });
});
