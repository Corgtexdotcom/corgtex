#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";
import prismaPackage from "@prisma/client";

const { PrismaClient } = prismaPackage;

const ACTIVE_STATUSES = new Set(["PENDING", "SCHEDULED", "JOINING", "RECORDING"]);
const AUTO_SCHEDULE_MIN_LEAD_MS = 10 * 60 * 1000;
const DUPLICATE_RECORDER_FAILURE_CODE = "DUPLICATE_RECORDER";

function usage(exitCode = 1) {
  const message = [
    "Usage:",
    "  node scripts/meeting-recorder-cleanup.mjs --workspace <id-or-slug> --from <iso> --to <iso> [--dry-run|--apply] [--enqueue-reconcile]",
    "",
    "Options:",
    "  --workspace <id-or-slug>",
    "  --from <iso-inclusive>",
    "  --to <iso-exclusive>",
    "  --dry-run",
    "  --apply",
    "  --enqueue-reconcile",
    "",
    "Dry-run is the default. Output is sanitized and hashes provider/internal IDs.",
  ].join("\n");
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (rawValue !== undefined) {
      args[key] = rawValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      args[key] = argv[index + 1];
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function parseDate(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`${label} must be a valid ISO date.`);
  }
  return parsed;
}

function hashId(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function safeRecording(recording) {
  return {
    idHash: hashId(recording.id),
    provider: recording.provider,
    externalBotHash: recording.externalBotId ? hashId(recording.externalBotId) : null,
    status: recording.status,
    joinAt: recording.joinAt?.toISOString() ?? null,
    scheduledAt: recording.scheduledAt?.toISOString() ?? null,
    createdAt: recording.createdAt.toISOString(),
    failureCode: recording.failureCode,
  };
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function recallAuthorization(apiKey) {
  return /^(Token|Bearer)\s+/i.test(apiKey) ? apiKey : `Token ${apiKey}`;
}

async function fetchProvider(url, init, provider, okStatuses = []) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok && !okStatuses.includes(response.status)) {
    const message = text ? ` ${text.slice(0, 80).replace(/\s+/g, " ")}` : "";
    throw new Error(`${provider} returned ${response.status}.${message}`);
  }
  if (!response.ok) {
    return null;
  }
  return text ? JSON.parse(text) : null;
}

function shouldDeleteScheduledRecallBot(recording) {
  if (recording.status === "JOINING" || recording.status === "RECORDING") {
    return false;
  }
  const joinAtMs = recording.joinAt?.getTime();
  if (joinAtMs && joinAtMs - Date.now() <= AUTO_SCHEDULE_MIN_LEAD_MS) {
    return false;
  }
  return true;
}

function recallDeleteCanFallBackToLeave(error) {
  return /\b(400|405|409|425)\b/.test(error instanceof Error ? error.message : String(error));
}

async function cancelRecall(recording) {
  const apiKey = process.env.RECALL_API_KEY;
  const region = process.env.RECALL_REGION || "us-west-2";
  if (!apiKey) {
    throw new Error("RECALL_API_KEY is missing.");
  }
  if (shouldDeleteScheduledRecallBot(recording)) {
    try {
      await fetchProvider(`https://${region}.recall.ai/api/v1/bot/${recording.externalBotId}/`, {
        method: "DELETE",
        headers: {
          Authorization: recallAuthorization(apiKey),
          accept: "application/json",
        },
      }, "RECALL_AI", [404]);
      return "delete";
    } catch (error) {
      if (!recallDeleteCanFallBackToLeave(error)) {
        throw error;
      }
    }
  }
  await fetchProvider(`https://${region}.recall.ai/api/v1/bot/${recording.externalBotId}/leave_call/`, {
    method: "POST",
    headers: {
      Authorization: recallAuthorization(apiKey),
      accept: "application/json",
      "content-type": "application/json",
    },
  }, "RECALL_AI", [404]);
  return "leave_call";
}

