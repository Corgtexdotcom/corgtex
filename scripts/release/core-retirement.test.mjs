import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { identityHash, sha256 } from "../accepted-core-baseline.mjs";
import { CORE_RETIREMENT_TARGET as target, CORE_SOURCE_SHA as sourceSha, CORE_BEFORE, ROLES,
  retirementCommand, sourceFreezeServer, retireCore, assertQuietTriggers } from "./core-retirement.mjs";

const H = "a".repeat(64), now = Date.parse("2026-09-30T19:00:00Z");
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function fixture() {
  const baselineTarget = { ...target, id: "backup-app", origin: "https://app.corgtex.com", provider: "railway", databaseIdentitySha256: H };
  const images = Object.fromEntries(ROLES.map(role => [role, { deploymentId: CORE_BEFORE[role], digest: `sha256:${H}` }]));
  const verifier = "b".repeat(40), observedAt = new Date(now).toISOString();
  const evidence = { target: baselineTarget, sourceSha, images,
    buildProof: { kind: "direct-container-build-readback", evidenceSha256: H, observedAt,
      roles: Object.fromEntries(ROLES.map(role => [role, { deploymentId: CORE_BEFORE[role], sourceSha }])) },
    authProof: { kind: "protected-review-retained-core-auth", runId: 1, runAttempt: 1, jobId: 2, stepNumber: 3,
      workflowSha: verifier, evidenceSha256: H, observedAt, origin: baselineTarget.origin,
      checks: { health: true, releaseMetadata: true, loginPage: true, login: true, session: true, rootFlow: true } } };
  const receipt = { schemaVersion: 1, kind: "accepted-core-baseline", accepted: true, evidence,
    schema: { manifestSha256: H, datamodelSha256: H, exactLedgerMatch: true, supportedSchemaMatch: true },
    acceptance: { repository: "Corgtexdotcom/corgtex", workflowPath: ".github/workflows/accepted-core-baseline.yml", workflowSha: verifier,
      runId: 4, runAttempt: 1, acceptedAt: observedAt, evidenceSha256: identityHash(evidence) } };
  const receiptBytes = JSON.stringify(receipt);
  const pin = { schemaVersion: 1, target: "backup-app", targetSha256: identityHash(baselineTarget), sourceSha, verifierSha: verifier,
    receiptSha256: sha256(receiptBytes), run: { id: 4, attempt: 1, workflowId: 5, workflowSha: verifier },
    artifact: { id: 6, name: "accepted-core-baseline-4-1", sha256: H } };
  const stages = Object.fromEntries(ROLES.map(role => [role, {
    image: `ghcr.io/corgtexdotcom/corgtex/${role}@sha256:${H}`, startCommand: `npm run start --workspace=@corgtex/${role}`,
    latestDeployment: { id: CORE_BEFORE[role], status: "SUCCESS" }, activeDeployments: [{ id: CORE_BEFORE[role], status: "SUCCESS" }],
    history: [{ id: CORE_BEFORE[role], status: "SUCCESS", digest: `sha256:${H}` }],
    releaseSettings: { CORGTEX_RELEASE_GIT_SHA: sourceSha, CORGTEX_RELEASE_IMAGE_TAG: `sha-${sourceSha}`,
      CORGTEX_RELEASE_VERSION: `main-${sourceSha.slice(0, 12)}`, CORGTEX_STARTUP_MODE: "web" },
  }]));
  const state = { stages, fence: { staged: { empty: true, status: "STAGED" }, pendingWork: [], services: ROLES.map(role => ({
    serviceId: target[`${role}ServiceId`], autoDeployEnabled: false, autoUpdatesType: null,
    cronSchedule: null, configuredCronSchedule: null, nextCronRunAt: null, fileConfig: null, deployments: [{ status: "SUCCESS" }],
  })) } };
  const writes = [];
  const deps = { now: () => now, assertContext: vi.fn(async () => H), verifyImages: vi.fn(async () => H),
    readState: vi.fn(async () => structuredClone(state)), reserveIntent: vi.fn(async () => true),
    setCommand: vi.fn(async (role, command) => { writes.push(`command:${role}`); state.stages[role].startCommand = command; }),
    deploy: vi.fn(async role => { writes.push(`deploy:${role}`); return id(role === "worker" ? 10 : 11); }),
    verifyRuntime: vi.fn(async (role, deploymentId) => {
      state.stages[role].latestDeployment = { id: deploymentId, status: "SUCCESS" };
      state.stages[role].activeDeployments = [{ id: deploymentId, status: "SUCCESS" }];
      return structuredClone(state);
    }), verifyPublic: vi.fn(async () => {}) };
  const input = { pin, receipt, receiptBytes };
  const approve = async () => {
    const plan = await retireCore(input, deps);
    const approval = { schemaVersion: 1, kind: "core-logical-retirement", reviewedAt: observedAt,
      baselineReceiptSha256: pin.receiptSha256, providerBeforeSha256: plan.providerBeforeSha256, opsSnapshotSha256: H,
      imageStartupProofSha256: H, publicSelfserveEvidenceSha256: H, providerDispositionSha256: H, sourceDataDispositionSha256: H,
      sourceDataDisposition: "retain-unchanged", customerTargets: "selfserve-only", physicalServices: "retain", databaseChanges: false };
    return { ...input, approval, approvalHash: identityHash(approval), dryRun: false };
  };
  return { input, deps, state, writes, approve };
}

