import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ update: vi.fn(), read: vi.fn() }));
vi.mock("@corgtex/shared", () => ({ prisma: { workflowJob: { updateMany: mocks.update } } }));
vi.mock("@corgtex/domain", async () => ({ ...(await import("../../domain/src/release-diagnostics")), ...(await import("../../domain/src/errors")), readReleaseBuildSha: mocks.read }));
import { handleReleaseDiagnostic } from "./release-diagnostic-handler";
const sha = "a".repeat(40);
function job() { const id = randomUUID(), workspaceId = randomUUID(); return { id, workspaceId, payload: { schemaVersion: 1, jobId: id, workspaceId, nonce: randomUUID(), operationId: randomUUID(), expectedGitSha: sha, webGitSha: sha } }; }
describe("release diagnostic worker", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.read.mockReturnValue(sha); mocks.update.mockResolvedValue({ count: 1 }); });
  it("atomically completes with a handler-specific receipt under the exact worker lock", async () => {
    const input = job();
    await handleReleaseDiagnostic(input, "worker-1");
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: input.id, workspaceId: input.workspaceId, type: "runtime.release-diagnostic.v1", status: "RUNNING", lockedBy: "worker-1", payload: { equals: input.payload } },
      data: expect.objectContaining({ status: "COMPLETED", lockedBy: null, payload: { ...input.payload, receipt: { ...input.payload, workerGitSha: sha, workerId: "worker-1", completedAt: expect.any(String) } } }),
    });
  });
  it("does not acknowledge another release, job, workspace or copied receipt", async () => {
    const input = job();
    for (const invalid of [{ ...input, id: randomUUID() }, { ...input, workspaceId: randomUUID() }, { ...input, payload: { ...input.payload, receipt: {} } }]) await expect(handleReleaseDiagnostic(invalid, "worker-1")).rejects.toThrow();
    mocks.read.mockReturnValue("b".repeat(40));
    await expect(handleReleaseDiagnostic(input, "worker-1")).rejects.toMatchObject({ code: "RELEASE_BUILD_MISMATCH" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not claim success after a worker lock or payload changed", async () => {
    mocks.update.mockResolvedValue({ count: 0 });
    await expect(handleReleaseDiagnostic(job(), "worker-1")).rejects.toMatchObject({ code: "RELEASE_DIAGNOSTIC_OWNERSHIP_LOST" });
  });
});
