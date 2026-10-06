import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectOpsReceipt, main, projectOpsInventory } from "./ops-readiness-receipt.mjs";

const candidateSha = "a".repeat(40);
const targetId = "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16";
const sharedId = "19bb3d17-01cf-4739-9726-926a658a1af1";
const workspaceId = "72534ed7-3302-484d-8912-877b24604488";
const accountId = "82d42461-ce5f-48e0-84d1-3718b12cb1f0";

const target = { id: targetId, hasDeployment: true, deploymentKind: "REMOTE_MANAGED", deploymentStatus: "ACTIVE",
  environment: "production", cloudProvider: "AZURE", url: "https://selfserve.corgtex.com",
  managedWorkspaceId: null, remoteWorkspaceId: null, customerAccountId: null };
const shared = { id: sharedId, hasDeployment: true, deploymentKind: "SHARED_WORKSPACE", deploymentStatus: "ACTIVE",
  environment: "production", cloudProvider: "RAILWAY", url: "https://ops.corgtex.com",
  managedWorkspaceId: workspaceId, remoteWorkspaceId: null, customerAccountId: accountId };
const details = new Map([[targetId, { ...target, releaseLeaseId: null, releaseLeasePhase: null,
  releaseLeaseOwner: null, releaseLeaseExpiresAt: null }], [sharedId, { ...shared, releaseLeaseId: null,
  releaseLeasePhase: null, releaseLeaseOwner: null, releaseLeaseExpiresAt: null }]]);

function rpc(result, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "readiness", result }), { status });
}

function fixtureFetch({ rows = [target, shared], rowsAfterReadback = rows, byId = details,
  tools = ["list_customers", "get_customer_deployment_status"], supportsUncapped = true,
  status = 200, onCall = () => {} } = {}) {
  let listCalls = 0;
  return async (url, options) => {
    assert.equal(url, "https://ops.corgtex.com/api/control-plane/mcp");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer cp-synthetic-token");
    const body = JSON.parse(options.body);
    onCall(body);
    if (status !== 200) return new Response("private error", { status });
    if (body.method === "tools/list") return rpc({ tools: tools.map((name) => ({ name,
      inputSchema: { properties: name === "list_customers"
        ? { includeAllDeployments: { type: "boolean" }, ...(supportsUncapped ? { uncapped: { type: "boolean" } } : {}) }
        : { deploymentId: { type: "string" } } },
    })) });
    if (body.method !== "tools/call") throw new Error("unexpected method");
    const value = body.params.name === "list_customers"
      ? (++listCalls === 1 ? rows : rowsAfterReadback) : byId.get(body.params.arguments.deploymentId);
    if (body.params.name === "list_customers") {
      assert.deepEqual(body.params.arguments, { includeAllDeployments: true, uncapped: true });
    }
    return rpc({ content: [{ type: "text", text: JSON.stringify(value) }] });
  };
}

function collect(fetchImpl) {
  return collectOpsReceipt({ fetchImpl, token: "synthetic-token", targetDeploymentId: targetId,
    candidateSha, runnerSha: candidateSha, observedAt: "2026-10-06T00:00:00.000Z" });
}

test("returns bounded Ops mappings and an explicitly blocked flag/overall receipt", async () => {
  const calls = [];
  const receipt = await collect(fixtureFetch({ onCall: (body) => calls.push(body) }));
  assert.equal(receipt.controlPlane.status, "verified");
  assert.equal(receipt.controlPlane.checkedDeploymentCount, 2);
  assert.equal(receipt.controlPlane.sharedWorkspaceCount, 1);
  assert.deepEqual(receipt.controlPlane.activeLeases, []);
  assert.deepEqual(receipt.controlPlane.mappings.map((mapping) => mapping.deploymentId), [sharedId, targetId]);
  assert.equal(receipt.controlPlane.mappings[0].managedWorkspaceId, workspaceId);
  assert.equal(receipt.featureFlag.status, "unavailable");
  assert.equal(receipt.featureFlag.enabledCount, null);
  assert.deepEqual(receipt.readiness, { status: "blocked", reasons: ["AUTHORITATIVE_FLAG_EVIDENCE_UNAVAILABLE"] });
  assert.equal(calls.length, 5);
  assert.ok(!JSON.stringify(receipt).includes("synthetic-token"));
});

test("active lease blocks Ops evidence and includes only lease fields", async () => {
  const leased = new Map(details);
  leased.set(targetId, { ...details.get(targetId), releaseLeaseId: "198a4459-c41d-4b6c-adc9-c9c470693633",
    releaseLeaseOwner: "private-owner", releaseLeasePhase: "RESERVED", releaseLeaseExpiresAt: "2026-10-07T00:00:00.000Z",
    releaseLeaseTokenHash: "private-hash" });
  const receipt = await collect(fixtureFetch({ byId: leased }));
  assert.equal(receipt.controlPlane.status, "blocked");
  assert.equal(receipt.controlPlane.activeLeases.length, 1);
  assert.equal(receipt.controlPlane.activeLeases[0].phase, "RESERVED");
  assert.ok(receipt.readiness.reasons.includes("ACTIVE_RELEASE_LEASE"));
  assert.ok(!JSON.stringify(receipt).includes("private-owner"));
  assert.ok(!JSON.stringify(receipt).includes("private-hash"));
});