describe("bounded Core retirement", () => {
  it("defaults to a read-only exact-target plan", async () => {
    const f = fixture(); expect(await retireCore(f.input, f.deps)).toMatchObject({ mutations: 0, dryRun: true, target });
    expect(f.writes).toEqual([]); expect(f.deps.reserveIntent).not.toHaveBeenCalled();
  });
  it("retires worker then web only after durable reservation and exact approval", async () => {
    const f = fixture(), input = await f.approve();
    expect(await retireCore(input, f.deps)).toMatchObject({ applicationWrites: false, businessWorker: false, databaseChanges: false });
    expect(f.writes).toEqual(["command:worker", "deploy:worker", "command:web", "deploy:web"]);
    expect(f.deps.reserveIntent.mock.invocationCallOrder[0]).toBeLessThan(f.deps.setCommand.mock.invocationCallOrder[0]);
    expect(f.deps.verifyPublic).toHaveBeenCalledWith(input.approvalHash);
  });
  it.each(["approval", "provider", "ops", "registry", "disposition", "expiry"])("rejects changed %s proof before writes", async kind => {
    const f = fixture(), input = await f.approve();
    if (kind === "approval") input.approvalHash = "b".repeat(64);
    if (kind === "provider") f.state.stages.web.startCommand = "unexpected";
    if (kind === "ops") f.deps.assertContext.mockResolvedValue("c".repeat(64));
    if (kind === "registry") f.deps.verifyImages.mockResolvedValue("c".repeat(64));
    if (kind === "disposition") { delete input.approval.providerDispositionSha256; input.approvalHash = identityHash(input.approval); }
    if (kind === "expiry") { input.approval.reviewedAt = new Date(now - 3600001).toISOString(); input.approvalHash = identityHash(input.approval); }
    await expect(retireCore(input, f.deps)).rejects.toThrow(); expect(f.writes).toEqual([]);
  });
  it.each(["autoDeployEnabled", "cronSchedule", "pendingWork", "staging", "deployment"])("blocks %s before mutation", async kind => {
    const f = fixture();
    if (kind === "autoDeployEnabled") f.state.fence.services[0].autoDeployEnabled = true;
    if (kind === "cronSchedule") f.state.fence.services[0].cronSchedule = "* * * * *";
    if (kind === "pendingWork") f.state.fence.pendingWork.push({});
    if (kind === "staging") f.state.fence.staged.empty = false;
    if (kind === "deployment") f.state.fence.services[0].deployments[0].status = "DEPLOYING";
    expect(() => assertQuietTriggers(f.state.fence)).toThrow();
    await expect(retireCore(f.input, f.deps)).rejects.toThrow(); expect(f.writes).toEqual([]);
  });
  it("does not replay uncertain commands or continue to web after failed worker deployment", async () => {
    const f = fixture(), input = await f.approve(); f.deps.deploy.mockRejectedValue(new Error("uncertain"));
    await expect(retireCore(input, f.deps)).rejects.toThrow("uncertain");
    expect(f.deps.deploy).toHaveBeenCalledOnce(); expect(f.writes).toEqual(["command:worker"]);
  });
  it("requires fresh exclusion immediately before deployment", async () => {
    const f = fixture(), input = await f.approve(); let calls = 0;
    f.deps.assertContext.mockImplementation(async () => ++calls === 3 ? "b".repeat(64) : H);
    await expect(retireCore(input, f.deps)).rejects.toThrow("OPS_SNAPSHOT_CHANGED");
    expect(f.writes).toEqual(["command:worker"]);
  });
});

describe("actual source-freeze utility", () => {
  it.each(["web", "worker"])("serves health and rejects writes without app startup (%s)", async role => {
    const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ["-e", `(${sourceFreezeServer.toString()})(${JSON.stringify(role)},${JSON.stringify(H)})`], {
      env: { PORT: String(port) }, stdio: "pipe",
    });
    try {
      let response;
      for (let attempt = 0; attempt < 50; attempt++) {
        try { response = await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      expect(await response.json()).toMatchObject({ mode: "source-freeze-utility", applicationWrites: false, businessWorker: false, proofSha256: H });
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const denied = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method });
        expect(denied.status).toBe(503); expect(denied.headers.get("retry-after")).toBe("3600"); expect(denied.headers.get("location")).toBe(null);
      }
      expect((await fetch(`http://127.0.0.1:${port}/api/auth/callback/google?code=never-exchange`)).status).toBe(503);
      const page = await fetch(`http://127.0.0.1:${port}/en/workspaces/legacy`);
      expect(page.status).toBe(role === "web" ? 200 : 503);
      if (role === "web") expect(await page.text()).toContain('href="https://selfserve.corgtex.com"');
      expect(retirementCommand(role, H)).toContain("-u NODE_OPTIONS -u NODE_PATH /usr/local/bin/node -e");
    } finally { child.kill("SIGTERM"); await once(child, "exit"); }
  });
});
