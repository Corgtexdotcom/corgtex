import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { processMeetingTranscriptSourceWebhook, retryMeetingTranscriptImportBatch, runMeetingTranscriptSourceBackfill } from "./meeting-transcript-sources";
import { readableArtifactIds } from "./source-lineage";

const key = process.env.ENCRYPTION_KEY;
const secret = "synthetic-provider-webhook-secret";
async function fixture() {
  const ws = await prisma.workspace.create({ data: { name: "Native provider fixture", slug: `provider-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: ws.id, userId: user.id, role: "ADMIN" } });
  await prisma.workspaceFeatureFlag.create({ data: { workspaceId: ws.id, flag: "MEETING_TRANSCRIPT_SOURCES", enabled: true } });
  const connection = await prisma.meetingTranscriptSourceConnection.create({ data: { workspaceId: ws.id, provider: "FIREFLIES", status: "ACTIVE", authMode: "API_KEY", webhookSecretEnc: encryptSecret(secret) } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Fixture" } };
  const rawBody = JSON.stringify({ id: "synthetic-external", title: "Synthetic provider meeting", date: "2026-10-14T12:00:00.000Z", updated_at: "2026-10-14T13:00:00.000Z", transcript_text: "Alice: Exact synthetic provider text.\r\nBob: Confirmed." });
  const deliver = (body = rawBody) => processMeetingTranscriptSourceWebhook({ workspaceId: ws.id, provider: "FIREFLIES", rawBody: body, headers: { "x-fireflies-signature": createHmac("sha256", secret).update(body).digest("hex") } });
  return { ws, actor, connection, rawBody, deliver };
}
async function originalWires(input: { encryptedPayloadJson: string }) {
  const payload = JSON.parse(decryptSecret(input.encryptedPayloadJson));
  const archive = await prisma.transcriptTransportArchive.findUniqueOrThrow({ where: { id: payload.archive.id } });
  return JSON.parse(decryptSecret(archive.encryptedWiresJson));
}
describe("authenticated provider native transcript custody", () => {
  beforeEach(async () => { process.env.ENCRYPTION_KEY ??= "1".repeat(64); await truncateAllTables(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external provider network"); })); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); if (key === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = key; });
  it("atomically publishes a signed original and serves it through ordinary member lineage", async () => {
    const f = await fixture();
    const result = await f.deliver();
    expect(await prisma.meetingTranscriptSourceRecord.findMany({ where: { workspaceId: f.ws.id, status: "FAILED" }, select: { error: true } })).toEqual([]);
    expect("batch" in result && result.batch.error).toBe(null);
    expect("batch" in result && result.batch.importedCount).toBe(1);
    const meeting = await prisma.meeting.findFirstOrThrow({ where: { workspaceId: f.ws.id } });
    const native = await prisma.nativeTranscriptInput.findFirstOrThrow({ where: { workspaceId: f.ws.id, mode: "PROVIDER_IMPORT" } });
    expect((await originalWires(native))[0].text).toBe(f.rawBody);
    expect(native.ownerMemberId).toBe(null);
    expect(await readableArtifactIds(f.actor, f.ws.id, "Meeting", [meeting])).toEqual(new Set([meeting.id]));
  });
  it("keeps the original native authority through a newer provider revision and denies revoke-restore", async () => {
    const f = await fixture();
    await f.deliver();
    const first = await prisma.meetingTranscriptSourceRecord.findFirstOrThrow({ where: { workspaceId: f.ws.id, status: "ACTIVE" } });
    const body = JSON.stringify({ ...JSON.parse(f.rawBody), updated_at: "2026-10-14T14:00:00.000Z", transcript_text: "Alice: Corrected synthetic provider text." });
    const revision = await f.deliver(body);
    expect(await prisma.meetingTranscriptSourceRecord.findMany({ where: { workspaceId: f.ws.id, status: "FAILED" }, select: { error: true } })).toEqual([]);
    expect("batch" in revision && revision.batch.importedCount).toBe(1);
    expect(await prisma.meetingTranscriptSourceRecord.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "SUPERSEDED" });
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: first.meetingId! } });
    expect(meeting.transcript).toBe("Alice: Corrected synthetic provider text.");
    expect(await readableArtifactIds(f.actor, f.ws.id, "Meeting", [meeting])).toEqual(new Set([meeting.id]));
    const duplicate = await f.deliver(body);
    expect("batch" in duplicate && duplicate.batch.skippedCount).toBe(1);
    await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { status: "DISABLED" } });
    await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { status: "ACTIVE" } });
    expect(await readableArtifactIds(f.actor, f.ws.id, "Meeting", [meeting])).toEqual(new Set());
    const stale = await f.deliver(body);
    expect("batch" in stale && stale.batch.failedCount).toBe(1);
    expect("batch" in stale && stale.batch.skippedCount).toBe(0);
  });

  it.each(["FATHOM", "READ_AI"] as const)("publishes exact authenticated %s callback custody", async provider => {
    const f = await fixture();
    const providerSecret = Buffer.from("synthetic-provider-key").toString("base64");
    await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { provider, webhookSecretEnc: encryptSecret(providerSecret) } });
    const rawBody = provider === "FATHOM" ? f.rawBody : JSON.stringify({ session_id: "read-synthetic", trigger: "meeting_end", title: "Synthetic Read", start_time: "2026-10-14T12:00:00Z", end_time: "2026-10-14T13:00:00Z", transcript: { speaker_blocks: [{ speaker: { name: "Alice" }, words: "Exact synthetic Read original." }] } });
    const timestamp = String(Math.floor(Date.now() / 1000)), id = "synthetic-event";
    const headers = provider === "FATHOM" ? { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${createHmac("sha256", Buffer.from(providerSecret, "base64")).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}` } : { "x-read-signature": createHmac("sha256", Buffer.from(providerSecret, "base64")).update(rawBody).digest("hex") };
    const result = await processMeetingTranscriptSourceWebhook({ workspaceId: f.ws.id, provider, rawBody, headers });
    expect(await prisma.meetingTranscriptSourceRecord.findMany({ where: { workspaceId: f.ws.id, status: "FAILED" }, select: { error: true } })).toEqual([]);
    expect("batch" in result && result.batch.importedCount).toBe(1);
    const native = await prisma.nativeTranscriptInput.findFirstOrThrow({ where: { workspaceId: f.ws.id } });
    expect((await originalWires(native))[0].text).toBe(rawBody);
    const meeting = await prisma.meeting.findFirstOrThrow({ where: { workspaceId: f.ws.id } });
    expect(await readableArtifactIds(f.actor, f.ws.id, "Meeting", [meeting])).toEqual(new Set([meeting.id]));
  });

  it("rejects wrong-provider and wrong-workspace callbacks before native custody", async () => {
    const f = await fixture();
    await expect(processMeetingTranscriptSourceWebhook({ workspaceId: f.ws.id, provider: "FIREFLIES", rawBody: f.rawBody, headers: { "x-read-signature": createHmac("sha256", secret).update(f.rawBody).digest("hex") } })).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    await expect(processMeetingTranscriptSourceWebhook({ workspaceId: randomUUID(), provider: "FIREFLIES", rawBody: f.rawBody, headers: {} })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.nativeTranscriptInput.count()).toBe(0);
  });

  it("seals the exact authenticated API response selected for each backfill item", async () => {
    const f = await fixture();
    await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { apiKeyEnc: encryptSecret("synthetic-api-key") } });
    const raw = JSON.stringify({ data: { transcripts: [1, 2].map(index => ({ id: `api-${index}`, title: `Synthetic API ${index}`, date: "2026-10-14T12:00:00Z", sentences: [{ speaker_name: "Alice", text: `Exact ${index} API original.` }] })) } });
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(new Headers(options.headers).get("authorization")).toBe("Bearer synthetic-api-key");
      expect(options.redirect).toBe("error");
      return new Response(raw, { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await runMeetingTranscriptSourceBackfill(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES" });
    expect(await prisma.meetingTranscriptSourceRecord.findMany({ where: { workspaceId: f.ws.id, status: "FAILED" }, select: { error: true } })).toEqual([]);
    expect(result.batch.importedCount).toBe(2);
    for (const input of await prisma.nativeTranscriptInput.findMany({ where: { workspaceId: f.ws.id } })) expect(await originalWires(input)).toEqual([{ kind: "API", url: "https://api.fireflies.ai/graphql", status: 200, text: raw }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("archives a 15 MiB shared page once and publishes all six small selections within the default transaction budget", async () => {
    const f = await fixture();
    await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { apiKeyEnc: encryptSecret("synthetic-api-key") } });
    const raw = JSON.stringify({ padding: "x".repeat(15 * 1024 * 1024), data: { transcripts: Array.from({ length: 6 }, (_, index) => ({ id: `budget-${index}`, title: `Budget ${index}`, date: "2026-10-14T12:00:00Z", sentences: [{ speaker_name: "Alice", text: `Original ${index}.` }] })) } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(raw)));
    const result = await runMeetingTranscriptSourceBackfill(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES" });
    expect(await prisma.meetingTranscriptSourceRecord.findMany({ where: { status: "FAILED" }, select: { error: true } })).toEqual([]);
    expect(result.batch.status).toBe("COMPLETED");
    expect(result.batch.importedCount).toBe(6);
    expect(result.batch.failedCount).toBe(0);
    const inputs = await prisma.nativeTranscriptInput.findMany({ where: { workspaceId: f.ws.id } });
    expect(inputs).toHaveLength(6);
    expect(await prisma.transcriptTransportArchive.count()).toBe(1);
    const archive = await prisma.transcriptTransportArchive.findFirstOrThrow();
    expect(JSON.parse(decryptSecret(archive.encryptedWiresJson))[0].text).toBe(raw);
    for (const input of inputs) {
      expect(Buffer.byteLength(input.encryptedPayloadJson)).toBeLessThan(15000);
      expect(JSON.parse(decryptSecret(input.encryptedPayloadJson)).archive.id).toBe(archive.id);
    }
    for (const meeting of await prisma.meeting.findMany()) expect(await readableArtifactIds(f.actor, f.ws.id, "Meeting", [meeting])).toEqual(new Set([meeting.id]));
    expect(await prisma.meeting.count()).toBe(6);
  });

  it("serializes concurrent imports without replacing the winning source or granting the losing receipt", async () => {
    const f = await fixture();
    await Promise.all([f.deliver(), f.deliver()]);
    const records = await prisma.meetingTranscriptSourceRecord.findMany({where:{workspaceId:f.ws.id,status:"ACTIVE"}});
    expect(records).toHaveLength(1);
    expect(await prisma.meeting.count()).toBe(1);
    const {isProviderTranscriptInputCurrent} = await import("./transcript-source-native-input");
    const inputs = await prisma.nativeTranscriptInput.findMany({where:{workspaceId:f.ws.id}});
    const allowed = await Promise.all(inputs.map(input=>isProviderTranscriptInputCurrent(f.actor,f.ws.id,input,prisma)));
    expect(allowed.filter(Boolean)).toHaveLength(1);
  });

  it("rejects caller revoke-restore during authenticated backfill without publishing", async () => {
    const f = await fixture();
    await prisma.meetingTranscriptSourceConnection.update({where:{id:f.connection.id},data:{apiKeyEnc:encryptSecret("synthetic-api-key")}});
    const member = await prisma.member.findFirstOrThrow({where:{workspaceId:f.ws.id}});
    vi.stubGlobal("fetch", vi.fn(async () => {
      await prisma.member.update({where:{id:member.id},data:{role:"CONTRIBUTOR"}});
      await prisma.member.update({where:{id:member.id},data:{role:"ADMIN"}});
      return new Response(JSON.stringify({data:{transcripts:[]}}));
    }));
    const result = await runMeetingTranscriptSourceBackfill(f.actor,{workspaceId:f.ws.id,provider:"FIREFLIES"});
    expect(result.batch.status).toBe("FAILED");
    expect(await prisma.nativeTranscriptInput.count()).toBe(0);
    expect(await prisma.meeting.count()).toBe(0);
  });

  it("enforces one streamed operation budget across pages and cancels the overflowing reader", async () => {
    const f = await fixture();
    await prisma.meetingTranscriptSourceConnection.update({where:{id:f.connection.id},data:{apiKeyEnc:encryptSecret("synthetic-api-key")}});
    const {withTranscriptSourceTransport,fetchTranscriptSourceJson} = await import("./transcript-source-native-input");
    let cancelled = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({data:"x".repeat(11*1024*1024)}))); },
      cancel() { cancelled += 1; },
    }))));
    // First response must close to finish parsing; the second remains open so
    // overflow proves cancellation rather than an already-consumed stream.
    const fetcher = vi.mocked(fetch);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({data:"x".repeat(11*1024*1024)})));
    await expect(withTranscriptSourceTransport(f.actor,{workspaceId:f.ws.id,provider:"FIREFLIES"},async token=>{
      await fetchTranscriptSourceJson(token,"https://api.fireflies.ai/graphql");
      await fetchTranscriptSourceJson(token,"https://api.fireflies.ai/graphql");
    })).rejects.toMatchObject({code:"TRANSCRIPT_TOO_LARGE"});
    expect(cancelled).toBe(1);
    expect(await prisma.nativeTranscriptInput.count()).toBe(0);
  });

  it("preserves the entire failed original on identical authenticated retry and replay", async () => {
    const f = await fixture();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION pun68_test_provider_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='meeting-transcript-source.imported' THEN RAISE EXCEPTION 'synthetic publication rollback'; END IF; RETURN NEW; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER pun68_test_provider_rollback BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION pun68_test_provider_rollback()`);
    try {
      const failed = await f.deliver();
      expect("batch" in failed && failed.batch.failedCount).toBe(1);
      expect(await prisma.meeting.count()).toBe(0);
      expect(await prisma.artifactInputLineage.count({where:{artifactType:"MeetingTranscript"}})).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER pun68_test_provider_rollback ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION pun68_test_provider_rollback()`);
    }
    const diagnostic = await prisma.meetingTranscriptSourceRecord.findFirstOrThrow({where:{workspaceId:f.ws.id,status:"FAILED"}});
    const retry = await f.deliver();
    expect("batch" in retry && retry.batch.importedCount).toBe(1);
    const replay = await f.deliver();
    expect("batch" in replay && replay.batch.skippedCount).toBe(1);
    expect(await prisma.meetingTranscriptSourceRecord.findUniqueOrThrow({where:{id:diagnostic.id}})).toEqual(diagnostic);
    expect(await prisma.meetingTranscriptSourceRecord.count({where:{workspaceId:f.ws.id,status:"ACTIVE"}})).toBe(1);
    expect(await prisma.event.count({where:{workspaceId:f.ws.id,type:"meeting.created"}})).toBe(1);
    const {isProviderTranscriptInputCurrent} = await import("./transcript-source-native-input");
    const inputs = await prisma.nativeTranscriptInput.findMany({where:{workspaceId:f.ws.id}});
    expect((await Promise.all(inputs.map(input=>isProviderTranscriptInputCurrent(f.actor,f.ws.id,input,prisma)))).filter(Boolean)).toHaveLength(1);
  });

  it("enforces successful dedup in PostgreSQL while preserving multiple failed diagnostic identities", async () => {
    const f = await fixture();
    const data = {workspaceId:f.ws.id,provider:"FIREFLIES" as const,externalId:"same-identity",contentHash:"a".repeat(64),recordedAt:new Date(),transcriptText:"Exact diagnostic original"};
    const failed = await prisma.meetingTranscriptSourceRecord.create({data:{...data,status:"FAILED",error:"original failure"}});
    await prisma.meetingTranscriptSourceRecord.create({data:{...data,status:"FAILED",error:"second failure"}});
    await prisma.meetingTranscriptSourceRecord.create({data:{...data,status:"ACTIVE"}});
    for (const status of ["ACTIVE","SUPERSEDED","SKIPPED"] as const) await expect(prisma.meetingTranscriptSourceRecord.create({data:{...data,status}})).rejects.toMatchObject({code:"P2002"});
    expect(await prisma.meetingTranscriptSourceRecord.findUniqueOrThrow({where:{id:failed.id}})).toEqual(failed);
  });

  it("withholds an original after provider record payload mutation and restoration", async () => {
    const f = await fixture(); await f.deliver();
    const record = await prisma.meetingTranscriptSourceRecord.findFirstOrThrow({where:{workspaceId:f.ws.id,status:"ACTIVE"}});
    const meeting = await prisma.meeting.findFirstOrThrow({where:{workspaceId:f.ws.id}});
    await prisma.meetingTranscriptSourceRecord.update({where:{id:record.id},data:{transcriptText:"Changed bytes"}});
    await prisma.meetingTranscriptSourceRecord.update({where:{id:record.id},data:{transcriptText:record.transcriptText}});
    expect(await readableArtifactIds(f.actor,f.ws.id,"Meeting",[meeting])).toEqual(new Set());
  });

  it("keeps transport ciphertext immutable and withholds delete-restore archive bindings", async () => {
    const f = await fixture(); await f.deliver();
    const archive = await prisma.transcriptTransportArchive.findFirstOrThrow();
    const meeting = await prisma.meeting.findFirstOrThrow();
    await expect(prisma.transcriptTransportArchive.update({ where: { id: archive.id }, data: { encryptedWiresJson: encryptSecret("forged") } })).rejects.toThrow("immutable");
    await prisma.transcriptTransportArchive.delete({ where: { id: archive.id } });
    const { cipherHash: _generated, ...data } = archive;
    await prisma.transcriptTransportArchive.create({ data });
    expect(await readableArtifactIds(f.actor, f.ws.id, "Meeting", [meeting])).toEqual(new Set());
  });

  it("refetches only the selected failed ID and preserves its original diagnostic through retry and replay", async () => {
    const f = await fixture();
    await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { apiKeyEnc: encryptSecret("synthetic-api-key") } });
    const batch = await prisma.meetingTranscriptImportBatch.create({ data: { workspaceId: f.ws.id, connectionId: f.connection.id, provider: "FIREFLIES", sourceKind: "provider_backfill", status: "FAILED" } });
    const old = await prisma.meetingTranscriptSourceRecord.create({ data: { workspaceId: f.ws.id, connectionId: f.connection.id, batchId: batch.id, provider: "FIREFLIES", externalId: "retry-exact", contentHash: "d".repeat(64), recordedAt: new Date(), transcriptText: "Original diagnostic must stay byte-identical", rawMetadataJson: { original: "retained" }, status: "FAILED", error: "Original failure" } });
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(JSON.parse(String(options.body)).variables).toEqual({ id: old.externalId });
      return new Response(JSON.stringify({ data: { transcript: { id: old.externalId, title: "Fresh authenticated retry", date: "2026-10-14T12:00:00Z", sentences: [{ speaker_name: "Alice", text: "Fresh exact provider bytes." }] } } }));
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await retryMeetingTranscriptImportBatch(f.actor, { workspaceId: f.ws.id, batchId: batch.id })).batch.importedCount).toBe(1);
    expect((await retryMeetingTranscriptImportBatch(f.actor, { workspaceId: f.ws.id, batchId: batch.id })).batch.skippedCount).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await prisma.meetingTranscriptSourceRecord.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await prisma.meeting.count()).toBe(1);
    expect(await prisma.meetingTranscriptSourceRecord.count({ where: { status: "ACTIVE" } })).toBe(1);
  });

  it.each(["wrong-response", "caller", "connection"])("denies authenticated failed retry after %s changes", async reason => {
    const f = await fixture();
    await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { apiKeyEnc: encryptSecret("synthetic-api-key") } });
    const batch = await prisma.meetingTranscriptImportBatch.create({ data: { workspaceId: f.ws.id, connectionId: f.connection.id, provider: "FIREFLIES", sourceKind: "provider_backfill", status: "FAILED" } });
    const old = await prisma.meetingTranscriptSourceRecord.create({ data: { workspaceId: f.ws.id, connectionId: f.connection.id, batchId: batch.id, provider: "FIREFLIES", externalId: "retry-selected", contentHash: "d".repeat(64), recordedAt: new Date(), transcriptText: "Retained original", status: "FAILED" } });
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (reason === "caller") {
        const member = await prisma.member.findFirstOrThrow({ where: { workspaceId: f.ws.id } });
        await prisma.member.update({ where: { id: member.id }, data: { role: "CONTRIBUTOR" } });
        await prisma.member.update({ where: { id: member.id }, data: { role: "ADMIN" } });
      }
      if (reason === "connection") {
        await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { status: "DISABLED" } });
        await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { status: "ACTIVE" } });
      }
      return new Response(JSON.stringify({ data: { transcript: { id: reason === "wrong-response" ? "foreign-id" : old.externalId, date: "2026-10-14T12:00:00Z", sentences: [{ text: "Exact response." }] } } }));
    }));
    await expect(retryMeetingTranscriptImportBatch(f.actor, { workspaceId: f.ws.id, batchId: batch.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.meetingTranscriptSourceRecord.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await prisma.nativeTranscriptInput.count()).toBe(0);
    expect(await prisma.meeting.count()).toBe(0);
  });

  it("bounds persisted failure diagnostics when remaining durable custody cannot admit the selected original", async () => {
    const f = await fixture();
    await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { apiKeyEnc: encryptSecret("synthetic-api-key") } });
    const raw = JSON.stringify({ data: { transcripts: [
      ...[1, 2].map(index => ({ id: `invalid-${index}`, padding: "x".repeat(3 * 1024 * 1024) })),
      { id: "compact-overflow", title: "Rejected large selected metadata", date: "2026-10-14T12:00:00Z", padding: "y".repeat(8 * 1024 * 1024), sentences: [{ text: "Small selected transcript." }] },
    ] } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(raw)));
    const result = await runMeetingTranscriptSourceBackfill(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES" });
    expect(result.batch).toMatchObject({ status: "FAILED", failedCount: 3, importedCount: 0 });
    const denied = await prisma.meetingTranscriptSourceRecord.findFirstOrThrow({ where: { externalId: "compact-overflow" } });
    expect(denied).toMatchObject({ transcriptText: "", summaryMd: null, segmentsJson: null, participantsJson: null, rawMetadataJson: { nativeBudgetExceeded: true } });
    expect(Buffer.byteLength(JSON.stringify(denied))).toBeLessThan(2048);
    expect(await prisma.nativeTranscriptInput.count()).toBe(0);
    expect(await prisma.meeting.count()).toBe(0);
    expect(await prisma.transcriptTransportArchive.count()).toBe(0);
    const preserved = await prisma.meetingTranscriptSourceRecord.findMany({ where: { externalId: { startsWith: "invalid-" } } });
    expect(preserved).toHaveLength(2);
    for (const record of preserved) expect(Buffer.byteLength(JSON.stringify(record.rawMetadataJson))).toBeGreaterThan(3 * 1024 * 1024);
  });

  it("rejects successful duplicate return when the initiating admin is revoked and restored during native validation", async () => {
    const f = await fixture();
    await prisma.meetingTranscriptSourceConnection.update({ where: { id: f.connection.id }, data: { apiKeyEnc: encryptSecret("synthetic-api-key") } });
    const raw = JSON.stringify({ data: { transcripts: [{ id: "duplicate-operation", title: "Duplicate operation", date: "2026-10-14T12:00:00Z", sentences: [{ text: "Exact original." }] }] } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(raw)));
    expect((await runMeetingTranscriptSourceBackfill(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES" })).batch.importedCount).toBe(1);
    const originalRecord = await prisma.meetingTranscriptSourceRecord.findFirstOrThrow({ where: { status: "ACTIVE" } });
    const member = await prisma.member.findFirstOrThrow({ where: { workspaceId: f.ws.id } });
    let intervened = false;
    const find = prisma.nativeTranscriptInput.findFirst.bind(prisma.nativeTranscriptInput);
    // Only the delegate's awaited result is used here; every read still executes
    // real PostgreSQL, with the revocation scheduled at the duplicate boundary.
    vi.spyOn(prisma.nativeTranscriptInput, "findFirst").mockImplementation((async args => {
      const row = await find(args);
      if (!intervened && args?.where?.sourceRecordId === originalRecord.id) {
        intervened = true;
        await prisma.member.update({ where: { id: member.id }, data: { role: "CONTRIBUTOR" } });
        await prisma.member.update({ where: { id: member.id }, data: { role: "ADMIN" } });
      }
      return row;
    }) as typeof prisma.nativeTranscriptInput.findFirst);
    const replay = await runMeetingTranscriptSourceBackfill(f.actor, { workspaceId: f.ws.id, provider: "FIREFLIES" });
    expect(intervened).toBe(true);
    expect(replay.batch).toMatchObject({ importedCount: 0, skippedCount: 0, failedCount: 1 });
    expect(await prisma.meetingTranscriptSourceRecord.findUniqueOrThrow({ where: { id: originalRecord.id } })).toEqual(originalRecord);
    expect(await prisma.meeting.count()).toBe(1);
  });

});
