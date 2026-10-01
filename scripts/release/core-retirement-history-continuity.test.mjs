import { describe, expect, it } from "vitest";
import { identityHash } from "../accepted-core-baseline.mjs";
import { CORE_RETIREMENT_TARGET as target } from "./core-retirement.mjs";
import { verifyRetirementHistoryContinuity as verify } from "./core-retirement-history-continuity.mjs";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = n => `sha256:${String(n).padStart(64, "0")}`;
function fixture() {
  const history = Array.from({ length: 100 }, (_, i) => ({ id: id(i + 1), status: i ? "REMOVED" : "SUCCESS", digest: digest(i + 1) }));
  const lifecycle = n => ({ id: id(n), projectId: target.projectId, environmentId: target.environmentId, serviceId: target.workerServiceId,
    status: n === 1 ? "SUCCESS" : "REMOVED", createdAt: "2026-01-01T00:00:00Z", deploymentStopped: n !== 1,
    instances: [{ idRef: String(n), status: n === 1 ? "RUNNING" : "REMOVED" }] });
  const previous = { stages: { worker: { history, hasMoreHistory: true, activeDeployments: [{ id: id(1), status: "SUCCESS" }] } },
    fence: { binding: { projectId: target.projectId, environmentId: target.environmentId, serviceIds: [target.webServiceId, target.workerServiceId] },
      services: [{ serviceId: target.workerServiceId, deployments: Array.from({ length: 120 }, (_, i) => lifecycle(i + 1)) }] } };
  const current = structuredClone(previous);
  current.stages.worker.history = [...structuredClone(history.slice(0, 99)), { id: id(121), status: "SUCCESS", digest: digest(1) }];
  current.fence.services[0].deployments.push({ ...lifecycle(121), status: "SUCCESS", deploymentStopped: false, instances: [{ idRef: "121", status: "RUNNING" }] });
  const calls = [], supplements = [];
  const f = { role: "worker", previous, current, previousIds: [id(1)], target, calls, supplements,
    onSupplement: async rows => supplements.push(rows),
    query: async (query, variables) => {
      calls.push({ query, variables });
      const old = f.previous.stages.worker.history.find(row => row.id === variables.id);
      const live = f.current.fence.services[0].deployments.find(row => row.id === variables.id);
      return { deployment: { id: variables.id, projectId: target.projectId, environmentId: target.environmentId,
        serviceId: target.workerServiceId, status: live.status, meta: { imageDigest: old.digest, unrelated: "not-in-supplement" } } };
    } };
  return f;
}

