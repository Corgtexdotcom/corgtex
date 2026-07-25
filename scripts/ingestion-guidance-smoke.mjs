import process from "node:process";
import { File } from "node:buffer";
import { PrismaClient } from "@prisma/client";

import {
  createValidationCleanupRegistry,
  createValidationRun,
  parseValidationPrNumbers,
  productionValidationTag,
  recordValidationResult,
  writeValidationArtifacts,
} from "./lib/production-validation.mjs";
import {
  requireInternalValidationWorkspace,
  selectWorkspaceForValidation,
  validationWorkspaceSelectorFromEnv,
  workspaceTenant,
} from "./lib/validation-workspace.mjs";

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`OK   ${message}`);
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

async function fetchJsonResponse(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readJsonResponse(response);
  return { response, body };
}

async function requestJson(url, options = {}) {
  const { response, body } = await fetchJsonResponse(url, options);
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`${options.method ?? "GET"} ${url.pathname} failed ${response.status}: ${detail}`);
  }

  return { response, body };
}

function assertMeetingSnapshotUnchanged(label, before, after) {
  if (!before || !after) {
    throw new Error(`${label} could not verify the meeting record after duplicate upload rejection`);
  }
  if (
    after.transcript !== before.transcript
    || after.ingestionGuidanceMd !== before.ingestionGuidanceMd
  ) {
    throw new Error(`${label} modified source transcript evidence`);
  }
}

function eventPayloadFilter(key, value) {
  return {
    payload: {
      path: [key],
      equals: value,
    },
  };
}

function validationRecordPrefix(run, fallback) {
  if (run.prNumbers.length === 0) return `${fallback} ${run.runId}`;
  return productionValidationTag({
    date: run.startedAt,
    prNumber: run.prNumbers[0],
    runId: run.runId,
  });
}

function validationRunId() {
  return process.env.PRODUCTION_VALIDATION_RUN_ID?.trim()
    || process.env.INGESTION_GUIDANCE_SMOKE_RUN_ID?.trim()
    || `ingestion-guidance-smoke-${Date.now().toString(36)}`;
}

function validationOutDir() {
  return process.env.PRODUCTION_VALIDATION_OUT_DIR?.trim()
    || process.env.INGESTION_GUIDANCE_SMOKE_OUT_DIR?.trim()
    || ".artifacts/ingestion-guidance-smoke";
}

