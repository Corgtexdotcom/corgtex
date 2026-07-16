#!/usr/bin/env node

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const PROVIDER_SOURCE_PREFIX = "meeting-transcript:";
const RECORDER_SOURCE_PREFIXES = ["recorder:", "meeting-recorder"];
const RECORDER_SOURCES = new Set(["manual-recorder", "recorder"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE = `usage: node scripts/meeting-transcript-upload-diagnostics.mjs --workspace <id-or-slug> [options]

options:
  --since <iso-date>                       Emit non-duplicate advisories for meetings changed since this date.
  --max-recorded-at-drift-days <number>    Flag manual transcript dates this far from upload time. Default: 30.
  --processing-pending-minutes <number>    Flag transcript processing not READY after this age. Default: 30.`;

const readArg = (argv, name) => {
  const index = argv.indexOf(name);
  const value = index === -1 ? null : argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
};
const parsePositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const parseDate = (value, fallback) => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.valueOf()) ? parsed : fallback;
};
const validDate = (value) => (value instanceof Date && !Number.isNaN(value.valueOf()) ? value : null);
const daysBetween = (left, right) => Math.round(Math.abs(left.getTime() - right.getTime()) / DAY_MS);
const minutesBetween = (left, right) => Math.round(Math.abs(left.getTime() - right.getTime()) / 60_000);
const transcriptHash = (value) => createHash("sha256").update(value.trim().replace(/\s+/g, " ")).digest("hex");

function isManualTranscriptMeeting(meeting) {
  const source = meeting.source ?? "";
  return !source.startsWith(PROVIDER_SOURCE_PREFIX)
    && !RECORDER_SOURCES.has(source)
    && !RECORDER_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
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
    transcriptProcessingProgress: progress ? {
      currentStage: progress.currentStage ?? null,
      createdAt: progress.createdAt?.toISOString?.() ?? null,
      startedAt: progress.startedAt?.toISOString?.() ?? null,
      failedAt: progress.failedAt?.toISOString?.() ?? null,
      updatedAt: progress.updatedAt?.toISOString?.() ?? null,
    } : null,
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
    if (!isManualTranscriptMeeting(meeting) || !meeting.transcript?.trim()) continue;
    const isTarget = meeting.isDiagnosticTarget !== false;
    const meetingSummary = serializableMeeting(meeting);
    const uploadedAt = validDate(meeting.transcriptUploadAuditAt);
    const driftDays = meeting.recordedAt && uploadedAt ? daysBetween(meeting.recordedAt, uploadedAt) : null;

    if (isTarget && driftDays !== null && driftDays > maxRecordedAtDriftDays) {
      advisories.push({
        kind: "manual_transcript_recorded_at_outlier",
        severity: "warning",
        meeting: meetingSummary,
        driftDays,
      });
    }

    const hash = transcriptHash(meeting.transcript);
    transcriptGroups.set(hash, [...(transcriptGroups.get(hash) ?? []), meeting]);

    const progress = meeting.transcriptProcessingProgress ?? null;
    const processingObservedAt = validDate(progress?.startedAt)
      ?? validDate(progress?.createdAt)
      ?? validDate(progress?.updatedAt)
      ?? meeting.updatedAt
      ?? meeting.createdAt;
    if (
      isTarget
      && processingObservedAt
      && minutesBetween(checkedAt, processingObservedAt) >= processingPendingMinutes
      && progress?.currentStage !== "READY"
    ) {
      advisories.push({
        kind: "transcript_processing_not_ready",
        severity: "warning",
        meeting: meetingSummary,
        ageMinutes: minutesBetween(checkedAt, processingObservedAt),
      });
    }
  }

  for (const [hash, group] of transcriptGroups.entries()) {
    if (group.length >= 2 && group.some((meeting) => meeting.isDiagnosticTarget !== false)) {
      advisories.push({
        kind: "duplicate_manual_transcript_content",
        severity: "warning",
        transcriptHash: hash.slice(0, 16),
        meetings: group.map(serializableMeeting),
      });
    }
  }

  return {
    checkedAt: checkedAt.toISOString(),
    advisoryCount: advisories.length,
    advisories,
  };
}

async function findWorkspace(prisma, workspace) {
  const found = await prisma.workspace.findFirst({
    where: { OR: [{ id: workspace }, { slug: workspace }] },
    select: { id: true, slug: true, name: true },
  });
  if (!found) throw new Error(`Workspace not found: ${workspace}`);
  return found;
}

async function loadMeetings(prisma, workspaceId, since) {
  const meetings = await prisma.meeting.findMany({
    where: { workspaceId, transcript: { not: null }, archivedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      source: true,
      recordedAt: true,
      createdAt: true,
      updatedAt: true,
      transcript: true,
      transcriptProcessingProgress: { select: { currentStage: true, createdAt: true, startedAt: true, failedAt: true, updatedAt: true } },
    },
  });
  const uploadLogs = meetings.length ? await prisma.auditLog.findMany({
    where: {
      workspaceId,
      action: "meeting.transcript-uploaded",
      entityType: "Meeting",
      entityId: { in: meetings.map((meeting) => meeting.id) },
    },
    orderBy: { createdAt: "desc" },
    select: { entityId: true, createdAt: true },
  }) : [];
  const uploadAtByMeeting = new Map();
  for (const log of uploadLogs) {
    if (!uploadAtByMeeting.has(log.entityId)) uploadAtByMeeting.set(log.entityId, log.createdAt);
  }
  return meetings.map((meeting) => ({
    ...meeting,
    transcriptUploadAuditAt: uploadAtByMeeting.get(meeting.id) ?? null,
    isDiagnosticTarget: meeting.createdAt >= since || meeting.updatedAt >= since,
  }));
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const workspaceArg = readArg(argv, "--workspace") ?? env.CORGTEX_WORKSPACE ?? env.WORKSPACE_ID;
  if (!workspaceArg) {
    console.error(USAGE);
    return 2;
  }

  const now = new Date();
  const workspace = readArg(argv, "--workspace") ?? workspaceArg;
  const since = parseDate(readArg(argv, "--since"), new Date(now.getTime() - 7 * DAY_MS));
  const prisma = new PrismaClient();

  try {
    const foundWorkspace = await findWorkspace(prisma, workspace);
    const diagnostics = buildMeetingTranscriptUploadDiagnostics({
      meetings: await loadMeetings(prisma, foundWorkspace.id, since),
      checkedAt: now,
      maxRecordedAtDriftDays: parsePositiveNumber(readArg(argv, "--max-recorded-at-drift-days"), 30),
      processingPendingMinutes: parsePositiveNumber(readArg(argv, "--processing-pending-minutes"), 30),
    });
    console.log(JSON.stringify({
      ...diagnostics,
      workspace: foundWorkspace,
      since: since.toISOString(),
    }, null, argv.includes("--json") ? 0 : 2));
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