describe("retirement history first-page continuity", () => {
  it("supplements only the displaced old row from its exact target and preserves both projections", async () => {
    const f = fixture(), before = identityHash({ previous: f.previous, current: f.current });
    const result = await verify(f);
    expect(result).toEqual([{ id: id(100), status: "REMOVED", digest: digest(100),
      target: { projectId: target.projectId, environmentId: target.environmentId, serviceId: target.workerServiceId } }]);
    expect(f.supplements).toEqual([result]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].variables).toEqual({ id: id(100) });
    expect(f.calls[0].query).toMatch(/^query RetirementHistorySupplement/);
    expect(f.calls[0].query).not.toMatch(/mutation|deployments\(/);
    expect(identityHash({ previous: f.previous, current: f.current })).toBe(before);
  });
  it("binds web supplements to the web service instead of the worker", async () => {
    const f = fixture(); f.role = "web";
    for (const state of [f.previous, f.current]) {
      state.stages.web = state.stages.worker; delete state.stages.worker;
      state.fence.services[0].serviceId = target.webServiceId;
      for (const row of state.fence.services[0].deployments) row.serviceId = target.webServiceId;
    }
    f.query = async (query, variables) => {
      f.calls.push({ query, variables });
      return { deployment: { id: variables.id, projectId: target.projectId, environmentId: target.environmentId,
        serviceId: target.webServiceId, status: "REMOVED", meta: { imageDigest: digest(100) } } };
    };
    expect((await verify(f))[0].target.serviceId).toBe(target.webServiceId);
  });
  it("makes no lookup or supplement callback when all prior rows remain visible", async () => {
    const f = fixture(); f.current.stages.worker.history = structuredClone(f.previous.stages.worker.history);
    expect(await verify(f)).toEqual([]); expect(f.calls).toEqual([]); expect(f.supplements).toEqual([]);
  });
  it("allows the active predecessor to drain, while retaining its original digest", async () => {
    const f = fixture();
    f.current.stages.worker.history[0].status = "REMOVED";
    const prior = f.current.fence.services[0].deployments[0]; prior.status = "REMOVED"; prior.deploymentStopped = true; prior.instances[0].status = "REMOVED";
    expect(await verify(f)).toHaveLength(1);
  });
  it("can supplement a displaced draining predecessor without requiring its old active status", async () => {
    const f = fixture(); f.current.stages.worker.history = structuredClone(f.previous.stages.worker.history.slice(1));
    const prior = f.current.fence.services[0].deployments[0]; prior.status = "REMOVED"; prior.deploymentStopped = true; prior.instances[0].status = "REMOVED";
    expect(await verify(f)).toEqual([{ id: id(1), status: "REMOVED", digest: digest(1), target: {
      projectId: target.projectId, environmentId: target.environmentId, serviceId: target.workerServiceId } }]);
  });
  it("preserves a genuine null historical image digest", async () => {
    const f = fixture(); f.previous.stages.worker.history[99].digest = null;
    expect((await verify(f))[0].digest).toBeNull();
  });
  it.each(["missing", "id", "project", "environment", "service", "status", "digest", "inventedNull", "inventedImage"])("rejects direct-read %s mismatch", async kind => {
    const f = fixture(), read = f.query;
    if (kind === "inventedImage") f.previous.stages.worker.history[99].digest = null;
    f.query = async (...args) => {
      const result = await read(...args), row = result.deployment;
      if (kind === "missing") return { deployment: null };
      if (kind === "id") row.id = id(121);
      if (kind === "project") row.projectId = id(500);
      if (kind === "environment") row.environmentId = id(500);
      if (kind === "service") row.serviceId = target.webServiceId;
      if (kind === "status") row.status = "SUCCESS";
      if (kind === "digest") row.meta.imageDigest = digest(1);
      if (kind === "inventedNull") row.meta.imageDigest = null;
      if (kind === "inventedImage") row.meta.imageDigest = digest(1);
      return result;
    };
    await expect(verify(f)).rejects.toThrow("CORE_RETIREMENT_HISTORY_EVIDENCE_CHANGED");
    expect(f.supplements).toEqual([]);
  });
  it.each(["missingFence", "lifecycle", "olderLifecycle", "wrongFenceTarget", "wrongRowBinding", "visibleStatus", "visibleDigest", "activeDigest", "notTruncated", "duplicatePrior", "over100", "undeclaredActive"])("rejects %s before any supplemental read", async kind => {
    const f = fixture(), deployments = f.current.fence.services[0].deployments;
    if (kind === "missingFence") deployments.splice(99, 1);
    if (kind === "lifecycle") deployments[99].instances[0].status = "RUNNING";
    if (kind === "olderLifecycle") deployments[115].status = "SUCCESS";
    if (kind === "wrongFenceTarget") f.current.fence.binding.environmentId = id(500);
    if (kind === "wrongRowBinding") deployments[99].serviceId = target.webServiceId;
    if (kind === "visibleStatus") f.current.stages.worker.history[1].status = "SUCCESS";
    if (kind === "visibleDigest") f.current.stages.worker.history[1].digest = digest(500);
    if (kind === "activeDigest") f.current.stages.worker.history[0].digest = digest(500);
    if (kind === "notTruncated") f.current.stages.worker.hasMoreHistory = false;
    if (kind === "duplicatePrior") f.previous.stages.worker.history[99] = f.previous.stages.worker.history[98];
    if (kind === "over100") f.previous.stages.worker.history.push({ id: id(500), status: "REMOVED", digest: null });
    if (kind === "undeclaredActive") f.previousIds.push(id(100));
    await expect(verify(f)).rejects.toThrow("CORE_RETIREMENT_HISTORY_EVIDENCE_CHANGED");
    expect(f.calls).toEqual([]); expect(f.supplements).toEqual([]);
  });
  it("performs at most one exact lookup for each of the bounded prior 100 IDs", async () => {
    const f = fixture(); f.current.stages.worker.history = [{ id: id(121), status: "SUCCESS", digest: digest(1) }];
    const result = await verify(f); expect(result).toHaveLength(100); expect(f.calls).toHaveLength(100);
    expect(new Set(f.calls.map(call => call.variables.id)).size).toBe(100);
    expect(f.calls.every(call => f.previous.stages.worker.history.some(row => row.id === call.variables.id))).toBe(true);
  });
  it("does not retry failed exact reads or emit partial supplements", async () => {
    const f = fixture(); f.query = async () => { f.calls.push("once"); throw new Error("READ_FAILED"); };
    await expect(verify(f)).rejects.toThrow("READ_FAILED"); expect(f.calls).toEqual(["once"]); expect(f.supplements).toEqual([]);
  });
});
