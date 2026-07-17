#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createValidationCleanupRegistry,
  createValidationRun,
  parseValidationPrNumbers,
  productionValidationTag,
  recordValidationResult,
  writeValidationArtifacts,
} from "./lib/production-validation.mjs";
import {
  requireInternalValidationWorkspace,
  selectWorkspaceForValidation,
  validationWorkspaceSelectorFromEnv,
  workspaceTenant,
} from "./lib/validation-workspace.mjs";
import {
  healthConfiguredReleaseDrift,
  healthReleaseMismatch,
} from "./lib/release-health-validation.mjs";

const DEFAULT_BASE_URL = "https://app.corgtex.com";
const DEFAULT_OUT_DIR = ".artifacts/work-item-parity-production-smoke";

function usage() {
  return [
    "usage: node scripts/work-item-parity-production-smoke.mjs [base-url] [out-dir]",
    "",
    "Runs a production-safe work-item parity smoke against the internal validation workspace.",
    "",
    "Environment:",
    "  WORK_ITEM_PARITY_SMOKE_EXPECTED_GIT_SHA  optional /api/health release SHA to require",
    "  WORK_ITEM_PARITY_SMOKE_WORKSPACE_SLUG    workspace slug to select after login",
    "  WORK_ITEM_PARITY_SMOKE_EMAIL             login email; falls back to PRODUCTION_VALIDATION_ADMIN_EMAIL or ADMIN_EMAIL",
    "  WORK_ITEM_PARITY_SMOKE_PASSWORD          login password; falls back to PRODUCTION_VALIDATION_ADMIN_PASSWORD or ADMIN_PASSWORD",
    "  WORK_ITEM_PARITY_SMOKE_PR_NUMBERS        comma-separated PR numbers covered by this validation run",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function parseSetCookie(setCookie) {
  assert(setCookie, "Missing session cookie.");
  return setCookie.split(", ").find((part) => part.includes("corgtex"))?.split(";")[0] ?? setCookie.split(";")[0];
}

function parseToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find?.((item) => item.type === "text")?.text;
  assert(text, "MCP result did not include JSON text content.");
  return JSON.parse(text);
}

function validationRecordPrefix(run, fallback) {
  if (run.prNumbers.length === 0) return `${fallback} ${run.runId}`;
  return productionValidationTag({
    date: run.startedAt,
    prNumber: run.prNumbers[0],
    runId: run.runId,
  });
}

export function workItemParityHealthReleaseBlocker(health, expectedGitSha = null) {
  return healthReleaseMismatch(health, expectedGitSha)
    ?? healthConfiguredReleaseDrift(health, expectedGitSha);
}

function normalizeDateForTitle(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

export function isHumanValidationMember(member) {
  if (!member?.isActive) return false;
  if (!(member.displayName || member.email)) return false;
  if (member.kind === "SYSTEM") return false;
  const email = String(member.email ?? "").trim().toLowerCase();
  const displayName = String(member.displayName ?? "").trim().toLowerCase();
  if (email.startsWith("system+") || email.startsWith("support+")) return false;
  if (displayName === "corgtex support") return false;
  return true;
}

export function cleanupFailureMessage(cleanup) {
  const failed = cleanup?.failed ?? [];
  if (failed.length === 0) return null;
  return `Validation cleanup failed for ${failed.map(({ entry }) => entry.id).join(", ")}`;
}

export function assertFields(actual, expected, label) {
  for (const [field, value] of Object.entries(expected)) {
    assert(
      actual?.[field] === value,
      `${label} ${field} mismatch: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual?.[field])}`,
    );
  }
}

export function workItemExpectations(member, {
  priority,
  priorityLabel,
  type,
}) {
  const memberName = member.displayName || member.email;
  if (type === "action") {
    return {
      priority,
      priorityLabel,
      assigneeMemberId: member.id,
      assigneeMemberName: memberName,
      assignee: memberName,
      responsibleMemberId: member.id,
      responsibleMemberName: memberName,
      responsiblePerson: memberName,
      ownerMemberId: member.id,
      ownerMemberName: memberName,
      owner: memberName,
    };
  }
  if (type === "tension") {
    return {
      priority,
      priorityLabel,
      assigneeMemberId: member.id,
      assigneeMemberName: memberName,
      assignee: memberName,
      responsibleMemberId: member.id,
      responsibleMemberName: memberName,
      responsiblePerson: memberName,
      raisedByMemberId: member.id,
      raisedByMemberName: memberName,
      raisedBy: memberName,
      ownerMemberId: member.id,
      ownerMemberName: memberName,
      owner: memberName,
    };
  }
  return {
    priority,
    priorityLabel,
    ownerMemberId: member.id,
    ownerMemberName: memberName,
    owner: memberName,
    responsibleMemberId: member.id,
    responsibleMemberName: memberName,
    responsiblePerson: memberName,
  };
}

export class WorkItemParitySmoke {
  constructor({
    baseUrl,
    outDir,
    expectedGitSha,
    workspaceSelector,
    authEmail,
    authPassword,
    prNumbers,
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.outDir = path.resolve(outDir || DEFAULT_OUT_DIR);
    this.expectedGitSha = expectedGitSha || null;
    this.workspaceSelector = workspaceSelector ?? validationWorkspaceSelectorFromEnv(process.env, "WORK_ITEM_PARITY_SMOKE");
    this.workspaceSlug = this.workspaceSelector.workspaceSlug;
    this.authEmail = authEmail || null;
    this.authPassword = authPassword || null;
    this.runId = `work-item-parity-${Date.now().toString(36)}`;
    this.validationRun = createValidationRun({
      runId: this.runId,
      tenant: { slug: this.workspaceSlug, label: this.workspaceSlug },
      prNumbers,
      baseUrl: this.baseUrl,
      environment: "production",
      metadata: {
        script: "work-item-parity-production-smoke",
        workspaceSelector: this.workspaceSelector,
        strictInternalValidationWorkspace: true,
      },
    });
    this.cleanupRegistry = createValidationCleanupRegistry(this.validationRun);
    this.validationTag = validationRecordPrefix(this.validationRun, "work-item-parity-production-smoke");
    this.cookie = null;
    this.workspaceId = null;
    this.credentialId = null;
    this.mcpToken = null;
    this.rpcSeq = 0;
    this.results = [];
    this.created = {
      action: null,
      tension: null,
      proposal: null,
    };
  }

  record(name, detail = {}) {
    this.results.push({ name, status: "ok", ...detail });
    console.log(`OK   ${name}`);
  }

  async sessionFetch(pathOrUrl, init = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers = new Headers(init.headers ?? {});
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(url, { ...init, headers });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${url} failed ${response.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)}`);
    }
    return { response, body, text };
  }

  async mcpRpc(method, params) {
    const response = await fetch(`${this.baseUrl}/api/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.mcpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: `${this.runId}-${++this.rpcSeq}`, method, params }),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`MCP ${method} returned non-JSON ${response.status}: ${text.slice(0, 300)}`); }
    if (!response.ok || body.error) throw new Error(`MCP ${method} failed ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 500)}`);
    return body.result;
  }

  async callTool(name, args = {}) {
    return parseToolResult(await this.mcpRpc("tools/call", { name, arguments: args }));
  }

  async verifyHealth() {
    const health = await this.sessionFetch("/api/health");
    const blocker = workItemParityHealthReleaseBlocker(health.body, this.expectedGitSha);
    assert(!blocker, blocker);
    this.record("health release metadata", {
      runtimeGitSha: health.body?.release?.gitSha ?? null,
      configuredGitSha: health.body?.release?.configuredGitSha ?? null,
    });
  }

  async login() {
    assert(this.authEmail && this.authPassword, "Work-item parity smoke requires WORK_ITEM_PARITY_SMOKE_EMAIL/PASSWORD or production validation admin credentials.");
    const login = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.authEmail, password: this.authPassword }),
      redirect: "manual",
    });
    const text = await login.text();
    assert(login.ok, `/api/auth/login failed ${login.status}: ${text.slice(0, 300)}`);
    this.cookie = parseSetCookie(login.headers.get("set-cookie"));

    const session = await this.sessionFetch("/api/session");
    const workspace = selectWorkspaceForValidation(session.body?.workspaces ?? [], {
      workspaceId: this.workspaceSelector.workspaceId,
      workspaceSlug: this.workspaceSelector.workspaceSlug,
      purpose: "work-item parity production smoke",
    });
    requireInternalValidationWorkspace(workspace, { purpose: "work-item parity production smoke writes" });
    this.workspaceId = workspace.id;
    this.validationRun.tenant = workspaceTenant(workspace);
    this.record("password login", { workspaceId: this.workspaceId, workspaceSlug: workspace.slug ?? null });
  }

  async issueCredential() {
    const result = await this.sessionFetch(`/api/workspaces/${this.workspaceId}/agent-credentials`, {
      method: "POST",
      body: JSON.stringify({
        label: `Work-item parity smoke ${this.runId}`,
        scopes: [
          "members:read",
          "actions:read",
          "actions:write",
          "tensions:read",
          "tensions:write",
          "proposals:read",
          "proposals:write",
        ],
        reasonMd: "Temporary credential for work-item parity production smoke.",
        dailyCallLimit: 100,
        monthlyBudgetCents: 0,
      }),
    });
    this.credentialId = result.body.credential.id;
    this.mcpToken = result.body.token;
    const cleanupActionId = `revoke:AgentCredential:${this.credentialId}`;
    this.cleanupRegistry.add({
      id: cleanupActionId,
      action: "revoke",
      target: {
        type: "AgentCredential",
        id: this.credentialId,
        label: `Work-item parity smoke ${this.runId}`,
      },
      runner: async () => {
        await this.sessionFetch(`/api/workspaces/${this.workspaceId}/agent-credentials/${this.credentialId}/revoke`, { method: "POST" });
        return "Temporary MCP credential revoked.";
      },
    });
    this.record("temporary MCP credential issued", { credentialId: this.credentialId, cleanupActionId });
  }

  async selectValidationMember() {
    const members = await this.callTool("list_members", { includeInactive: false });
    const member = members.members?.find((item) => isHumanValidationMember(item));
    assert(member, "No active human validation member was available.");
    this.record("validation member selected", { memberId: member.id, email: member.email });
    return member;
  }

  addRecordCleanup({ type, id, title, endpoint }) {
    const cleanupActionId = `archive:${type}:${id}`;
    this.cleanupRegistry.add({
      id: cleanupActionId,
      action: "archive",
      target: { type, id, label: title },
      runner: async () => {
        await this.sessionFetch(endpoint, { method: "DELETE" });
        return `${type} archived through product API.`;
      },
    });
    return cleanupActionId;
  }

  async createWorkItems(member) {
    const date = normalizeDateForTitle(this.validationRun.startedAt ? new Date(this.validationRun.startedAt) : new Date());
    const actionTitle = `${this.validationTag} action parity ${date}`;
    const tensionTitle = `${this.validationTag} tension parity ${date}`;
    const proposalTitle = `${this.validationTag} proposal parity ${date}`;

    const action = await this.sessionFetch(`/api/workspaces/${this.workspaceId}/actions`, {
      method: "POST",
      body: JSON.stringify({
        title: actionTitle,
        bodyMd: "Temporary production validation action. Archive after smoke.",
        assigneeMemberId: member.id,
        priorityLabel: "Important",
      }),
    });
    const actionRecord = action.body.action;
    const actionCleanupId = this.addRecordCleanup({
      type: "Action",
      id: actionRecord.id,
      title: actionTitle,
      endpoint: `/api/workspaces/${this.workspaceId}/actions/${actionRecord.id}`,
    });
    this.created.action = { ...actionRecord, cleanupActionId: actionCleanupId };
    assertFields(actionRecord, workItemExpectations(member, { type: "action", priority: 2, priorityLabel: "Important" }), "REST action create");

    const tension = await this.sessionFetch(`/api/workspaces/${this.workspaceId}/tensions`, {
      method: "POST",
      body: JSON.stringify({
        title: tensionTitle,
        bodyMd: "Temporary production validation tension. Archive after smoke.",
        assigneeMemberId: member.id,
        raisedByMemberId: member.id,
        priorityLabel: "Urgent",
      }),
    });
    const tensionRecord = tension.body.tension;
    const tensionCleanupId = this.addRecordCleanup({
      type: "Tension",
      id: tensionRecord.id,
      title: tensionTitle,
      endpoint: `/api/workspaces/${this.workspaceId}/tensions/${tensionRecord.id}`,
    });
    this.created.tension = { ...tensionRecord, cleanupActionId: tensionCleanupId };
    assertFields(tensionRecord, workItemExpectations(member, { type: "tension", priority: 3, priorityLabel: "Urgent" }), "REST tension create");

    const proposal = await this.sessionFetch(`/api/workspaces/${this.workspaceId}/proposals`, {
      method: "POST",
      body: JSON.stringify({
        title: proposalTitle,
        summary: "Temporary production validation proposal.",
        bodyMd: "Temporary production validation proposal. Archive after smoke.",
        ownerMemberId: member.id,
        priorityLabel: "Medium",
      }),
    });
    const proposalRecord = proposal.body.proposal;
    const proposalCleanupId = this.addRecordCleanup({
      type: "Proposal",
      id: proposalRecord.id,
      title: proposalTitle,
      endpoint: `/api/workspaces/${this.workspaceId}/proposals/${proposalRecord.id}`,
    });
    this.created.proposal = { ...proposalRecord, cleanupActionId: proposalCleanupId };
    assertFields(proposalRecord, workItemExpectations(member, { type: "proposal", priority: 1, priorityLabel: "Medium" }), "REST proposal create");

    this.record("work items created with normalized REST responses", {
      actionId: actionRecord.id,
      tensionId: tensionRecord.id,
      proposalId: proposalRecord.id,
    });
  }

  async verifyRestLists(member) {
    const [action, tension, proposal] = await Promise.all([
      this.findRestListRecord({
        path: `/api/workspaces/${this.workspaceId}/actions?archiveFilter=active`,
        responseKey: "actions",
        recordId: this.created.action.id,
        label: "REST action list",
      }),
      this.findRestListRecord({
        path: `/api/workspaces/${this.workspaceId}/tensions?archiveFilter=active`,
        responseKey: "tensions",
        recordId: this.created.tension.id,
        label: "REST tension list",
      }),
      this.findRestListRecord({
        path: `/api/workspaces/${this.workspaceId}/proposals?archiveFilter=active`,
        responseKey: "proposals",
        recordId: this.created.proposal.id,
        label: "REST proposal list",
      }),
    ]);

    assertFields(action, workItemExpectations(member, { type: "action", priority: 2, priorityLabel: "Important" }), "REST action list");
    assertFields(tension, workItemExpectations(member, { type: "tension", priority: 3, priorityLabel: "Urgent" }), "REST tension list");
    assertFields(proposal, workItemExpectations(member, { type: "proposal", priority: 1, priorityLabel: "Medium" }), "REST proposal list");
    this.record("REST list parity", { actionId: action.id, tensionId: tension.id, proposalId: proposal.id });
  }

  async findRestListRecord({ path: listPath, responseKey, recordId, label }) {
    const pageSize = 100;
    for (let skip = 0; ; skip += pageSize) {
      const separator = listPath.includes("?") ? "&" : "?";
      const result = await this.sessionFetch(`${listPath}${separator}take=${pageSize}&skip=${skip}`);
      const collection = result.body?.[responseKey] ?? {};
      const item = collection.items?.find?.((candidate) => candidate.id === recordId);
      if (item) return item;
      const itemCount = collection.items?.length ?? 0;
      const total = collection.total ?? skip + itemCount;
      if (itemCount === 0 || skip + itemCount >= total) break;
    }
    throw new Error(`${label} did not include record ${recordId}.`);
  }

  async verifyMcpLists(member) {
    const [actions, tensions, proposals] = await Promise.all([
      this.findMcpListRecord({
        toolName: "list_actions",
        recordId: this.created.action.id,
        label: "MCP action list",
      }),
      this.findMcpListRecord({
        toolName: "list_tensions",
        recordId: this.created.tension.id,
        label: "MCP tension list",
      }),
      this.findMcpListRecord({
        toolName: "list_proposals",
        recordId: this.created.proposal.id,
        label: "MCP proposal list",
      }),
    ]);

    assertFields(actions, workItemExpectations(member, { type: "action", priority: 2, priorityLabel: "Important" }), "MCP action list");
    assertFields(tensions, workItemExpectations(member, { type: "tension", priority: 3, priorityLabel: "Urgent" }), "MCP tension list");
    assertFields(proposals, workItemExpectations(member, { type: "proposal", priority: 1, priorityLabel: "Medium" }), "MCP proposal list");
    this.record("MCP list parity", { actionId: actions.id, tensionId: tensions.id, proposalId: proposals.id });
  }

  async findMcpListRecord({ toolName, recordId, label }) {
    const pageSize = 100;
    for (let skip = 0; ; skip += pageSize) {
      const result = await this.callTool(toolName, { take: pageSize, skip, archiveFilter: "active" });
      const item = result.items?.find?.((candidate) => candidate.id === recordId);
      if (item) return item;
      const itemCount = result.items?.length ?? 0;
      const total = result.total ?? skip + itemCount;
      if (itemCount === 0 || skip + itemCount >= total) break;
    }
    throw new Error(`${label} did not include record ${recordId}.`);
  }

  recordValidationOutcome(result) {
    const coveredPrNumbers = this.validationRun.prNumbers.length > 0
      ? this.validationRun.prNumbers
      : [null];
    for (const prNumber of coveredPrNumbers) {
      recordValidationResult(this.validationRun, {
        ...(prNumber ? { prNumber } : {}),
        ...result,
      });
    }
  }

  recordValidationPass() {
    this.recordValidationOutcome({
      intent: "Work-item owner/responsibility/priority parity across Action, Tension, and Proposal surfaces",
      method: "work-item-parity-production-smoke",
      result: "pass",
      evidence: [
        { type: "health", summary: "Production release metadata matched expected SHA." },
        { type: "rest-api", summary: "REST create and list responses returned normalized work-item fields." },
        { type: "mcp", summary: "MCP list tools returned the same normalized work-item fields." },
      ],
      createdRecordIds: [this.created.action?.id, this.created.tension?.id, this.created.proposal?.id].filter(Boolean),
      cleanupActionIds: [
        this.created.action?.cleanupActionId,
        this.created.tension?.cleanupActionId,
        this.created.proposal?.cleanupActionId,
        this.credentialId ? `revoke:AgentCredential:${this.credentialId}` : null,
      ].filter(Boolean),
    });
  }

  recordValidationFailure(error) {
    if (this.validationRun.results.length > 0) return;
    this.recordValidationOutcome({
      intent: "Work-item owner/responsibility/priority parity across Action, Tension, and Proposal surfaces",
      method: "work-item-parity-production-smoke",
      result: "partial",
      blocker: error instanceof Error ? error.message : String(error),
      evidence: this.results.map((item) => ({ type: "step", summary: `${item.name}: ${item.status}` })),
      createdRecordIds: [this.created.action?.id, this.created.tension?.id, this.created.proposal?.id].filter(Boolean),
      cleanupActionIds: this.cleanupRegistry.entries().map((entry) => entry.id),
    });
  }

  async run() {
    let runError = null;
    await mkdir(this.outDir, { recursive: true });
    try {
      await this.verifyHealth();
      await this.login();
      await this.issueCredential();
      const member = await this.selectValidationMember();
      await this.createWorkItems(member);
      await this.verifyRestLists(member);
      await this.verifyMcpLists(member);
      this.recordValidationPass();
    } catch (error) {
      runError = error;
      this.recordValidationFailure(error);
    } finally {
      const cleanup = await this.cleanupRegistry.runAll({ throwOnFailure: false });
      const cleanupErrorMessage = cleanupFailureMessage(cleanup);
      if (cleanupErrorMessage && !runError) {
        runError = new Error(cleanupErrorMessage);
        this.validationRun.results = [];
        this.recordValidationFailure(runError);
      }
      const resultsPath = path.join(this.outDir, "work-item-parity-production-smoke.json");
      await writeFile(resultsPath, `${JSON.stringify({
        runId: this.runId,
        results: this.results,
        cleanup,
        created: this.created,
        error: runError ? { message: runError.message, stack: runError.stack } : null,
      }, null, 2)}\n`);
      await writeValidationArtifacts(this.validationRun, this.outDir, {
        jsonFileName: "work-item-parity-production-smoke.matrix.json",
        markdownFileName: "work-item-parity-production-smoke.report.md",
      });
    }
    if (runError) throw runError;
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const baseUrl = process.argv[2] || DEFAULT_BASE_URL;
  const outDir = process.argv[3] || DEFAULT_OUT_DIR;
  const smoke = new WorkItemParitySmoke({
    baseUrl,
    outDir,
    expectedGitSha: process.env.WORK_ITEM_PARITY_SMOKE_EXPECTED_GIT_SHA || process.env.PRODUCTION_VALIDATION_EXPECTED_GIT_SHA || null,
    workspaceSelector: validationWorkspaceSelectorFromEnv(process.env, "WORK_ITEM_PARITY_SMOKE"),
    authEmail: process.env.WORK_ITEM_PARITY_SMOKE_EMAIL || process.env.PRODUCTION_VALIDATION_ADMIN_EMAIL || process.env.ADMIN_EMAIL,
    authPassword: process.env.WORK_ITEM_PARITY_SMOKE_PASSWORD || process.env.PRODUCTION_VALIDATION_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD,
    prNumbers: parseValidationPrNumbers(process.env.WORK_ITEM_PARITY_SMOKE_PR_NUMBERS || process.env.PRODUCTION_VALIDATION_PR_NUMBERS || ""),
  });
  await smoke.run();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
