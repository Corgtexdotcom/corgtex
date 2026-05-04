import process from "node:process";
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
  const ids = [params.sourceId, params.meetingId].filter(Boolean);
  if (ids.length === 0) return;

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
    const workspaceId = session.body?.workspaces?.[0]?.id;
    if (!workspaceId) {
      fail("/api/session did not return a workspace for ingestion guidance smoke");
    }
    pass("/api/session returned a workspace for ingestion guidance smoke");

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

      const meetingGuidance = `Highlight the meeting guidance for ${tag}.`;
      const meeting = await requestJson(new URL(`/api/workspaces/${workspaceId}/data-sources/text-ingest`, baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({
          sourceType: "MEETING",
          title: meetingTitle,
          channel: "production-smoke",
          recordedAt: new Date().toISOString(),
          content: `Jan: Milan owns the temporary follow-up for ${tag}.`,
          ingestionGuidanceMd: ` ${meetingGuidance} `,
        }),
      });

      if (meeting.body?.status !== "meeting_created") {
        fail(`meeting text ingestion did not create an isolated smoke meeting: ${JSON.stringify(meeting.body)}`);
      }

      meetingId = meeting.body?.meeting?.id;
      if (!meetingId || meeting.body?.meeting?.ingestionGuidanceMd !== meetingGuidance) {
        fail("meeting text ingestion did not persist trimmed ingestionGuidanceMd");
      }
      pass("meeting text ingestion persists trimmed ingestionGuidanceMd");
      await cleanupSmokeArtifacts(prisma, {
        workspaceId,
        meetingId,
        meetingTitle,
      });
      meetingId = null;
      pass("temporary meeting text ingestion record was removed");
    } finally {
      await cleanupSmokeArtifacts(prisma, {
        workspaceId,
        sourceId,
        sourceTitle,
        meetingId,
        meetingTitle,
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
