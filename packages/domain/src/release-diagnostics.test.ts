import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActor } from "@corgtex/shared";
const mocks = vi.hoisted(() => ({ read: vi.fn(), membership: vi.fn(), upsert: vi.fn(), find: vi.fn(), updateMany: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: mocks.read }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: mocks.membership }));
vi.mock("@corgtex/shared", () => ({ prisma: { workflowJob: { upsert: mocks.upsert, findUnique: mocks.find, updateMany: mocks.updateMany } } }));
import { dispatchReleaseDiagnostic, getReleaseDiagnostic, readReleaseBuildSha, RELEASE_DIAGNOSTIC_JOB_TYPE } from "./release-diagnostics";

const workspaceId = randomUUID(), expectedGitSha = "a".repeat(40);
const actor: AgentActor = { kind: "agent", authProvider: "credential", label: "Synthetic", workspaceIds: [workspaceId], scopes: ["runtime:read", "runtime:write"] };
const request = () => ({ operationId: randomUUID(), expectedGitSha });
function stored(input = request(), overrides = {}) {
  const id = randomUUID();
  return { id, workspaceId, type: RELEASE_DIAGNOSTIC_JOB_TYPE, status: "PENDING", attempts: 0, lockedAt: null, lockedBy: null,
    startedAt: null, completedAt: null, error: null, payload: { ...input, schemaVersion: 1,
      jobId: id, workspaceId, nonce: randomUUID(), webGitSha: expectedGitSha }, ...overrides };
}

