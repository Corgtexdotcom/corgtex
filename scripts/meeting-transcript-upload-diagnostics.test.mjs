import { describe, expect, it } from "vitest";
import { buildMeetingTranscriptUploadDiagnostics } from "./meeting-transcript-upload-diagnostics.mjs";

const at = (value) => new Date(value);
const checkedAt = at("2026-07-16T12:00:00.000Z");

function meeting(overrides = {}) {
  return {
    id: "meeting-1",
    title: "Weekly Review",
    source: "transcript-upload",
    recordedAt: at("2026-07-15T16:00:00.000Z"),
    createdAt: at("2026-07-15T17:00:00.000Z"),
    updatedAt: at("2026-07-15T17:00:00.000Z"),
    transcriptUploadAuditAt: at("2026-07-15T17:00:00.000Z"),
    transcript: "Jan: We discussed follow-up actions.",
    transcriptProcessingProgress: { currentStage: "READY", createdAt: at("2026-07-15T17:01:00.000Z"), startedAt: at("2026-07-15T17:02:00.000Z"), failedAt: null, updatedAt: at("2026-07-15T17:05:00.000Z") },
    ...overrides,
  };
}

const diagnostics = (meetings) => buildMeetingTranscriptUploadDiagnostics({ checkedAt, meetings }).advisories;

describe("meeting transcript upload diagnostics", () => {
  it("flags manual transcript dates that drift far from upload time", () => {
    expect(diagnostics([meeting({ id: "bad-historical", recordedAt: at("2001-07-15T16:00:00.000Z") })])).toEqual([
      expect.objectContaining({
        kind: "manual_transcript_recorded_at_outlier",
        meeting: expect.objectContaining({ id: "bad-historical" }),
        driftDays: expect.any(Number),
      }),
    ]);
  });

  it("flags duplicate manual transcript content without exposing the content", () => {
    const duplicate = diagnostics([
      meeting({ id: "meeting-a", source: "customer-interview", isDiagnosticTarget: false, transcript: "Jan: Same transcript." }),
      meeting({ id: "meeting-b", source: "Zoom", transcript: "Jan:   Same transcript.\n" }),
    ]).find((advisory) => advisory.kind === "duplicate_manual_transcript_content");

    expect(duplicate).toMatchObject({
      kind: "duplicate_manual_transcript_content",
      transcriptHash: expect.any(String),
      meetings: [expect.objectContaining({ id: "meeting-a" }), expect.objectContaining({ id: "meeting-b" })],
    });
    expect(JSON.stringify(duplicate)).not.toContain("Same transcript");
  });

  it("excludes provider transcript source records from manual upload diagnostics", () => {
    expect(diagnostics([
      meeting({ id: "provider-import", source: "meeting-transcript:fireflies", recordedAt: at("2001-07-15T16:00:00.000Z") }),
    ])).toEqual([]);
  });

  it("flags transcript processing that has not reached READY", () => {
    expect(diagnostics([
      meeting({
        id: "stuck-processing",
        createdAt: at("2026-07-16T10:00:00.000Z"),
        transcriptProcessingProgress: { currentStage: "SUMMARIZING", createdAt: at("2026-07-16T10:00:00.000Z"), startedAt: at("2026-07-16T10:01:00.000Z"), failedAt: null, updatedAt: at("2026-07-16T10:01:00.000Z") },
      }),
    ])).toContainEqual(expect.objectContaining({
      kind: "transcript_processing_not_ready",
      meeting: expect.objectContaining({ id: "stuck-processing" }),
    }));
  });

  it("uses upload audit time for drift and processing start time for stale checks", () => {
    expect(diagnostics([
      meeting({
        id: "fresh-processing-existing-meeting",
        recordedAt: at("2001-07-15T16:00:00.000Z"),
        createdAt: at("2026-06-01T10:00:00.000Z"),
        updatedAt: at("2026-07-16T11:59:00.000Z"),
        transcriptUploadAuditAt: null,
        transcriptProcessingProgress: { currentStage: "SUMMARIZING", createdAt: at("2026-06-01T10:00:00.000Z"), startedAt: at("2026-07-16T11:59:30.000Z"), failedAt: null, updatedAt: at("2026-07-16T11:59:30.000Z") },
      }),
    ])).toEqual([]);
  });
});
