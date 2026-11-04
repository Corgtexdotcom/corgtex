import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelGateway } from "@corgtex/models";
import { encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { processMeetingTranscriptSourceWebhook } from "./meeting-transcript-sources";
import { captureCompanyMemberTranscriptInput } from "./native-transcript-input";
import { intakeMeetingTranscript } from "./meeting-transcript-intake";
import { readableArtifactIds } from "./source-lineage";

const oldKey = process.env.ENCRYPTION_KEY;
const secret = "synthetic-metadata-webhook-secret";
const modelResult = {output: {title: "Inferred original meeting", recordedAt: null, participantEmails: []}};
async function fixture() {
  const ws = await prisma.workspace.create({data: {name: "Metadata attempt", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: ws.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user: {id: user.id, email: user.email, displayName: "Fixture"}};
  await prisma.workspaceFeatureFlag.create({data: {workspaceId: ws.id, flag: "MEETING_TRANSCRIPT_SOURCES", enabled: true}});
  const connection = await prisma.meetingTranscriptSourceConnection.create({data: {workspaceId: ws.id, provider: "FIREFLIES", status: "ACTIVE", authMode: "API_KEY", webhookSecretEnc: encryptSecret(secret)}});
  // No title: the real provider normalizer must reach metadata inference.
  const rawBody = JSON.stringify({id: "synthetic-external", date: "2026-10-14T12:00:00Z", updated_at: "2026-10-14T13:00:00Z", transcript_text: "Alice: Exact original provider text."});
  const deliver = () => processMeetingTranscriptSourceWebhook({workspaceId: ws.id, provider: "FIREFLIES", rawBody,
    headers: {"x-fireflies-signature": createHmac("sha256",secret).update(rawBody).digest("hex")}});
  const submission = {workspaceId: ws.id, transcript: "Alice: Exact original member text.", recordedAt: "2026-10-14T12:00:00Z", createNewMeeting: true};
  return {ws, actor, member, connection, deliver, submission};
}

describe("native transcript metadata provider attempts", () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_KEY ??= "1".repeat(64);
    await truncateAllTables();
    vi.stubGlobal("fetch", vi.fn(() => {throw new Error("Unexpected live provider request");}));
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (oldKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = oldKey;
  });

  it.each(["provider", "member"] as const)("allows two authorized %s attempts and publishes readable native evidence", async mode => {
    const f = await fixture(); let sends = 0;
    const extract = vi.spyOn(defaultModelGateway,"extract").mockImplementation(async request => {
      expect(request.authorizeAttempt).toBeTypeOf("function");
      expect(request.signal?.aborted).toBe(false);
      expect(request.input).toContain(mode === "provider" ? "Exact original provider" : "Exact original member");
      for (let index=0;index<2;index++) {await request.authorizeAttempt!({signal: new AbortController().signal}); sends++;}
      return modelResult as never;
    });
    if (mode === "provider") {
      const result = await f.deliver();
      expect("batch" in result && result.batch.importedCount).toBe(1);
      expect("batch" in result && result.batch.failedCount).toBe(0);
    } else {
      const nativeReceipt = await captureCompanyMemberTranscriptInput(f.actor,{workspaceId:f.ws.id,submission:f.submission});
      expect((await intakeMeetingTranscript(f.actor,{...f.submission,nativeReceipt})).status).toBe("meeting_created");
    }
    expect(extract).toHaveBeenCalledTimes(1); expect(sends).toBe(2);
    const meeting = await prisma.meeting.findFirstOrThrow({where:{workspaceId:f.ws.id}});
    expect(meeting.title).toBe("Inferred original meeting");
    expect(await readableArtifactIds(f.actor,f.ws.id,"Meeting",[meeting])).toEqual(new Set([meeting.id]));
  });

  it.each(["credentials", "retry"] as const)("blocks provider connection revoke-restore at %s despite swallowed model denial", async boundary => {
    const f = await fixture(); let sends=0; let guardError: unknown; let aborted = false;
    const extract = vi.spyOn(defaultModelGateway,"extract").mockImplementation(async request => {
      if (boundary === "retry") {await request.authorizeAttempt!({signal:new AbortController().signal}); sends++;}
      await prisma.meetingTranscriptSourceConnection.update({where:{id:f.connection.id},data:{status:"DISABLED"}});
      await prisma.meetingTranscriptSourceConnection.update({where:{id:f.connection.id},data:{status:"ACTIVE"}});
      try { await request.authorizeAttempt?.({signal:new AbortController().signal}); sends++; }
      catch (error) { guardError = error; }
      aborted = request.signal?.aborted === true;
      return modelResult as never;
    });
    const result = await f.deliver();
    expect(guardError).toMatchObject({code:"SOURCE_CHANGED"});
    expect(aborted).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1); expect(sends).toBe(boundary === "retry" ? 1 : 0);
    expect("batch" in result && result.batch.failedCount).toBe(1);
    expect("batch" in result && result.batch.importedCount).toBe(0);
    expect((await prisma.meetingTranscriptSourceConnection.findUniqueOrThrow({where:{id:f.connection.id}})).status).toBe("ACTIVE");
    expect(await prisma.meeting.count({where:{workspaceId:f.ws.id}})).toBe(0);
    expect(await prisma.meetingTranscriptSourceRecord.count({where:{workspaceId:f.ws.id,status:"ACTIVE"}})).toBe(0);
  });

  it.each(["credentials", "retry"] as const)("blocks original member authority revoke-restore at %s despite swallowed model denial", async boundary => {
    const f = await fixture(); let sends=0; let guardError: unknown; let aborted = false;
    const nativeReceipt = await captureCompanyMemberTranscriptInput(f.actor,{workspaceId:f.ws.id,submission:f.submission});
    const extract = vi.spyOn(defaultModelGateway,"extract").mockImplementation(async request => {
      if (boundary === "retry") {await request.authorizeAttempt!({signal:new AbortController().signal}); sends++;}
      await prisma.member.update({where:{id:f.member.id},data:{isActive:false}});
      await prisma.member.update({where:{id:f.member.id},data:{isActive:true}});
      try { await request.authorizeAttempt?.({signal:new AbortController().signal}); sends++; }
      catch (error) { guardError = error; }
      aborted = request.signal?.aborted === true;
      return modelResult as never;
    });
    await expect(intakeMeetingTranscript(f.actor,{...f.submission,nativeReceipt})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(guardError).toMatchObject({code:"SOURCE_CHANGED"});
    expect(aborted).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1); expect(sends).toBe(boundary === "retry" ? 1 : 0);
    expect((await prisma.member.findUniqueOrThrow({where:{id:f.member.id}})).isActive).toBe(true);
    expect(await prisma.meeting.count({where:{workspaceId:f.ws.id}})).toBe(0);
    expect(await prisma.nativeTranscriptPublication.count({where:{nativeInputId:nativeReceipt.inputId}})).toBe(0);
  });
});
