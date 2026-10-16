import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureCompanyMemberTranscriptInput } from "./native-transcript-input";
import { intakeMeetingTranscript } from "./meeting-transcript-intake";
import { readableArtifactIds } from "./source-lineage";
const oldKey = process.env.ENCRYPTION_KEY;
async function fixture() {
  const ws = await prisma.workspace.create({ data: { name: "Company transcript", slug: randomUUID() } });
  const actors: AppActor[] = [];
  for (const name of ["Uploader", "Peer"]) {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    await prisma.member.create({ data: { workspaceId: ws.id, userId: user.id, role: name === "Uploader" ? "ADMIN" : "CONTRIBUTOR" } });
    actors.push({ kind: "user", user: { id: user.id, email: user.email, displayName: name } });
  }
  const submission = { workspaceId: ws.id, transcript: "Alice: Original public meeting transcript.", title: "Company meeting", recordedAt: "2026-10-14T12:00:00Z", createNewMeeting: true };
  return { ws, actor: actors[0], peer: actors[1], submission };
}
describe("standalone company transcript publication", () => {
  beforeEach(async () => { process.env.ENCRYPTION_KEY ??= "1".repeat(64); await truncateAllTables(); });
  afterEach(() => { vi.restoreAllMocks(); if (oldKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = oldKey; });
  it("publishes exact member custody atomically and permits ordinary peer reads after scope cleanup", async () => {
    const f = await fixture();
    const nativeReceipt = await captureCompanyMemberTranscriptInput(f.actor, { workspaceId: f.ws.id, submission: f.submission });
    const result = await intakeMeetingTranscript(f.actor, { ...f.submission, nativeReceipt });
    expect(result.status).toBe("meeting_created");
    if (result.status === "needs_clarification") throw new Error("unexpected clarification");
    const binding = await prisma.nativeTranscriptPublication.findFirstOrThrow({ where: { nativeInputId: nativeReceipt.inputId } });
    expect(binding.meetingId).toBe(result.meeting.id);
    expect(await readableArtifactIds(f.peer, f.ws.id, "Meeting", [result.meeting])).toEqual(new Set([result.meeting.id]));
    const uploader = await prisma.member.findFirstOrThrow({ where: { workspaceId: f.ws.id, userId: f.actor.kind === "user" ? f.actor.user.id : "" } });
    await prisma.member.update({ where: { id: uploader.id }, data: { isActive: false } });
    expect(await readableArtifactIds(f.peer, f.ws.id, "Meeting", [result.meeting])).toEqual(new Set([result.meeting.id]));
    await expect(prisma.nativeTranscriptPublication.update({ where: { id: binding.id }, data: { meetingId: randomUUID() } })).rejects.toThrow("immutable");
    await prisma.nativeTranscriptPublication.delete({ where: { id: binding.id } });
    await prisma.nativeTranscriptPublication.create({ data: { ...binding, permissionEpochsJson: binding.permissionEpochsJson as Prisma.InputJsonValue } });
    expect(await readableArtifactIds(f.peer, f.ws.id, "Meeting", [result.meeting])).toEqual(new Set());
  });
  it("rejects capture-to-publication uploader revoke-restore without refreshing its operation authority", async () => {
    const f = await fixture();
    const nativeReceipt = await captureCompanyMemberTranscriptInput(f.actor, { workspaceId: f.ws.id, submission: f.submission });
    const member = await prisma.member.findFirstOrThrow({ where: { workspaceId: f.ws.id, userId: f.actor.kind === "user" ? f.actor.user.id : "" } });
    await prisma.member.update({ where: { id: member.id }, data: { isActive: false } });
    await prisma.member.update({ where: { id: member.id }, data: { isActive: true } });
    await expect(intakeMeetingTranscript(f.actor, { ...f.submission, nativeReceipt })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.meeting.count()).toBe(0);
    expect(await prisma.nativeTranscriptPublication.count()).toBe(0);
  });
  it("preserves clarification and existing-meeting no-op without promoting an input", async () => {
    const f = await fixture();
    const { defaultModelGateway } = await import("@corgtex/models");
    vi.spyOn(defaultModelGateway, "extract").mockResolvedValue({ output: {} } as never);
    const submission = { ...f.submission, recordedAt: undefined };
    const receipt = await captureCompanyMemberTranscriptInput(f.actor, { workspaceId: f.ws.id, submission });
    expect((await intakeMeetingTranscript(f.actor, { ...submission, nativeReceipt: receipt })).status).toBe("needs_clarification");
    expect(await prisma.nativeTranscriptPublication.count()).toBe(0);
    const first = await intakeMeetingTranscript(f.actor, { ...f.submission, nativeReceipt: await captureCompanyMemberTranscriptInput(f.actor, { workspaceId: f.ws.id, submission: f.submission }) });
    if (first.status === "needs_clarification") throw new Error("unexpected clarification");
    const duplicate = { ...f.submission, duplicateGuard: { resolution: "use_existing" as const, targetEntityId: first.meeting.id } };
    const result = await intakeMeetingTranscript(f.actor, { ...duplicate, nativeReceipt: await captureCompanyMemberTranscriptInput(f.actor, { workspaceId: f.ws.id, submission: duplicate }) });
    expect(result.status).toBe("meeting_matched");
    expect(await prisma.nativeTranscriptPublication.count()).toBe(1);
  });
  it("rolls back publication binding, transcript and event together on a later writer failure", async () => {
    const f = await fixture();
    const nativeReceipt = await captureCompanyMemberTranscriptInput(f.actor, { workspaceId: f.ws.id, submission: f.submission });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION pun68_company_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic company rollback'; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER pun68_company_rollback BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION pun68_company_rollback()`);
    try { await expect(intakeMeetingTranscript(f.actor, { ...f.submission, nativeReceipt })).rejects.toThrow("synthetic company rollback"); }
    finally { await prisma.$executeRawUnsafe(`DROP TRIGGER pun68_company_rollback ON "AuditLog"`); await prisma.$executeRawUnsafe(`DROP FUNCTION pun68_company_rollback()`); }
    expect(await prisma.nativeTranscriptPublication.count()).toBe(0);
    expect(await prisma.meeting.count()).toBe(0);
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.nativeTranscriptInput.count()).toBe(1);
  });

  it("imports an exact manual provider-export file as member custody and rejects unreceipted copies", async () => {
    const f = await fixture();
    await prisma.workspaceFeatureFlag.create({ data: { workspaceId: f.ws.id, flag: "MEETING_TRANSCRIPT_SOURCES", enabled: true } });
    const { captureManualTranscriptSourceArtifact } = await import("./manual-transcript-source-input");
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");
    const text = "Alice: Exact member-owned exported text.\r\n";
    const artifact = { externalId: "manual-original", text, title: "Manual file", recordedAt: "2026-10-14T12:00:00Z", fileName: "fireflies.txt", rawFileBase64: Buffer.from(text).toString("base64"), rawFileMimeType: "text/plain" };
    await captureManualTranscriptSourceArtifact(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES", artifact });
    const result = await importMeetingTranscriptSourceArtifacts(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES", artifacts: [artifact] });
    expect(await prisma.meetingTranscriptSourceRecord.findMany({ where: { status: "FAILED" }, select: { error: true } })).toEqual([]);
    expect(result.batch.importedCount).toBe(1);
    const meeting = await prisma.meeting.findFirstOrThrow();
    expect(await readableArtifactIds(f.peer, f.ws.id, "Meeting", [meeting])).toEqual(new Set([meeting.id]));
    const input = await prisma.nativeTranscriptInput.findFirstOrThrow();
    const { decryptSecret } = await import("@corgtex/shared");
    expect(input.mode).toBe("COMPANY_MEMBER_UPLOAD");
    expect(JSON.parse(decryptSecret(input.encryptedPayloadJson)).originalExport.rawFileBase64).toBe(artifact.rawFileBase64);
    const copied = await importMeetingTranscriptSourceArtifacts(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES", artifacts: [{ ...artifact }] });
    expect(copied.batch.failedCount).toBe(1);
    expect(copied.batch.skippedCount).toBe(0);
    expect(await prisma.meeting.count()).toBe(1);
  });

  it("preserves configured company category and circle restrictions on the public publication", async () => {
    const f = await fixture();
    const { configureInformationCategory } = await import("./information-category-policy");
    const circle = await prisma.circle.create({ data: { workspaceId: f.ws.id, name: "Allowed" } });
    const role = await prisma.role.create({ data: { circleId: circle.id, name: "Reader", accountabilities: [], artifacts: [] } });
    const owner = await prisma.member.findFirstOrThrow({ where: { workspaceId: f.ws.id, userId: f.actor.kind === "user" ? f.actor.user.id : "" } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, memberId: owner.id } });
    await configureInformationCategory(f.actor, { workspaceId: f.ws.id, category: "GENERAL", isRestricted: true, allowedRoleIds: [], allowedCircleIds: [circle.id] });
    const nativeReceipt = await captureCompanyMemberTranscriptInput(f.actor, { workspaceId: f.ws.id, submission: f.submission });
    const result = await intakeMeetingTranscript(f.actor, { ...f.submission, nativeReceipt });
    if (result.status === "needs_clarification") throw new Error("unexpected clarification");
    expect(await readableArtifactIds(f.actor, f.ws.id, "Meeting", [result.meeting])).toEqual(new Set([result.meeting.id]));
    expect(await readableArtifactIds(f.peer, f.ws.id, "Meeting", [result.meeting])).toEqual(new Set());
    await configureInformationCategory(f.actor, { workspaceId: f.ws.id, category: "GENERAL", isRestricted: false, allowedRoleIds: [], allowedCircleIds: [] });
    await configureInformationCategory(f.actor, { workspaceId: f.ws.id, category: "GENERAL", isRestricted: true, allowedRoleIds: [], allowedCircleIds: [circle.id] });
    expect(await readableArtifactIds(f.actor, f.ws.id, "Meeting", [result.meeting])).toEqual(new Set());
  });

  it("keeps valid manual siblings in chronological order while preserving a malformed export diagnostic", async () => {
    const f = await fixture();
    await prisma.workspaceFeatureFlag.create({ data: { workspaceId: f.ws.id, flag: "MEETING_TRANSCRIPT_SOURCES", enabled: true } });
    const { captureManualTranscriptSourceArtifact } = await import("./manual-transcript-source-input");
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");
    const artifacts = [
      { externalId: "newest", text: "Alice: Second distinct original.", title: "Later manual meeting", recordedAt: "2026-10-14T12:00:00Z" },
      { externalId: "malformed", text: "", metadata: { exact: "original invalid diagnostic" } },
      { externalId: "oldest", text: "Bob: First distinct original.", title: "Earlier manual meeting", recordedAt: "2026-09-14T12:00:00Z" },
    ];
    for (const artifact of artifacts) await captureManualTranscriptSourceArtifact(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES", artifact });
    const result = await importMeetingTranscriptSourceArtifacts(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES", artifacts });
    expect(result.batch).toMatchObject({ status: "PARTIAL", importedCount: 2, failedCount: 1 });
    expect(result.results.map(item => item.record.externalId)).toEqual(["oldest", "newest"]);
    expect(await prisma.nativeTranscriptPublication.count()).toBe(2);
    expect(await prisma.nativeTranscriptInput.count()).toBe(2);
    expect(await prisma.meetingTranscriptSourceRecord.findFirstOrThrow({ where: { status: "FAILED" } })).toMatchObject({ externalId: "malformed", rawMetadataJson: expect.objectContaining({ originalArtifact: artifacts[1] }) });
  });

});
