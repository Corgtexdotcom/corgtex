import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIXED,
  Pr976ActionGoalProductionSmoke,
  healthBlocker,
  sanitize,
  selectExactWorkspace,
  validateChangedFiles,
  validateCredentials,
  validateWorkflowEnvironment,
} from "./pr976-action-goal-production-smoke.mjs";

function env(overrides = {}) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: "Corgtexdotcom/corgtex",
    GITHUB_TOKEN: "fixture-github-token",
    PR976_SMOKE_BASE_URL: FIXED.baseUrl,
    PR976_SMOKE_WORKSPACE_SLUG: FIXED.workspaceSlug,
    PR976_SMOKE_EXPECTED_GIT_SHA: FIXED.expectedGitSha,
    PR976_SMOKE_PR_NUMBER: FIXED.prNumber,
    PR976_SMOKE_CONFIRMATION: FIXED.confirmation,
    PR976_SMOKE_ADMIN_EMAIL: "admin@example.test",
    PR976_SMOKE_ADMIN_PASSWORD: "fixture-password",
    ...overrides,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function textResponse(text, init = {}) {
  return new Response(text, { status: init.status ?? 200, headers: init.headers ?? {} });
}

function toolResult(payload) {
  return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function createMockFetch({ failAt = null } = {}) {
  const calls = [];
  const state = {
    action: null,
    goal: null,
    credential: null,
    marker: null,
  };
  const ids = {
    workspace: "11111111-1111-4111-8111-111111111111",
    credential: "22222222-2222-4222-8222-222222222222",
    action: "33333333-3333-4333-8333-333333333333",
    goal: "44444444-4444-4444-8444-444444444444",
  };
  const release = {
    gitSha: FIXED.expectedGitSha,
    configuredGitSha: FIXED.expectedGitSha,
    imageTag: `sha-${FIXED.expectedGitSha}`,
    version: `main-${FIXED.expectedGitSha.slice(0, 12)}`,
    drift: { gitSha: false, imageTag: false, version: false },
  };

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: parsed.host, path: parsed.pathname + parsed.search, method: init.method ?? "GET", body, headers: init.headers });
    if (parsed.host === "api.github.com") {
      if (failAt === "previous-dispatch") return jsonResponse({ workflow_runs: [{ id: 122, status: "completed", conclusion: "failure" }] });
      return jsonResponse({ workflow_runs: [{ id: 123, status: "in_progress", conclusion: null }] });
    }
    if (parsed.pathname === "/api/health") {
      if (failAt === "nested-health-drift") return jsonResponse({ release: { ...release, drift: { gitSha: true, imageTag: false, version: false } } });
      if (failAt === "post-health" && state.credential) return jsonResponse({ release: { ...release, gitSha: "bad" } });
      return jsonResponse({ release });
    }
    if (parsed.pathname === "/api/auth/login") return textResponse("ok", { headers: { "set-cookie": "corgtex-session=fixture; Path=/; HttpOnly" } });
    if (parsed.pathname === "/api/session") return jsonResponse({ workspaces: [{ id: ids.workspace, slug: FIXED.workspaceSlug, privateName: "not emitted" }] });
    if (parsed.pathname === `/api/workspaces/${ids.workspace}/agent-credentials` && init.method === "POST") {
      state.credential = { id: ids.credential, token: "fixture-token", revoked: false };
      if (failAt === "credential-token-missing") return jsonResponse({ credential: { id: ids.credential }, token: "" }, { status: 201 });
      return jsonResponse({ credential: { id: ids.credential }, token: "fixture-token" }, { status: 201 });
    }
    if (parsed.pathname === `/api/workspaces/${ids.workspace}/agent-credentials/${ids.credential}/revoke`) {
      if (failAt === "revoke" || failAt === "all-cleanups") return jsonResponse({ code: "FAIL" }, { status: 500 });
      if (failAt === "revoke-mismatch") return jsonResponse({ credential: { id: ids.credential, isActive: true } });
      state.credential.revoked = true;
      return jsonResponse({ credential: { id: ids.credential, isActive: false } });
    }
    if (parsed.pathname === `/api/workspaces/${ids.workspace}/actions` && init.method === "POST") {
      state.marker = body.title.replace(/ action$/, "");
      state.action = {
        id: ids.action,
        workspaceId: failAt === "action-workspace-mismatch" ? "99999999-9999-4999-8999-999999999999" : ids.workspace,
        title: failAt === "action-marker-mismatch" ? "foreign action" : body.title,
        status: failAt === "malformed-action-create" ? "OPEN" : "DRAFT",
        isPrivate: failAt === "action-public" ? false : true,
        version: 1,
        bodyMd: body.bodyMd,
      };
      return jsonResponse({ action: state.action }, { status: 201 });
    }
    if (parsed.pathname.match(/\/actions\/[0-9a-f-]+$/) && init.method === "PATCH") {
      const actionId = parsed.pathname.split("/").at(-1);
      if (actionId !== ids.action) return jsonResponse({ code: "NOT_FOUND" }, { status: 404 });
      if (failAt === "request-timeout" && body.expectedVersion === state.action.version) return waitForAbort(init.signal);
      if (body.expectedVersion !== state.action.version) {
        if (failAt === "wrong-action-409") return jsonResponse({ code: "SOME_OTHER_CONFLICT" }, { status: 409 });
        if (failAt === "action-content-drift") state.action = { ...state.action, bodyMd: body.bodyMd };
        return jsonResponse({ code: "VERSION_CONFLICT" }, { status: 409 });
      }
      state.action = { ...state.action, bodyMd: body.bodyMd, version: state.action.version + 1 };
      return jsonResponse({ action: state.action });
    }
    if (parsed.pathname.match(/\/actions\/[0-9a-f-]+$/) && init.method === "DELETE") {
      const actionId = parsed.pathname.split("/").at(-1);
      if (actionId !== ids.action) return jsonResponse({ code: "NOT_FOUND" }, { status: 404 });
      if (failAt === "action-cleanup" || failAt === "all-cleanups") return jsonResponse({ code: "FAIL" }, { status: 500 });
      if (failAt === "action-cleanup-mismatch") return jsonResponse({ ok: false });
      state.action.archived = true;
      return jsonResponse({ ok: true });
    }
    if (parsed.pathname === `/api/workspaces/${ids.workspace}/work-item-versions`) {
      const entityId = parsed.searchParams.get("entityId");
      if (entityId !== ids.action) return jsonResponse({ code: "NOT_FOUND" }, { status: 404 });
      return jsonResponse({ entityType: "ACTION", entityId, currentVersion: state.action.version, versions: [] });
    }
    if (parsed.pathname === `/workspaces/${ids.workspace}/actions/${ids.action}`) {
      if (["action-workspace-mismatch", "action-public"].includes(failAt)) return textResponse("<main>foreign action</main>");
      return textResponse(`<main>${state.action.title} ${state.action.bodyMd}</main>`);
    }
    if (parsed.pathname === "/api/mcp") {
      const request = body;
      if (request.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} });
      if (request.method === "tools/list") {
        if (failAt === "tool-preflight") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: ["create_goal", "get_goal", "update_goal", "archive_goal"].map((name) => ({ name })) } });
      }
      if (request.method === "tools/call") {
        const { name, arguments: args } = request.params;
        if (name === "get_goal" && args.goalId !== ids.goal) return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: "NOT_FOUND" } }, { status: 404 });
        if (name === "create_goal") {
          assert.equal(args.duplicateResolution, "create_new");
          state.goal = {
            id: ids.goal,
            workspaceId: failAt === "goal-workspace-mismatch" ? "99999999-9999-4999-8999-999999999999" : ids.workspace,
            title: failAt === "goal-marker-mismatch" ? "foreign goal" : args.title,
            status: failAt === "malformed-goal-create" ? "ACTIVE" : "DRAFT",
            version: 1,
            progressPercent: 0,
          };
          return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult(state.goal) });
        }
        if (name === "get_goal") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult(state.goal) });
        if (name === "update_goal") {
          if (args.expectedVersion !== state.goal.version) return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult({ status: "VERSION_CONFLICT" }) });
          state.goal = { ...state.goal, progressPercent: args.progressPercent, version: state.goal.version + 1 };
          return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult({ id: ids.goal, version: state.goal.version }) });
        }
        if (name === "archive_goal") {
          if (failAt === "goal-cleanup" || failAt === "all-cleanups") return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: "FAIL" } }, { status: 500 });
          if (failAt === "goal-cleanup-mismatch") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult({ id: ids.goal, archived: false }) });
          state.goal.archived = true;
          return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult({ id: ids.goal, archived: true }) });
        }
      }
    }
    throw new Error(`Unhandled request ${init.method ?? "GET"} ${parsed.href}`);
  }
  return { fetchImpl, calls, state, ids };
}

