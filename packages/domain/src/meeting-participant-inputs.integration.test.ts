import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { findTranscriptMeetingCandidates, getMeeting, getMeetingParticipants } from "./meetings";
import { recordArtifactInputLineage, type LineageKind } from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic participant proof", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Reader" } });
  const reader = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const profile = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic-secret-canary",
    displayName: "Participant", bio: "private-bio-canary", avatarUrl: "https://example.test/avatar", linkedinUrl: "https://example.test/linkedin", websiteUrl: "https://example.test/site" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: profile.id, role: "CONTRIBUTOR" } });
  return { workspaceId: workspace.id, actor: { kind: "user", user } as AppActor, reader, profile, member };
}

it("returns current participants for legacy member and canonical user IDs without returning fingerprint-only profile fields", async () => {
  const f = await fixture();
  const result = await getMeetingParticipants(f.actor, f.workspaceId, [f.member.id, f.profile.id]);
  expect(result).toHaveLength(1);
  expect(result[0].id).toBe(f.member.id);
  expect(result[0].user).toEqual({ id: f.profile.id, displayName: "Participant", email: f.profile.email });
  expect(JSON.stringify(result)).not.toContain("canary");
  expect(result[0].user).not.toHaveProperty("createdAt");
});

it("omits departed and foreign profiles", async () => {
  const f = await fixture();
  await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
  const foreign = await prisma.workspace.create({ data: { name: "Other tenant", slug: randomUUID() } });
  const foreignProfile = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Foreign" } });
  const foreignMember = await prisma.member.create({ data: { workspaceId: foreign.id, userId: foreignProfile.id } });
  expect(await getMeetingParticipants(f.actor, f.workspaceId, [f.member.id, f.profile.id, foreignMember.id, foreignProfile.id])).toEqual([]);
});

function memberPageProbe(work: (args: Prisma.MemberFindManyArgs | undefined) => Promise<void>) {
  const delegate = prisma.member as unknown as { findMany: (args?: Prisma.MemberFindManyArgs) => Promise<Array<{ id: string }>> };
  const read = delegate.findMany.bind(delegate);
  return vi.spyOn(delegate, "findMany").mockImplementation(async (args) => {
    const rows = await read(args);
    await work(args);
    return rows;
  });
}

it.each(["profile", "epoch"] as const)("rejects a first-page participant whose %s changes while loading the next page", async (mode) => {
  const f = await fixture();
  const users = Array.from({ length: 100 }, (_, index) => ({ id: `page-user-${index}`, email: `${randomUUID()}@example.test`, passwordHash: "synthetic" }));
  await prisma.user.createMany({ data: users });
  await prisma.member.createMany({ data: users.map((user, index) => ({ id: `page-member-${String(index).padStart(3, "0")}`, workspaceId: f.workspaceId, userId: user.id })) });
  let changed = false;
  const probe = memberPageProbe(async (args) => {
    expect(args?.take).toBe(100);
    if (args?.cursor && !changed) {
      changed = true;
      if (mode === "profile") await prisma.user.update({ where: { id: f.profile.id }, data: { bio: "changed-profile-canary" } });
      else {
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      }
    }
  });
  await expect(getMeetingParticipants(f.actor, f.workspaceId, [f.member.id, ...users.map((user) => user.id)])).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(changed).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
});

it("rechecks current caller membership before releasing an empty participant result", async () => {
  const f = await fixture();
  memberPageProbe(async () => { await prisma.member.update({ where: { id: f.reader.id }, data: { isActive: false } }); });
  await expect(getMeetingParticipants(f.actor, f.workspaceId, [])).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
});

async function original(actor: AppActor, workspaceId: string, kind: LineageKind, row: { id: string }) {
  await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind, id: row.id },
    content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
}

it("keeps admitted meeting author and assignee labels without exposing canonical proof-only fields", async () => {
  const f = await fixture();
  const meeting = await prisma.meeting.create({ data: { workspaceId: f.workspaceId, title: "Synthetic", source: "manual", recordedAt: new Date(), participantIds: [] } });
  await original(f.actor, f.workspaceId, "Meeting", meeting);
  const proposal = await prisma.proposal.create({ data: { workspaceId: f.workspaceId, meetingId: meeting.id, authorUserId: f.profile.id, title: "Proposal", bodyMd: "Synthetic", status: "OPEN" } });
  const tension = await prisma.tension.create({ data: { workspaceId: f.workspaceId, meetingId: meeting.id, authorUserId: f.profile.id, title: "Tension", status: "OPEN" } });
  const action = await prisma.action.create({ data: { workspaceId: f.workspaceId, authorUserId: f.profile.id, assigneeMemberId: f.member.id, title: "Action", status: "OPEN" } });
  const insight = await prisma.meetingInsight.create({ data: { workspaceId: f.workspaceId, meetingId: meeting.id, type: "ACTION_ITEM", operation: "CREATE", status: "APPLIED", title: "Action", bodyMd: "Synthetic", appliedEntityType: "Action", appliedEntityId: action.id } });
  for (const [kind, row] of [["Proposal", proposal], ["Tension", tension], ["Action", action], ["MeetingInsight", insight]] as const) await original(f.actor, f.workspaceId, kind, row);
  const result = await getMeeting(f.actor, f.workspaceId, meeting.id);
  const label = { id: f.profile.id, email: f.profile.email, displayName: "Participant" };
  expect(result?.proposals[0].author).toEqual(label);
  expect(result?.tensions[0].author).toEqual(label);
  expect(result?.raisedActions[0].author).toEqual(label);
  expect(result?.raisedActions[0].assigneeMember?.user).toEqual(label);
  expect(JSON.stringify(result)).not.toContain("canary");
});

it("uses admitted canonical member and profile inputs for transcript participant matching", async () => {
  const f = await fixture();
  const recordedAt = new Date("2026-10-14T10:00:00Z");
  const meeting = await prisma.meeting.create({ data: { workspaceId: f.workspaceId, title: "Synthetic matching", source: "manual", status: "SCHEDULED", recordedAt, participantIds: [f.member.id] } });
  await original(f.actor, f.workspaceId, "Meeting", meeting);
  const result = await findTranscriptMeetingCandidates(f.actor, { workspaceId: f.workspaceId, recordedAt, participantEmails: [f.profile.email] });
  expect(result[0]).toMatchObject({ meetingId: meeting.id, score: 0.6 });
  expect(result[0].reason).toContain("attendees");
});