async function cleanupStaleMeetingSmokeArtifacts(prisma, workspaceId) {
  const smokeTextFilters = [
    { title: { contains: "ingestion-guidance-smoke" } },
    { title: { contains: "ingestion guidance smoke" } },
    { bodyMd: { contains: "ingestion-guidance-smoke" } },
    { bodyMd: { contains: "ingestion guidance smoke" } },
  ];
  const productionSmokeMeetingFilters = [
    { title: { startsWith: "Temporary meeting ingestion" } },
    { transcript: { contains: "ingestion-guidance-smoke" } },
    { transcript: { contains: "ingestion guidance smoke" } },
    { ingestionGuidanceMd: { contains: "ingestion-guidance-smoke" } },
    { ingestionGuidanceMd: { contains: "ingestion guidance smoke" } },
  ];
  const legacySmokeMeetingFilters = [
    { title: { startsWith: "Temporary meeting ingestion-guidance-smoke" } },
    { title: { startsWith: "Temporary meeting ingestion guidance smoke" } },
    { title: { contains: "ingestion-guidance-smoke" } },
    { title: { contains: "ingestion guidance smoke" } },
    { transcript: { contains: "ingestion-guidance-smoke" } },
    { transcript: { contains: "ingestion guidance smoke" } },
    { ingestionGuidanceMd: { contains: "ingestion-guidance-smoke" } },
    { ingestionGuidanceMd: { contains: "ingestion guidance smoke" } },
  ];
  const staleMeetings = await prisma.meeting.findMany({
    where: {
      workspaceId,
      OR: [
        { source: "production-smoke", OR: productionSmokeMeetingFilters },
        ...legacySmokeMeetingFilters,
      ],
    },
    select: { id: true },
  });
  const meetingIds = staleMeetings.map((meeting) => meeting.id);

  if (meetingIds.length > 0) {
    const events = await prisma.event.findMany({
      where: { aggregateId: { in: meetingIds } },
      select: { id: true },
    });
    const eventIds = events.map((event) => event.id);
    if (eventIds.length > 0) {
      await prisma.workflowJob.deleteMany({ where: { eventId: { in: eventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }

    await prisma.meetingInsight.deleteMany({
      where: {
        workspaceId,
        meetingId: { in: meetingIds },
      },
    });
    await prisma.tension.deleteMany({
      where: {
        workspaceId,
        OR: [
          { meetingId: { in: meetingIds } },
          ...smokeTextFilters,
        ],
      },
    });

    const proposals = await prisma.proposal.findMany({
      where: {
        workspaceId,
        OR: [
          { meetingId: { in: meetingIds } },
          ...smokeTextFilters,
          { summary: { contains: "ingestion-guidance-smoke" } },
          { summary: { contains: "ingestion guidance smoke" } },
        ],
      },
      select: { id: true },
    });
    const proposalIds = proposals.map((proposal) => proposal.id);
    if (proposalIds.length > 0) {
      await prisma.policyCorpus.deleteMany({ where: { proposalId: { in: proposalIds } } });
      await prisma.proposal.deleteMany({
        where: { workspaceId, id: { in: proposalIds } },
      });
    }

    await prisma.action.deleteMany({
      where: {
        workspaceId,
        OR: smokeTextFilters,
      },
    });
    await prisma.meeting.deleteMany({
      where: {
        workspaceId,
        id: { in: meetingIds },
      },
    });
    await prisma.auditLog.deleteMany({
      where: {
        workspaceId,
        entityId: { in: meetingIds },
      },
    });
  }

  return meetingIds.length;
}

async function cleanupSmokeArtifacts(prisma, params) {
  const ids = [params.sourceId, params.meetingId].filter(Boolean);
  if (ids.length === 0 && !params.tag) return;

  if (ids.length > 0) {
    const eventWhere = {
      OR: [
        { aggregateId: { in: ids } },
        params.sourceId ? eventPayloadFilter("sourceId", params.sourceId) : null,
        params.meetingId ? eventPayloadFilter("meetingId", params.meetingId) : null,
      ].filter(Boolean),
    };
    const events = await prisma.event.findMany({
      where: eventWhere,
      select: { id: true },
    });
    const eventIds = events.map((event) => event.id);

    await prisma.workflowJob.deleteMany({
      where: {
        OR: [
          eventIds.length > 0 ? { eventId: { in: eventIds } } : null,
          params.sourceId ? eventPayloadFilter("sourceId", params.sourceId) : null,
          params.meetingId ? eventPayloadFilter("meetingId", params.meetingId) : null,
        ].filter(Boolean),
      },
    });
    await prisma.event.deleteMany({ where: eventWhere });
  }

  if (params.tag) {
    const tagFilter = [
      { title: { contains: params.tag } },
      { bodyMd: { contains: params.tag } },
    ];
    await prisma.action.deleteMany({
      where: { workspaceId: params.workspaceId, OR: tagFilter },
    });
    const proposals = await prisma.proposal.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { title: { contains: params.tag } },
          { bodyMd: { contains: params.tag } },
          { summary: { contains: params.tag } },
        ],
      },
      select: { id: true },
    });
    const proposalIds = proposals.map((proposal) => proposal.id);
    if (proposalIds.length > 0) {
      await prisma.policyCorpus.deleteMany({ where: { proposalId: { in: proposalIds } } });
      await prisma.proposal.deleteMany({ where: { id: { in: proposalIds }, workspaceId: params.workspaceId } });
    }
    await prisma.tension.deleteMany({
      where: { workspaceId: params.workspaceId, OR: tagFilter },
    });
  }

  if (params.meetingId) {
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
      },
    });
  }

  if (params.sourceId) {
    await prisma.brainSource.deleteMany({
      where: {
        id: params.sourceId,
        workspaceId: params.workspaceId,
        title: params.sourceTitle,
      },
    });
  }

  await prisma.auditLog.deleteMany({
    where: {
      workspaceId: params.workspaceId,
      entityId: { in: ids },
    },
  });
}