async function runSmoke(options = {}, overrides = {}) {
  process.exitCode = undefined;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pr976-smoke-"));
  const mock = createMockFetch(options);
  const smoke = new Pr976ActionGoalProductionSmoke({
    env: env({ PR976_SMOKE_OUT_DIR: tmp, ...overrides.env }),
    fetchImpl: mock.fetchImpl,
    execFile: (cmd, args) => args[0] === "merge-base" ? "" : FIXED.allowedChangedFiles.join("\n"),
    outDir: tmp,
    runId: "run-ok",
    totalMs: overrides.totalMs ?? 10_000,
    requestMs: overrides.requestMs ?? 500,
    cleanupReserveMs: overrides.cleanupReserveMs ?? 1_000,
    cleanupRequestMs: overrides.cleanupRequestMs ?? 500,
  });
  const evidence = await smoke.run();
  process.exitCode = undefined;
  return { evidence, mock, tmp };
}

test("workflow policy is dispatch-only, fixed-target, environment-gated, and artifact-producing", async () => {
  const workflow = await readFile(new URL("../workflows/pr976-action-goal-production-smoke.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  for (const forbidden of ["schedule:", "workflow_run:", "pull_request:", "push:", "repository_dispatch:", "workflow_call:"]) {
    assert.doesNotMatch(workflow, new RegExp(`\\b${forbidden}`));
  }
  assert.match(workflow, /fleet-release-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permissions:\n  actions: read\n  contents: read/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, new RegExp(FIXED.baseUrl.replaceAll(".", "\\.")));
  assert.match(workflow, new RegExp(FIXED.workspaceSlug));
  assert.match(workflow, new RegExp(FIXED.expectedGitSha));
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /node .*PASSWORD|node .*EMAIL/);
});

