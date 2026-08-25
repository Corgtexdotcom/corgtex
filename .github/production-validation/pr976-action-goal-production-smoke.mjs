#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXED = Object.freeze({
  baseUrl: "https://app.corgtex.com",
  workspaceSlug: "corgtex-validation",
  expectedGitSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
  prNumber: "976",
  confirmation: "RUN-PR976-ACTION-GOAL-SMOKE-ONCE",
  allowedChangedFiles: [
    ".github/workflows/pr976-action-goal-production-smoke.yml",
    ".github/production-validation/pr976-action-goal-production-smoke.mjs",
    ".github/production-validation/pr976-action-goal-production-smoke.test.mjs",
  ],
});

const DEFAULT_OUT_DIR = ".artifacts/production-validation/pr976-action-goal-production-smoke";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /password["'\s:=]+[^"',\s]+/gi,
  /token["'\s:=]+[^"',\s]+/gi,
  /cookie["'\s:=]+[^"',\s]+/gi,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
];

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requireEqual(actual, expected, code) {
  if (String(actual ?? "") !== expected) fail(code);
}

function assertPositiveVersion(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function assertUuid(value, code) {
  if (typeof value !== "string" || !UUID_RE.test(value)) fail(code);
  return value;
}

export function sanitize(value) {
  let text = value instanceof Error ? `${value.code ?? "ERROR"} ${value.message}` : String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  return text.slice(0, 180);
}

export function validateWorkflowEnvironment(env) {
  requireEqual(env.GITHUB_EVENT_NAME, "workflow_dispatch", "EVENT_NOT_WORKFLOW_DISPATCH");
  requireEqual(env.GITHUB_REF, "refs/heads/main", "REF_NOT_MAIN");
  requireEqual(env.PR976_SMOKE_BASE_URL, FIXED.baseUrl, "BASE_URL_NOT_FIXED");
  requireEqual(env.PR976_SMOKE_WORKSPACE_SLUG, FIXED.workspaceSlug, "WORKSPACE_NOT_FIXED");
  requireEqual(env.PR976_SMOKE_EXPECTED_GIT_SHA, FIXED.expectedGitSha, "EXPECTED_SHA_NOT_FIXED");
  requireEqual(env.PR976_SMOKE_PR_NUMBER, FIXED.prNumber, "PR_NUMBER_NOT_FIXED");
  requireEqual(env.PR976_SMOKE_CONFIRMATION, FIXED.confirmation, "CONFIRMATION_MISSING");
}

export function validateCredentials(env) {
  if (!env.PR976_SMOKE_ADMIN_EMAIL || !env.PR976_SMOKE_ADMIN_PASSWORD) {
    fail("CREDENTIALS_MISSING", "Credential references were empty.");
  }
}

export function validateChangedFiles({
  targetSha = FIXED.expectedGitSha,
  execFile = execFileSync,
} = {}) {
  try {
    execFile("git", ["merge-base", "--is-ancestor", targetSha, "HEAD"], { stdio: "pipe" });
  } catch {
    fail("TARGET_SHA_NOT_ANCESTOR");
  }
  const output = execFile("git", ["diff", "--name-only", `${targetSha}..HEAD`], { encoding: "utf8" });
  const changed = output.split(/\r?\n/).filter(Boolean).sort();
  const allowed = [...FIXED.allowedChangedFiles].sort();
  const unexpected = changed.filter((file) => !allowed.includes(file));
  if (unexpected.length > 0) fail("CHANGED_FILE_ALLOWLIST_VIOLATION");
  return changed;
}

export function healthBlocker(health, expectedGitSha = FIXED.expectedGitSha) {
  const release = health?.release ?? {};
  if (release.gitSha !== expectedGitSha) return "RELEASE_SHA_MISMATCH";
  if (release.configuredGitSha && release.configuredGitSha !== expectedGitSha) return "CONFIGURED_SHA_MISMATCH";
  if (release.drift === true || release.hasDrift === true) return "RELEASE_DRIFT";
  const drift = health?.drift ?? release.driftDetails;
  if (drift && typeof drift === "object" && Object.values(drift).some(Boolean)) return "RELEASE_DRIFT";
  return null;
}

export function selectExactWorkspace(workspaces, slug = FIXED.workspaceSlug) {
  const matches = Array.isArray(workspaces) ? workspaces.filter((workspace) => workspace?.slug === slug) : [];
  if (matches.length !== 1) fail("WORKSPACE_SELECTION_FAILED");
  return { id: assertUuid(matches[0].id, "WORKSPACE_ID_INVALID"), slug };
}

export function parseToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === "text")?.text;
  if (!text) fail("MCP_RESULT_NOT_JSON");
  return JSON.parse(text);
}

function parseCookie(setCookie) {
  if (!setCookie) fail("SESSION_COOKIE_MISSING");
  return setCookie.split(", ").find((part) => part.includes("corgtex"))?.split(";")[0] ?? setCookie.split(";")[0];
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text: "[non-json]" };
  }
}

