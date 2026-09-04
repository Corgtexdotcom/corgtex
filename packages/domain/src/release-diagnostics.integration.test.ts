import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AgentActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
const build = vi.hoisted(() => ({ role: "web", sha: "a".repeat(40) }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => args[0] === "/app/release-build.json"
    ? JSON.stringify({ schemaVersion: 1, role: build.role, gitSha: build.sha }) : fs.readFileSync(...args) };
});
import { dispatchReleaseDiagnostic, getReleaseDiagnostic } from "./release-diagnostics";
import { handleReleaseDiagnostic } from "../../workflows/src/release-diagnostic-handler";
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { slug: randomUUID(), name: "Synthetic diagnostic" } });
  const actor: AgentActor = { kind: "agent", authProvider: "credential", label: "Synthetic", workspaceIds: [workspace.id], scopes: ["runtime:read", "runtime:write"] };
  const request = { operationId: randomUUID(), expectedGitSha: build.sha };
  return { workspaceId: workspace.id, actor, request };
}
describe("durable release diagnostics", () => {
  beforeEach(async () => { await truncateAllTables(); build.role = "web"; });
  it("deduplicates concurrent/lost replies and accepts only a worker-owned durable receipt", async () => {
    const { actor, workspaceId, request } = await fixture();
    const dispatched = await Promise.all([dispatchReleaseDiagnostic(actor, workspaceId, request), dispatchReleaseDiagnostic(actor, workspaceId, request)]);
    expect(dispatched[0]).toEqual(dispatched[1]);
    expect(await prisma.workflowJob.count()).toBe(1);
    const job = await prisma.workflowJob.update({ where: { id: dispatched[0].jobId }, data: { status: "RUNNING", lockedBy: "worker-1", lockedAt: new Date() } });
    build.role = "worker";
    await handleReleaseDiagnostic(job, "worker-1");
    build.role = "web";
    expect(await getReleaseDiagnostic(actor, workspaceId, request)).toMatchObject({ accepted: true, receipt: { workerId: "worker-1", jobId: job.id, workerGitSha: build.sha } });
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.agentRun.count()).toBe(0);
  });
  it("rejects cross-workspace access and never treats an old unknown-job completion as proof", async () => {
    const { actor, workspaceId, request } = await fixture();
    const dispatched = await dispatchReleaseDiagnostic(actor, workspaceId, request);
    await expect(getReleaseDiagnostic({ ...actor, workspaceIds: [randomUUID()] }, workspaceId, request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await prisma.workflowJob.update({ where: { id: dispatched.jobId }, data: { status: "COMPLETED" } });
    expect(await getReleaseDiagnostic(actor, workspaceId, request)).toMatchObject({ accepted: false });
  });
  it("preserves a new owner when the original worker finishes late", async () => {
    const { actor, workspaceId, request } = await fixture();
    const dispatched = await dispatchReleaseDiagnostic(actor, workspaceId, request);
    const job = await prisma.workflowJob.update({ where: { id: dispatched.jobId }, data: { status: "RUNNING", lockedBy: "worker-new", lockedAt: new Date() } });
    build.role = "worker";
    await expect(handleReleaseDiagnostic(job, "worker-old")).rejects.toMatchObject({ code: "RELEASE_DIAGNOSTIC_OWNERSHIP_LOST" });
    expect(await prisma.workflowJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "RUNNING", lockedBy: "worker-new", payload: job.payload });
  });
});
