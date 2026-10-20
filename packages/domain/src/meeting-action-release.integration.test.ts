import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPrismaClient, prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getAction } from "./actions";
import { getMeeting, listMeetings, listUpcomingMeetings } from "./meetings";
import { meetingAgendaInputProjection, meetingTranscriptInputProjection } from "./meeting-intelligence-context";
import * as lineage from "./source-lineage";
import * as digest from "./digest-lineage";
import * as meetingContext from "./meeting-intelligence-context";

// Promise.all rejects before its sibling reads settle. Keep the whole query /
// admission chains alive until teardown drains them, before the next TRUNCATE.
const pendingReads: Promise<void>[] = [];
function trackRead<T>(read: Promise<T>): Promise<T> {
  pendingReads.push(read.then(() => undefined, () => undefined));
  return read;
}
async function drainReads() {
  while (pendingReads.length) await Promise.all(pendingReads.splice(0));
}
beforeEach(async () => {
  await truncateAllTables();
  const batches = meetingContext.readMeetingInputBatches;
  vi.spyOn(meetingContext, "readMeetingInputBatches").mockImplementation(<T extends { id: string }>(
    ...args: Parameters<typeof meetingContext.readMeetingInputBatches<T>>
  ) => trackRead(batches(...args)));
  const observe = digest.DigestReadRelease.prototype.observeRead;
  vi.spyOn(digest.DigestReadRelease.prototype, "observeRead").mockImplementation(function<T>(
    this: digest.DigestReadRelease, read: () => Promise<T>,
  ): Promise<T> {
    return trackRead(observe.call(this, read) as Promise<T>);
  });
});
afterEach(async () => {
  await drainReads();
  vi.restoreAllMocks();
});
async function setup() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic final release", slug: randomUUID() } });
  const users = await Promise.all(["reader", "author"].map(name => prisma.user.create({ data: {
    email: `${name}-${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: name,
  } })));
  const members = await Promise.all(users.map(user => prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } })));
  const actor: AppActor = { kind: "user", user: users[0] };
  const author: AppActor = { kind: "user", user: users[1] };
  const input = await prisma.action.create({ data: { workspaceId: workspace.id, authorUserId: users[1].id, title: "Original input", bodyMd: "Input body", status: "OPEN" } });
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: author, workspaceId: workspace.id,
    artifact: { kind: "Action", id: input.id }, content: input, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const meeting = await prisma.meeting.create({ data: { workspaceId: workspace.id, title: "Original meeting", source: "manual",
    status: "SCHEDULED", recordedAt: new Date("2026-10-20T09:00:00Z"), participantIds: [], transcript: "Original transcript",
    summaryMd: "Original summary", agendaJson: { title: "Original agenda" } } });
  for (const [kind, content] of [["MeetingTranscript", meetingTranscriptInputProjection(meeting)], ["MeetingAgenda", meetingAgendaInputProjection(meeting)], ["Meeting", meeting]] as const) {
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: author, workspaceId: workspace.id,
      artifact: { kind, id: meeting.id }, content, origin: "DERIVED", inputs: [{ kind: "Action", id: input.id }] }));
  }
  const proposal = await prisma.proposal.create({ data: { workspaceId: workspace.id, meetingId: meeting.id,
    authorUserId: users[1].id, title: "Joined proposal", bodyMd: "Joined body", status: "OPEN" } });
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: author, workspaceId: workspace.id,
    artifact: { kind: "Proposal", id: proposal.id }, content: proposal, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const action = await prisma.action.create({ data: { workspaceId: workspace.id, authorUserId: users[1].id,
    proposalId: proposal.id, title: "Selected action", bodyMd: "Selected body", status: "OPEN" } });
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: author, workspaceId: workspace.id,
    artifact: { kind: "Action", id: action.id }, content: action, origin: "DERIVED", inputs: [{ kind: "Action", id: input.id }] }));
  const restoreCaller = async () => {
    await prisma.member.update({ where: { id: members[0].id }, data: { isActive: false } });
    await prisma.member.update({ where: { id: members[0].id }, data: { isActive: true } });
  };
  const restoreInput = async () => {
    await prisma.action.update({ where: { id: input.id }, data: { archivedAt: new Date() } });
    await prisma.action.update({ where: { id: input.id }, data: { archivedAt: null } });
  };
  const replaceHead = async (kind: "MeetingTranscript" | "MeetingAgenda" | "Action" | "Proposal", id: string) => {
    const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: workspace.id, artifactType: kind, artifactId: id }, orderBy: { revision: "desc" } });
    await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" ("id", "workspaceId", "artifactType", "artifactId", "revision", "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson") SELECT ${randomUUID()}, "workspaceId", "artifactType", "artifactId", "revision" + 1, "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson" FROM "ArtifactInputLineage" WHERE "id" = ${head.id}`;
  };
  return { workspaceId: workspace.id, actor, meeting, action, proposal, users, restoreCaller, restoreInput, replaceHead };
}

it("preserves complete positive meeting/detail projections and rejects foreign workspace identities", async () => {
  const f = await setup();
  for (const rows of [await listMeetings(f.actor, f.workspaceId), await listUpcomingMeetings(f.actor, f.workspaceId, { from: new Date("2026-10-19"), to: new Date("2026-10-21") })]) {
    expect(rows).toMatchObject([{ id: f.meeting.id, transcript: "Original transcript", summaryMd: "Original summary", agendaJson: { title: "Original agenda" } }]);
  }
  expect(await getMeeting(f.actor, f.workspaceId, f.meeting.id)).toMatchObject({ id: f.meeting.id, proposals: [{ id: f.proposal.id, author: { displayName: "author" }, actions: [{ id: f.action.id }] }] });
  expect(await getAction(f.actor, { workspaceId: f.workspaceId, actionId: f.action.id })).toMatchObject({ title: "Selected action", bodyMd: "Selected body", proposal: { title: "Joined proposal" }, author: { displayName: "author" } });
  const foreign = await prisma.workspace.create({ data: { name: "Foreign", slug: randomUUID() } });
  await prisma.member.create({ data: { workspaceId: foreign.id, userId: f.users[0].id } });
  expect(await getMeeting(f.actor, foreign.id, f.meeting.id)).toBeNull();
  await expect(getAction(f.actor, { workspaceId: foreign.id, actionId: f.action.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it.each(["list", "upcoming", "detail"] as const)("withholds %s transcript when authority changes during later agenda admission", async mode => {
  const f = await setup(); const read = lineage.readableArtifactIds; let changed = false;
  vi.spyOn(lineage, "readableArtifactIds").mockImplementation(async (...args) => {
    const ids = await read(...args);
    if (!changed && args[2] === "MeetingAgenda") { changed = true; await f.restoreInput(); }
    return ids;
  });
  const result = mode === "list" ? listMeetings(f.actor, f.workspaceId) : mode === "upcoming"
    ? listUpcomingMeetings(f.actor, f.workspaceId, { from: new Date("2026-10-19"), to: new Date("2026-10-21") })
    : getMeeting(f.actor, f.workspaceId, f.meeting.id);
  // The changed root may be detected while capturing agenda inputs, before final release.
  await expect(result).rejects.toMatchObject({ code: expect.stringMatching(/^(SOURCE_CHANGED|UNKNOWN_LINEAGE)$/) }); expect(changed).toBe(true);
});

it.each(["transcript-head", "agenda-head", "caller", "body"] as const)("withholds original meeting after %s changes during related reads", async change => {
  const f = await setup(); const delegate = getPrismaClient().proposal; const query = delegate.findMany.bind(delegate); let changed = false;
  vi.spyOn(delegate, "findMany").mockImplementation((async (args: Parameters<typeof query>[0]) => {
    const rows = await query(args);
    if (!changed) {
      changed = true;
      if (change === "caller") await f.restoreCaller();
      else if (change === "body") await prisma.meeting.update({ where: { id: f.meeting.id }, data: { transcript: "Changed transcript" } });
      else await f.replaceHead(change === "transcript-head" ? "MeetingTranscript" : "MeetingAgenda", f.meeting.id);
    }
    return rows;
  }) as typeof delegate.findMany);
  // Parallel joins may observe the caller during the deliberately inactive interval.
  await expect(getMeeting(f.actor, f.workspaceId, f.meeting.id)).rejects.toMatchObject({
    code: change === "caller" ? expect.stringMatching(/^(SOURCE_CHANGED|NOT_A_MEMBER)$/) : "SOURCE_CHANGED",
  }); expect(changed).toBe(true);
});

it.each(["input", "head", "caller", "profile", "proposal"] as const)("withholds original Action after %s changes during joined profile admission", async change => {
  const f = await setup(); const capture = digest.captureReadableDigestInputs; let changed = false;
  vi.spyOn(digest, "captureReadableDigestInputs").mockImplementation(async args => {
    const result = await capture(args);
    if (!changed && args.kind === "User" && args.records.length) {
      changed = true;
      if (change === "input") await f.restoreInput();
      else if (change === "caller") await f.restoreCaller();
      else if (change === "profile") await prisma.user.update({ where: { id: f.users[1].id }, data: { displayName: "Changed profile" } });
      else await f.replaceHead(change === "head" ? "Action" : "Proposal", change === "head" ? f.action.id : f.proposal.id);
    }
    return result;
  });
  await expect(getAction(f.actor, { workspaceId: f.workspaceId, actionId: f.action.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" }); expect(changed).toBe(true);
});


it("drains a pending sibling meeting query after another parallel branch rejects", async () => {
  const f = await setup();
  let unblock!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { unblock = resolve; });
  const queryStarted = new Promise<void>(resolve => { started = resolve; });
  const delegate = getPrismaClient().tension;
  const query = delegate.findMany.bind(delegate);
  let siblingSettled = false;
  vi.spyOn(delegate, "findMany").mockImplementation((async (args: Parameters<typeof query>[0]) => {
    started();
    await held;
    const rows = await query(args);
    siblingSettled = true;
    return rows;
  }) as typeof delegate.findMany);
  vi.spyOn(getPrismaClient().meetingInsight as { findMany: () => Promise<unknown[]> }, "findMany").mockImplementation(async () => {
    await queryStarted;
    throw new Error("synthetic joined-read rejection");
  });
  let drained = false;
  try {
    await expect(getMeeting(f.actor, f.workspaceId, f.meeting.id)).rejects.toThrow("synthetic joined-read rejection");
    expect(siblingSettled).toBe(false);
    const draining = drainReads().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    unblock();
    await draining;
    expect(siblingSettled).toBe(true);
    expect(drained).toBe(true);
    expect(pendingReads).toHaveLength(0);
  } finally {
    unblock();
  }
});