describe("release diagnostics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.read.mockReturnValue(JSON.stringify({ schemaVersion: 1, role: "web", gitSha: expectedGitSha }));
    mocks.upsert.mockImplementation(({ create }) => ({ ...create, status: "PENDING", attempts: 0,
      lockedAt: null, lockedBy: null, startedAt: null, completedAt: null, error: null }));
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });
  it("creates only a bounded diagnostic with server-owned identity", async () => {
    const result = await dispatchReleaseDiagnostic(actor, workspaceId, request());
    expect(result).toMatchObject({ accepted: false, webGitSha: expectedGitSha, workspaceId, status: "PENDING" });
    expect(mocks.upsert.mock.calls[0][0]).toMatchObject({ update: {}, create: { type: RELEASE_DIAGNOSTIC_JOB_TYPE } });
    expect(mocks.read).toHaveBeenCalledWith("/app/release-build.json", "utf8");
  });
  it("rejects a caller-supplied payload, receipt or job ID", async () => {
    for (const key of ["payload", "receipt", "jobId", "workspaceId", "url", "type"]) {
      await expect(dispatchReleaseDiagnostic(actor, workspaceId, { ...request(), [key]: "forged" })).rejects.toThrow();
    }
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("requires current membership and explicit agent runtime permissions", async () => {
    await expect(dispatchReleaseDiagnostic({ ...actor, scopes: ["runtime:read"] }, workspaceId, request())).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.membership.mockRejectedValueOnce(new Error("revoked membership"));
    await expect(dispatchReleaseDiagnostic(actor, workspaceId, request())).rejects.toThrow("revoked membership");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("rejects absent, wrong-role or wrong-release build identity without dispatch", async () => {
    for (const value of [null, { schemaVersion: 1, role: "worker", gitSha: expectedGitSha }, { schemaVersion: 1, role: "web", gitSha: "b".repeat(40) }]) {
      mocks.read.mockReturnValue(JSON.stringify(value));
      await expect(dispatchReleaseDiagnostic(actor, workspaceId, request())).rejects.toThrow();
    }
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("does not trust configured SHA when the immutable file is missing", () => {
    mocks.read.mockImplementation(() => { throw new Error("missing"); });
    expect(() => readReleaseBuildSha("web")).toThrow("Immutable release build identity");
  });
  it("returns the same durable job and nonce after a lost dispatch response", async () => {
    const input = request(), job = stored(input);
    mocks.upsert.mockResolvedValue(job);
    expect(await dispatchReleaseDiagnostic(actor, workspaceId, input)).toEqual(await dispatchReleaseDiagnostic(actor, workspaceId, input));
  });
  it("rearms only the first terminal failure with the same job and a fresh nonce", async () => {
    const input = request(); const job = stored(input, { status: "FAILED", attempts: 1, completedAt: new Date(), error: "failed" });
    mocks.find.mockResolvedValue(job);
    const result = await dispatchReleaseDiagnostic(actor, workspaceId, { ...input, retryAttempt: 1 });
    expect(result).toMatchObject({ jobId: job.id, operationId: input.operationId, status: "PENDING", attempts: 1 });
    expect(result.nonce).not.toBe(job.payload.nonce);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: job.id, status: "FAILED", attempts: 1, payload: { equals: job.payload } }),
      data: expect.objectContaining({ status: "PENDING" }),
    }));
    expect(mocks.updateMany.mock.calls[0][0].data).not.toHaveProperty("attempts");
  });
  it("keeps pending, running, completed and second-failure retries read-only", async () => {
    const input = request();
    for (const job of [stored(input), stored(input, { status: "RUNNING", attempts: 1, lockedAt: new Date(), lockedBy: "worker" }),
      stored(input, { status: "COMPLETED", attempts: 1 }), stored(input, { status: "FAILED", attempts: 2 })]) {
      mocks.find.mockResolvedValueOnce(job);
      await expect(dispatchReleaseDiagnostic(actor, workspaceId, { ...input, retryAttempt: 1 })).resolves.toMatchObject({
        jobId: job.id, status: job.status, attempts: job.attempts,
      });
    }
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it("never creates a job from a retry request", async () => {
    mocks.find.mockResolvedValue(null);
    await expect(dispatchReleaseDiagnostic(actor, workspaceId, { ...request(), retryAttempt: 1 }))
      .rejects.toMatchObject({ code: "RELEASE_DIAGNOSTIC_CONFLICT" });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it("rejects operation-ID reuse with another requested release", async () => {
    const input = request();
    mocks.upsert.mockResolvedValue(stored({ ...input, expectedGitSha: "b".repeat(40) }));
    await expect(dispatchReleaseDiagnostic(actor, workspaceId, input)).rejects.toMatchObject({ code: "RELEASE_DIAGNOSTIC_CONFLICT" });
  });
  it("requires an exact handler receipt, not generic COMPLETED status", async () => {
    const input = request(), job = { ...stored(input), status: "COMPLETED" };
    mocks.find.mockResolvedValue(job);
    expect(await getReleaseDiagnostic(actor, workspaceId, input)).toMatchObject({ accepted: false, receipt: null });
    const receipt = { ...job.payload, workerId: "worker-1", workerGitSha: expectedGitSha, completedAt: new Date().toISOString() };
    mocks.find.mockResolvedValue({ ...job, payload: { ...job.payload, receipt } });
    expect(await getReleaseDiagnostic(actor, workspaceId, input)).toMatchObject({ accepted: true, receipt });
    for (const change of [{ nonce: randomUUID() }, { jobId: randomUUID() }, { workspaceId: randomUUID() }, { operationId: randomUUID() }, { workerGitSha: "b".repeat(40) }]) {
      mocks.find.mockResolvedValue({ ...job, payload: { ...job.payload, receipt: { ...receipt, ...change } } });
      expect(await getReleaseDiagnostic(actor, workspaceId, input)).toMatchObject({ accepted: false, receipt: null });
    }
  });
  it("rejects a copied/replayed job or a different workspace", async () => {
    const input = request(), job = stored(input);
    mocks.find.mockResolvedValue({ ...job, id: randomUUID() });
    await expect(getReleaseDiagnostic(actor, workspaceId, input)).rejects.toMatchObject({ code: "RELEASE_DIAGNOSTIC_CONFLICT" });
    mocks.find.mockResolvedValue({ ...job, workspaceId: randomUUID() });
    await expect(getReleaseDiagnostic(actor, workspaceId, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
