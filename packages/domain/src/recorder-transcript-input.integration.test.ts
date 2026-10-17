import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import type { AppActor } from "@corgtex/shared";
const probe = vi.hoisted(() => ({ depth: 0, failPublication: false, tamperEvent: false, tamperMeeting: false, tamperManifest: false, dispatchEvent: false }));
vi.mock("@corgtex/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  const instrumented = new Proxy(actual.prisma, { get(target, key) {
    if (key !== "$transaction") return Reflect.get(target, key, target);
    return async (...args: any[]) => {
      const original = target.$transaction.bind(target) as (...args: any[]) => Promise<any>;
      if (typeof args[0] !== "function") return original(...args);
      return original(async (tx: any) => {
        probe.depth++;
        try {
          const fenced = new Proxy(tx, { get(client, field) {
            const delegate = Reflect.get(client, field, client);
            if (field === "event" && probe.dispatchEvent) return { ...delegate, create: (input: any) => delegate.create({ ...input, data: { ...input.data, status: "DISPATCHED", attempts: 1 } }) };
            if (field === "artifactInputLineage" && probe.tamperManifest) return { ...delegate, create: (input: any) => delegate.create({ ...input, data: { ...input.data, rootsJson: [], origin: "HUMAN_ORIGINAL" } }) };
            if (field === "event" && probe.tamperEvent) return { ...delegate, create: (input: any) => delegate.create({ ...input, data: { ...input.data, payload: { substituted: true } } }) };
            if (field === "meeting" && probe.tamperMeeting) return { ...delegate, update: (input: any) => delegate.update({ ...input, data: { ...input.data, transcript: "Substituted after preparation" } }) };
            return delegate;
          } });
          const value = await args[0](fenced);
          if (value?.committed && probe.failPublication) throw new Error("synthetic publication rollback");
          return value;
        } finally { probe.depth--; }
      }, ...args.slice(1));
    };
  } });
  return { ...actual, prisma: instrumented };
});
import { prisma, decryptSecret } from "@corgtex/shared";
import { prepareArtifactSourceCommit, withArtifactSourceCommit } from "./artifact-source-commit";
import { processMeetingRecorderWebhook, reconcileMeetingRecorders, redactProviderArtifactUrls } from "./meeting-recorders";
import { recordArtifactInputLineage, captureArtifactInputProof, isArtifactInputProofReadable } from "./source-lineage";
import { isRecorderTranscriptInputCurrent, readRecorderProviderResponse, captureRecorderProviderWire, reserveRecorderProviderWire, publishEmptyRecorderTranscript, prepareRecorderTranscript, publishRecorderTranscript, withRecorderTranscriptAttempt } from "./recorder-transcript-input";

async function fixture(proven = true, provider: "RECALL_AI" | "MEETING_BAAS" = "RECALL_AI") {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic recorder", slug: `recorder-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: "Recorder member", passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: user.displayName, globalRole: "USER" } };
  const meeting = await prisma.meeting.create({ data: { workspaceId: workspace.id, title: "Synthetic scheduled meeting", source: "manual", recordedAt: new Date(Date.now() - 2 * 3600_000), scheduledEndAt: new Date(Date.now() - 3600_000), status: "SCHEDULED" } });
  if (proven) await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "Meeting", id: meeting.id }, content: meeting, origin: "HUMAN_ORIGINAL", inputs: [] }));
  await prisma.workspaceMeetingRecorderConfig.create({ data: { workspaceId: workspace.id, enabled: true } });
  const recording = await prisma.meetingRecording.create({ data: { workspaceId: workspace.id, meetingId: meeting.id, provider, externalBotId: `synthetic-bot-${randomUUID()}`, meetingUrl: "https://meet.google.com/synthetic", status: "COMPLETED" } });
  return { workspace, actor, meeting, recording };
}
const artifact = { transcriptPayload: [{ speaker: "Synthetic speaker", start: 0, text: "Exact native recorder original." }], metadata: { source: "synthetic" } };
function provider(recording: Awaited<ReturnType<typeof fixture>>["recording"]) {
  expect(probe.depth).toBe(0);
  const url = `https://us-west-2.recall.ai/api/v1/bot/${recording.externalBotId}/transcript/`;
  captureRecorderProviderWire(url, { headers: { Authorization: "Token synthetic-recall-key" } }, 200, JSON.stringify(artifact.transcriptPayload));
  return artifact;
}
async function ingest(f: Awaited<ReturnType<typeof fixture>>) {
  return withRecorderTranscriptAttempt(f.recording, null, async receipt => publishRecorderTranscript(await prepareRecorderTranscript(receipt, provider(f.recording), { source: "synthetic" })));
}
beforeEach(async () => {
  // The native driver fixture is independent of developer credentials and CI's shell.
  vi.unstubAllGlobals();
  vi.stubEnv("MEETING_BAAS_API_KEY", "synthetic-baas-key");
  vi.stubEnv("MEETING_BAAS_WEBHOOK_SECRET", "synthetic-baas-secret");
  vi.stubEnv("RECALL_API_KEY", "synthetic-recall-key");
  vi.stubEnv("RECALL_REGION", "us-west-2");
  vi.stubEnv("RECALL_WEBHOOK_SECRET", "synthetic-signing");
  vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", undefined);
  probe.failPublication = false; probe.tamperEvent = false; probe.tamperMeeting = false; probe.tamperManifest = false; probe.dispatchEvent = false;
  await truncateAllTables();
});
afterAll(async () => { try { await prisma.$disconnect(); } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); } });