test("input, rerun, run-history, and exact changed-file guards fail closed before creates", async () => {
  assert.doesNotThrow(() => validateWorkflowEnvironment(env()));
  assert.throws(() => validateWorkflowEnvironment(env({ GITHUB_RUN_ATTEMPT: "2" })), /RERUN_NOT_AUTHORIZED/);
  assert.throws(() => validateWorkflowEnvironment(env({ GITHUB_ACTIONS: "true", GITHUB_TOKEN: "" })), /GITHUB_RUN_HISTORY_UNAVAILABLE/);
  assert.throws(() => validateWorkflowEnvironment(env({ GITHUB_EVENT_NAME: "push" })), /EVENT_NOT_WORKFLOW_DISPATCH/);
  assert.throws(() => validateWorkflowEnvironment(env({ GITHUB_REF: "refs/heads/feature" })), /REF_NOT_MAIN/);
  assert.throws(() => validateWorkflowEnvironment(env({ PR976_SMOKE_CONFIRMATION: "" })), /CONFIRMATION_MISSING/);
  assert.throws(() => validateCredentials(env({ PR976_SMOKE_ADMIN_PASSWORD: "" })), /Credential references were empty/);
  assert.throws(() => validateChangedFiles({ execFile: (cmd, args) => args[0] === "merge-base" ? "" : `${FIXED.allowedChangedFiles[0]}\n` }), /CHANGED_FILE_SET_MISMATCH/);
  assert.throws(() => validateChangedFiles({ execFile: (cmd, args) => args[0] === "merge-base" ? "" : `${FIXED.allowedChangedFiles.join("\n")}\napps/web/app/page.tsx\n` }), /CHANGED_FILE_SET_MISMATCH/);

  const { evidence, mock } = await runSmoke({ failAt: "previous-dispatch" });
  assert.equal(evidence.blockerCode, "PREVIOUS_DISPATCH_ATTEMPT_EXISTS");
  assert.equal(mock.calls.some((call) => call.path.endsWith("/actions") && call.method === "POST"), false);
});