async function cancelMeetingBaas(recording) {
  const apiKey = process.env.MEETING_BAAS_API_KEY;
  if (!apiKey) {
    throw new Error("MEETING_BAAS_API_KEY is missing.");
  }
  await fetchProvider(`https://api.meetingbaas.com/v2/bots/${recording.externalBotId}`, {
    method: "DELETE",
    headers: {
      "x-meeting-baas-api-key": apiKey,
    },
  }, "MEETING_BAAS", [404]);
  return "delete";
}

async function cancelProviderBot(recording) {
  if (!recording.externalBotId) {
    throw new Error("duplicate recording is missing provider bot id.");
  }
  return recording.provider === "RECALL_AI" ? cancelRecall(recording) : cancelMeetingBaas(recording);
}

async function resolveWorkspace(prisma, ref) {
  const workspace = await prisma.workspace.findFirst({
    where: {
      OR: [
        { id: ref },
        { slug: ref },
      ],
    },
    select: {
      id: true,
      slug: true,
      name: true,
    },
  });
  if (!workspace) {
    throw new Error(`Workspace "${ref}" was not found.`);
  }
  return workspace;
}

function groupKey(recording) {
  const joinAt = recording.joinAt ?? recording.meeting.recordedAt;
  return `${recording.workspaceId}:${recording.meetingId}:${recording.provider}:${joinAt.toISOString()}`;
}

function compareCanonical(left, right) {
  const leftActive = ACTIVE_STATUSES.has(left.status) ? 1 : 0;
  const rightActive = ACTIVE_STATUSES.has(right.status) ? 1 : 0;
  if (leftActive !== rightActive) return rightActive - leftActive;

  const leftScheduledAt = left.scheduledAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightScheduledAt = right.scheduledAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftScheduledAt !== rightScheduledAt) return rightScheduledAt - leftScheduledAt;

  return right.createdAt.getTime() - left.createdAt.getTime();
}

function activeDedupeKey(recording) {
  return `meeting-recording:${recording.workspaceId}:${recording.meetingId}:${recording.provider}`;
}

function duplicateFailureMessage(canonicalId) {
  return `Duplicate recorder skipped; canonical recording ${canonicalId} retained.`;
}

async function markDuplicateSkipped(prisma, duplicate, canonical) {
  await prisma.meetingRecording.update({
    where: { id: duplicate.id },
    data: {
      status: "SKIPPED",
      activeDedupeKey: null,
      endedAt: new Date(),
      failureCode: DUPLICATE_RECORDER_FAILURE_CODE,
      failureMessage: duplicateFailureMessage(canonical.id),
    },
  });
}

async function restoreCanonical(prisma, canonical) {
  await prisma.meetingRecording.update({
    where: { id: canonical.id },
    data: {
      status: "SCHEDULED",
      activeDedupeKey: activeDedupeKey(canonical),
      endedAt: null,
      failureCode: null,
      failureMessage: null,
    },
  });
}

