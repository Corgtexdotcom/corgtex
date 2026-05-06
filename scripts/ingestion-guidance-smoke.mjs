import process from "node:process";
import { File } from "node:buffer";
import { PrismaClient } from "@prisma/client";

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

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readJsonResponse(response);

  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`${options.method ?? "GET"} ${url.pathname} failed ${response.status}: ${detail}`);
  }

  return { response, body };
}

function eventPayloadFilter(key, value) {
  return {
    payload: {
      path: [key],
      equals: value,
    },
  };
}

async function cleanupSmokeArtifacts(prisma, params) {
  const sourceIds = new Set([params.sourceId].filter(Boolean));
  const meetingIds = new Set([params.meetingId].filter(Boolean));

  if (params.cleanupStaleSmokeArtifacts) {
    const [staleSources, staleMeetings] = await Promise.all([
      prisma.brainSource.findMany({
        where: {
          workspaceId: params.workspaceId,
          OR: [
            { title: { startsWith: "Temporary source ingestion-guidance-smoke-" } },
            { title: { startsWith: "Temporary source ingestion guidance smoke " } },
          ],
        },
        select: { id: true },
      }),
      prisma.meeting.findMany({
        where: {
          workspaceId: params.workspaceId,
          source: "production-smoke",
          OR: [
            { title: { startsWith: "Temporary meeting ingestion-guidance-smoke-" } },
            { title: { startsWith: "Temporary meeting ingestion guidance smoke " } },
          ],
        },
        select: { id: true },
      }),
    ]);

    for (const source of staleSources) sourceIds.add(source.id);
    for (const meeting of staleMeetings) meetingIds.add(meeting.id);
  }

  const ids = [...sourceIds, ...meetingIds];
  if (ids.length === 0 && !params.tag) return;

  if (ids.length > 0) {
    const eventWhere = {
      OR: [
        { aggregateId: { in: ids } },
        ...[...sourceIds].map((sourceId) => eventPayloadFilter("sourceId", sourceId)),
        ...[...meetingIds].map((meetingId) => eventPayloadFilter("meetingId", meetingId)),
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
          ...[...sourceIds].map((sourceId) => eventPayloadFilter("sourceId", sourceId)),
          ...[...meetingIds].map((meetingId) => eventPayloadFilter("meetingId", meetingId)),
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

  if (meetingIds.size > 0) {
    await prisma.meetingInsight.deleteMany({
      where: {
        workspaceId: params.workspaceId,
        meetingId: { in: [...meetingIds] },
      },
    });
    await prisma.meeting.deleteMany({
      where: {
        id: { in: [...meetingIds] },
        workspaceId: params.workspaceId,
      },
    });
  }

  if (sourceIds.size > 0) {
    await prisma.brainSource.deleteMany({
      where: {
        id: { in: [...sourceIds] },
        workspaceId: params.workspaceId,
      },
    });
  }

  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({
      where: {
        workspaceId: params.workspaceId,
        entityId: { in: ids },
      },
    });
  }
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
    const workspaceId = session.body?.workspaces?.[0]?.id;
    if (!workspaceId) {
      fail("/api/session did not return a workspace for ingestion guidance smoke");
    }
    pass("/api/session returned a workspace for ingestion guidance smoke");

    await cleanupSmokeArtifacts(prisma, {
      workspaceId,
      cleanupStaleSmokeArtifacts: true,
    });
    pass("stale ingestion guidance smoke records were removed");

    const tag = `ingestion-guidance-smoke-${Date.now()}`;
    let sourceId = null;
    let meetingId = null;
    const sourceTitle = `Temporary source ${tag}`;
    const meetingTitle = `Temporary meeting ${tag}`;

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
        fail("non-meeting text ingestion did not persist trimmed ingestionGuidanceMd");
      }
      pass("non-meeting text ingestion persists trimmed ingestionGuidanceMd");
      await cleanupSmokeArtifacts(prisma, {
        workspaceId,
        sourceId,
        sourceTitle,
      });
      sourceId = null;
      pass("temporary non-meeting text ingestion record was removed");

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
        fail(`meeting transcript upload did not create an isolated smoke meeting: ${JSON.stringify(meeting.body)}`);
      }

      meetingId = meeting.body?.meeting?.id;
      if (!meetingId || meeting.body?.meeting?.ingestionGuidanceMd !== meetingGuidance) {
        fail("meeting transcript upload did not persist trimmed ingestionGuidanceMd");
      }
      pass("meeting transcript upload persists trimmed ingestionGuidanceMd");

      const duplicateGuidance = `Add the duplicate-upload guidance for ${tag}.`;
      const duplicateMeeting = await requestJson(new URL(`/api/workspaces/${workspaceId}/data-sources/text-ingest`, baseUrl), {
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

      if (duplicateMeeting.body?.status !== "meeting_matched" || duplicateMeeting.body?.meeting?.id !== meetingId) {
        fail(`duplicate MEETING text ingestion did not update the existing meeting: ${JSON.stringify(duplicateMeeting.body)}`);
      }
      const afterTextDuplicate = await prisma.meeting.findFirst({
        where: { id: meetingId, workspaceId },
        select: { transcript: true, ingestionGuidanceMd: true, aiProcessedAt: true },
      });
      if (!afterTextDuplicate?.transcript?.includes(`Additional transcript upload note for ${tag}`)) {
        fail("duplicate MEETING text ingestion did not merge useful new transcript text");
      }
      if (!afterTextDuplicate.ingestionGuidanceMd?.includes(duplicateGuidance) || afterTextDuplicate.aiProcessedAt !== null) {
        fail("duplicate MEETING text ingestion did not merge guidance and reset AI processing state");
      }
      pass("duplicate MEETING text ingestion updates the existing meeting and resets processing");

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
      const chatDuplicate = await requestJson(new URL(`/api/workspaces/${workspaceId}/chat/attachments`, baseUrl), {
        method: "POST",
        headers: {
          cookie: cookieHeader,
        },
        body: chatForm,
      });
      if (chatDuplicate.body?.status !== "meeting_matched" || chatDuplicate.body?.meeting?.id !== meetingId) {
        fail(`chat transcript upload did not update the existing meeting: ${JSON.stringify(chatDuplicate.body)}`);
      }
      const afterChatDuplicate = await prisma.meeting.findFirst({
        where: { id: meetingId, workspaceId },
        select: { transcript: true },
      });
      if (!afterChatDuplicate?.transcript?.includes(`Chat upload note for ${tag}`)) {
        fail("chat transcript upload did not merge useful new transcript text");
      }
      pass("chat transcript upload updates the existing meeting");

      await cleanupSmokeArtifacts(prisma, {
        workspaceId,
        meetingId,
        meetingTitle,
        tag,
      });
      meetingId = null;
      pass("temporary meeting transcript records were removed");
    } finally {
      await cleanupSmokeArtifacts(prisma, {
        workspaceId,
        sourceId,
        sourceTitle,
        meetingId,
        meetingTitle,
        tag,
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