test("lease on an inactive deployment still blocks the fleet receipt", async () => {
  const inactiveId = "29291628-c93a-4c22-9e61-aa79535e8c10";
  const inactive = { ...shared, id: inactiveId, deploymentStatus: "DRAFT", managedWorkspaceId: null };
  const leased = new Map(details);
  leased.set(inactiveId, { ...inactive, releaseLeaseId: "198a4459-c41d-4b6c-adc9-c9c470693633",
    releaseLeaseOwner: "private-owner", releaseLeasePhase: "RECOVERY_REQUIRED",
    releaseLeaseExpiresAt: "2026-10-01T00:00:00.000Z" });
  const receipt = await collect(fixtureFetch({ rows: [target, shared, inactive], byId: leased }));
  assert.equal(receipt.controlPlane.checkedDeploymentCount, 3);
  assert.equal(receipt.controlPlane.effectiveDeploymentCount, 2);
  assert.equal(receipt.controlPlane.activeLeases[0].deploymentId, inactiveId);
  assert.equal(receipt.controlPlane.status, "blocked");
});

test("missing active shared workspace mapping fails closed", async () => {
  const rows = [target, { ...shared, managedWorkspaceId: null }];
  const receipt = await collect(fixtureFetch({ rows }));
  assert.equal(receipt.controlPlane.status, "unavailable");
  assert.equal(receipt.controlPlane.code, "SHARED_MAPPING_INCOMPLETE");
  assert.deepEqual(receipt.controlPlane.mappings, []);
  assert.equal(receipt.readiness.status, "blocked");
});

test("missing environment on an active shared mapping fails closed", async () => {
  const rows = [target, { ...shared, environment: null }];
  const receipt = await collect(fixtureFetch({ rows }));
  assert.equal(receipt.controlPlane.code, "INVENTORY_INCOMPLETE");
});

test("changed deployment readback fails closed", () => {
  const changed = new Map(details);
  changed.set(sharedId, { ...details.get(sharedId), managedWorkspaceId: targetId });
  assert.throws(() => projectOpsInventory([target, shared], changed, targetId), { code: "DEPLOYMENT_READBACK_MISMATCH" });
});

test("a deployment added after the first inventory read fails closed", async () => {
  const added = { ...shared, id: "7a81a5ba-e994-4137-b8f0-036e919c3ac8" };
  const receipt = await collect(fixtureFetch({ rowsAfterReadback: [target, shared, added] }));
  assert.equal(receipt.controlPlane.code, "INVENTORY_CHANGED");
  assert.equal(receipt.readiness.status, "blocked");
});

test("permission denial never exposes the response or credential", async () => {
  const receipt = await collect(fixtureFetch({ status: 403 }));
  assert.equal(receipt.controlPlane.code, "CONTROL_PLANE_PERMISSION_DENIED");
  assert.equal(receipt.readiness.status, "blocked");
  assert.ok(!JSON.stringify(receipt).includes("private error"));
  assert.ok(!JSON.stringify(receipt).includes("synthetic-token"));
});

test("unsupported old-server method fails explicitly", async () => {
  const receipt = await collect(fixtureFetch({ tools: ["list_customers"] }));
  assert.equal(receipt.controlPlane.code, "CONTROL_PLANE_METHOD_UNSUPPORTED");
  assert.equal(receipt.readiness.status, "blocked");
});

test("old-server list without uncapped support cannot prove inventory completeness", async () => {
  const receipt = await collect(fixtureFetch({ supportsUncapped: false }));
  assert.equal(receipt.controlPlane.code, "CONTROL_PLANE_METHOD_UNSUPPORTED");
});

test("missing lease field never counts as an inactive lease", async () => {
  const incomplete = new Map(details);
  const { releaseLeaseId: _ignored, ...withoutLease } = details.get(targetId);
  incomplete.set(targetId, withoutLease);
  const receipt = await collect(fixtureFetch({ byId: incomplete }));
  assert.equal(receipt.controlPlane.code, "LEASE_FIELD_UNAVAILABLE");
});

test("writes only a private blocked receipt and exits nonzero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ops-receipt-"));
  const file = join(directory, "receipt.json");
  const oldExitCode = process.exitCode;
  const oldLog = console.log;
  const logs = [];
  console.log = (value) => logs.push(value);
  try {
    await main({ RELEASE_READINESS_RECEIPT_FILE: file, CONTROL_PLANE_AGENT_API_KEY: "synthetic-token",
      RELEASE_TARGET_DEPLOYMENT_ID: targetId, RELEASE_CANDIDATE_SHA: candidateSha, GITHUB_SHA: candidateSha }, fixtureFetch());
    assert.equal(process.exitCode, 1);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const body = JSON.parse(await readFile(file, "utf8"));
    assert.equal(body.readiness.status, "blocked");
    assert.equal(body.controlPlane.status, "verified");
    assert.ok(!JSON.stringify({ body, logs }).includes("synthetic-token"));
  } finally {
    process.exitCode = oldExitCode;
    console.log = oldLog;
    await rm(directory, { recursive: true, force: true });
  }
});
