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
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: "123",
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

function createMockFetch({ failAt = null, missingCredentials = false } = {}) {
  const calls = [];
  const state = {
    action: null,
    goal: null,
    credential: null,
  };
  const ids = {
    workspace: "11111111-1111-4111-8111-111111111111",
    credential: "22222222-2222-4222-8222-222222222222",
    action: "33333333-3333-4333-8333-333333333333",
    goal: "44444444-4444-4444-8444-444444444444",
  };
  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: parsed.pathname + parsed.search, method: init.method ?? "GET", body, headers: init.headers });
    if (failAt === "pre-health" && parsed.pathname === "/api/health" && !state.credential) {
      return jsonResponse({ release: { gitSha: "bad" } });
    }
    if (parsed.pathname === "/api/health") {
      return jsonResponse({ release: { gitSha: FIXED.expectedGitSha, configuredGitSha: FIXED.expectedGitSha, drift: false } });
    }
    if (parsed.pathname === "/api/auth/login") {
      if (missingCredentials) return textResponse("no", { status: 401 });
      return textResponse("ok", { headers: { "set-cookie": "corgtex-session=fixture; Path=/; HttpOnly" } });
    }
    if (parsed.pathname === "/api/session") {
      return jsonResponse({ workspaces: [{ id: ids.workspace, slug: FIXED.workspaceSlug, privateName: "not emitted" }] });
    }
    if (parsed.pathname === `/api/workspaces/${ids.workspace}/agent-credentials` && init.method === "POST") {
      if (failAt === "credential") return jsonResponse({ code: "FAIL" }, { status: 500 });
      state.credential = { id: ids.credential, token: "fixture-token" };
      return jsonResponse({ credential: { id: ids.credential }, token: "fixture-token" }, { status: 201 });
    }
    if (parsed.pathname === `/api/workspaces/${ids.workspace}/agent-credentials/${ids.credential}/revoke`) {
      if (failAt === "revoke") return jsonResponse({ code: "FAIL" }, { status: 500 });
      return jsonResponse({ credential: { id: ids.credential, isActive: false } });
    }
    if (parsed.pathname.match(/\/actions\/[0-9a-f-]+$/) && init.method === "PATCH") {
      const actionId = parsed.pathname.split("/").at(-1);
      if (actionId !== ids.action) return jsonResponse({ code: "NOT_FOUND" }, { status: 404 });
      if (body.expectedVersion !== state.action.version) return jsonResponse({ code: "VERSION_CONFLICT" }, { status: 409 });
      if (failAt === "action-edit") return jsonResponse({ code: "FAIL" }, { status: 500 });
      state.action = { ...state.action, bodyMd: body.bodyMd, version: state.action.version + 1 };
      return jsonResponse({ action: state.action });
    }
    if (parsed.pathname.match(/\/actions\/[0-9a-f-]+$/) && init.method === "DELETE") {
      const actionId = parsed.pathname.split("/").at(-1);
      if (actionId !== ids.action) return jsonResponse({ code: "NOT_FOUND" }, { status: 404 });
      if (failAt === "action-cleanup") return jsonResponse({ code: "FAIL" }, { status: 500 });
      state.action.archived = true;
      return jsonResponse({ ok: true });
    }
    if (parsed.pathname === `/api/workspaces/${ids.workspace}/work-item-versions`) {
      const entityId = parsed.searchParams.get("entityId");
      if (entityId !== ids.action) return jsonResponse({ code: "NOT_FOUND" }, { status: 404 });
      return jsonResponse({ entityType: "ACTION", entityId, currentVersion: state.action.version, versions: [] });
    }
    if (parsed.pathname === `/api/workspaces/${ids.workspace}/actions` && init.method === "POST") {
      if (failAt === "action-create") return jsonResponse({ code: "FAIL" }, { status: 500 });
      state.action = { id: ids.action, status: "DRAFT", version: 1, bodyMd: body.bodyMd };
      return jsonResponse({ action: state.action }, { status: 201 });
    }
    if (parsed.pathname === "/api/mcp") {
      const request = body;
      if (request.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} });
      if (request.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: ["create_goal", "get_goal", "update_goal", "archive_goal"].map((name) => ({ name })) } });
      }
      if (request.method === "tools/call") {
        const { name, arguments: args } = request.params;
        if (name === "get_goal" && args.goalId !== ids.goal) {
          return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: "NOT_FOUND" } }, { status: 404 });
        }
        if (name === "create_goal") {
          if (failAt === "goal-create") return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: "FAIL" } }, { status: 500 });
          assert.equal(args.duplicateResolution, "create_new");
          state.goal = { id: ids.goal, status: "DRAFT", version: 1, progressPercent: 0 };
          return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult(state.goal) });
        }
        if (name === "get_goal") {
          return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult(state.goal) });
        }
        if (name === "update_goal") {
          if (args.expectedVersion !== state.goal.version) {
            return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult({ status: "VERSION_CONFLICT" }) });
          }
          if (failAt === "goal-edit") return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: "FAIL" } }, { status: 500 });
          state.goal = { ...state.goal, progressPercent: args.progressPercent, version: state.goal.version + 1 };
          return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult({ id: ids.goal, version: state.goal.version }) });
        }
        if (name === "archive_goal") {
          if (failAt === "goal-cleanup") return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: "FAIL" } }, { status: 500 });
          state.goal.archived = true;
          return jsonResponse({ jsonrpc: "2.0", id: request.id, result: toolResult({ id: ids.goal, archived: true }) });
        }
      }
    }
    throw new Error(`Unhandled request ${init.method ?? "GET"} ${parsed.pathname}`);
  }
  return { fetchImpl, calls, state };
}

