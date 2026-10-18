import type { AppActor } from "@corgtex/shared";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, requireWorkspaceMembership, captureArtifactInputProof, isArtifactInputProofReadable, extractTextFromFileBuffer } = vi.hoisted(() => {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "ws-1" }]),
    nativeTranscriptInput: { create: vi.fn(), findFirst: vi.fn() },
    meetingAudioAsset: { findFirst: vi.fn() },
    workflowJob: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
  return { db, requireWorkspaceMembership: vi.fn(), captureArtifactInputProof: vi.fn(),
    isArtifactInputProofReadable: vi.fn(), extractTextFromFileBuffer: vi.fn() };
});
vi.mock("@corgtex/knowledge", () => ({ extractTextFromFileBuffer }));
vi.mock("@corgtex/shared", () => ({
  prisma: db,
  encryptSecret: (value: string) => `encrypted:${value}`,
  decryptSecret: (value: string) => value.slice("encrypted:".length),
}));
vi.mock("./auth", () => ({ requireWorkspaceMembership }));
vi.mock("./source-lineage", () => ({ captureArtifactInputProof, isArtifactInputProofReadable }));

const actor: AppActor = { kind: "user", user: { id: "user-1", email: "owner@example.test", displayName: "Owner" } };
const submission = { workspaceId: "ws-1", transcript: "Exact synthetic transcript", title: "Meeting",
  recordedAt: "2026-10-13T10:00:00Z", participantEmails: ["a@example.test"] };

