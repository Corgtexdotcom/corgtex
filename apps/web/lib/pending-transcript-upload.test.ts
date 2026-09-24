import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deletePendingTranscriptPayload, readPendingTranscriptPayload, storePendingTranscriptPayload, type PendingTranscriptPayload } from "./pending-transcript-upload";

const mocks = vi.hoisted(() => ({
  backend: "postgres",
  encrypt: vi.fn(), decrypt: vi.fn(), redis: vi.fn(),
  create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn(), cleanup: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({
  getSharedStateBackend: () => mocks.backend,
  encryptSecret: mocks.encrypt, decryptSecret: mocks.decrypt, getRedisClient: mocks.redis,
  redisKey: (key: string) => `test:${key}`,
  prisma: { pendingTranscriptUpload: { create: mocks.create, findFirst: mocks.findFirst, deleteMany: mocks.deleteMany }, $executeRaw: mocks.cleanup },
}));
const payload: PendingTranscriptPayload = {
  workspaceId: "workspace-a", transcript: "Synthetic transcript", fileName: null,
  title: null, source: null, recordedAt: null, timeZone: null, summaryMd: null,
  ingestionGuidanceMd: null, participantIds: [], participantEmails: [], meetingId: null, createNewMeeting: false,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.backend = "postgres";
  mocks.encrypt.mockReturnValue("encrypted-fixture");
  mocks.decrypt.mockReturnValue(JSON.stringify(payload));
  mocks.findFirst.mockResolvedValue({ encryptedPayload: "encrypted-fixture" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("pending transcript storage", () => {
  it("stores only ciphertext under a hashed namespace and a 20 minute expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T00:00:00Z"));
    try {
      const token = await storePendingTranscriptPayload(payload);
      expect(token).toEqual(expect.any(String));
      expect(mocks.create).toHaveBeenCalledWith({ data: {
        id: expect.stringMatching(/^[a-f0-9]{64}$/), workspaceId: "workspace-a", encryptedPayload: "encrypted-fixture",
        expiresAt: new Date("2026-09-24T00:20:00Z"),
      } });
      expect(mocks.create.mock.calls[0][0].data.id).not.toBe(token);
      expect(mocks.encrypt).toHaveBeenCalledWith(JSON.stringify(payload));
      expect(mocks.redis).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("rejects missing encryption configuration before any database write", async () => {
    mocks.encrypt.mockImplementation(() => { throw new Error("Missing key"); });
    expect(await storePendingTranscriptPayload(payload)).toBeNull();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.redis).not.toHaveBeenCalled();
  });

  it("permits repeated clarification reads and predicates reads/deletes on workspace and expiry", async () => {
    expect(await readPendingTranscriptPayload("workspace-a", "opaque-token")).toEqual(payload);
    expect(await readPendingTranscriptPayload("workspace-a", "opaque-token")).toEqual(payload);
    const where = mocks.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: "workspace-a", expiresAt: { gt: expect.any(Date) } });
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    await deletePendingTranscriptPayload("workspace-a", "opaque-token");
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: where.id, workspaceId: "workspace-a" } });
    await deletePendingTranscriptPayload("workspace-b", "opaque-token");
    expect(mocks.deleteMany.mock.calls[1][0].where.id).not.toBe(where.id);
  });

  it("rejects expired, corrupt, invalid, and cross-workspace payloads without Redis fallback", async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    expect(await readPendingTranscriptPayload("workspace-a", "opaque-token")).toBeNull();
    mocks.decrypt.mockImplementationOnce(() => { throw new Error("Bad authentication tag"); });
    expect(await readPendingTranscriptPayload("workspace-a", "opaque-token")).toBeNull();
    mocks.decrypt.mockReturnValueOnce(JSON.stringify({ ...payload, participantIds: [42] }));
    expect(await readPendingTranscriptPayload("workspace-a", "opaque-token")).toBeNull();
    mocks.decrypt.mockReturnValueOnce(JSON.stringify({ ...payload, workspaceId: "workspace-b" }));
    expect(await readPendingTranscriptPayload("workspace-a", "opaque-token")).toBeNull();
    mocks.findFirst.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await readPendingTranscriptPayload("workspace-a", "opaque-token")).toBeNull();
    expect(mocks.redis).not.toHaveBeenCalled();
  });

  it("preserves Redis keys and expiry when Redis is selected", async () => {
    mocks.backend = "redis";
    const redis = { setEx: vi.fn(), get: vi.fn().mockResolvedValue(JSON.stringify(payload)), del: vi.fn() };
    mocks.redis.mockResolvedValue(redis);
    const token = await storePendingTranscriptPayload(payload);
    expect(redis.setEx).toHaveBeenCalledWith(`test:meeting-transcript-upload:workspace-a:${token}`, 1200, JSON.stringify(payload));
    expect(await readPendingTranscriptPayload("workspace-a", token!)).toEqual(payload);
    await deletePendingTranscriptPayload("workspace-a", token);
    expect(redis.del).toHaveBeenCalledWith(`test:meeting-transcript-upload:workspace-a:${token}`);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