test("workflow policy is dispatch-only, fixed-target, environment-gated, and artifact-producing", async () => {
  const workflow = await readFile(new URL("../workflows/pr976-action-goal-production-smoke.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  for (const forbidden of ["schedule:", "workflow_run:", "pull_request:", "push:", "repository_dispatch:", "workflow_call:"]) {
    assert.doesNotMatch(workflow, new RegExp(`\\b${forbidden}`));
  }
  assert.match(workflow, /fleet-release-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, new RegExp(FIXED.baseUrl.replaceAll(".", "\\.")));
  assert.match(workflow, new RegExp(FIXED.workspaceSlug));
  assert.match(workflow, new RegExp(FIXED.expectedGitSha));
  assert.match(workflow, /PRODUCTION_VALIDATION_ADMIN_EMAIL/);
  assert.match(workflow, /PRODUCTION_VALIDATION_ADMIN_PASSWORD/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /node .*PASSWORD|node .*EMAIL/);
});

test("input and repository guards reject non-dispatch, wrong target, and unrelated files", () => {
  assert.doesNotThrow(() => validateWorkflowEnvironment(env()));
  assert.throws(() => validateWorkflowEnvironment(env({ GITHUB_EVENT_NAME: "push" })), /EVENT_NOT_WORKFLOW_DISPATCH/);
  assert.throws(() => validateWorkflowEnvironment(env({ GITHUB_REF: "refs/heads/feature" })), /REF_NOT_MAIN/);
  assert.throws(() => validateWorkflowEnvironment(env({ PR976_SMOKE_BASE_URL: "https://example.test" })), /BASE_URL_NOT_FIXED/);
  assert.throws(() => validateWorkflowEnvironment(env({ PR976_SMOKE_CONFIRMATION: "" })), /CONFIRMATION_MISSING/);
  assert.throws(() => validateCredentials(env({ PR976_SMOKE_ADMIN_PASSWORD: "" })), /Credential references were empty/);
  const execFile = (cmd, args) => {
    assert.equal(cmd, "git");
    if (args[0] === "merge-base") return "";
    return `${FIXED.allowedChangedFiles[0]}\napps/web/app/page.tsx\n`;
  };
  assert.throws(() => validateChangedFiles({ execFile }), /CHANGED_FILE_ALLOWLIST_VIOLATION/);
});

test("health, workspace, and redaction helpers fail closed without exposing private values", () => {
  assert.equal(healthBlocker({ release: { gitSha: FIXED.expectedGitSha, configuredGitSha: FIXED.expectedGitSha, drift: false } }), null);
  assert.equal(healthBlocker({ release: { gitSha: "bad" } }), "RELEASE_SHA_MISMATCH");
  assert.equal(selectExactWorkspace([{ id: "11111111-1111-4111-8111-111111111111", slug: FIXED.workspaceSlug }]).slug, FIXED.workspaceSlug);
  assert.throws(() => selectExactWorkspace([{ id: "11111111-1111-4111-8111-111111111111", slug: FIXED.workspaceSlug }, { id: "22222222-2222-4222-8222-222222222222", slug: FIXED.workspaceSlug }]), /WORKSPACE_SELECTION_FAILED/);
  const redacted = sanitize("admin@example.test password=fixture-password token=fixture-token bearer abc.def cookie=session");
  assert.doesNotMatch(redacted, /admin@example|fixture-password|fixture-token|abc\.def|session/);
});

test("happy path performs one Action edit, one Goal progress edit, stale no-effect probes, and reverse cleanup", async () => {
  process.exitCode = undefined;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pr976-smoke-"));
  const mock = createMockFetch();
  const smoke = new Pr976ActionGoalProductionSmoke({
    env: env({ PR976_SMOKE_OUT_DIR: tmp }),
    fetchImpl: mock.fetchImpl,
    execFile: (cmd, args) => args[0] === "merge-base" ? "" : FIXED.allowedChangedFiles.join("\n"),
    outDir: tmp,
    runId: "run-ok",
  });
  const evidence = await smoke.run();
  assert.equal(process.exitCode, undefined);
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

test("credential absence and pre-health drift stop before any Action or Goal create", async () => {
  for (const [name, options, overrides] of [
    ["missing credentials", {}, { PR976_SMOKE_ADMIN_PASSWORD: "" }],
    ["pre-health drift", { failAt: "pre-health" }, {}],
  ]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), `pr976-${name.replaceAll(" ", "-")}-`));
    const mock = createMockFetch(options);
    const smoke = new Pr976ActionGoalProductionSmoke({
      env: env({ ...overrides, PR976_SMOKE_OUT_DIR: tmp }),
      fetchImpl: mock.fetchImpl,
      execFile: (cmd, args) => args[0] === "merge-base" ? "" : FIXED.allowedChangedFiles.join("\n"),
      outDir: tmp,
      runId: name,
    });
    const evidence = await smoke.run();
    assert.equal(evidence.status, "fail");
    assert.equal(mock.calls.some((call) => call.path.endsWith("/actions") && call.method === "POST"), false);
    assert.equal(mock.calls.some((call) => call.path === "/api/mcp" && call.body?.params?.name === "create_goal"), false);
    process.exitCode = undefined;
  }
});