async function main() {
  const [rawBaseUrl, email, password] = process.argv.slice(2);
  const baseUrl = rawBaseUrl ?? process.env.APP_URL;

  if (!baseUrl || !email || !password) {
    fail("usage: node scripts/ingestion-guidance-smoke.mjs <base-url> <email> <password>");
  }
  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is required so the smoke test can remove temporary production records");
  }

  const prisma = new PrismaClient();
  try {
    const login = await requestJson(new URL("/api/auth/login", baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
      redirect: "manual",
    });
    const cookieHeader = cookieHeaderFromSetCookie(login.response.headers.get("set-cookie"));
    pass("/api/auth/login accepted production smoke credentials");

    const session = await requestJson(new URL("/api/session", baseUrl), {
      headers: {
        cookie: cookieHeader,
      },
    });
    const workspaceSelector = validationWorkspaceSelectorFromEnv(process.env, "INGESTION_GUIDANCE_SMOKE");
    const workspace = selectWorkspaceForValidation(session.body?.workspaces ?? [], {
      workspaceId: workspaceSelector.workspaceId,
      workspaceSlug: workspaceSelector.workspaceSlug,
      purpose: "ingestion guidance smoke",
    });
    requireInternalValidationWorkspace(workspace, {
      purpose: "ingestion guidance smoke writes",
    });
    const workspaceId = workspace.id;
    pass(`/api/session returned workspace '${workspace.slug ?? workspace.id}' for ingestion guidance smoke`);

    const validationRun = createValidationRun({
      runId: validationRunId(),
      tenant: workspaceTenant(workspace),
      prNumbers: parseValidationPrNumbers(process.env.INGESTION_GUIDANCE_SMOKE_PR_NUMBERS ?? process.env.PRODUCTION_VALIDATION_PR_NUMBERS),
      baseUrl,
      environment: "production",
      metadata: {
        script: "ingestion-guidance-smoke",
        workspaceSelector,
        strictInternalValidationWorkspace: true,
      },
    });
    const cleanupRegistry = createValidationCleanupRegistry(validationRun);
    const tag = validationRecordPrefix(validationRun, "ingestion-guidance-smoke");
    let sourceId = null;
    let meetingId = null;
    const sourceTitle = `Temporary source ${tag}`;
    const meetingTitle = `Temporary meeting ${tag}`;
    let sourceCleanupActionId = null;
    let meetingCleanupActionId = null;
    let fatalError = null;

    try {
      const sourceGuidance = `Preserve the source guidance for ${tag}.`;
      const source = await requestJson(new URL(`/api/workspaces/${workspaceId}/data-sources/text-ingest`, baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          sourceType: "DOC",
          title: sourceTitle,
          channel: "production-smoke",
          content: `Temporary non-meeting source content for ${tag}.`,
          ingestionGuidanceMd: ` ${sourceGuidance} `,
        }),
      });

      sourceId = source.body?.id;
      if (!sourceId || source.body?.ingestionGuidanceMd !== sourceGuidance) {
        throw new Error("non-meeting text ingestion did not persist trimmed ingestionGuidanceMd");
      }
      sourceCleanupActionId = `delete-temporary:BrainSource:${sourceId}`;
      cleanupRegistry.add({
        id: sourceCleanupActionId,
        action: "delete-temporary",
        target: { type: "BrainSource", id: sourceId, label: sourceTitle },
        runner: async () => {
          await cleanupSmokeArtifacts(prisma, {
            workspaceId,
            sourceId,
            sourceTitle,
          });
          return "Temporary non-meeting text ingestion record was removed.";
        },
      });
      pass("non-meeting text ingestion persists trimmed ingestionGuidanceMd");
      await cleanupRegistry.runAction(sourceCleanupActionId);
      sourceId = null;
      pass("temporary non-meeting text ingestion record was removed");

      const staleMeetingCount = await cleanupStaleMeetingSmokeArtifacts(prisma, workspaceId);
      if (staleMeetingCount > 0) {
        pass(`removed ${staleMeetingCount} stale meeting transcript smoke record(s)`);
      }

      const recordedAt = new Date().toISOString();
      const meetingGuidance = `Highlight the meeting guidance for ${tag}.`;
      const transcriptText = [
        `Meeting title: ${meetingTitle}`,
        `Date: ${recordedAt}`,
        `Jan: This is the temporary transcript for ${tag}.`,
        `Milan: I own the temporary follow-up for ${tag}.`,
        "Jan: Please track the action item and decision from this transcript.",
      ].join("\n");
      const meeting = await requestJson(new URL(`/api/workspaces/${workspaceId}/meetings/transcript`, baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          title: meetingTitle,
          source: "production-smoke",
          recordedAt,
          transcript: transcriptText,
          ingestionGuidanceMd: ` ${meetingGuidance} `,
        }),
      });

      if (meeting.body?.status !== "meeting_created") {
        throw new Error(`meeting transcript upload did not create an isolated smoke meeting: ${JSON.stringify(meeting.body)}`);
      }

      meetingId = meeting.body?.meeting?.id;
      if (!meetingId || meeting.body?.meeting?.ingestionGuidanceMd !== meetingGuidance) {
        throw new Error("meeting transcript upload did not persist trimmed ingestionGuidanceMd");
      }
      meetingCleanupActionId = `delete-temporary:Meeting:${meetingId}`;
      cleanupRegistry.add({
        id: meetingCleanupActionId,
        action: "delete-temporary",
        target: { type: "Meeting", id: meetingId, label: meetingTitle },
        runner: async () => {
          await cleanupSmokeArtifacts(prisma, {
            workspaceId,
            meetingId,
            meetingTitle,
            tag,
          });
          return "Temporary meeting transcript records were removed.";
        },
      });
      pass("meeting transcript upload persists trimmed ingestionGuidanceMd");

      const duplicateGuidance = `Add the duplicate-upload guidance for ${tag}.`;
      const beforeTextDuplicate = await prisma.meeting.findFirst({
        where: { id: meetingId, workspaceId },
        select: { transcript: true, ingestionGuidanceMd: true },
      });
      const duplicateMeeting = await fetchJsonResponse(new URL(`/api/workspaces/${workspaceId}/data-sources/text-ingest`, baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          sourceType: "MEETING",
          title: meetingTitle,
          channel: "production-smoke",
          recordedAt,
          content: `${transcriptText}\nAndy: Additional transcript upload note for ${tag}.`,
          ingestionGuidanceMd: ` ${duplicateGuidance} `,
        }),
      });

      if (
        duplicateMeeting.response.status !== 400
        || duplicateMeeting.body?.error?.code !== "INVALID_STATE"
        || !duplicateMeeting.body?.error?.message?.includes("source transcript evidence")
      ) {
        throw new Error(`duplicate MEETING text ingestion did not reject source transcript replacement: ${JSON.stringify(duplicateMeeting.body)}`);
      }
      const afterTextDuplicate = await prisma.meeting.findFirst({
        where: { id: meetingId, workspaceId },
        select: { transcript: true, ingestionGuidanceMd: true },
      });
      assertMeetingSnapshotUnchanged("duplicate MEETING text ingestion", beforeTextDuplicate, afterTextDuplicate);
      pass("duplicate MEETING text ingestion rejects source transcript replacement");

      const chatForm = new FormData();
      chatForm.set(
        "file",
        new File([
          [
            `Meeting title: ${meetingTitle}`,
            `Date: ${recordedAt}`,
            `Jan: This is the meeting transcript chat upload for ${tag}.`,
            `Milan: The action item remains assigned for ${tag}.`,
            `Andy: Chat upload note for ${tag}.`,
          ].join("\n"),
        ], `${tag}-meeting-transcript.txt`, { type: "text/plain" }),
      );
      chatForm.set("message", `Meeting transcript upload for ${tag}`);
      chatForm.set("title", meetingTitle);
      chatForm.set("recordedAt", recordedAt);
      const chatDuplicate = await fetchJsonResponse(new URL(`/api/workspaces/${workspaceId}/chat/attachments`, baseUrl), {
        method: "POST",
        headers: {
          cookie: cookieHeader,
        },
        body: chatForm,
      });
      if (
        chatDuplicate.response.status !== 400
        || chatDuplicate.body?.error?.code !== "INVALID_STATE"
        || !chatDuplicate.body?.error?.message?.includes("source transcript evidence")
      ) {
        throw new Error(`chat transcript duplicate upload did not reject source transcript replacement: ${JSON.stringify(chatDuplicate.body)}`);
      }
      const afterChatDuplicate = await prisma.meeting.findFirst({
        where: { id: meetingId, workspaceId },
        select: { transcript: true, ingestionGuidanceMd: true },
      });
      assertMeetingSnapshotUnchanged("chat transcript duplicate upload", afterTextDuplicate, afterChatDuplicate);
      pass("chat transcript duplicate upload rejects source transcript replacement");

      await cleanupRegistry.runAction(meetingCleanupActionId);
      meetingId = null;
      pass("temporary meeting transcript records were removed");
    } catch (error) {
      fatalError = error;
      throw error;
    } finally {
      const cleanup = await cleanupRegistry.runAll({ throwOnFailure: false });
      let fallbackCleanupError = null;
      try {
        await cleanupSmokeArtifacts(prisma, {
          workspaceId,
          sourceId,
          sourceTitle,
          meetingId,
          meetingTitle,
          tag,
        });
        sourceId = null;
        meetingId = null;
        await cleanupStaleMeetingSmokeArtifacts(prisma, workspaceId);
      } catch (error) {
        fallbackCleanupError = error;
      }
      const cleanupFailure = cleanup.failed[0]?.error ?? fallbackCleanupError;
      recordValidationResult(validationRun, {
        intent: "Source and meeting ingestion guidance write paths",
        method: "ingestion-guidance-smoke",
        result: fatalError || cleanupFailure ? "partial" : "pass",
        blocker: fatalError || cleanupFailure
          ? (fatalError?.message ?? cleanupFailure?.message ?? "Ingestion guidance smoke cleanup failed.")
          : null,
        evidence: [
          "non-meeting text ingestion",
          "meeting transcript upload",
          "duplicate meeting text ingestion rejected source transcript replacement",
          "chat transcript duplicate upload rejected source transcript replacement",
        ],
        createdRecordIds: validationRun.createdRecords.map((record) => record.id),
        cleanupActionIds: validationRun.cleanupActions.map((entry) => entry.id),
      });
      await writeValidationArtifacts(validationRun, validationOutDir());
      if (!fatalError && cleanupFailure) {
        throw cleanupFailure;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
