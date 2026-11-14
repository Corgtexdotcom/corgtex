import assert from "node:assert/strict";
import test from "node:test";
import { configureReleaseConnector } from "./configure-selfserve-release-connector.mjs";
import { SELFSERVE_VALIDATION_TARGET as workspace } from "../lib/selfserve-validation-target.mjs";
import { SELFSERVE_RELEASE_HOST_ID as hostId } from "./managed-azure-selfserve-profile.mjs";

function fixture() {
  const state = { configured: false, issued: [], closed: 0, ambiguous: false, workspaceId: workspace.workspaceId };
  const env = { CONTROL_PLANE_AGENT_API_KEY: "ops-fixture", EXPECTED_SELFSERVE_SHA: "a".repeat(40) };
  const openSession = async () => ({ cookie: "session=fixture", close: async () => { state.closed++; } });
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, "error");
    const { origin, pathname } = new URL(url);
    const body = init.body && JSON.parse(init.body);
    if (origin === workspace.origin) {
      assert.equal(init.headers.authorization, undefined);
      if (pathname === "/api/health") {
        assert.equal(init.headers.cookie, undefined);
        const gitSha = state.servingSha || env.EXPECTED_SELFSERVE_SHA;
        return Response.json({ status: "ok", database: "up", schema: "ready",
          release: { gitSha, runtime: { gitSha, evidence: "baked" } } });
      }
      assert.equal(init.headers.cookie, "session=fixture");
      assert.equal(pathname, `/api/workspaces/${workspace.workspaceId}/agent-credentials`);
      if (!body) return Response.json({ credentials: state.issued });
      assert.deepEqual(body.scopes, ["runtime:read", "runtime:write", "workspace:read"]);
      const credential = { id: "issued-id", label: body.label, scopes: body.scopes, isActive: true };
      state.issued.push(credential);
      return Response.json({ token: "fixture-one-time", credential });
    }
    assert.equal(origin, "https://ops.corgtex.com");
    assert.equal(init.headers.authorization, "Bearer cp-ops-fixture");
    assert.equal(init.headers.cookie, undefined);
    if (pathname === "/api/control-plane/mcp") {
      assert.deepEqual(body.params, { name: "read_managed_release_auth", arguments: { deploymentId: hostId, mode: "preflight" } });
      return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({
        status: "READY", effects: 0, workspaceId: state.workspaceId,
      }) }] } });
    }
    if (pathname.endsWith("/support-connector")) {
      assert.equal(body.supportCredential, "fixture-one-time");
      if (state.ambiguous) throw Error("connection lost");
      state.configured = true;
    } else assert.equal(pathname, `/api/control-plane/deployments/${hostId}`);
    return Response.json({ deployment: { id: hostId, deploymentKind: "REMOTE_MANAGED", cloudProvider: "AZURE",
      url: workspace.origin, supportMcpUrl: state.supportMcpUrl, hasSupportCredential: state.configured } });
  };
  return { state, run: () => configureReleaseConnector(env, { fetchImpl, openSession }) };
}

test("binds one narrow internal credential and rechecks an already configured host", async () => {
  const { state, run } = fixture();
  assert.equal(await run(), "READY");
  assert.equal(await run(), "ALREADY_READY");
  assert.equal(state.issued.length, 1);
  assert.equal(state.closed, 1);
});
test("an ambiguous registration cannot silently create a second credential", async () => {
  const { state, run } = fixture();
  state.ambiguous = true;
  await assert.rejects(run(), /connection lost/);
  await assert.rejects(run(), /RECONCILIATION/);
  assert.equal(state.issued.length, 1);
  assert.equal(state.closed, 2);
});
test("existing connector for another workspace fails verification", async () => {
  const { state, run } = fixture();
  state.configured = true;
  state.workspaceId = "another";
  await assert.rejects(run(), /DIAGNOSTIC_UNVERIFIED/);
  assert.equal(state.issued.length, 0);
});

test("a stale existing MCP endpoint is rejected before any credential is used", async () => {
  const { state, run } = fixture();
  state.configured = true;
  state.supportMcpUrl = "https://former.example.test/api/mcp";
  await assert.rejects(run(), /CONNECTOR_ENDPOINT_MISMATCH/);
  assert.equal(state.issued.length, 0);
});

test("an existing connector verifies the running release before its diagnostic", async () => {
  const { state, run } = fixture();
  state.configured = true;
  state.servingSha = "b".repeat(40);
  await assert.rejects(run(), /SERVING_RELEASE_MISMATCH/);
});