describe("native direct transcript capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(callback => callback(db));
    db.nativeTranscriptInput.create.mockImplementation(({ data }) => Promise.resolve({ id: "input-1", ...data,
      meetingAudioAssetId: null, sourceRecordId: null, connectionId: null, recordingId: null,
      fileHash: null, storageKey: null, fileSizeBytes: null, grantHash: null }));
    db.member.findFirst.mockResolvedValue({ id: "member-1" });
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1", workspaceId: "ws-1", userId: "user-1", isActive: true });
    captureArtifactInputProof.mockResolvedValue([{ kind: "NativeTranscriptInput", id: "input-1", fingerprint: "a".repeat(64) }]);
    isArtifactInputProofReadable.mockResolvedValue(true);
    extractTextFromFileBuffer.mockResolvedValue({ textContent: "Exact synthetic transcript", truncated: false });
  });

  it("stores the exact encrypted submission and rejects a changed or forged receipt", async () => {
    const { captureDirectMemberTranscriptInput, directMemberTranscriptRoots,
      isNativeTranscriptInputCurrent } = await import("./native-transcript-input");
    const receipt = await captureDirectMemberTranscriptInput(actor, { workspaceId: "ws-1", submission });
    const row = db.nativeTranscriptInput.create.mock.calls[0]![0].data;
    expect(row).toMatchObject({ mode: "DIRECT_MEMBER_UPLOAD", workspaceId: "ws-1",
      ownerMemberId: "member-1", submittedByUserId: "user-1", payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(row.encryptedPayloadJson).toContain("Exact synthetic transcript");
    await expect(directMemberTranscriptRoots(actor, "ws-1", submission, receipt))
      .resolves.toEqual([{ kind: "NativeTranscriptInput", id: "input-1", fingerprint: "a".repeat(64) }]);
    await expect(directMemberTranscriptRoots(actor, "ws-1", { ...submission, transcript: "changed" }, receipt))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(directMemberTranscriptRoots(actor, "ws-1", submission, { inputId: receipt.inputId }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(isNativeTranscriptInputCurrent(actor, "ws-1", { ...row, id: "input-1" }))
      .resolves.toBe(true);
    await expect(isNativeTranscriptInputCurrent(actor, "ws-1", { ...row, payloadHash: "0".repeat(64) }))
      .resolves.toBe(false);
  });

  it("does not mint direct-human authority for an agent", async () => {
    const { captureDirectMemberTranscriptInput } = await import("./native-transcript-input");
    await expect(captureDirectMemberTranscriptInput({ kind: "agent", authProvider: "credential",
      label: "tool", workspaceIds: ["ws-1"] }, { workspaceId: "ws-1", submission }))
      .rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(db.nativeTranscriptInput.create).not.toHaveBeenCalled();
  });

  it("requires uploaded file bytes to reproduce the exact extracted transcript", async () => {
    const { captureDirectMemberTranscriptInput } = await import("./native-transcript-input");
    await expect(captureDirectMemberTranscriptInput(actor, { workspaceId: "ws-1", submission: {
      ...submission, fileName: "meeting.txt", rawFileMimeType: "text/plain",
    } })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(captureDirectMemberTranscriptInput(actor, { workspaceId: "ws-1", submission: {
      ...submission, fileName: "meeting.txt", rawFileMimeType: "text/plain",
      rawFileBase64: Buffer.from("Exact synthetic transcript").toString("base64"),
    } })).resolves.toMatchObject({ inputId: "input-1" });
    expect(extractTextFromFileBuffer).toHaveBeenCalledWith(expect.objectContaining({
      fileBuffer: Buffer.from("Exact synthetic transcript"), fileName: "meeting.txt", mimeType: "text/plain",
    }));
  });

  it("freezes the workspace, fields and exact file bytes before extraction awaits", async () => {
    let release!: (value: { textContent: string; truncated: boolean }) => void;
    extractTextFromFileBuffer.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { captureDirectMemberTranscriptInput } = await import("./native-transcript-input");
    const mutable = { ...submission, fileName: "meeting.txt", rawFileMimeType: "text/plain",
      rawFileBase64: Buffer.from("Exact synthetic transcript").toString("base64") };
    const args = { workspaceId: "ws-1", submission: mutable };
    const pending = captureDirectMemberTranscriptInput(actor, args);
    await vi.waitFor(() => expect(extractTextFromFileBuffer).toHaveBeenCalled());
    mutable.transcript = "changed after extraction began";
    args.workspaceId = "ws-2";
    mutable.rawFileBase64 = Buffer.from("different bytes").toString("base64");
    release({ textContent: "Exact synthetic transcript", truncated: false });
    await expect(pending).resolves.toMatchObject({ inputId: "input-1" });
    const saved = db.nativeTranscriptInput.create.mock.calls[0]![0].data;
    expect(saved.workspaceId).toBe("ws-1");
    expect(saved.encryptedPayloadJson).toContain("Exact synthetic transcript");
    expect(saved.encryptedPayloadJson).not.toContain("different bytes");
  });

  it("freezes audio metadata and bytes before membership awaits", async () => {
    let release!: (value: { id: string; workspaceId: string; userId: string; isActive: boolean }) => void;
    requireWorkspaceMembership.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { captureAudioUploadInput } = await import("./native-transcript-input");
    const asset = { id: "audio-1", workspaceId: "ws-1", uploadedByUserId: "user-1",
      meetingId: null, fileName: "meeting.m4a", mimeType: "audio/mp4", storageKey: "stored/audio-1",
      sizeBytes: 5, durationSeconds: null, title: "Original title", recordedAt: null,
      participantEmails: [] } as never;
    const bytes = Buffer.from("audio");
    const args = { workspaceId: "ws-1", asset, fileBuffer: bytes, tx: db as never };
    const copy = vi.spyOn(Buffer, "from");
    const pending = captureAudioUploadInput(actor, args);
    expect(copy.mock.calls.some(call => call[0] === bytes)).toBe(false);
    copy.mockRestore();
    await vi.waitFor(() => expect(requireWorkspaceMembership).toHaveBeenCalled());
    (asset as { title: string }).title = "Changed title";
    bytes.write("other");
    args.workspaceId = "ws-2";
    release({ id: "member-1", workspaceId: "ws-1", userId: "user-1", isActive: true });
    await expect(pending).resolves.toMatchObject({ input: { id: "input-1" } });
    const saved = db.nativeTranscriptInput.create.mock.calls[0]![0].data;
    expect(saved.workspaceId).toBe("ws-1");
    expect(saved.fileHash).toBe(createHash("sha256").update("audio").digest("hex"));
    expect(saved.encryptedPayloadJson).toContain("Original title");
    expect(saved.encryptedPayloadJson).not.toContain("Changed title");
  });

  it("rejects oversized audio before hashing, copying or awaiting membership", async () => {
    const { captureAudioUploadInput } = await import("./native-transcript-input");
    const oversized = Buffer.from("small allocation");
    Object.defineProperty(oversized, "byteLength", { value: 500 * 1024 * 1024 + 1 });
    await expect(captureAudioUploadInput(actor, { workspaceId: "ws-1", fileBuffer: oversized,
      asset: {} as never, tx: db as never })).rejects.toMatchObject({ code: "AUDIO_TOO_LARGE" });
    expect(requireWorkspaceMembership).not.toHaveBeenCalled();
    expect(db.nativeTranscriptInput.create).not.toHaveBeenCalled();
  });

  it("does not let an older worker adopt a newly claimed audio job", async () => {
    db.meetingAudioAsset.findFirst.mockResolvedValue({ id: "audio-1", workspaceId: "ws-1" });
    db.nativeTranscriptInput.findFirst.mockResolvedValue({ id: "native-1", ownerMemberId: "member-1",
      submittedByUserId: "user-1", grantHash: "a".repeat(64) });
    db.workflowJob.findFirst.mockResolvedValue({ id: "job-1", workspaceId: "ws-1", type: "meeting-audio.transcribe",
      status: "RUNNING", lockedBy: "worker-new", lockedAt: new Date("2026-10-13T11:00:00.000Z"),
      attempts: 2, payload: { audioAssetId: "audio-1" } });
    const { createAudioTranscriptWorkerActor } = await import("./native-transcript-input");
    await expect(createAudioTranscriptWorkerActor({ workspaceId: "ws-1", audioAssetId: "audio-1",
      workflowJobId: "job-1", expectedLease: { attempts: 1, lockedBy: "worker-old",
        lockedAt: new Date("2026-10-13T10:00:00.000Z") } }))
      .rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(captureArtifactInputProof).not.toHaveBeenCalled();
  });
  it("mints a renewable same-attempt lease that retains the original proof", async () => {
    const now = new Date();
    db.meetingAudioAsset.findFirst.mockResolvedValue({ id: "audio-1", workspaceId: "ws-1" });
    db.nativeTranscriptInput.findFirst.mockResolvedValue({ id: "native-1", ownerMemberId: "member-1",
      submittedByUserId: "user-1", grantHash: "a".repeat(64) });
    db.workflowJob.findFirst.mockResolvedValue({ id: "job-1", workspaceId: "ws-1", type: "meeting-audio.transcribe",
      status: "RUNNING", lockedBy: "worker-1", lockedAt: now, startedAt: now,
      attempts: 1, payload: { audioAssetId: "audio-1" } });
    const { createAudioTranscriptWorkerActor } = await import("./native-transcript-input");
    const worker = await createAudioTranscriptWorkerActor({ workspaceId: "ws-1", audioAssetId: "audio-1",
      workflowJobId: "job-1", expectedLease: { attempts: 1, lockedBy: "worker-1", lockedAt: now } });
    expect(worker).toHaveProperty("renewLease", expect.any(Function));
  });

});
