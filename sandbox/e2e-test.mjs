/**
 * Comprehensive E2E Backend Tests for Corgtex Production
 * Tests: health, public endpoints, auth, agent API, workspace-scoped CRUD
 */

const API_KEY = "02a5c04359516882b0d24e854b44b204f124bb28d1d3c1cc84b815b59e732b2d";
const BASE_URL = "https://corgtexweb-production.up.railway.app";
const AGENT_HEADERS = { Authorization: `Bearer agent-${API_KEY}` };

const results = [];

async function test(name, method, path, { body, headers, expect: expectStatus } = {}) {
  const url = `${BASE_URL}${path}`;
  const opts = { method, headers: { ...headers } };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const label = `${method} ${path}`;
  process.stdout.write(`  [${name}] ${label} ... `);

  try {
    const res = await fetch(url, opts);
    let data;
    try { data = await res.json(); } catch { data = await res.text(); }

    const pass = expectStatus ? res.status === expectStatus : res.ok;
    const icon = pass ? "✅" : "❌";
    console.log(`${icon} ${res.status}`);
    if (!pass) console.log(`    Response:`, JSON.stringify(data).slice(0, 200));
    results.push({ name, pass, status: res.status, data });
    return { ok: pass, status: res.status, data };
  } catch (err) {
    console.log(`❌ NETWORK: ${err.message}`);
    results.push({ name, pass: false, status: 0, error: err.message });
    return { ok: false, status: 0, error: err.message };
  }
}

