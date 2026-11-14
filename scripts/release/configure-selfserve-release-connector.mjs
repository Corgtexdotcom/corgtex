import { pathToFileURL } from "node:url";
import { fullReleaseSha, SELFSERVE_VALIDATION_TARGET as workspace } from "../lib/selfserve-validation-target.mjs";
import { openSelfserveValidationSession } from "../selfserve-validation-smoke.mjs";
import { SELFSERVE_RELEASE_HOST_ID as hostId } from "./managed-azure-selfserve-profile.mjs";

const ops = "https://ops.corgtex.com";
const hostPath = `/api/control-plane/deployments/${hostId}`;
const credentialsPath = `/api/workspaces/${workspace.workspaceId}/agent-credentials`;
const label = "Corgtex Support — selfserve release diagnostics";
const scopes = ["runtime:read", "runtime:write", "workspace:read"];
const check = (condition, code) => { if (!condition) throw new Error(code); };

export async function configureReleaseConnector(env, { fetchImpl = fetch, openSession = openSelfserveValidationSession } = {}) {
  check(env.CONTROL_PLANE_AGENT_API_KEY?.trim(), "OPS_CREDENTIAL_REQUIRED");
  const authorization = `Bearer cp-${env.CONTROL_PLANE_AGENT_API_KEY.trim()}`;
  const request = async (url, headers, body) => {
    const response = await fetchImpl(url, { method: body === undefined ? "GET" : "POST",
      headers: { ...headers, "content-type": "application/json" }, redirect: "error",
      signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    check(response.ok, "REQUEST_FAILED");
    return response.json();
  };
  const host = async () => {
    const { deployment } = await request(ops + hostPath, { authorization });
    check(deployment?.id === hostId && deployment.deploymentKind === "REMOTE_MANAGED"
      && deployment.cloudProvider === "AZURE" && [workspace.origin, workspace.origin + "/"].includes(deployment.url)
      && (!deployment.remoteWorkspaceId || deployment.remoteWorkspaceId === workspace.workspaceId)
      && typeof deployment.hasSupportCredential === "boolean", "HOST_BINDING_CHANGED");
    const base = deployment.supportBaseUrl || deployment.url;
    check([workspace.origin, workspace.origin + "/"].includes(base)
      && (!deployment.supportMcpUrl || deployment.supportMcpUrl === workspace.origin + "/api/mcp"),
      "CONNECTOR_ENDPOINT_MISMATCH");
    return deployment;
  };
  const verify = async () => {
    const result = await request(ops + "/api/control-plane/mcp", { authorization }, {
      jsonrpc: "2.0", id: "release-diagnostic-preflight", method: "tools/call",
      params: { name: "read_managed_release_auth", arguments: { deploymentId: hostId, mode: "preflight" } },
    });
    const text = result.result?.content?.find(item => item.type === "text")?.text;
    const proof = text && JSON.parse(text);
    check(proof?.status === "READY" && proof.effects === 0 && proof.workspaceId === workspace.workspaceId, "DIAGNOSTIC_UNVERIFIED");
  };
  const expectedSha = fullReleaseSha(env.EXPECTED_SELFSERVE_SHA);
  if ((await host()).hasSupportCredential) {
    const health = await request(workspace.origin + "/api/health", {});
    check(health.status === "ok" && health.database === "up" && health.schema === "ready"
      && health.release?.gitSha === expectedSha && health.release.runtime?.gitSha === expectedSha
      && health.release.runtime.evidence === "baked", "SERVING_RELEASE_MISMATCH");
    await verify();
    return "ALREADY_READY";
  }
  const session = await openSession({ origin: workspace.origin, expectedSha: env.EXPECTED_SELFSERVE_SHA,
    email: env.SELFSERVE_VALIDATION_EMAIL, password: env.SELFSERVE_VALIDATION_PASSWORD, fetchImpl });
  try {
    const local = (path, body) => request(workspace.origin + path, { cookie: session.cookie }, body);
    const existing = await local(credentialsPath);
    check(Array.isArray(existing.credentials) && !existing.credentials.some(row => row.isActive && row.label === label),
      "EXISTING_DIAGNOSTIC_CREDENTIAL_REQUIRES_RECONCILIATION");
    check(!(await host()).hasSupportCredential, "HOST_ALREADY_CONFIGURED");
    const { token, credential } = await local(credentialsPath, { label, scopes,
      reasonMd: "Authenticate protected releases on the internal selfserve validation workspace.", monthlyBudgetCents: 0 });
    check(credential?.id && credential.label === label && credential.isActive === true
      && Array.isArray(credential.scopes) && JSON.stringify([...credential.scopes].sort()) === JSON.stringify(scopes)
      && typeof token === "string" && token.length > 0, "ISSUANCE_REQUIRES_RECONCILIATION");
    // Keep an issued credential recoverable after an ambiguous registration response.
    // A retry checks the host first and never issues a second active credential with this label.
    await request(ops + hostPath + "/support-connector", { authorization }, { supportBaseUrl: workspace.origin,
      supportMcpUrl: workspace.origin + "/api/mcp", supportCredentialLabel: label, supportCredential: token });
    check((await host()).hasSupportCredential, "REGISTRATION_UNVERIFIED");
    await verify();
    return "READY";
  } finally { await session.close(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(await configureReleaseConnector(process.env)); }
  catch (error) {
    console.error(/^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "CONNECTOR_RECONCILIATION_REQUIRED");
    process.exitCode = 1;
  }
}