function isNotFound(response, body) {
  return response.status === 404 || body?.code === "NOT_FOUND" || body?.error?.code === "NOT_FOUND";
}

function isConflict(response, body) {
  return response.status === 409 || body?.code === "VERSION_CONFLICT" || body?.status === "VERSION_CONFLICT";
}

export class Pr976ActionGoalProductionSmoke {
  constructor({
    env = process.env,
    fetchImpl = globalThis.fetch,
    execFile = execFileSync,
    outDir = env.PR976_SMOKE_OUT_DIR || DEFAULT_OUT_DIR,
    runId = null,
  } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.execFile = execFile;
    this.outDir = path.resolve(outDir);
    this.runId = runId ?? `pr976-${env.GITHUB_RUN_ID ?? "local"}-${randomUUID()}`;
    this.marker = `PROD-VERIFY 2026-08-24 PR-976 ${this.runId}`;
    this.cookie = null;
    this.workspace = null;
    this.credential = null;
    this.rpcId = 0;
    this.created = { action: null, goal: null };
    this.cleanup = [];
    this.evidence = {
      runId: this.runId,
      expectedGitSha: FIXED.expectedGitSha,
      preGitSha: null,
      postGitSha: null,
      preDrift: null,
      postDrift: null,
      workspaceSlug: FIXED.workspaceSlug,
      actionId: null,
      goalId: null,
      actionVersions: {},
      goalVersions: {},
      successfulEdits: { actionContent: 0, goalProgress: 0 },
      staleNoEffect: { action: false, goal: false },
      cleanup: [],
      credentialRevoke: null,
      blockerCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
  }

  recordCleanup(entry) {
    this.cleanup.push(entry);
  }

  async http(pathOrUrl, init = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${FIXED.baseUrl}${pathOrUrl}`;
    const headers = new Headers(init.headers ?? {});
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await this.fetch(url, { ...init, headers });
    const body = await responsePayload(response);
    if (!response.ok) {
      const error = new Error(`${init.method ?? "GET"} ${new URL(url).pathname} failed ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return { response, body };
  }

  async httpAllowFailure(pathOrUrl, init = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${FIXED.baseUrl}${pathOrUrl}`;
    const headers = new Headers(init.headers ?? {});
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await this.fetch(url, { ...init, headers });
    const body = await responsePayload(response);
    return { response, body };
  }

  async mcpRpc(method, params) {
    const response = await this.fetch(`${FIXED.baseUrl}/api/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.credential.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: `${this.runId}-${++this.rpcId}`, method, params }),
    });
    const body = await responsePayload(response);
    if (!response.ok || body?.error) {
      const error = new Error(`MCP ${method} failed`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body.result;
  }

  async callTool(name, args = {}, { allowStructuredError = false } = {}) {
    const result = parseToolResult(await this.mcpRpc("tools/call", { name, arguments: args }));
    if (!allowStructuredError && result?.status === "VERSION_CONFLICT") fail(`MCP_${name.toUpperCase()}_${result.status}`);
    return result;
  }

  async verifyHealth(label) {
    const { body } = await this.http("/api/health");
    const blocker = healthBlocker(body);
    if (blocker) fail(`${label.toUpperCase()}_${blocker}`);
    this.evidence[`${label}GitSha`] = body.release.gitSha;
    this.evidence[`${label}Drift`] = false;
  }

  async loginAndSelectWorkspace() {
    validateCredentials(this.env);
    const login = await this.fetch(`${FIXED.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.env.PR976_SMOKE_ADMIN_EMAIL, password: this.env.PR976_SMOKE_ADMIN_PASSWORD }),
      redirect: "manual",
    });
    await responsePayload(login);
    if (!login.ok) fail("LOGIN_FAILED");
    this.cookie = parseCookie(login.headers.get("set-cookie"));
    const { body } = await this.http("/api/session");
    this.workspace = selectExactWorkspace(body?.workspaces, FIXED.workspaceSlug);
  }

  async issueCredential() {
    const { body } = await this.http(`/api/workspaces/${this.workspace.id}/agent-credentials`, {
      method: "POST",
      body: JSON.stringify({
        label: `PR 976 Action/Goal smoke ${this.runId}`,
        scopes: ["actions:read", "actions:write", "goals:read", "goals:write"],
        reasonMd: "Temporary credential for PR 976 Action/Goal production validation smoke.",
        dailyCallLimit: 50,
        monthlyBudgetCents: 0,
      }),
    });
    this.credential = {
      id: assertUuid(body?.credential?.id, "CREDENTIAL_ID_INVALID"),
      token: typeof body?.token === "string" && body.token.length > 0 ? body.token : fail("CREDENTIAL_TOKEN_MISSING"),
    };
    this.recordCleanup({
      type: "credential",
      id: this.credential.id,
      run: async () => {
        await this.http(`/api/workspaces/${this.workspace.id}/agent-credentials/${this.credential.id}/revoke`, { method: "POST" });
        this.evidence.credentialRevoke = "complete";
      },
    });
  }

  async preflightRoutesAndTools() {
    const probeId = randomUUID();
    const patch = await this.httpAllowFailure(`/api/workspaces/${this.workspace.id}/actions/${probeId}`, {
      method: "PATCH",
      body: JSON.stringify({ bodyMd: "probe", expectedVersion: 1 }),
    });
    if (!isNotFound(patch.response, patch.body)) fail("ACTION_PATCH_PREFLIGHT_FAILED");
    const del = await this.httpAllowFailure(`/api/workspaces/${this.workspace.id}/actions/${probeId}`, { method: "DELETE" });
    if (!isNotFound(del.response, del.body)) fail("ACTION_DELETE_PREFLIGHT_FAILED");
    const versionRead = await this.httpAllowFailure(`/api/workspaces/${this.workspace.id}/work-item-versions?entityType=ACTION&entityId=${probeId}`);
    if (!isNotFound(versionRead.response, versionRead.body)) fail("ACTION_VERSION_READ_PREFLIGHT_FAILED");

    await this.mcpRpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pr976-smoke", version: "1" } });
    const tools = await this.mcpRpc("tools/list", {});
    const toolNames = new Set(tools?.tools?.map((tool) => tool.name) ?? []);
    for (const name of ["create_goal", "get_goal", "update_goal", "archive_goal"]) {
      if (!toolNames.has(name)) fail("GOAL_TOOL_PREFLIGHT_FAILED");
    }
    const missingGoal = await this.callTool("get_goal", { goalId: probeId }, { allowStructuredError: true }).catch((error) => {
      if (error.status === 404 || error.body?.error?.code === "NOT_FOUND") return { status: "NOT_FOUND" };
      throw error;
    });
    if (missingGoal.status !== "NOT_FOUND") fail("GOAL_GET_PREFLIGHT_FAILED");
  }

  assertOwnedCreate(record, type) {
    assertUuid(record?.id, `${type}_ID_INVALID`);
    assertPositiveVersion(record?.version, `${type}_VERSION_INVALID`);
    if (record.status !== "DRAFT") fail(`${type}_NOT_DRAFT`);
  }

  async createSyntheticRecords() {
    const action = await this.http(`/api/workspaces/${this.workspace.id}/actions`, {
      method: "POST",
      body: JSON.stringify({
        title: `${this.marker} action`,
        bodyMd: "Temporary internal production validation record.",
        priorityLabel: "Low",
      }),
    });
    const actionRecord = action.body?.action;
    this.assertOwnedCreate(actionRecord, "ACTION");
    this.created.action = actionRecord;
    this.evidence.actionId = actionRecord.id;
    this.recordCleanup({
      type: "Action",
      id: actionRecord.id,
      run: async () => {
        await this.http(`/api/workspaces/${this.workspace.id}/actions/${actionRecord.id}`, { method: "DELETE" });
      },
    });

    const goal = await this.callTool("create_goal", {
      title: `${this.marker} goal`,
      descriptionMd: "Temporary internal production validation record.",
      status: "DRAFT",
      cadence: "QUARTERLY",
      level: "WORKSPACE",
      duplicateResolution: "create_new",
    });
    this.assertOwnedCreate(goal, "GOAL");
    this.created.goal = goal;
    this.evidence.goalId = goal.id;
    this.recordCleanup({
      type: "Goal",
      id: goal.id,
      run: async () => {
        await this.callTool("archive_goal", { goalId: goal.id });
      },
    });
  }

  async verifyActionEditAndConflict() {
    const observed = assertPositiveVersion(this.created.action.version, "ACTION_OBSERVED_VERSION_INVALID");
    const bodyMd = "Temporary PR 976 validation content edit.";
    const edit = await this.http(`/api/workspaces/${this.workspace.id}/actions/${this.created.action.id}`, {
      method: "PATCH",
      body: JSON.stringify({ bodyMd, expectedVersion: observed }),
    });
    const edited = edit.body?.action;
    if (edited?.id !== this.created.action.id || edited?.bodyMd !== bodyMd || edited?.version !== observed + 1) {
      fail("ACTION_EDIT_ASSERTION_FAILED");
    }
    this.evidence.successfulEdits.actionContent = 1;
    this.evidence.actionVersions = { observed, edited: edited.version };
    const stale = await this.httpAllowFailure(`/api/workspaces/${this.workspace.id}/actions/${this.created.action.id}`, {
      method: "PATCH",
      body: JSON.stringify({ bodyMd: "Unauthorized stale probe content.", expectedVersion: observed }),
    });
    if (!isConflict(stale.response, stale.body)) fail("ACTION_STALE_CONFLICT_FAILED");
    const readback = await this.http(`/api/workspaces/${this.workspace.id}/work-item-versions?entityType=ACTION&entityId=${this.created.action.id}`);
    if (readback.body?.currentVersion !== observed + 1) fail("ACTION_STALE_NO_EFFECT_FAILED");
    this.evidence.staleNoEffect.action = true;
  }

  async verifyGoalEditAndConflict() {
    const current = await this.callTool("get_goal", { goalId: this.created.goal.id });
    const observed = assertPositiveVersion(current.version, "GOAL_OBSERVED_VERSION_INVALID");
    const edit = await this.callTool("update_goal", {
      goalId: this.created.goal.id,
      expectedVersion: observed,
      progressPercent: 37,
    });
    if (edit?.id !== this.created.goal.id || edit?.version !== observed + 1) fail("GOAL_EDIT_ASSERTION_FAILED");
    const read = await this.callTool("get_goal", { goalId: this.created.goal.id });
    if (read?.progressPercent !== 37 || read?.version !== observed + 1) fail("GOAL_EDIT_READBACK_FAILED");
    this.evidence.successfulEdits.goalProgress = 1;
    this.evidence.goalVersions = { observed, edited: edit.version };
    const stale = await this.callTool("update_goal", {
      goalId: this.created.goal.id,
      expectedVersion: observed,
      progressPercent: 91,
    }, { allowStructuredError: true });
    if (stale?.status !== "VERSION_CONFLICT") fail("GOAL_STALE_CONFLICT_FAILED");
    const staleRead = await this.callTool("get_goal", { goalId: this.created.goal.id });
    if (staleRead?.progressPercent !== 37 || staleRead?.version !== observed + 1) fail("GOAL_STALE_NO_EFFECT_FAILED");
    this.evidence.staleNoEffect.goal = true;
  }

  async cleanupCreated() {
    const entries = [...this.cleanup].reverse();
    for (const entry of entries) {
      try {
        await entry.run();
        this.evidence.cleanup.push({ type: entry.type, id: entry.id, status: "complete" });
      } catch {
        this.evidence.cleanup.push({ type: entry.type, id: entry.id, status: "failed" });
        if (entry.type === "credential") this.evidence.credentialRevoke = "failed";
        fail("CLEANUP_FAILED");
      }
    }
  }

  async writeEvidence(status) {
    this.evidence.finishedAt = new Date().toISOString();
    this.evidence.status = status;
    await mkdir(this.outDir, { recursive: true });
    const clean = JSON.parse(JSON.stringify(this.evidence));
    await writeFile(path.join(this.outDir, "evidence.json"), `${JSON.stringify(clean, null, 2)}\n`);
    const summary = [
      "## PR 976 Action/Goal Production Smoke",
      "",
      `- Status: ${status}`,
      `- Expected SHA: ${clean.expectedGitSha}`,
      `- Pre SHA: ${clean.preGitSha ?? "n/a"}`,
      `- Post SHA: ${clean.postGitSha ?? "n/a"}`,
      `- Workspace: ${clean.workspaceSlug}`,
      `- Action edit count: ${clean.successfulEdits.actionContent}`,
      `- Goal progress edit count: ${clean.successfulEdits.goalProgress}`,
      `- Action stale no-effect: ${clean.staleNoEffect.action}`,
      `- Goal stale no-effect: ${clean.staleNoEffect.goal}`,
      `- Blocker: ${clean.blockerCode ?? "none"}`,
    ].join("\n");
    if (this.env.GITHUB_STEP_SUMMARY) await writeFile(this.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: "a" });
  }

  async run() {
    let status = "pass";
    let runError = null;
    try {
      validateWorkflowEnvironment(this.env);
      validateChangedFiles({ execFile: this.execFile });
      await this.verifyHealth("pre");
      await this.loginAndSelectWorkspace();
      await this.issueCredential();
      await this.preflightRoutesAndTools();
      await this.createSyntheticRecords();
      await this.verifyActionEditAndConflict();
      await this.verifyGoalEditAndConflict();
    } catch (error) {
      status = "fail";
      runError = error;
      this.evidence.blockerCode = error?.code ?? "RUN_FAILED";
    } finally {
      try {
        await this.cleanupCreated();
      } catch (cleanupError) {
        status = "fail";
        runError ??= cleanupError;
        this.evidence.blockerCode ??= cleanupError?.code ?? "CLEANUP_FAILED";
      }
      try {
        await this.verifyHealth("post");
      } catch (postHealthError) {
        status = "fail";
        runError ??= postHealthError;
        this.evidence.blockerCode ??= postHealthError?.code ?? "POST_HEALTH_FAILED";
      }
      await this.writeEvidence(status);
    }
    if (runError) {
      console.error(`PR976_SMOKE_FAILED ${sanitize(runError)}`);
      process.exitCode = 1;
      return this.evidence;
    }
    console.log("PR976_SMOKE_PASSED sanitized_evidence_written");
    return this.evidence;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await new Pr976ActionGoalProductionSmoke().run();
}