async function run() {
  console.log(`\n🔬 Corgtex Production E2E Tests`);
  console.log(`   Target: ${BASE_URL}\n`);

  // ═══════════════════════════════════════════
  // 1. INFRASTRUCTURE
  // ═══════════════════════════════════════════
  console.log("─── 1. Infrastructure ───");
  await test("health", "GET", "/api/health");

  // ═══════════════════════════════════════════
  // 2. PUBLIC ENDPOINTS (no auth)
  // ═══════════════════════════════════════════
  console.log("\n─── 2. Public Endpoints ───");
  await test("demo-leads", "POST", "/api/demo-leads", {
    body: { email: "e2e-smoke@corgtex.app" },
  });
  await test("demo-leads-invalid", "POST", "/api/demo-leads", {
    body: { email: "not-an-email" },
    expect: 400,
  });

  // ═══════════════════════════════════════════
  // 3. AUTH VALIDATION
  // ═══════════════════════════════════════════
  console.log("\n─── 3. Auth Validation ───");
  // Unauthenticated → 401
  await test("unauth-workspaces", "GET", "/api/workspaces", { expect: 401 });
  await test("unauth-session", "GET", "/api/session", { expect: 401 });
  // Bad bearer → 401
  await test("bad-bearer", "GET", "/api/workspaces", {
    headers: { Authorization: "Bearer agent-wrong-key" },
    expect: 401,
  });
  // Login validation
  await test("login-missing-pw", "POST", "/api/auth/login", {
    body: { email: "x@y.com" },
    expect: 400,
  });
  await test("login-bad-creds", "POST", "/api/auth/login", {
    body: { email: "nonexistent@test.com", password: "wrongpassword123" },
    expect: 401,
  });

  // ═══════════════════════════════════════════
  // 4. AGENT API (bootstrap token)
  // ═══════════════════════════════════════════
  console.log("\n─── 4. Agent API ───");

  // Session endpoint (should work for agents too)
  const sessionRes = await test("agent-session", "GET", "/api/session", {
    headers: AGENT_HEADERS,
  });

  // List workspaces
  const wsRes = await test("agent-list-workspaces", "GET", "/api/workspaces", {
    headers: AGENT_HEADERS,
  });

  // If we got workspaces, test workspace-scoped routes
  let workspaceId = null;
  if (wsRes.ok && wsRes.data?.workspaces?.length > 0) {
    workspaceId = wsRes.data.workspaces[0].id;
    console.log(`\n   📂 Using workspace: ${wsRes.data.workspaces[0].name} (${workspaceId})`);
  } else {
    // Fallback: use the known workspace ID from the browser
    workspaceId = "c83ecae6-266e-4872-8b5a-411843421307";
    console.log(`\n   📂 Falling back to known workspace: ${workspaceId}`);
  }

  // ═══════════════════════════════════════════
  // 5. WORKSPACE-SCOPED READS (Agent)
  // ═══════════════════════════════════════════
  console.log("\n─── 5. Workspace-Scoped Reads ───");
  const wsPath = `/api/workspaces/${workspaceId}`;

  await test("proposals-list", "GET", `${wsPath}/proposals`, { headers: AGENT_HEADERS });
  await test("tensions-list", "GET", `${wsPath}/tensions`, { headers: AGENT_HEADERS });
  await test("actions-list", "GET", `${wsPath}/actions`, { headers: AGENT_HEADERS });
  await test("members-list", "GET", `${wsPath}/members`, { headers: AGENT_HEADERS });
  await test("circles-list", "GET", `${wsPath}/circles`, { headers: AGENT_HEADERS });
  await test("meetings-list", "GET", `${wsPath}/meetings`, { headers: AGENT_HEADERS });
  await test("cycles-list", "GET", `${wsPath}/cycles`, { headers: AGENT_HEADERS });
  await test("roles-list", "GET", `${wsPath}/roles`, { headers: AGENT_HEADERS });
  await test("ledger-list", "GET", `${wsPath}/ledger-accounts`, { headers: AGENT_HEADERS });
  await test("spends-list", "GET", `${wsPath}/spends`, { headers: AGENT_HEADERS });
  await test("events-list", "GET", `${wsPath}/events`, { headers: AGENT_HEADERS });
  await test("documents-list", "GET", `${wsPath}/documents`, { headers: AGENT_HEADERS });
  await test("check-ins-list", "GET", `${wsPath}/check-ins`, { headers: AGENT_HEADERS });

  // ═══════════════════════════════════════════
  // 6. WORKSPACE-SCOPED WRITES (Agent)
  // ═══════════════════════════════════════════
  console.log("\n─── 6. Workspace-Scoped Writes ───");

  // Create a tension
  const tensionRes = await test("tension-create", "POST", `${wsPath}/tensions`, {
    headers: AGENT_HEADERS,
    body: { title: "[E2E] Smoke test tension", bodyMd: "Created by automated E2E test — safe to delete." },
  });

  // Create an action
  const actionRes = await test("action-create", "POST", `${wsPath}/actions`, {
    headers: AGENT_HEADERS,
    body: { title: "[E2E] Smoke test action" },
  });

  // Create a proposal
  const proposalRes = await test("proposal-create", "POST", `${wsPath}/proposals`, {
    headers: AGENT_HEADERS,
    body: { title: "[E2E] Smoke test proposal", bodyMd: "Created by automated E2E test — safe to delete." },
  });

  // ═══════════════════════════════════════════
  // 7. INVALID WORKSPACE (Agent)
  // ═══════════════════════════════════════════
  console.log("\n─── 7. Invalid Workspace ───");
  await test("bad-workspace", "GET", `/api/workspaces/00000000-0000-0000-0000-000000000000/proposals`, {
    headers: AGENT_HEADERS,
    expect: 403,
  });

  // ═══════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════
  console.log("\n══════════════════════════════════");
  console.log("         RESULTS SUMMARY");
  console.log("══════════════════════════════════");

  const passed = results.filter(r => r.pass);
  const failed = results.filter(r => !r.pass);

  for (const r of results) {
    console.log(`  ${r.pass ? "✅" : "❌"} ${r.name} (${r.status})`);
  }

  console.log(`\n  Total: ${results.length} | ✅ ${passed.length} | ❌ ${failed.length}`);

  if (failed.length > 0) {
    console.log("\n  FAILED TESTS:");
    for (const f of failed) {
      console.log(`    ❌ ${f.name}: ${f.status} ${f.error || ""}`);
    }
    process.exit(1);
  } else {
    console.log("\n  🎉 All tests passed!");
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