async function enqueueReconcile(prisma, workspaceId) {
  const bucket = Math.floor(Date.now() / 60_000);
  return prisma.workflowJob.upsert({
    where: { dedupeKey: `meeting-recorders:reconcile:${workspaceId}:operator-cleanup:${bucket}` },
    update: {},
    create: {
      workspaceId,
      type: "meeting-recorders.reconcile",
      payload: {},
      dedupeKey: `meeting-recorders:reconcile:${workspaceId}:operator-cleanup:${bucket}`,
    },
    select: {
      id: true,
      status: true,
      runAfter: true,
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) usage(0);
  const workspaceRef = args.workspace ?? args._[0];
  if (!workspaceRef) usage();
  if (args.apply === true && args.dryRun === true) {
    fail("use either --dry-run or --apply, not both");
  }
  const apply = args.apply === true;
  const from = parseDate(args.from, "--from");
  const to = parseDate(args.to, "--to");
  if (to <= from) {
    fail("--to must be after --from");
  }

  const prisma = new PrismaClient();
  try {
    const workspace = await resolveWorkspace(prisma, workspaceRef);
    const meetings = await prisma.meeting.findMany({
      where: {
        workspaceId: workspace.id,
        recordedAt: { gte: from, lt: to },
        archivedAt: null,
      },
      select: {
        id: true,
        workspaceId: true,
        recordedAt: true,
        scheduledEndAt: true,
        recordings: {
          where: {
            externalBotId: { not: null },
            OR: [
              { status: { in: [...ACTIVE_STATUSES] } },
              { status: "FAILED", failureCode: "STALE_RECORDER" },
              { status: "COMPLETED", transcriptProcessedAt: null },
            ],
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            workspaceId: true,
            meetingId: true,
            provider: true,
            externalBotId: true,
            activeDedupeKey: true,
            joinAt: true,
            scheduledAt: true,
            startedAt: true,
            endedAt: true,
            status: true,
            failureCode: true,
            transcriptProcessedAt: true,
            createdAt: true,
            meeting: {
              select: {
                recordedAt: true,
              },
            },
          },
        },
      },
      orderBy: { recordedAt: "asc" },
    });

    const summary = {
      mode: apply ? "apply" : "dry-run",
      workspace: {
        idHash: hashId(workspace.id),
      },
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
      meetingsChecked: meetings.length,
      duplicateGroupsFound: 0,
      futureDuplicateGroupsFound: 0,
      pastDuplicateGroupsFound: 0,
      canonicalRecordingsRetained: 0,
      canonicalRecordingsRestored: 0,
      duplicateProviderBotsToCancel: 0,
      duplicateRecordersToSkip: 0,
      duplicateProviderBotsCancelled: 0,
      duplicateRecordersSkipped: 0,
      details: [],
      reconcileJob: null,
    };

    for (const meeting of meetings) {
      const groups = new Map();
      for (const recording of meeting.recordings) {
        const key = groupKey(recording);
        groups.set(key, [...(groups.get(key) ?? []), recording]);
      }
      for (const group of groups.values()) {
        if (group.length <= 1) continue;
        summary.duplicateGroupsFound += 1;
        const canonical = [...group].sort(compareCanonical)[0];
        const duplicates = group.filter((recording) => recording.id !== canonical.id);
        const joinAt = canonical.joinAt ?? canonical.meeting.recordedAt;
        const isFuture = joinAt.getTime() - Date.now() > AUTO_SCHEDULE_MIN_LEAD_MS;
        if (isFuture) {
          summary.futureDuplicateGroupsFound += 1;
        } else {
          summary.pastDuplicateGroupsFound += 1;
        }

        const detail = {
          meetingHash: hashId(meeting.id),
          provider: canonical.provider,
          joinAt: joinAt.toISOString(),
          action: isFuture ? "cancel_future_duplicates" : "reconcile_transcript_duplicates",
          canonical: safeRecording(canonical),
          duplicates: duplicates.map(safeRecording),
          cancellationMethods: [],
        };

        if (isFuture) {
          for (const duplicate of duplicates) {
            summary.duplicateProviderBotsToCancel += 1;
            summary.duplicateRecordersToSkip += 1;
            if (apply) {
              const method = await cancelProviderBot(duplicate);
              detail.cancellationMethods.push({
                recordingHash: hashId(duplicate.id),
                externalBotHash: hashId(duplicate.externalBotId),
                method,
              });
              await markDuplicateSkipped(prisma, duplicate, canonical);
              summary.duplicateProviderBotsCancelled += 1;
              summary.duplicateRecordersSkipped += 1;
            }
          }
          if (apply) {
            await restoreCanonical(prisma, canonical);
          }
          summary.canonicalRecordingsRestored += canonical.status !== "SCHEDULED" || canonical.activeDedupeKey !== activeDedupeKey(canonical) ? 1 : 0;
          summary.canonicalRecordingsRetained += 1;
        }

        summary.details.push(detail);
      }
    }

    if (apply && args.enqueueReconcile === true) {
      const job = await enqueueReconcile(prisma, workspace.id);
      summary.reconcileJob = {
        idHash: hashId(job.id),
        status: job.status,
        runAfter: job.runAfter.toISOString(),
      };
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
