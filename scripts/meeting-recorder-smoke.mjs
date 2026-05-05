#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";
import prismaPackage from "@prisma/client";

const { PrismaClient } = prismaPackage;

const FEATURE_FLAG = "MEETING_RECORDERS";
const ACTIVE_STATUSES = new Set(["PENDING", "SCHEDULED", "JOINING", "RECORDING"]);

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`OK   ${message}`);
}

function usage(exitCode = 1) {
  const message = [
    "Usage:",
    "  node scripts/meeting-recorder-smoke.mjs <base-url> <email> <password> <workspace-id-or-slug> <meeting-url> <join-at-iso> [options]",
    "",
    "Options:",
    "  --provider recall|baas",
    "  --confirm-live-vendor-call",
    "  --cancel-after-schedule",
    "  --wait-transcript-ms <milliseconds>",
    "  --cleanup",
    "",
    "Without --confirm-live-vendor-call this validates configuration only and does not create a bot.",
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

function parseProvider(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("--provider must be recall or baas.");
  }
  const normalized = value.trim().toLowerCase().replace(/[._\s]+/g, "-");
  if (normalized === "recall" || normalized === "recall-ai") return "RECALL_AI";
  if (normalized === "baas" || normalized === "meeting-baas") return "MEETING_BAAS";
  throw new Error(`Unknown provider "${value}". Use recall or baas.`);
}

function parseInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return Math.round(parsed);
}

function normalizeMeetingUrl(value) {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.hostname.includes("zoom.us")) {
      url.searchParams.sort();
    }
    return url.toString();
  } catch {
    return value.trim();
  }
}

function meetingUrlHash(value) {
  return createHash("sha256").update(normalizeMeetingUrl(value)).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function cookieHeaderFromSetCookie(setCookie) {
  if (!setCookie) {
    fail("missing session cookie from /api/auth/login");
  }

  const [cookie] = setCookie.split(";");
  if (!cookie) {
    fail("could not parse session cookie");
  }

  return cookie;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readJsonResponse(response);

  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`${options.method ?? "GET"} ${url.pathname} failed ${response.status}: ${detail}`);
  }

  return { response, body };
}

function collectUnredactedUrls(value, path = "$") {
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectUnredactedUrls(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => collectUnredactedUrls(item, `${path}.${key}`));
  }
  return [];
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
    fail(`workspace "${ref}" was not found`);
  }
  return workspace;
}

function requiredProviderEnv(provider) {
  if (provider === "RECALL_AI") {
    return [
      ["RECALL_API_KEY", process.env.RECALL_API_KEY],
      ["RECALL_WEBHOOK_SECRET", process.env.RECALL_WEBHOOK_SECRET],
    ];
  }
  return [
    ["MEETING_BAAS_API_KEY", process.env.MEETING_BAAS_API_KEY],
    ["MEETING_BAAS_WEBHOOK_SECRET", process.env.MEETING_BAAS_WEBHOOK_SECRET],
  ];
}

function validateProviderEnv(providers) {
  const missing = [];
  for (const provider of providers) {
    for (const [name, value] of requiredProviderEnv(provider)) {
      if (!value) missing.push(name);
    }
  }
  if (missing.length > 0) {
    fail(`missing recorder runtime env: ${[...new Set(missing)].join(", ")}`);
  }
}

async function validateNoUnredactedArtifactUrls(prisma, recordingId) {
  const recording = await prisma.meetingRecording.findUnique({
    where: { id: recordingId },
    select: {
      id: true,
      providerMetadata: true,
      events: {
        select: {
          id: true,
          payload: true,
        },
      },
    },
  });
  if (!recording) {
    fail(`recording ${recordingId} disappeared before artifact retention checks`);
  }

  const metadataUrls = collectUnredactedUrls(recording.providerMetadata);
  const eventUrls = recording.events.flatMap((event) => collectUnredactedUrls(event.payload, `event:${event.id}`));
  const rawUrls = [...metadataUrls, ...eventUrls];
  if (rawUrls.length > 0) {
    fail(`provider artifact payloads contain unredacted URL values at ${rawUrls.join(", ")}`);
  }
  pass("provider artifacts do not contain raw audio/video/transcript URLs in stored metadata");
}