test("health, workspace, and redaction helpers cover nested release schema", () => {
  const release = { gitSha: FIXED.expectedGitSha, imageTag: `sha-${FIXED.expectedGitSha}`, version: `main-${FIXED.expectedGitSha.slice(0, 12)}`, drift: { gitSha: false, imageTag: false, version: false } };
  assert.equal(healthBlocker({ release }), null);
  assert.equal(healthBlocker({ release: { ...release, drift: { gitSha: true, imageTag: false, version: false } } }), "RELEASE_DRIFT");
  assert.equal(healthBlocker({ release: { ...release, imageTag: "sha-bad" } }), "RELEASE_IMAGE_TAG_MISMATCH");
  assert.equal(healthBlocker({ release: { ...release, version: "main-bad" } }), "RELEASE_VERSION_MISMATCH");
  assert.equal(healthBlocker({ release: { gitSha: FIXED.expectedGitSha } }), "RELEASE_IMAGE_TAG_MISSING");
  assert.equal(selectExactWorkspace([{ id: "11111111-1111-4111-8111-111111111111", slug: FIXED.workspaceSlug }]).slug, FIXED.workspaceSlug);
  assert.throws(() => selectExactWorkspace([{ id: "11111111-1111-4111-8111-111111111111", slug: FIXED.workspaceSlug }, { id: "22222222-2222-4222-8222-222222222222", slug: FIXED.workspaceSlug }]), /WORKSPACE_SELECTION_FAILED/);
  const redacted = sanitize("admin@example.test password=fixture-password token=fixture-token bearer abc.def cookie=session");
  assert.doesNotMatch(redacted, /admin@example|fixture-password|fixture-token|abc\.def|session/);
});

test("happy path performs exact edits, stale no-effect probes, readbacks, and reverse cleanup", async () => {
  const { evidence, mock, tmp } = await runSmoke();
  assert.equal(evidence.status, "pass");
  assert.deepEqual(evidence.successfulEdits, { actionContent: 1, goalProgress: 1 });
  assert.deepEqual(evidence.staleNoEffect, { action: true, goal: true });
  assert.equal(evidence.actionVersions.edited, evidence.actionVersions.observed + 1);
  assert.equal(evidence.goalVersions.edited, evidence.goalVersions.observed + 1);
  assert.equal(mock.calls.filter((call) => call.path.endsWith(`/actions/${evidence.actionId}`) && call.method === "PATCH" && call.body?.bodyMd === "Temporary PR 976 validation content edit.").length, 1);
  assert.equal(mock.calls.filter((call) => call.path === "/api/mcp" && call.body?.params?.name === "update_goal" && call.body?.params?.arguments?.progressPercent === 37).length, 1);
  assert.equal(mock.calls.filter((call) => call.path === "/api/mcp" && call.body?.params?.name === "update_goal" && call.body?.params?.arguments?.progressPercent === 91).length, 1);
  assert.deepEqual(evidence.cleanup.map((item) => item.type), ["Goal", "Action", "credential"]);
  const artifact = await readFile(path.join(tmp, "evidence.json"), "utf8");
  assert.doesNotMatch(artifact, /fixture-password|fixture-token|admin@example|Temporary PR 976 validation content edit|PROD-VERIFY/);
});