test("partial creation still attempts exact reverse cleanup and fails on ambiguous cleanup", async () => {
  process.exitCode = undefined;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pr976-cleanup-"));
  const mock = createMockFetch({ failAt: "goal-edit" });
  const smoke = new Pr976ActionGoalProductionSmoke({
    env: env({ PR976_SMOKE_OUT_DIR: tmp }),
    fetchImpl: mock.fetchImpl,
    execFile: (cmd, args) => args[0] === "merge-base" ? "" : FIXED.allowedChangedFiles.join("\n"),
    outDir: tmp,
    runId: "partial",
  });
  const evidence = await smoke.run();
  assert.equal(evidence.status, "fail");
  assert.deepEqual(evidence.cleanup.map((item) => item.type), ["Goal", "Action", "credential"]);
  assert.equal(mock.state.action.archived, true);
  assert.equal(mock.state.goal.archived, true);
  process.exitCode = undefined;

  const revokeTmp = await mkdtemp(path.join(os.tmpdir(), "pr976-revoke-"));
  const revokeMock = createMockFetch({ failAt: "revoke" });
  const revokeSmoke = new Pr976ActionGoalProductionSmoke({
    env: env({ PR976_SMOKE_OUT_DIR: revokeTmp }),
    fetchImpl: revokeMock.fetchImpl,
    execFile: (cmd, args) => args[0] === "merge-base" ? "" : FIXED.allowedChangedFiles.join("\n"),
    outDir: revokeTmp,
    runId: "revoke-fail",
  });
  const revokeEvidence = await revokeSmoke.run();
  assert.equal(revokeEvidence.status, "fail");
  assert.equal(revokeEvidence.credentialRevoke, "failed");
  process.exitCode = undefined;
});