describe("authenticated recorder native custody and atomic publication", () => {
  it("claims before native fetch, commits complete manifests and event atomically, and serves after the worker lease ends", async () => {
    const f = await fixture();
    const result = await ingest(f);
    expect(result).toMatchObject({ committed: true, meetingId: f.meeting.id });
    const input = await prisma.nativeTranscriptInput.findFirstOrThrow({ where: { workspaceId: f.workspace.id, mode: "RECORDER" } });
    expect(input.ownerMemberId).toBeNull(); expect(input.submittedByUserId).toBeNull();
    expect(JSON.parse(decryptSecret(input.encryptedPayloadJson)).responses[0].text).toBe(JSON.stringify(artifact.transcriptPayload));
    const publication = await prisma.recorderTranscriptPublication.findFirstOrThrow({ where: { nativeInputId: input.id } });
    expect(await prisma.event.findUnique({ where: { id: publication.eventId } })).toMatchObject({ status: "PENDING", payload: expect.objectContaining({ nativeInputId: input.id, source: "recorder:recall_ai" }) });
    expect(await prisma.artifactInputLineage.findUnique({ where: { id: publication.transcriptManifestId } })).toMatchObject({ origin: "DERIVED", artifactType: "MeetingTranscript" });
    expect(await prisma.meetingRecording.findUnique({ where: { id: f.recording.id } })).toMatchObject({ status: "COMPLETED", transcriptProcessedAt: expect.any(Date) });
    expect(await prisma.meeting.findUnique({ where: { id: f.meeting.id } })).toMatchObject({ source: "recorder:recall_ai" });
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "MeetingTranscript", id: f.meeting.id }]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    await expect(prisma.nativeTranscriptInput.update({ where: { id: input.id }, data: { encryptedPayloadJson: "replacement" } })).rejects.toThrow("Immutable");
  });
  it.each(["startedAt", "joinAt", "createdAt"] as const)("publishes original recording %s consistently in Meeting, event, audit and proved output", async field => {
    const f = await fixture();
    const startedAt = new Date("2026-01-03T12:05:00Z"), joinAt = new Date("2026-01-03T12:00:00Z"), createdAt = new Date("2026-01-02T12:00:00Z");
    f.recording = await prisma.meetingRecording.update({where: {id: f.recording.id}, data: {
      startedAt: field === "startedAt" ? startedAt : null, joinAt: field !== "createdAt" ? joinAt : null, createdAt,
    }});
    const expected = {startedAt, joinAt, createdAt}[field];
    await ingest(f);
    const meeting = await prisma.meeting.findUniqueOrThrow({where: {id: f.meeting.id}});
    expect(meeting.recordedAt).toEqual(expected);
    expect(meeting.recordedAt).not.toEqual(f.meeting.recordedAt);
    expect(await prisma.event.findFirstOrThrow({where: {workspaceId: f.workspace.id, type: "meeting.transcript-uploaded"}}))
      .toMatchObject({payload: expect.objectContaining({recordedAt: expected.toISOString()})});
    expect(await prisma.auditLog.findFirstOrThrow({where: {workspaceId: f.workspace.id, action: "meeting.transcript-uploaded"}}))
      .toMatchObject({meta: expect.objectContaining({recordedAt: expected.toISOString()})});
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "Meeting", id: meeting.id}]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
  });
  it.each(["during fetch", "after preparation"])("rejects timestamp replacement %s without refreshing original recording authority", async phase => {
    const f = await fixture();
    await expect(withRecorderTranscriptAttempt(f.recording, null, async receipt => {
      const fetched = provider(f.recording);
      const prepared = phase === "after preparation" ? await prepareRecorderTranscript(receipt, fetched, {}) : null;
      await prisma.meetingRecording.update({where: {id: f.recording.id}, data: {startedAt: new Date("2026-01-03T12:05:00Z")}});
      return publishRecorderTranscript(prepared ?? await prepareRecorderTranscript(receipt, fetched, {}));
    })).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(await prisma.meeting.findUniqueOrThrow({where: {id: f.meeting.id}})).toMatchObject({recordedAt: f.meeting.recordedAt, transcript: null});
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.event.count({where: {type: "meeting.transcript-uploaded"}})).toBe(0);
  });
  it("a real transaction failure leaves immutable original custody and no transcript, terminal receipt or outbox advancement", async () => {
    const f = await fixture(); probe.failPublication = true;
    await expect(ingest(f)).rejects.toThrow("synthetic publication rollback");
    expect(await prisma.nativeTranscriptInput.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.meeting.findUnique({ where: { id: f.meeting.id } })).toMatchObject({ transcript: null });
    expect(await prisma.meetingRecording.findUnique({ where: { id: f.recording.id } })).toMatchObject({ transcriptProcessedAt: null });
    expect(await prisma.event.count({ where: { type: "meeting.transcript-uploaded" } })).toBe(0);
    expect(await prisma.meetingTranscriptProcessingProgress.count()).toBe(0);
  });
  it("withholds unknown prior metadata while preserving the authenticated raw original", async () => {
    const f = await fixture(false);
    await expect(ingest(f)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(await prisma.nativeTranscriptInput.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.meeting.findUnique({ where: { id: f.meeting.id } })).toMatchObject({ transcript: null });
  });
  it("rejects a label or copied receipt without any native publication", async () => {
    await expect(prepareRecorderTranscript({} as any, artifact, {})).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
  });
  it("database disable and restore cannot revive an old committed source proof", async () => {
    const f = await fixture(); await ingest(f);
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "MeetingTranscript", id: f.meeting.id }]);
    await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: false } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(false);
    await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: true } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(false);
  });
  it("commits a signed event terminal marker with its exact outbox identity", async () => {
    const f = await fixture();
    const eventId = `evt-${randomUUID()}`;
    const downloadUrl = "https://synthetic.example.test/transcript.json";
    const rawBody = JSON.stringify({ id: eventId, event: "transcript.done", data: { bot: { id: f.recording.externalBotId,
      metadata: { workspaceId: f.workspace.id, meetingId: f.meeting.id, recordingId: f.recording.id } },
      transcript: { id: "synthetic-transcript", data: { download_url: downloadUrl } } } });
    const headers = { "svix-id": "synthetic-message", "svix-timestamp": "1",
      "svix-signature": `v1,${createHmac("sha256", "synthetic-signing").update(`synthetic-message.1.${rawBody}`).digest("base64")}` };
    const event = await prisma.meetingRecorderProviderEvent.create({ data: { workspaceId: f.workspace.id, recordingId: f.recording.id,
      provider: "RECALL_AI", externalBotId: f.recording.externalBotId, externalEventId: eventId, eventType: "transcript.done", dedupeKey: `RECALL_AI:${eventId}`, payload: redactProviderArtifactUrls(JSON.parse(rawBody)) } });
    await withRecorderTranscriptAttempt(f.recording, { rawBody, headers, providerEventId: event.id }, async receipt => {
      expect(probe.depth).toBe(0);
      captureRecorderProviderWire(downloadUrl, { headers: {} }, 200, JSON.stringify(artifact.transcriptPayload));
      return publishRecorderTranscript(await prepareRecorderTranscript(receipt, artifact, {}));
    });
    const publication = await prisma.recorderTranscriptPublication.findFirstOrThrow({ where: { recordingId: f.recording.id } });
    expect(publication.providerEventId).toBe(event.id);
    expect(await prisma.meetingRecorderProviderEvent.findUnique({ where: { id: event.id } })).toMatchObject({ processedAt: expect.any(Date), error: null });
  });
  it("rejects a valid signed event for a different bot before any provider fetch", async () => {
    const f = await fixture();
    const rawBody = JSON.stringify({ id: "wrong-bot", event: "transcript.done", data: { bot: { id: "foreign-bot", metadata: { workspaceId: f.workspace.id } } } });
    const headers = { "svix-id": "m", "svix-timestamp": "1", "svix-signature": `v1,${createHmac("sha256", "synthetic-signing").update(`m.1.${rawBody}`).digest("base64")}` };
    const fetch = vi.fn();
    await expect(withRecorderTranscriptAttempt(f.recording, { rawBody, headers, providerEventId: "missing" }, fetch)).rejects.toMatchObject({ code: "RECORDER_WEBHOOK_RECORDING_MISMATCH" });
    expect(fetch).not.toHaveBeenCalled(); expect(await prisma.recorderTranscriptAttempt.count()).toBe(0);
  });
  it("rejects caller text substituted for authenticated response bytes", async () => {
    const f = await fixture();
    await expect(withRecorderTranscriptAttempt(f.recording, null, async receipt => {
      provider(f.recording);
      return prepareRecorderTranscript(receipt, { ...artifact, transcriptPayload: "Substituted caller text" }, {});
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.event.count({ where: { type: "meeting.transcript-uploaded" } })).toBe(0);
  });
  it("a copied attempt token cannot capture or publish", async () => {
    const f = await fixture();
    await withRecorderTranscriptAttempt(f.recording, null, async receipt => {
      provider(f.recording);
      await expect(prepareRecorderTranscript({ ...receipt } as typeof receipt, artifact, {})).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
  });
  it("allows one active generation and rejects a stale prepared writer after reclaim", async () => {
    const f = await fixture();
    await withRecorderTranscriptAttempt(f.recording, null, async receipt => {
      const pending = await prepareRecorderTranscript(receipt, provider(f.recording), {});
      const duplicateFetch = vi.fn();
      expect(await withRecorderTranscriptAttempt(f.recording, null, duplicateFetch)).toBeNull();
      expect(duplicateFetch).not.toHaveBeenCalled();
      await prisma.recorderTranscriptClaim.update({ where: { recordingId: f.recording.id }, data: { leaseUntil: new Date(0) } });
      const claim = await prisma.recorderTranscriptClaim.findUniqueOrThrow({ where: { recordingId: f.recording.id } });
      await withRecorderTranscriptAttempt(f.recording, null, async fresh => {
        await expect(publishRecorderTranscript(pending)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
        const result = await publishRecorderTranscript(await prepareRecorderTranscript(fresh, provider(f.recording), {}));
        expect(result.committed).toBe(true);
      });
      expect((await prisma.recorderTranscriptClaim.findUniqueOrThrow({ where: { recordingId: f.recording.id } })).generation).toBe(claim.generation + 1);
    });
    expect(await prisma.nativeTranscriptInput.count()).toBe(2); expect(await prisma.recorderTranscriptPublication.count()).toBe(1);
  });
  it("withholds unproved matching legacy text instead of treating a substring as a commit receipt", async () => {
    const f = await fixture(false);
    await prisma.meeting.update({ where: { id: f.meeting.id }, data: { transcript: "Synthetic speaker [00:00:00]: Exact native recorder original." } });
    await expect(ingest(f)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(await prisma.nativeTranscriptInput.count()).toBe(1); expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.event.count({ where: { type: "meeting.transcript-uploaded" } })).toBe(0);
  });
  it.each(["event", "meeting"])("rejects complete %s output substitution and rolls back all publication markers", async field => {
    const f = await fixture();
    if (field === "event") probe.tamperEvent = true; else probe.tamperMeeting = true;
    await expect(ingest(f)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.meeting.findUnique({ where: { id: f.meeting.id } })).toMatchObject({ transcript: null });
    expect(await prisma.meetingRecording.findUnique({ where: { id: f.recording.id } })).toMatchObject({ transcriptProcessedAt: null });
    expect(await prisma.event.count({ where: { type: "meeting.transcript-uploaded" } })).toBe(0);
    expect(await prisma.nativeTranscriptInput.count()).toBe(1);
  });
  it("refuses publication after the recording processed marker advances during provider work", async () => {
    const f = await fixture();
    await expect(withRecorderTranscriptAttempt(f.recording, null, async receipt => {
      const bytes = provider(f.recording);
      await prisma.meetingRecording.update({ where: { id: f.recording.id }, data: { transcriptProcessedAt: new Date() } });
      return prepareRecorderTranscript(receipt, bytes, {});
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.nativeTranscriptInput.count()).toBe(1); expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
  });

  it("uses declared request order when parallel transcript responses finish in reverse", async () => {
    const f = await fixture();
    const first = [{ speaker: "First", start: 0, text: "First declared artifact" }], second = [{ speaker: "Second", start: 1, text: "Second declared artifact" }];
    await withRecorderTranscriptAttempt(f.recording, null, async receipt => {
      const firstOrdinal = reserveRecorderProviderWire(), secondOrdinal = reserveRecorderProviderWire();
      const base = `https://us-west-2.recall.ai/api/v1/bot/${f.recording.externalBotId}/`;
      const init = { headers: { Authorization: "Token synthetic-recall-key" } };
      captureRecorderProviderWire(`${base}transcript/second`, init, 200, JSON.stringify(second), secondOrdinal);
      captureRecorderProviderWire(`${base}transcript/first`, init, 200, JSON.stringify(first), firstOrdinal);
      return publishRecorderTranscript(await prepareRecorderTranscript(receipt, { transcriptPayload: [...first, ...second], metadata: {} }, {}));
    });
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: f.meeting.id } })).transcript).toBe("First [00:00:00]: First declared artifact\nSecond [00:00:01]: Second declared artifact");
  });
  it("fences verified empty custody without a serving publication, transcript or outbox event", async () => {
    const f = await fixture();
    const smoke = await prisma.meetingRecorderSmokeRun.create({ data: { workspaceId: f.workspace.id, recordingId: f.recording.id, status: "PENDING" } });
    const result = await withRecorderTranscriptAttempt(f.recording, null, async receipt => {
      captureRecorderProviderWire(`https://us-west-2.recall.ai/api/v1/bot/${f.recording.externalBotId}/transcript/`, { headers: { Authorization: "Token synthetic-recall-key" } }, 200, "[]");
      return publishEmptyRecorderTranscript(receipt, { transcriptPayload: [], metadata: {} }, {});
    });
    expect(result).toMatchObject({ committed: true, empty: true });
    expect(await prisma.meeting.findUnique({ where: { id: f.meeting.id } })).toMatchObject({ transcript: null });
    expect(await prisma.meetingRecording.findUnique({ where: { id: f.recording.id } })).toMatchObject({ transcriptProcessedAt: expect.any(Date), failureCode: "RECORDER_TRANSCRIPT_EMPTY" });
    expect(await prisma.meetingRecorderSmokeRun.findUnique({ where: { id: smoke.id } })).toMatchObject({ status: "FAILED" });
    expect(await prisma.nativeTranscriptInput.count()).toBe(1); expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.event.count({ where: { type: "meeting.transcript-uploaded" } })).toBe(0);
    const native = await prisma.nativeTranscriptInput.findFirstOrThrow();
    await expect(captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "NativeTranscriptInput", id: native.id }])).rejects.toThrow();
  });
  it("a busy signed delivery stays retryable and leaves its event unprocessed", async () => {
    const f = await fixture(); const id = `busy-${randomUUID()}`;
    const rawBody = JSON.stringify({ id, event: "transcript.done", data: { bot: { id: f.recording.externalBotId, metadata: { workspaceId: f.workspace.id, recordingId: f.recording.id, meetingId: f.meeting.id } } } });
    const headers = { "svix-id": "busy", "svix-timestamp": "1", "svix-signature": `v1,${createHmac("sha256", "synthetic-signing").update(`busy.1.${rawBody}`).digest("base64")}` };
    const event = await prisma.meetingRecorderProviderEvent.create({ data: { workspaceId: f.workspace.id, recordingId: f.recording.id,
      provider: "RECALL_AI", externalBotId: f.recording.externalBotId, externalEventId: id, eventType: "transcript.done", dedupeKey: `RECALL_AI:${id}`, payload: redactProviderArtifactUrls(JSON.parse(rawBody)) } });
    await withRecorderTranscriptAttempt(f.recording, null, async () => {
      const fetch = vi.fn();
      await expect(withRecorderTranscriptAttempt(f.recording, { rawBody, headers, providerEventId: event.id }, fetch)).rejects.toMatchObject({ code: "RECORDER_TRANSCRIPT_BUSY", status: 503 });
      expect(fetch).not.toHaveBeenCalled();
    });
    expect(await prisma.meetingRecorderProviderEvent.findUnique({ where: { id: event.id } })).toMatchObject({ processedAt: null });
  });
  it.each(["manifest", "dispatch"])("rejects substituted %s state with complete rollback", async field => {
    const f = await fixture(); if (field === "manifest") probe.tamperManifest = true; else probe.dispatchEvent = true;
    await expect(ingest(f)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.event.count({ where: { type: "meeting.transcript-uploaded" } })).toBe(0);
    expect(await prisma.meeting.findUnique({ where: { id: f.meeting.id } })).toMatchObject({ transcript: null });
  });
  it("a later privately authenticated recording retains exact prior recorder ancestry", async () => {
    const f = await fixture(); await ingest(f);
    const priorNative = await prisma.nativeTranscriptInput.findFirstOrThrow();
    const secondRecording = await prisma.meetingRecording.create({ data: { workspaceId: f.workspace.id, meetingId: f.meeting.id, provider: "RECALL_AI",
      externalBotId: `later-bot-${randomUUID()}`, meetingUrl: f.recording.meetingUrl, status: "COMPLETED", joinAt: new Date("2026-10-14T08:00:00Z") } });
    const extra = { transcriptPayload: [{ speaker: "Second", start: 10, text: "Later authenticated native original." }], metadata: {} };
    await withRecorderTranscriptAttempt(secondRecording, null, async receipt => {
      captureRecorderProviderWire(`https://us-west-2.recall.ai/api/v1/bot/${secondRecording.externalBotId}/transcript/`, { headers: { Authorization: "Token synthetic-recall-key" } }, 200, JSON.stringify(extra.transcriptPayload));
      return publishRecorderTranscript(await prepareRecorderTranscript(receipt, extra, {}));
    });
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "MeetingTranscript", id: f.meeting.id }]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: f.meeting.id } })).transcript).toContain("Later authenticated native original.");
    expect((await prisma.nativeTranscriptInput.findUniqueOrThrow({ where: { id: priorNative.id } })).encryptedPayloadJson).toBe(priorNative.encryptedPayloadJson);
    const originalBinding = await prisma.recorderTranscriptBinding.findUniqueOrThrow({ where: { id: priorNative.recorderBindingId! } });
    await prisma.recorderTranscriptBinding.update({ where: { id: originalBinding.id }, data: { active: false, revokedAt: new Date() } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(false);
  });

  it("refuses a new proof for an old native receipt after disable and restore", async () => {
    const f = await fixture(); await ingest(f); const input = await prisma.nativeTranscriptInput.findFirstOrThrow();
    await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: false } });
    await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: true } });
    await expect(captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "NativeTranscriptInput", id: input.id }])).rejects.toThrow();
  });
  it("original claim epochs reject database disable and restore during provider preparation", async () => {
    const f = await fixture();
    await expect(withRecorderTranscriptAttempt(f.recording, null, async receipt => {
      const bytes = provider(f.recording);
      await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: false } });
      await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: true } });
      return prepareRecorderTranscript(receipt, bytes, {});
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.nativeTranscriptInput.count()).toBe(1); expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
  });
  it("the actual signed webhook driver performs native HTTP outside SQL and publishes its event atomically", async () => {
    const f = await fixture(); const download = "https://synthetic.example.test/driver.json";
    const rawBody = JSON.stringify({ id: `driver-${randomUUID()}`, event: "transcript.done", data: { bot: { id: f.recording.externalBotId,
      metadata: { workspaceId: f.workspace.id, meetingId: f.meeting.id, recordingId: f.recording.id } }, transcript: { id: "driver-transcript", data: { download_url: download } } } });
    const headers = { "svix-id": "driver", "svix-timestamp": "1", "svix-signature": `v1,${createHmac("sha256", "synthetic-signing").update(`driver.1.${rawBody}`).digest("base64")}` };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(probe.depth).toBe(0); expect(String(url)).toBe(download);
      return new Response(JSON.stringify(artifact.transcriptPayload), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const { processMeetingRecorderWebhook } = await import("./meeting-recorders");
      expect(await processMeetingRecorderWebhook("RECALL_AI", { rawBody, headers })).toMatchObject({ processed: true, duplicate: false });
      expect(fetch).toHaveBeenCalledOnce();
      const publication = await prisma.recorderTranscriptPublication.findFirstOrThrow();
      expect(await prisma.meetingRecorderProviderEvent.findUnique({ where: { id: publication.providerEventId! } })).toMatchObject({ processedAt: expect.any(Date) });
      expect(await prisma.event.findUnique({ where: { id: publication.eventId } })).toMatchObject({ status: "PENDING" });
    } finally { vi.unstubAllGlobals(); }
  });
  it("the actual recovery driver captures canonical authenticated bot responses and preserves source ancestry", async () => {
    const f = await fixture();
    await prisma.meetingRecording.update({ where: { id: f.recording.id }, data: { transcriptProcessedAt: new Date() } });
    await prisma.workspaceFeatureFlag.create({ data: { workspaceId: f.workspace.id, flag: "MEETING_RECORDERS", enabled: true } });
    const bot = `https://us-west-2.recall.ai/api/v1/bot/${f.recording.externalBotId}/`;
    const download = "https://synthetic.example.test/recovery.json";
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(probe.depth).toBe(0);
      if (String(url) === bot) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Token synthetic-recall-key");
        return new Response(JSON.stringify({ id: f.recording.externalBotId, status: "done", recordings: [{ media_shortcuts: { transcript: { data: { download_url: download } } } }] }), { status: 200 });
      }
      expect(String(url)).toBe(download);
      return new Response(JSON.stringify(artifact.transcriptPayload), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      expect(await reconcileMeetingRecorders(f.workspace.id)).toMatchObject({ recoveredTranscripts: 1 });
      expect(await prisma.recorderTranscriptPublication.count()).toBe(1);
      const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "MeetingTranscript", id: f.meeting.id }]);
      expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it("skips a duplicate recorder occurrence before provider work and without competing publication", async () => {
    const f = await fixture(); await ingest(f);
    const duplicate = await prisma.meetingRecording.create({ data: { workspaceId: f.workspace.id, meetingId: f.meeting.id, provider: "RECALL_AI", externalBotId: `duplicate-${randomUUID()}`, meetingUrl: f.recording.meetingUrl, status: "COMPLETED" } });
    const fetch = vi.fn(); expect(await withRecorderTranscriptAttempt(duplicate, null, fetch)).toBeNull(); expect(fetch).not.toHaveBeenCalled();
    expect(await prisma.meetingRecording.findUnique({ where: { id: duplicate.id } })).toMatchObject({ status: "SKIPPED", failureCode: "DUPLICATE_RECORDER" });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(1);
  });

  it("authenticates recovery despite an own legacy processed marker without a publication receipt", async () => {
    const f = await fixture();
    f.recording = await prisma.meetingRecording.update({ where: { id: f.recording.id }, data: { transcriptProcessedAt: new Date() } });
    expect(await ingest(f)).toMatchObject({ committed: true });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(1);
    const fetch = vi.fn();
    expect(await withRecorderTranscriptAttempt(await prisma.meetingRecording.findUniqueOrThrow({ where: { id: f.recording.id } }), null, fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("an unreceipted canonical marker does not suppress authenticated recovery of another recording", async () => {
    const f = await fixture();
    const legacy = await prisma.meetingRecording.create({ data: { workspaceId: f.workspace.id, meetingId: f.meeting.id,
      provider: "RECALL_AI", externalBotId: `legacy-${randomUUID()}`, meetingUrl: f.recording.meetingUrl,
      status: "COMPLETED", transcriptProcessedAt: new Date() } });
    expect(await ingest(f)).toMatchObject({ committed: true });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(1);
    expect(await prisma.recorderTranscriptAttempt.count({ where: { recordingId: legacy.id } })).toBe(0);
  });
  it("retains discarded partial-download custody while deriving only from the actual fallback response", async () => {
    const f = await fixture();
    await prisma.workspaceFeatureFlag.create({ data: { workspaceId: f.workspace.id, flag: "MEETING_RECORDERS", enabled: true } });
    const bot = `https://us-west-2.recall.ai/api/v1/bot/${f.recording.externalBotId}/`;
    const downloads = ["https://synthetic.example.test/partial.json", "https://synthetic.example.test/missing.json"];
    const discarded = [{ speaker: "Discarded", text: "Partial response is custody only." }];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(probe.depth).toBe(0);
      if (String(url) === bot) return new Response(JSON.stringify({ id: f.recording.externalBotId, status: "done",
        recordings: downloads.map(download_url => ({ media_shortcuts: { transcript: { data: { download_url } } } })) }), { status: 200 });
      if (String(url) === downloads[0]) return new Response(JSON.stringify(discarded), { status: 200 });
      if (String(url) === downloads[1]) return new Response("missing synthetic transcript", { status: 404 });
      expect(String(url)).toBe(`${bot}transcript/`);
      return new Response(JSON.stringify(artifact.transcriptPayload), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      expect(await reconcileMeetingRecorders(f.workspace.id)).toMatchObject({ recoveredTranscripts: 1 });
      const input = await prisma.nativeTranscriptInput.findFirstOrThrow();
      const raw = JSON.parse(decryptSecret(input.encryptedPayloadJson));
      expect(raw.responses).toEqual(expect.arrayContaining([
        expect.objectContaining({ url: downloads[0], text: JSON.stringify(discarded) }),
        expect.objectContaining({ url: downloads[1], status: 404 }),
      ]));
      expect(raw.selectedResponseOrdinals).toHaveLength(1);
      expect(raw.responses.find((wire: { ordinal: number }) => wire.ordinal === raw.selectedResponseOrdinals[0]).url).toBe(`${bot}transcript/`);
      expect((await prisma.meeting.findUniqueOrThrow({ where: { id: f.meeting.id } })).transcript).not.toContain("Partial response");
    } finally { vi.unstubAllGlobals(); }
  });
  it("a direct native consumer holds the publication's original transcript manifest through commit", async () => {
    const f = await fixture(); await ingest(f);
    const input = await prisma.nativeTranscriptInput.findFirstOrThrow();
    const publication = await prisma.recorderTranscriptPublication.findFirstOrThrow();
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "NativeTranscriptInput", id: input.id }]);
    const options = { writeTargets: [], ownerBinding: { kind: "HUMAN_REQUEST" as const, id: randomUUID(), generation: 1 } };
    const prepared = await prepareArtifactSourceCommit(f.actor, f.workspace.id, roots, options);
    await prisma.$transaction(tx => withArtifactSourceCommit(f.actor, f.workspace.id, tx, roots, options, prepared, async bound => {
      expect(await bound.member.findFirst({ where: { workspaceId: f.workspace.id, userId: f.actor.kind === "user" ? f.actor.user.id : "", isActive: true } })).not.toBeNull();
    }, async () => {
      await expect(prisma.$transaction(async competing => {
        await competing.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
        await competing.$queryRaw`SELECT "id" FROM "ArtifactInputLineage" WHERE "id"=${publication.transcriptManifestId} FOR UPDATE`;
      })).rejects.toThrow("lock timeout");
    }), { timeout: 20000 });
  });

  it("the actual signed webhook cancels an oversized response before full-body decoding or publication", async () => {
    const f = await fixture(); const download = "https://synthetic.example.test/oversized.json";
    const rawBody = JSON.stringify({ id: `oversized-${randomUUID()}`, event: "transcript.done", data: { bot: { id: f.recording.externalBotId,
      metadata: { workspaceId: f.workspace.id, meetingId: f.meeting.id, recordingId: f.recording.id } }, transcript: { data: { download_url: download } } } });
    const headers = { "svix-id": "oversized", "svix-timestamp": "1", "svix-signature": `v1,${createHmac("sha256", "synthetic-signing").update(`oversized.1.${rawBody}`).digest("base64")}` };
    let readBytes = 0; const cancelled = vi.fn(); const chunk = new Uint8Array(64 * 1024).fill(120);
    vi.stubGlobal("fetch", vi.fn(async () => {
      expect(probe.depth).toBe(0);
      return new Response(new ReadableStream({ pull(controller) { readBytes += chunk.byteLength; controller.enqueue(chunk); }, cancel: cancelled }), { status: 500 });
    }));
    try {
      const { processMeetingRecorderWebhook } = await import("./meeting-recorders");
      await expect(processMeetingRecorderWebhook("RECALL_AI", { rawBody, headers })).rejects.toMatchObject({ code: "TRANSCRIPT_TOO_LARGE", status: 413 });
      expect(cancelled).toHaveBeenCalledOnce(); expect(readBytes).toBeLessThanOrEqual(20 * 1024 * 1024 + 2 * chunk.byteLength);
      expect(await prisma.recorderTranscriptPublication.count()).toBe(0); expect(await prisma.nativeTranscriptInput.count()).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
  it("parallel response readers share one unchanged native transport budget", async () => {
    const f = await fixture(); let bytes = 0; const cancelled = vi.fn();
    const response = () => {
      let remaining = 12 * 1024 * 1024;
      return new Response(new ReadableStream({ pull(controller) {
        if (!remaining) { controller.close(); return; }
        const size = Math.min(64 * 1024, remaining); remaining -= size; bytes += size; controller.enqueue(new Uint8Array(size).fill(120));
      }, cancel: cancelled }));
    };
    await expect(withRecorderTranscriptAttempt(f.recording, null, async () => {
      const responses = [response(), response()];
      const outcomes = await Promise.allSettled(responses.map(value => readRecorderProviderResponse(value, reserveRecorderProviderWire())));
      const failures = outcomes.filter(value => value.status === "rejected");
      expect(failures.length).toBeGreaterThan(0);
      const failed = failures[0]; if (failed.status === "rejected") throw failed.reason;
    })).rejects.toMatchObject({ code: "TRANSCRIPT_TOO_LARGE" });
    expect(bytes).toBeLessThanOrEqual(20 * 1024 * 1024 + 4 * 64 * 1024);
    expect(cancelled).toHaveBeenCalled(); expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
  });

});

describe("Meeting BaaS authenticated native continuity", () => {
  const downloadUrl = "https://storage.example.test/synthetic-baas.json?signed=synthetic";
  const wireText = '\ufeff{ "result": { "utterances": [{"speaker":"BaaS speaker","start":0.125,"end":2.5,"text":"Exact BaaS original."}] } }\n';
  function signed(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
    const rawBody = JSON.stringify({ id: `baas-event-${randomUUID()}`, event: "bot.completed", data: {
      bot_id: f.recording.externalBotId, status: "completed", transcription: "https://expired.example.test/old.json",
      extra: { workspaceId: f.workspace.id, recordingId: f.recording.id, meetingId: f.meeting.id, ...extra },
    } });
    return { rawBody, headers: { "webhook-id": "synthetic-baas-message", "webhook-timestamp": "1",
      "webhook-signature": `v1,${createHmac("sha256", "synthetic-baas-secret").update(`synthetic-baas-message.1.${rawBody}`).digest("base64")}` } };
  }
  function native(f: Awaited<ReturnType<typeof fixture>>, options: { text?: string; botId?: string; beforeDownload?: () => Promise<void> } = {}) {
    const calls = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(probe.depth).toBe(0);
      expect(init?.redirect).toBe("error");
      const claim = await prisma.recorderTranscriptClaim.findUniqueOrThrow({ where: { recordingId: f.recording.id } });
      expect(claim.leaseUntil.getTime()).toBeGreaterThan(Date.now());
      if (String(url) === `https://api.meetingbaas.com/v2/bots/${f.recording.externalBotId}`) {
        expect(new Headers(init?.headers).get("x-meeting-baas-api-key")).toBe("synthetic-baas-key");
        return new Response(JSON.stringify({ success: true, data: { bot_id: options.botId ?? f.recording.externalBotId,
          status: "completed", transcription: downloadUrl } }), { status: 200 });
      }
      expect(String(url)).toBe(downloadUrl);
      expect(new Headers(init?.headers).get("x-meeting-baas-api-key")).toBeNull();
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      await options.beforeDownload?.();
      return new Response(options.text ?? wireText, { status: 200 });
    });
    vi.stubGlobal("fetch", calls);
    return calls;
  }
  it("publishes a signed BaaS webhook with exact encrypted wire bytes and ordinary authorized read, then deduplicates", async () => {
    const f = await fixture(true, "MEETING_BAAS"), request = signed(f), calls = native(f);
    await expect(processMeetingRecorderWebhook("MEETING_BAAS", request)).resolves.toMatchObject({ processed: true });
    const input = await prisma.nativeTranscriptInput.findFirstOrThrow({ where: { recordingId: f.recording.id } });
    expect(input).toMatchObject({ recorderProvider: "MEETING_BAAS", ownerMemberId: null, submittedByUserId: null });
    const payload = JSON.parse(decryptSecret(input.encryptedPayloadJson));
    expect(payload.responses.map((wire: { authenticated: boolean }) => wire.authenticated)).toEqual([true, false]);
    expect(payload.responses[1].text).toBe(wireText);
    expect(payload.origin.rawBody).toBe(request.rawBody);
    expect(await isRecorderTranscriptInputCurrent(f.actor, f.workspace.id, { ...input, recorderProvider: "RECALL_AI" }, payload, prisma)).toBe(false);
    expect(await isRecorderTranscriptInputCurrent(f.actor, randomUUID(), input, payload, prisma)).toBe(false);
    expect(await isRecorderTranscriptInputCurrent(f.actor, f.workspace.id, input, { ...payload, provider: "RECALL_AI" }, prisma)).toBe(false);
    expect(payload.selectedResponseOrdinals).toEqual([1]);
    const publication = await prisma.recorderTranscriptPublication.findFirstOrThrow({ where: { nativeInputId: input.id } });
    expect(await prisma.meetingRecorderProviderEvent.findUnique({ where: { id: publication.providerEventId! } })).toMatchObject({ processedAt: expect.any(Date) });
    const { getMeeting } = await import("./meetings");
    expect(await getMeeting(f.actor, f.workspace.id, f.meeting.id)).toMatchObject({ transcript: "BaaS speaker [00:00:00]: Exact BaaS original.", source: "recorder:meeting_baas" });
    expect(await prisma.event.findFirstOrThrow({ where: { workspaceId: f.workspace.id, type: "meeting.transcript-uploaded" } }))
      .toMatchObject({ payload: expect.objectContaining({ source: "recorder:meeting_baas" }) });
    await expect(processMeetingRecorderWebhook("MEETING_BAAS", request)).resolves.toMatchObject({ duplicate: true });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(await prisma.recorderTranscriptPublication.count()).toBe(1);
  });
  it.each(["COMPLETED", "RECORDING", "FAILED"] as const)("recovers a %s BaaS recording through authenticated canonical bot HTTP with no webhook or human principal", async status => {
    const f = await fixture(true, "MEETING_BAAS"), calls = native(f);
    await prisma.meetingRecording.update({ where: { id: f.recording.id }, data: { status, failureCode: status === "FAILED" ? "STALE_RECORDER" : null } });
    await reconcileMeetingRecorders(f.workspace.id);
    const input = await prisma.nativeTranscriptInput.findFirstOrThrow({ where: { recordingId: f.recording.id } });
    expect(JSON.parse(decryptSecret(input.encryptedPayloadJson)).origin.kind).toBe("AUTHENTICATED_RECOVERY");
    expect(await prisma.recorderTranscriptPublication.count()).toBe(1);
    expect(calls).toHaveBeenCalledTimes(2);
  });
  it("retains authenticated empty custody and a terminal event without publishing transcript knowledge", async () => {
    const f = await fixture(true, "MEETING_BAAS"); native(f, { text: '{"result":{"utterances":[]}}' });
    await processMeetingRecorderWebhook("MEETING_BAAS", { ...signed(f), headers: { "x-mb-secret": "synthetic-baas-secret" } });
    expect(await prisma.nativeTranscriptInput.count()).toBe(1);
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.meetingRecording.findUnique({ where: { id: f.recording.id } })).toMatchObject({ transcriptProcessedAt: expect.any(Date), failureCode: "RECORDER_TRANSCRIPT_EMPTY" });
    expect(await prisma.event.count({ where: { type: "meeting.transcript-uploaded" } })).toBe(0);
  });
  it("rejects an unrelated canonical bot despite a valid signed target and leaves its event retryable", async () => {
    const f = await fixture(true, "MEETING_BAAS"); const calls = native(f, { botId: "foreign-bot" });
    await expect(processMeetingRecorderWebhook("MEETING_BAAS", signed(f))).rejects.toMatchObject({ code: "RECORDER_WEBHOOK_RECORDING_MISMATCH" });
    expect(calls).toHaveBeenCalledTimes(1); expect(await prisma.nativeTranscriptInput.count()).toBe(0);
    expect(await prisma.meetingRecorderProviderEvent.findFirst()).toMatchObject({ processedAt: null });
  });
  it.each(["workspace", "provider", "signature"])("rejects a forged %s before provider traffic or custody", async kind => {
    const f = await fixture(true, "MEETING_BAAS"), calls = native(f);
    const request = signed(f, kind === "workspace" ? { workspaceId: randomUUID() } : {});
    if (kind === "provider") await prisma.meetingRecording.update({ where: { id: f.recording.id }, data: { provider: "RECALL_AI" } });
    if (kind === "signature") request.headers["webhook-signature"] = "v1,forged";
    await expect(processMeetingRecorderWebhook("MEETING_BAAS", request)).rejects.toMatchObject({ code: kind === "signature" ? "INVALID_SIGNATURE" : "RECORDER_WEBHOOK_RECORDING_MISMATCH" });
    expect(calls).not.toHaveBeenCalled(); expect(await prisma.nativeTranscriptInput.count()).toBe(0);
  });
  it("rejects Recall credentials as BaaS recovery custody", async () => {
    const f = await fixture(true, "MEETING_BAAS");
    await expect(withRecorderTranscriptAttempt(f.recording, null, async receipt => {
      provider(f.recording);
      return prepareRecorderTranscript(receipt, artifact, {});
    })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(await prisma.nativeTranscriptInput.count()).toBe(0);
  });
  it("preserves immutable custody and rolls back every publication marker after a late transaction failure", async () => {
    const f = await fixture(true, "MEETING_BAAS"); native(f); probe.failPublication = true;
    await expect(processMeetingRecorderWebhook("MEETING_BAAS", signed(f))).rejects.toThrow("synthetic publication rollback");
    expect(await prisma.nativeTranscriptInput.count()).toBe(1); expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    expect(await prisma.meeting.findUnique({ where: { id: f.meeting.id } })).toMatchObject({ transcript: null });
    expect(await prisma.meetingRecording.findUnique({ where: { id: f.recording.id } })).toMatchObject({ transcriptProcessedAt: null });
    expect(await prisma.meetingRecorderProviderEvent.findFirst()).toMatchObject({ processedAt: null });
    expect(await prisma.event.count({ where: { type: "meeting.transcript-uploaded" } })).toBe(0);
  });
  it("rejects configuration disable and restore during provider work and never publishes its stale attempt", async () => {
    const f = await fixture(true, "MEETING_BAAS"); native(f, { beforeDownload: async () => {
      await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: false } });
      await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: true } });
    } });
    await expect(processMeetingRecorderWebhook("MEETING_BAAS", signed(f))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
  });
  it("fences a reclaimed BaaS attempt after HTTP and permits its fresh recovery generation", async () => {
    const f = await fixture(true, "MEETING_BAAS"); native(f, { beforeDownload: async () => {
      await prisma.recorderTranscriptClaim.update({ where: { recordingId: f.recording.id }, data: { leaseUntil: new Date(0) } });
      await withRecorderTranscriptAttempt(f.recording, null, async () => undefined);
    } });
    await expect(processMeetingRecorderWebhook("MEETING_BAAS", signed(f))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.recorderTranscriptPublication.count()).toBe(0);
    native(f); await reconcileMeetingRecorders(f.workspace.id);
    expect(await prisma.recorderTranscriptPublication.count()).toBe(1);
    expect(await prisma.recorderTranscriptClaim.findUnique({ where: { recordingId: f.recording.id } })).toMatchObject({ generation: 3 });
  });
  it("keeps BaaS global credentials separate from workspace authority and permanently withholds proof after policy revoke/restore", async () => {
    const f = await fixture(true, "MEETING_BAAS"); native(f); await processMeetingRecorderWebhook("MEETING_BAAS", signed(f));
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "MeetingTranscript", id: f.meeting.id }]);
    vi.stubEnv("MEETING_BAAS_API_KEY", "rotated-synthetic-key");
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(false);
    vi.stubEnv("MEETING_BAAS_API_KEY", "synthetic-baas-key");
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: false } });
    await prisma.workspaceMeetingRecorderConfig.update({ where: { workspaceId: f.workspace.id }, data: { enabled: true } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(false);
  });
  it("captures only its restricted meeting and leaves ordinary readers and unregistered agents denied", async () => {
    const f = await fixture(true, "MEETING_BAAS");
    const { classifyInformationSource, configureInformationCategory } = await import("./information-category-policy");
    const circle = await prisma.circle.create({ data: { workspaceId: f.workspace.id, name: "BaaS permitted readers" } });
    const role = await prisma.role.create({ data: { circleId: circle.id, name: "Reader", accountabilities: [], artifacts: [] } });
    const member = await prisma.member.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    await prisma.roleAssignment.create({ data: { memberId: member.id, roleId: role.id } });
    await configureInformationCategory(f.actor, { workspaceId: f.workspace.id, category: "SALARY", isRestricted: true,
      allowedRoleIds: [role.id], allowedCircleIds: [] });
    await classifyInformationSource(f.actor, { workspaceId: f.workspace.id, kind: "Meeting", id: f.meeting.id, category: "SALARY" });
    native(f); await processMeetingRecorderWebhook("MEETING_BAAS", signed(f));
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "MeetingTranscript", id: f.meeting.id }]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    const ordinary = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    await prisma.member.create({ data: { workspaceId: f.workspace.id, userId: ordinary.id } });
    expect(await isArtifactInputProofReadable({ kind: "user", user: ordinary }, f.workspace.id, roots)).toBe(false);
    const copied: AppActor = { kind: "agent", authProvider: "bootstrap", label: "native-recorder-transcript-worker",
      workspaceIds: [f.workspace.id], scopes: ["meetings:write", "support:write"] };
    expect(await isArtifactInputProofReadable(copied, f.workspace.id, roots)).toBe(false);
  });
  it.each(['{"error":"synthetic unavailable"}', '{"result":{"utterances":[{"error":"unavailable"}]}}'])("does not turn malformed BaaS provider JSON %s into an empty success receipt", async text => {
    const f = await fixture(true, "MEETING_BAAS"); native(f, { text });
    await expect(processMeetingRecorderWebhook("MEETING_BAAS", signed(f))).rejects.toMatchObject({ code: "RECORDER_TRANSCRIPT_INVALID" });
    expect(await prisma.nativeTranscriptInput.count()).toBe(0);
    expect(await prisma.meetingRecording.findUnique({ where: { id: f.recording.id } })).toMatchObject({ transcriptProcessedAt: null });
  });

});