test("preflight failures create zero Action/Goal records", async () => {
  for (const failAt of ["nested-health-drift", "tool-preflight"]) {
    const { evidence, mock } = await runSmoke({ failAt });
    assert.equal(evidence.status, "fail");
    assert.equal(mock.calls.some((call) => call.path.endsWith("/actions") && call.method === "POST"), false);
    assert.equal(mock.calls.some((call) => call.path === "/api/mcp" && call.body?.params?.name === "create_goal"), false);
  }
});

test("malformed create and ownership mismatches register cleanup before failing", async () => {
  for (const failAt of ["credential-token-missing", "malformed-action-create", "action-marker-mismatch", "action-workspace-mismatch", "action-public", "malformed-goal-create", "goal-marker-mismatch", "goal-workspace-mismatch"]) {
    const { evidence, mock } = await runSmoke({ failAt });
    assert.equal(evidence.status, "fail");
    if (failAt !== "credential-token-missing") assert.equal(mock.state.credential.revoked, true);
    if (["malformed-action-create"].includes(failAt)) assert.equal(mock.state.action.archived, true);
    if (["action-marker-mismatch", "action-workspace-mismatch", "action-public"].includes(failAt)) assert.notEqual(mock.state.action.archived, true);
    if (["malformed-goal-create"].includes(failAt)) assert.equal(mock.state.goal?.archived, true);
    if (["goal-marker-mismatch", "goal-workspace-mismatch"].includes(failAt)) assert.notEqual(mock.state.goal?.archived, true);
  }
});

test("Action stale proof requires exact VERSION_CONFLICT and unchanged content", async () => {
  for (const failAt of ["wrong-action-409", "action-content-drift"]) {
    const { evidence, mock } = await runSmoke({ failAt });
    assert.equal(evidence.status, "fail");
    assert.equal(evidence.staleNoEffect.action, false);
    assert.equal(mock.state.credential.revoked, true);
  }
});

test("cleanup attempts every later exact cleanup and aggregates sanitized failures", async () => {
  for (const failAt of ["goal-cleanup", "action-cleanup", "revoke", "all-cleanups"]) {
    const { evidence } = await runSmoke({ failAt });
    assert.equal(evidence.status, "fail");
    assert.deepEqual(evidence.cleanup.map((item) => item.type), ["Goal", "Action", "credential"]);
    assert.equal(evidence.cleanupFailures.length, failAt === "all-cleanups" ? 3 : 1);
    assert.ok(evidence.blockerCode);
  }
});

test("cleanup response mismatches and post-health failure fail final evidence", async () => {
  for (const failAt of ["goal-cleanup-mismatch", "action-cleanup-mismatch", "revoke-mismatch", "post-health"]) {
    const { evidence } = await runSmoke({ failAt });
    assert.equal(evidence.status, "fail");
    assert.ok(evidence.blockerCode);
  }
});

test("request deadline exhaustion still runs cleanup for created production artifacts", async () => {
  const { evidence, mock } = await runSmoke({ failAt: "request-timeout" }, { totalMs: 2_000, requestMs: 10, cleanupReserveMs: 200, cleanupRequestMs: 200 });
  assert.equal(evidence.status, "fail");
  assert.equal(evidence.blockerCode, "REQUEST_TIMEOUT");
  assert.deepEqual(evidence.cleanup.map((item) => item.type), ["Goal", "Action", "credential"]);
  assert.equal(mock.state.goal.archived, true);
  assert.equal(mock.state.action.archived, true);
  assert.equal(mock.state.credential.revoked, true);
});