async function waitForTranscript(prisma, params) {
  const deadline = Date.now() + params.waitTranscriptMs;
  while (Date.now() <= deadline) {
    const recording = await prisma.meetingRecording.findUnique({
      where: { id: params.recordingId },
      select: {
        status: true,
        failureCode: true,
        failureMessage: true,
        transcriptProcessedAt: true,
        meeting: {
          select: {
            transcript: true,
            summaryMd: true,
          },
        },
      },
    });

    if (recording?.status === "FAILED") {
      fail(`recorder failed before transcript processing: ${recording.failureCode ?? "unknown"} ${recording.failureMessage ?? ""}`.trim());
    }
    if (recording?.transcriptProcessedAt && recording.meeting.transcript) {
      pass("transcript was processed into the Corgtex meeting record");
      if (recording.meeting.summaryMd) {
        pass("meeting summary exists after recorder transcript processing");
      }
      return;
    }
    await sleep(Math.min(15_000, Math.max(1_000, params.waitTranscriptMs)));
  }
  fail(`transcript was not processed within ${params.waitTranscriptMs}ms`);
}

async function login(baseUrl, email, password) {
  const { response } = await requestJson(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  pass("/api/auth/login accepted the smoke user");
  return cookieHeaderFromSetCookie(response.headers.get("set-cookie"));
}

async function createSmokeMeeting(prisma, params) {
  const tag = Date.now().toString(36);
  const title = `[SMOKE] Meeting recorder ${tag}`;
  const joinAt = params.joinAt;
  const scheduledEndAt = new Date(joinAt.getTime() + 30 * 60 * 1000);
  const meeting = await prisma.meeting.create({
    data: {
      workspaceId: params.workspaceId,
      status: "SCHEDULED",
      title,
      source: "meeting-recorder-smoke",
      externalId: `meeting-recorder-smoke:${tag}`,
      meetingUrl: normalizeMeetingUrl(params.meetingUrl),
      meetingUrlHash: meetingUrlHash(params.meetingUrl),
      recordedAt: joinAt,
      scheduledEndAt,
      participantIds: [],
      participantEmails: [params.email.toLowerCase()],
    },
    select: {
      id: true,
      workspaceId: true,
      title: true,
    },
  });
  pass(`created temporary meeting ${meeting.id}`);
  return meeting;
}

async function cleanupSmokeMeeting(prisma, params) {
  if (!params.workspaceId || !params.meetingId || !params.cleanup) return;
  if (params.recordingId) {
    await prisma.meetingRecorderProviderEvent.deleteMany({
      where: {
        workspaceId: params.workspaceId,
        recordingId: params.recordingId,
      },
    });
  }
  await prisma.meetingInsight.deleteMany({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
    },
  });
  await prisma.meeting.deleteMany({
    where: {
      id: params.meetingId,
      workspaceId: params.workspaceId,
      title: params.meetingTitle,
      source: "meeting-recorder-smoke",
    },
  });
  pass("removed temporary smoke meeting");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) usage(0);

  const [rawBaseUrl, email, password, workspaceRef, rawMeetingUrl, rawJoinAt] = args._;
  if (!rawBaseUrl || !email || !password || !workspaceRef || !rawMeetingUrl || !rawJoinAt) {
    usage();
  }
  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is required for direct production verification");
  }

  const baseUrl = rawBaseUrl.replace(/\/$/, "");
  const meetingUrl = normalizeMeetingUrl(rawMeetingUrl);
  const joinAt = new Date(rawJoinAt);
  if (Number.isNaN(joinAt.valueOf())) {
    fail("<join-at-iso> must be a valid ISO date");
  }
  if (joinAt <= new Date()) {
    fail("<join-at-iso> must be in the future");
  }

  const providerOverride = parseProvider(args.provider);
  const waitTranscriptMs = parseInteger(args.waitTranscriptMs, 0, "--wait-transcript-ms");
  if (args.cancelAfterSchedule === true && waitTranscriptMs > 0) {
    fail("do not combine --cancel-after-schedule and --wait-transcript-ms");
  }

  const prisma = new PrismaClient();
  let meeting = null;
  let recordingId = null;
  try {
    const workspace = await resolveWorkspace(prisma, workspaceRef);
    const [featureFlag, config] = await Promise.all([
      prisma.workspaceFeatureFlag.findUnique({
        where: {
          workspaceId_flag: {
            workspaceId: workspace.id,
            flag: FEATURE_FLAG,
          },
        },
      }),
      prisma.workspaceMeetingRecorderConfig.findUnique({
        where: { workspaceId: workspace.id },
      }),
    ]);

    if (!featureFlag?.enabled) {
      fail(`feature flag ${FEATURE_FLAG} is not enabled for ${workspace.slug}`);
    }
    if (!config?.enabled) {
      fail(`meeting recorder config is disabled for ${workspace.slug}`);
    }
    pass(`meeting recorders are enabled for ${workspace.slug}`);

    const providers = providerOverride
      ? [providerOverride]
      : [config.defaultProvider, config.fallbackProvider].filter(Boolean);
    validateProviderEnv(providers);
    pass("recorder vendor env is present");

    const dryRunSummary = {
      workspace,
      providerOverride: providerOverride ?? null,
      defaultProvider: config.defaultProvider,
      fallbackProvider: config.fallbackProvider,
      meetingUrl,
      joinAt: joinAt.toISOString(),
      willCreateLiveVendorBot: args.confirmLiveVendorCall === true,
    };

    if (args.confirmLiveVendorCall !== true) {
      console.log(JSON.stringify(dryRunSummary, null, 2));
      pass("dry run complete; add --confirm-live-vendor-call to schedule a real vendor bot");
      return;
    }

    meeting = await createSmokeMeeting(prisma, {
      workspaceId: workspace.id,
      meetingUrl,
      joinAt,
      email,
    });

    const cookie = await login(baseUrl, email, password);
    const scheduleBody = providerOverride ? { provider: providerOverride } : {};
    const { body: schedulePayload } = await requestJson(
      new URL(`/api/workspaces/${workspace.id}/meetings/${meeting.id}/recording/schedule`, baseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
        },
        body: JSON.stringify(scheduleBody),
      },
    );
    const recording = schedulePayload?.recording;
    if (!recording?.id) {
      fail(`/recording/schedule did not return a recording: ${JSON.stringify(schedulePayload)}`);
    }
    recordingId = recording.id;
    if (recording.status === "FAILED") {
      fail(`vendor scheduling returned FAILED: ${recording.failureCode ?? "unknown"} ${recording.failureMessage ?? ""}`.trim());
    }
    pass(`scheduled ${recording.provider} recorder ${recording.id} with status ${recording.status}`);

    const storedRecording = await prisma.meetingRecording.findUnique({
      where: { id: recording.id },
      select: {
        id: true,
        workspaceId: true,
        meetingId: true,
        status: true,
        provider: true,
        externalBotId: true,
      },
    });
    if (
      !storedRecording
      || storedRecording.workspaceId !== workspace.id
      || storedRecording.meetingId !== meeting.id
      || !["PENDING", "SCHEDULED", "JOINING", "RECORDING", "COMPLETED"].includes(storedRecording.status)
    ) {
      fail(`recording was not stored correctly: ${JSON.stringify(storedRecording)}`);
    }
    pass("recording is stored against the smoke meeting");

    await validateNoUnredactedArtifactUrls(prisma, recording.id);

    if (waitTranscriptMs > 0) {
      await waitForTranscript(prisma, { recordingId: recording.id, waitTranscriptMs });
      await validateNoUnredactedArtifactUrls(prisma, recording.id);
    }

    if (args.cancelAfterSchedule === true) {
      if (!ACTIVE_STATUSES.has(storedRecording.status)) {
        fail(`cannot cancel recording in status ${storedRecording.status}`);
      }
      const { body: cancelPayload } = await requestJson(
        new URL(`/api/workspaces/${workspace.id}/meetings/${meeting.id}/recording/cancel`, baseUrl),
        {
          method: "POST",
          headers: {
            cookie,
          },
        },
      );
      if (cancelPayload?.recording?.status !== "CANCELLED") {
        fail(`/recording/cancel did not cancel the recording: ${JSON.stringify(cancelPayload)}`);
      }
      pass("cancelled the smoke recorder through the customer route");
    }
  } finally {
    await cleanupSmokeMeeting(prisma, {
      cleanup: args.cleanup === true,
      workspaceId: meeting?.workspaceId,
      meetingId: meeting?.id,
      meetingTitle: meeting?.title,
      recordingId,
    });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
