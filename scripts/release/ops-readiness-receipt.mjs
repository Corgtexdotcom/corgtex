#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const CONTROL_PLANE_ENDPOINT = "https://ops.corgtex.com/api/control-plane/mcp";
const REQUIRED_TOOLS = ["list_customers", "get_customer_deployment_status"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const FLAG = "BRAIN_SOURCE_REMOVAL";
const FLAG_UNAVAILABLE = "SCHEMA_AUDITOR_HAS_NO_APPLICATION_TABLE_READ";

class ReceiptError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new ReceiptError(code); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function uuid(value) { return typeof value === "string" && UUID.test(value); }
function validatedDeployments(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length >= 500) fail("INVENTORY_INCOMPLETE");
  const ids = new Set();
  const deployments = [];
  for (const row of rows) {
    if (!object(row) || !uuid(row.id) || ids.has(row.id) || typeof row.hasDeployment !== "boolean") {
      fail("INVENTORY_INCOMPLETE");
    }
    ids.add(row.id);
    if (row.hasDeployment === false) {
      // Account-only rows have an explicit discriminator and no deployment fields.
      if (row.customerAccountId !== row.id || row.url !== ""
        || ["deploymentKind", "deploymentStatus", "environment", "cloudProvider", "managedWorkspaceId", "remoteWorkspaceId"]
          .some((field) => row[field] !== null)) fail("INVENTORY_INCOMPLETE");
      continue;
    }
    if (!["SHARED_WORKSPACE", "HOSTED_DEDICATED", "REMOTE_MANAGED", "SELF_HOSTED", "CUSTOMER_CONTROL_PLANE", "INTERNAL", "DEMO"].includes(row.deploymentKind)
      || !["DRAFT", "PROVISIONING", "BOOTSTRAPPING", "ACTIVE", "DEGRADED", "SUSPENDED", "RETIRED"].includes(row.deploymentStatus)
      || typeof row.environment !== "string" || !row.environment.trim()
      || !["RAILWAY", "AZURE", "SELF_HOSTED", "UNKNOWN"].includes(row.cloudProvider)
      || typeof row.url !== "string"
      || ["customerAccountId", "managedWorkspaceId", "remoteWorkspaceId"].some((field) => row[field] !== null && !uuid(row[field]))) {
      fail("INVENTORY_INCOMPLETE");
    }
    deployments.push(row);
  }
  if (deployments.length > 250) fail("INVENTORY_INCOMPLETE");
  return deployments;
}
function inventoryIdentity(rows) {
  validatedDeployments(rows);
  return JSON.stringify(rows.map((row) => [row?.id, row?.hasDeployment, row?.deploymentKind,
    row?.deploymentStatus, row?.environment, row?.cloudProvider, row?.url, row?.customerAccountId,
    row?.managedWorkspaceId, row?.remoteWorkspaceId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
function selfserveOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://selfserve.corgtex.com" && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

function baseReceipt(candidateSha, observedAt) {
  return {
    schemaVersion: 1,
    candidateSha,
    observedAt,
    controlPlane: { status: "unavailable", checkedDeploymentCount: 0, mappings: [], activeLeases: [] },
    featureFlag: { flag: FLAG, status: "unavailable", code: FLAG_UNAVAILABLE, enabledCount: null },
    readiness: { status: "blocked", reasons: ["AUTHORITATIVE_FLAG_EVIDENCE_UNAVAILABLE"] },
  };
}

function lease(detail) {
  if (!Object.hasOwn(detail, "releaseLeaseId")) fail("LEASE_FIELD_UNAVAILABLE");
  const id = detail.releaseLeaseId;
  if (id === null) {
    if (detail.releaseLeasePhase || detail.releaseLeaseOwner || detail.releaseLeaseExpiresAt) fail("LEASE_STATE_INCOMPLETE");
    return null;
  }
  if (!uuid(id) || typeof detail.releaseLeasePhase !== "string" || !detail.releaseLeasePhase
    || typeof detail.releaseLeaseExpiresAt !== "string" || !Number.isFinite(Date.parse(detail.releaseLeaseExpiresAt))) {
    fail("LEASE_STATE_INCOMPLETE");
  }
  return { deploymentId: detail.id, leaseId: id, phase: detail.releaseLeasePhase,
    expiresAt: detail.releaseLeaseExpiresAt };
}

export function projectOpsInventory(rows, details, targetDeploymentId) {
  const deployments = validatedDeployments(rows);
  const active = deployments.filter((row) => row.deploymentStatus === "ACTIVE" && row.environment === "production");
  if (!active.length || deployments.some((row) => row.deploymentStatus === "ACTIVE" && !row.environment)) {
    fail("INVENTORY_INCOMPLETE");
  }
  const target = active.find((row) => row.id === targetDeploymentId);
  if (!target || target.cloudProvider !== "AZURE" || !selfserveOrigin(target.url)) fail("TARGET_MAPPING_MISSING");
  const shared = active.filter((row) => row.deploymentKind === "SHARED_WORKSPACE");
  if (!shared.length || shared.some((row) => !uuid(row.managedWorkspaceId) && !uuid(row.remoteWorkspaceId))) fail("SHARED_MAPPING_INCOMPLETE");

  const mappings = [];
  const activeLeases = [];
  for (const row of deployments) {
    const detail = details.get(row.id);
    if (!object(detail) || detail.id !== row.id || detail.deploymentKind !== row.deploymentKind
      || detail.deploymentStatus !== row.deploymentStatus || detail.environment !== row.environment
      || detail.cloudProvider !== row.cloudProvider || detail.managedWorkspaceId !== row.managedWorkspaceId
      || detail.customerAccountId !== row.customerAccountId || detail.remoteWorkspaceId !== row.remoteWorkspaceId) {
      fail("DEPLOYMENT_READBACK_MISMATCH");
    }
    const activeLease = lease(detail);
    if (activeLease) activeLeases.push(activeLease);
    if (active.includes(row)) mappings.push({ deploymentId: row.id, customerAccountId: row.customerAccountId ?? null,
      deploymentKind: row.deploymentKind, managedWorkspaceId: row.managedWorkspaceId ?? null,
      remoteWorkspaceId: row.remoteWorkspaceId ?? null });
  }
  mappings.sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
  activeLeases.sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
  return { status: activeLeases.length ? "blocked" : "observed", leaseEvidence: "non_atomic_sequential_reads",
    checkedDeploymentCount: deployments.length,
    effectiveDeploymentCount: active.length, sharedWorkspaceCount: shared.length, targetDeploymentId, mappings, activeLeases };
}

async function rpc(fetchImpl, token, method, params) {
  let response;
  try {
    response = await fetchImpl(CONTROL_PLANE_ENDPOINT, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer cp-${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "readiness", method, params }),
    });
  } catch { fail("CONTROL_PLANE_UNAVAILABLE"); }
  if (response.status === 401 || response.status === 403) fail("CONTROL_PLANE_PERMISSION_DENIED");
  if (!response.ok) fail("CONTROL_PLANE_UNAVAILABLE");
  let payload;
  try {
    const raw = await response.text();
    if (raw.length > 2_000_000) fail("CONTROL_PLANE_RESPONSE_TOO_LARGE");
    payload = JSON.parse(raw);
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    fail("CONTROL_PLANE_RESPONSE_INVALID");
  }
  if (!object(payload) || payload.jsonrpc !== "2.0" || payload.id !== "readiness") fail("CONTROL_PLANE_RESPONSE_INVALID");
  if (payload.error?.code === -32601) fail("CONTROL_PLANE_METHOD_UNSUPPORTED");
  if (payload.error?.code === -32602) fail("CONTROL_PLANE_METHOD_UNSUPPORTED");
  if (payload.error) fail("CONTROL_PLANE_TOOL_FAILED");
  return payload.result;
}

async function tool(fetchImpl, token, name, args) {
  const result = await rpc(fetchImpl, token, "tools/call", { name, arguments: args });
  if (!object(result) || result.isError === true || !Array.isArray(result.content)) fail("CONTROL_PLANE_TOOL_FAILED");
  const texts = result.content.filter((item) => item?.type === "text" && typeof item.text === "string");
  if (texts.length !== 1 || texts[0].text.length > 2_000_000) fail("CONTROL_PLANE_RESPONSE_INVALID");
  try { return JSON.parse(texts[0].text); }
  catch { fail("CONTROL_PLANE_RESPONSE_INVALID"); }
}

export async function collectOpsReceipt({ fetchImpl = fetch, token, targetDeploymentId, candidateSha,
  runnerSha, observedAt = new Date().toISOString() }) {
  const receipt = baseReceipt(SHA.test(candidateSha || "") ? candidateSha : null, observedAt);
  try {
    if (!token || !uuid(targetDeploymentId) || !SHA.test(candidateSha || "") || candidateSha !== runnerSha) {
      fail("RECEIPT_INPUT_INVALID");
    }
    const listed = await rpc(fetchImpl, token, "tools/list", {});
    if (!object(listed) || !Array.isArray(listed.tools)) fail("CONTROL_PLANE_METHOD_UNSUPPORTED");
    const listTool = listed.tools.find((entry) => entry?.name === "list_customers");
    const detailTool = listed.tools.find((entry) => entry?.name === "get_customer_deployment_status");
    if (REQUIRED_TOOLS.some((name) => !listed.tools.some((entry) => entry?.name === name))
      || listTool?.inputSchema?.properties?.includeAllDeployments?.type !== "boolean"
      || listTool?.inputSchema?.properties?.uncapped?.type !== "boolean"
      || detailTool?.inputSchema?.properties?.deploymentId?.type !== "string") {
      fail("CONTROL_PLANE_METHOD_UNSUPPORTED");
    }
    const rows = await tool(fetchImpl, token, "list_customers", { includeAllDeployments: true, uncapped: true });
    const deployments = validatedDeployments(rows);
    const details = new Map();
    for (const row of deployments) {
      if (!uuid(row.id)) fail("INVENTORY_INCOMPLETE");
      details.set(row.id, await tool(fetchImpl, token, "get_customer_deployment_status", { deploymentId: row.id }));
    }
    const readback = await tool(fetchImpl, token, "list_customers", { includeAllDeployments: true, uncapped: true });
    if (inventoryIdentity(rows) !== inventoryIdentity(readback)) fail("INVENTORY_CHANGED");
    projectOpsInventory(rows, details, targetDeploymentId);
    const finalDetails = new Map();
    for (const row of deployments) {
      const current = await tool(fetchImpl, token, "get_customer_deployment_status", { deploymentId: row.id });
      const before = details.get(row.id);
      if (JSON.stringify(lease(before)) !== JSON.stringify(lease(current))) fail("LEASE_CHANGED_DURING_SCAN");
      finalDetails.set(row.id, current);
    }
    const finalReadback = await tool(fetchImpl, token, "list_customers", { includeAllDeployments: true, uncapped: true });
    if (inventoryIdentity(rows) !== inventoryIdentity(finalReadback)) fail("INVENTORY_CHANGED");
    receipt.controlPlane = projectOpsInventory(rows, finalDetails, targetDeploymentId);
    if (receipt.controlPlane.activeLeases.length) receipt.readiness.reasons.unshift("ACTIVE_RELEASE_LEASE");
  } catch (error) {
    receipt.controlPlane = { status: "unavailable", checkedDeploymentCount: 0, mappings: [], activeLeases: [],
      code: error instanceof ReceiptError ? error.code : "CONTROL_PLANE_READ_FAILED" };
    receipt.readiness.reasons.unshift("OPS_MAPPING_OR_LEASE_EVIDENCE_UNAVAILABLE");
  }
  return receipt;
}

export async function main(env = process.env, fetchImpl = fetch) {
  const file = env.RELEASE_READINESS_RECEIPT_FILE;
  if (!file || !isAbsolute(file)) fail("RECEIPT_PATH_INVALID");
  const receipt = await collectOpsReceipt({ fetchImpl, token: env.CONTROL_PLANE_AGENT_API_KEY,
    targetDeploymentId: env.RELEASE_TARGET_DEPLOYMENT_ID, candidateSha: env.RELEASE_CANDIDATE_SHA,
    runnerSha: env.GITHUB_SHA });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ controlPlane: receipt.controlPlane.status, featureFlag: receipt.featureFlag.status,
    readiness: receipt.readiness.status, checkedDeploymentCount: receipt.controlPlane.checkedDeploymentCount,
    code: receipt.controlPlane.code ?? null }));
  process.exitCode = 1; // The authoritative feature-flag read is unavailable; this receipt cannot clear a release.
  return receipt;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    console.error("RELEASE_READINESS_RECEIPT_FAILED");
    process.exitCode = 1;
  });
}
