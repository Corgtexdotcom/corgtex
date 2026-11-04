import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ redis: vi.fn(), database: vi.fn(), sentry: vi.fn(), values: new Map<string, { value: string; expiresAt: number }>() }));
vi.mock("@sentry/nextjs", () => ({ init: mocks.sentry, captureRequestError: vi.fn() }));
vi.mock("@corgtex/shared/telemetry", () => ({ captureErrorTelemetry: vi.fn() }));
vi.mock("@corgtex/shared", async () => ({
  ...await import("../../../packages/shared/src/crypto"),
  getSharedStateBackend: () => process.env.SHARED_STATE_BACKEND || "redis",
  isRedisConfigured: () => Boolean(process.env.REDIS_URL?.trim()),
  getRedisClient: mocks.redis,
  redisKey: (key: string) => `synthetic:${key}`,
  prisma: { pendingTranscriptUpload: { create: mocks.database }, $executeRaw: mocks.database },
}));
import { register } from "../instrumentation";
import { deletePendingTranscriptPayload, readPendingTranscriptPayload, storePendingTranscriptPayload, type PendingTranscriptPayload } from "./pending-transcript-upload";

const payload: PendingTranscriptPayload = {
  workspaceId: "workspace-a", uploadedByUserId: "uploader-a", transcript: "Synthetic private transcript",
  rawFileBase64: Buffer.from("Synthetic original bytes").toString("base64"), rawFileMimeType: "text/plain",
  fileName: "synthetic.txt", title: null, source: null, recordedAt: null, timeZone: null, summaryMd: null,
  ingestionGuidanceMd: null, participantIds: [], participantEmails: [], meetingId: null, createNewMeeting: false,
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.values.clear();
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("SHARED_STATE_BACKEND", "redis"); vi.stubEnv("REDIS_URL", "redis://synthetic.invalid:6379");
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  mocks.redis.mockResolvedValue({
    setEx: vi.fn(async (key: string, ttl: number, value: string) => { mocks.values.set(key, { value, expiresAt: Date.now() + ttl * 1000 }); }),
    get: vi.fn(async (key: string) => { const row = mocks.values.get(key); return row && row.expiresAt > Date.now() ? row.value : null; }),
    del: vi.fn(async (key: string) => { mocks.values.delete(key); }),
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("pending transcript Redis encryption readiness", () => {
  it.each(["", "not-hex", "a".repeat(62), "a".repeat(65), "z".repeat(64)])("rejects invalid configured Redis key before startup or token workflow (%#)", async key => {
    vi.stubEnv("ENCRYPTION_KEY", key);
    await expect(register()).rejects.toThrow("Pending transcript Redis storage requires ENCRYPTION_KEY to be a 32-byte hex string.");
    expect(mocks.sentry).not.toHaveBeenCalled();
    await expect(storePendingTranscriptPayload(payload)).rejects.toThrow(/ENCRYPTION_KEY/);
    await expect(readPendingTranscriptPayload(payload.workspaceId, "token")).rejects.toThrow(/ENCRYPTION_KEY/);
    expect(mocks.redis).not.toHaveBeenCalled(); expect(mocks.database).not.toHaveBeenCalled();
  });

  it("allows no-Redis development startup without an encryption key", async () => {
    vi.stubEnv("REDIS_URL", ""); vi.stubEnv("ENCRYPTION_KEY", "");
    await expect(register()).resolves.toBeUndefined();
    expect(mocks.redis).not.toHaveBeenCalled(); expect(mocks.database).not.toHaveBeenCalled();
  });

  it.each(["production-build", "edge"])("does not impose Node storage secrets on %s", async mode => {
    vi.stubEnv("ENCRYPTION_KEY", ""); vi.stubEnv("DATABASE_URL", "");
    if (mode === "production-build") vi.stubEnv("NEXT_PHASE", "phase-production-build");
    else vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(register()).resolves.toBeUndefined();
    expect(mocks.redis).not.toHaveBeenCalled(); expect(mocks.database).not.toHaveBeenCalled();
  });

  it("leaves PostgreSQL's existing startup/readiness contract unchanged", async () => {
    vi.stubEnv("SHARED_STATE_BACKEND", "postgres"); vi.stubEnv("ENCRYPTION_KEY", "");
    await expect(register()).resolves.toBeUndefined();
    expect(mocks.redis).not.toHaveBeenCalled(); expect(mocks.database).not.toHaveBeenCalled();
  });

  it("round trips authenticated ciphertext with uploader/workspace identity and the 20 minute Redis TTL", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    await register();
    const token = await storePendingTranscriptPayload(payload);
    expect(token).toEqual(expect.any(String));
    const key = `synthetic:meeting-transcript-upload:${payload.workspaceId}:${token}`;
    const stored = mocks.values.get(key)!;
    expect(stored.value).toMatch(/^aes-256-gcm:/);
    expect(stored.value).not.toContain(payload.transcript); expect(stored.value).not.toContain(payload.rawFileBase64!);
    expect(stored.expiresAt).toBe(Date.now() + 1200_000);
    expect(await readPendingTranscriptPayload(payload.workspaceId, token!)).toEqual(payload);
    expect(await readPendingTranscriptPayload(payload.workspaceId, token!)).toEqual(payload);
    expect(await readPendingTranscriptPayload("workspace-b", token!)).toBeNull();
    // Moving valid ciphertext to another namespace cannot relabel its authenticated workspace/uploader.
    mocks.values.set(`synthetic:meeting-transcript-upload:workspace-b:${token}`, stored);
    expect(await readPendingTranscriptPayload("workspace-b", token!)).toBeNull();
    vi.advanceTimersByTime(1200_000);
    expect(await readPendingTranscriptPayload(payload.workspaceId, token!)).toBeNull();
    await deletePendingTranscriptPayload(payload.workspaceId, token);
    expect(mocks.values.has(key)).toBe(false); expect(mocks.database).not.toHaveBeenCalled();
  });
});
