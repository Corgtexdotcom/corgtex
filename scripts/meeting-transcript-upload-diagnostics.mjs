#!/usr/bin/env node

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const PROVIDER_SOURCE_PREFIX = "meeting-transcript:";
const RECORDER_SOURCE_PREFIXES = ["recorder:", "meeting-recorder"];
const RECORDER_SOURCES = new Set(["manual-recorder", "recorder"]);

const DAY_MS = 24 * 60 * 60 * 1000;

function usage() {
  return [
    "usage: node scripts/meeting-transcript-upload-diagnostics.mjs --workspace <id-or-slug> [options]",
    "",
    "options:",
    "  --since <iso-date>                       Emit non-duplicate advisories for meetings changed since this date.",
    "  --max-recorded-at-drift-days <number>    Flag manual transcript dates this far from upload time. Default: 30.",
    "  --processing-pending-minutes <number>    Flag transcript processing not READY after this age. Default: 30.",
  ].join("\n");
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function parsePositiveNumber(value, fallback) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDate(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed;
}

function normalizeTranscript(value) {
  return value.trim().replace(/\s+/g, " ");
}

function transcriptHash(value) {
  return createHash("sha256").update(normalizeTranscript(value)).digest("hex");
}

function daysBetween(left, right) {
  return Math.round(Math.abs(left.getTime() - right.getTime()) / DAY_MS);
}

function minutesBetween(left, right) {
  return Math.round(Math.abs(left.getTime() - right.getTime()) / 60_000);
}

function isManualTranscriptMeeting(meeting) {
  const source = meeting.source ?? "";
  return !source.startsWith(PROVIDER_SOURCE_PREFIX)
    && !RECORDER_SOURCES.has(source)
    && !RECORDER_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
}

function isDiagnosticTarget(meeting) {
  return meeting.isDiagnosticTarget !== false;
}

function progressDate(progress, key) {
  const value = progress?.[key];
  return value instanceof Date && !Number.isNaN(value.valueOf()) ? value : null;
}

function transcriptObservedAt(meeting) {
  const progress = meeting.transcriptProcessingProgress ?? null;
  return progressDate(progress, "startedAt")
    ?? progressDate(progress, "createdAt")
    ?? progressDate(progress, "updatedAt")
    ?? meeting.updatedAt
    ?? meeting.createdAt;
}

function serializableMeeting(meeting) {
  const progress = meeting.transcriptProcessingProgress ?? null;
  return {
    id: meeting.id,
    title: meeting.title ?? null,
    source: meeting.source ?? null,
    recordedAt: meeting.recordedAt?.toISOString?.() ?? null,
    createdAt: meeting.createdAt?.toISOString?.() ?? null,
    updatedAt: meeting.updatedAt?.toISOString?.() ?? null,
    transcriptProcessingProgress: progress
        ? {
            currentStage: progress.currentStage ?? null,
            createdAt: progress.createdAt?.toISOString?.() ?? null,
            startedAt: progress.startedAt?.toISOString?.() ?? null,
            failedAt: progress.failedAt?.toISOString?.() ?? null,
          updatedAt: progress.updatedAt?.toISOString?.() ?? null,
        }
      : null,
  };
}

export function buildMeetingTranscriptUploadDiagnostics({
  meetings,
  checkedAt = new Date(),
  maxRecordedAtDriftDays = 30,
  processingPendingMinutes = 30,
}) {
  const advisories = [];
  const transcriptGroups = new Map();

  for (const meeting of meetings) {
    if (!isManualTranscriptMeeting(meeting)) continue;
    if (!meeting.transcript?.trim()) continue;

    const isTarget = isDiagnosticTarget(meeting);
    const meetingSummary = serializableMeeting(meeting);
    const observedAt = transcriptObservedAt(meeting);
    const driftDays = meeting.recordedAt && observedAt
      ? daysBetween(meeting.recordedAt, observedAt)
      : null;

    if (isTarget && driftDays !== null && driftDays > maxRecordedAtDriftDays) {
      advisories.push({
        kind: "manual_transcript_recorded_at_outlier",
        severity: "warning",
        meeting: meetingSummary,
        driftDays,
      });
    }

    const hash = transcriptHash(meeting.transcript);
    const group = transcriptGroups.get(hash) ?? [];
    group.push(meeting);
    transcriptGroups.set(hash, group);

    const progress = meeting.transcriptProcessingProgress ?? null;
    const processingObservedAt = progressDate(progress, "startedAt")
      ?? progressDate(progress, "createdAt")
      ?? progressDate(progress, "updatedAt")
      ?? meeting.updatedAt
      ?? meeting.createdAt;
    const ageMinutes = processingObservedAt ? minutesBetween(checkedAt, processingObservedAt) : 0;
    if (isTarget && ageMinutes >= processingPendingMinutes && progress?.currentStage !== "READY") {
      advisories.push({
        kind: "transcript_processing_not_ready",
        severity: "warning",
        meeting: meetingSummary,
        ageMinutes,
      });
    }
  }

  for (const [hash, group] of transcriptGroups.entries()) {
    if (group.length < 2 || !group.some(isDiagnosticTarget)) continue;
    advisories.push({
      kind: "duplicate_manual_transcript_content",
      severity: "warning",
      transcriptHash: hash.slice(0, 16),
      meetings: group.map(serializableMeeting),
    });
  }

  return {
    checkedAt: checkedAt.toISOString(),
    advisoryCount: advisories.length,
    advisories,
  };
}

async function findWorkspace(prisma, workspace) {
  const found = await prisma.workspace.findFirst({
    where: {
      OR: [
        { id: workspace },
        { slug: workspace },
      ],
    },
    select: { id: true, slug: true, name: true },
  });
  if (!found) {
    throw new Error(`Workspace not found: ${workspace}`);
  }
  return found;
}

async function loadMeetings(prisma, workspaceId, since) {
  const meetings = await prisma.meeting.findMany({
    where: {
      workspaceId,
      transcript: { not: null },
      archivedAt: null,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      source: true,
      recordedAt: true,
      createdAt: true,
      updatedAt: true,
      transcript: true,
      transcriptProcessingProgress: {
        select: {
          currentStage: true,
          createdAt: true,
          startedAt: true,
          failedAt: true,
          updatedAt: true,
        },
      },
    },
  });
  return meetings.map((meeting) => ({
    ...meeting,
    isDiagnosticTarget: meeting.createdAt >= since || meeting.updatedAt >= since,
  }));
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  if (hasArg(argv, "--help") || hasArg(argv, "-h")) {
    console.log(usage());
    return 0;
  }

  const workspaceArg = readArg(argv, "--workspace") ?? env.CORGTEX_WORKSPACE ?? env.WORKSPACE_ID;
  if (!workspaceArg) {
    console.error(usage());
    return 2;
  }

  const now = new Date();
  const since = parseDate(readArg(argv, "--since"), new Date(now.getTime() - 7 * DAY_MS));
  const maxRecordedAtDriftDays = parsePositiveNumber(readArg(argv, "--max-recorded-at-drift-days"), 30);
  const processingPendingMinutes = parsePositiveNumber(readArg(argv, "--processing-pending-minutes"), 30);
  const prisma = new PrismaClient();

  try {
    const workspace = await findWorkspace(prisma, workspaceArg);
    const meetings = await loadMeetings(prisma, workspace.id, since);
    const diagnostics = buildMeetingTranscriptUploadDiagnostics({
      meetings,
      checkedAt: now,
      maxRecordedAtDriftDays,
      processingPendingMinutes,
    });
    const summary = {
      ...diagnostics,
      workspace,
      since: since.toISOString(),
    };

    console.log(JSON.stringify(summary, null, hasArg(argv, "--json") ? 0 : 2));

    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
