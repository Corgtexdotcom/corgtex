import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createValidationCleanupRegistry,
  createValidationRun,
  parseValidationPrNumbers,
  productionValidationTag,
  recordCreatedRecord,
  recordValidationResult,
  writeValidationArtifacts,
} from "./lib/production-validation.mjs";
import {
  DEMO_WORKSPACE_SLUG,
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
const DEFAULT_OUT_DIR = ".artifacts/crm-production-smoke";

function usage() {
  return [
    "usage: node scripts/crm-production-smoke.mjs [base-url] [out-dir]",
    "",
    "Runs a production-safe CRM smoke against an explicitly selected validation workspace.",
    "When no workspace is selected, legacy demo-login behavior is used for manual demo visual checks.",
    "",
    "Environment:",
    "  CRM_SMOKE_EXPECTED_GIT_SHA  optional /api/health release SHA to require",
    "  CRM_SMOKE_WORKSPACE_SLUG    workspace slug to select after login",
    "  CRM_SMOKE_EMAIL             login email for validation workspace runs; falls back to ADMIN_EMAIL only when a workspace is selected",
    "  CRM_SMOKE_PASSWORD          login password for validation workspace runs; falls back to ADMIN_PASSWORD only when a workspace is selected",
    "  CRM_SMOKE_HEADLESS          false to show Chromium, default true",
    "  CRM_SMOKE_PR_NUMBERS        comma-separated PR numbers covered by this validation run",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function parsePendingOperationId(message) {
  const match = String(message).match(/Pending operation ID:\s*([A-Za-z0-9-]+)/i)
    ?? String(message).match(/pendingOperationId["'`:\s]+([A-Za-z0-9-]+)/i);
  assert(match?.[1], `Chat did not expose a pending operation ID. Message: ${String(message).slice(0, 500)}`);
  return match[1];
}

function parseActivityId(message) {
  return String(message).match(/Activity ID:\s*([A-Za-z0-9-]+)/i)?.[1] ?? null;
}

function crmVisualTargets(workspaceId, accountId) {
  return [
    { name: "dashboard", route: `/workspaces/${workspaceId}/leads`, selector: ".ws-section" },
    { name: "accounts-table", route: `/workspaces/${workspaceId}/leads/accounts?view=table`, selector: ".nr-work-item-table" },
    { name: "accounts-list", route: `/workspaces/${workspaceId}/leads/accounts?view=list`, selector: ".ws-section" },
    { name: "pipeline-kanban", route: `/workspaces/${workspaceId}/leads/pipeline?view=kanban`, selector: ".nr-kanban", kanban: true },
    { name: "pipeline-table", route: `/workspaces/${workspaceId}/leads/pipeline?view=table`, selector: ".nr-work-item-table" },
    { name: "pipeline-list", route: `/workspaces/${workspaceId}/leads/pipeline?view=list`, selector: ".ws-section" },
    { name: "activity-list", route: `/workspaces/${workspaceId}/leads/activity?view=list`, selector: ".ws-section" },
    { name: "activity-table", route: `/workspaces/${workspaceId}/leads/activity?view=table`, selector: ".nr-work-item-table" },
    { name: "suggestions-list", route: `/workspaces/${workspaceId}/leads/suggestions?view=list`, selector: ".ws-section" },
    { name: "suggestions-table", route: `/workspaces/${workspaceId}/leads/suggestions?view=table`, selector: ".nr-work-item-table" },
    { name: "suggestions-kanban", route: `/workspaces/${workspaceId}/leads/suggestions?view=kanban`, selector: ".nr-kanban", kanban: true },
    { name: "account-detail-pipeline", route: `/workspaces/${workspaceId}/leads/accounts/${accountId}?view=pipeline`, selector: ".nr-kanban", kanban: true },
  ];
}

function crmScreenshotFileName(targetName, theme) {
  return `${targetName}-${theme}.png`;
}

function validationRecordPrefix(run, fallback) {
  if (run.prNumbers.length === 0) return `${fallback} ${run.runId}`;
  return productionValidationTag({
    date: run.startedAt,
    prNumber: run.prNumbers[0],
    runId: run.runId,
  });
}

function evaluateKanbanSnapshot(snapshot) {
  if (!snapshot?.boardVisible) return "Kanban board was not visible.";
  if (snapshot.cardCount < 1) return "Kanban board did not render any visible cards.";
  if (snapshot.clippedWithoutPageScrollCount > 0) {
    return `${snapshot.clippedWithoutPageScrollCount} Kanban card(s) extended below the viewport while the page could not scroll.`;
  }
  return null;
}

function crmHealthReleaseBlocker(health, expectedGitSha = null) {
  return healthReleaseMismatch(health, expectedGitSha)
    ?? healthConfiguredReleaseDrift(health, expectedGitSha);
}

function crmPageContext(workspaceId, account, activityId = null, title = null) {
  return {
    surface: "crm",
    route: `/workspaces/${workspaceId}/leads/accounts/${account.id}${activityId ? "?view=activity" : ""}`,
    workspaceId,
    view: "account-detail",
    section: activityId ? "activity" : "overview",
    selectedIds: { accountId: account.id, contactId: null, dealId: null, activityId, suggestionId: null },
    filters: activityId ? { view: "activity" } : { view: "overview" },
    pagination: { page: null, pageCount: null, total: null },
    visibleContext: {
      metrics: [],
      accounts: [{
        id: account.id,
        name: account.name,
        domain: account.domain ?? null,
        relationshipType: account.relationshipType ?? null,
        lifecycleStage: account.lifecycleStage ?? null,
        webUrl: account.webUrl,
      }],
      contacts: [],
      deals: [],
      activities: activityId && title ? [{ id: activityId, title, type: "TASK", accountId: account.id, accountName: account.name, webUrl: account.webUrl }] : [],
      suggestions: [],
    },
  };
}

class CrmSmoke {
  constructor({
    baseUrl,
    outDir,
    expectedGitSha,
    workspaceSelector,
    authEmail,
    authPassword,
    requireSafeWorkspace,
    headless,
    prNumbers,
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.outDir = path.resolve(outDir || DEFAULT_OUT_DIR);
    this.expectedGitSha = expectedGitSha || null;
    this.workspaceSelector = workspaceSelector ?? {
      workspaceId: null,
      workspaceSlug: DEMO_WORKSPACE_SLUG,
      explicit: false,
    };
    this.workspaceSlug = this.workspaceSelector.workspaceSlug || DEMO_WORKSPACE_SLUG;
    this.authEmail = authEmail || null;
    this.authPassword = authPassword || null;
    this.requireSafeWorkspace = Boolean(requireSafeWorkspace);
    this.headless = headless;
    this.runId = `crm-smoke-${Date.now().toString(36)}`;
    this.validationRun = createValidationRun({
      runId: this.runId,
      tenant: { slug: this.workspaceSlug, label: this.workspaceSlug },
      prNumbers,
      baseUrl: this.baseUrl,
      environment: "production",
      metadata: {
        script: "crm-production-smoke",
        workspaceSelector: this.workspaceSelector,
        strictInternalValidationWorkspace: this.requireSafeWorkspace,
      },
    });
    this.cleanupRegistry = createValidationCleanupRegistry(this.validationRun);
    this.validationTag = validationRecordPrefix(this.validationRun, "crm-production-smoke");
    this.validationResultRecorded = false;
    this.cookie = null;
    this.workspaceId = null;
    this.credentialId = null;
    this.mcpToken = null;
    this.results = [];
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

  async chat(conversationId, message, pageContext) {
    const response = await fetch(`${this.baseUrl}/api/workspaces/${this.workspaceId}/conversations/${conversationId}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: JSON.stringify({ message, pageContext }),
    });
    if (!response.ok) throw new Error(`chat POST failed ${response.status}: ${(await response.text()).slice(0, 500)}`);
    assert(response.body, "Chat response did not include a stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantMessage = "";
    const consume = () => {
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          const payload = JSON.parse(line.slice(6));
          if (payload.text) assistantMessage += payload.text;
        }
        newline = buffer.indexOf("\n");
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consume();
    }
    buffer += decoder.decode();
    consume();
    assert(assistantMessage.trim(), `Chat returned an empty response for: ${message}`);
    return assistantMessage;
  }

  async verifyHealth() {
    const { body } = await this.sessionFetch("/api/health");
    assert(body.status === "ok", `/api/health status was ${body.status}`);
    assert(body.database === "up", `/api/health database was ${body.database}`);
    assert(body.schema === "ready", `/api/health schema was ${body.schema}`);
    if (this.expectedGitSha) {
      const actual = body.release?.gitSha ?? null;
      assert(actual === this.expectedGitSha, `/api/health release.gitSha ${actual ?? "missing"} did not match ${this.expectedGitSha}`);
    }
    const releaseBlocker = crmHealthReleaseBlocker(body, this.expectedGitSha);
    assert(!releaseBlocker, releaseBlocker);
    this.record("health", {
      gitSha: body.release?.gitSha ?? null,
      imageTag: body.release?.imageTag ?? null,
      version: body.release?.version ?? null,
    });
  }

  async loginDemo() {
    const response = await fetch(`${this.baseUrl}/api/auth/demo-login`, { method: "POST" });
    const text = await response.text();
    const body = JSON.parse(text);
    assert(response.ok, `/api/auth/demo-login failed ${response.status}: ${text.slice(0, 300)}`);
    this.cookie = parseSetCookie(response.headers.get("set-cookie"));
    this.workspaceId = body.workspaceId;

    const session = await this.sessionFetch("/api/session");
    const workspace = selectWorkspaceForValidation(session.body.workspaces ?? [], {
      workspaceId: this.workspaceSelector.workspaceId,
      workspaceSlug: this.workspaceSlug,
      purpose: "CRM production smoke demo login",
    });
    assert(workspace, `Workspace ${this.workspaceSlug} was not available after demo login.`);
    this.workspaceId = workspace.id;
    if (this.requireSafeWorkspace) {
      requireInternalValidationWorkspace(workspace, { purpose: "CRM production smoke writes" });
    }
    this.validationRun.tenant = workspaceTenant(workspace);
    this.record("demo login", { workspaceId: this.workspaceId, workspaceSlug: workspace.slug ?? null });
  }

  async loginPassword() {
    assert(this.authEmail && this.authPassword, "CRM validation workspace smoke requires CRM_SMOKE_EMAIL/CRM_SMOKE_PASSWORD or ADMIN_EMAIL/ADMIN_PASSWORD.");
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
    const workspace = selectWorkspaceForValidation(session.body.workspaces ?? [], {
      workspaceId: this.workspaceSelector.workspaceId,
      workspaceSlug: this.workspaceSlug,
      purpose: "CRM production smoke password login",
    });
    if (this.requireSafeWorkspace) {
      requireInternalValidationWorkspace(workspace, { purpose: "CRM production smoke writes" });
    }
    this.workspaceId = workspace.id;
    this.validationRun.tenant = workspaceTenant(workspace);
    this.record("password login", { workspaceId: this.workspaceId, workspaceSlug: workspace.slug ?? null });
  }

  async login() {
    if (this.workspaceSelector.explicit) {
      await this.loginPassword();
      return;
    }
    await this.loginDemo();
  }

  async issueCredential() {
    const result = await this.sessionFetch(`/api/workspaces/${this.workspaceId}/agent-credentials`, {
      method: "POST",
      body: JSON.stringify({
        label: `CRM production smoke ${this.runId}`,
        scopes: ["relationships:read", "relationships:write"],
        reasonMd: "Temporary credential for manual CRM production smoke.",
        dailyCallLimit: 100,
        monthlyBudgetCents: 0,
      }),
    });
    this.credentialId = result.body.credential.id;
    this.mcpToken = result.body.token;
    this.rpcSeq = 0;
    const cleanupActionId = `revoke:AgentCredential:${this.credentialId}`;
    this.cleanupRegistry.add({
      id: cleanupActionId,
      action: "revoke",
      target: {
        type: "AgentCredential",
        id: this.credentialId,
        label: `CRM production smoke ${this.runId}`,
      },
      runner: async () => {
        await this.sessionFetch(`/api/workspaces/${this.workspaceId}/agent-credentials/${this.credentialId}/revoke`, { method: "POST" });
        return "Temporary MCP credential revoked.";
      },
    });
    this.record("temporary MCP credential issued", { credentialId: this.credentialId, cleanupActionId });
  }

  async verifyMcpReads(account) {
    const tools = await this.mcpRpc("tools/list", {});
    const names = new Set((tools.tools ?? []).map((tool) => tool.name));
    for (const name of ["list_relationship_accounts", "get_relationship_account", "list_relationship_contacts", "list_relationship_deals", "list_due_relationship_work", "list_communication_suggestions"]) {
      assert(names.has(name), `MCP tool missing: ${name}`);
    }
    const [detail, contacts, deals, dueWork, suggestions] = await Promise.all([
      this.callTool("get_relationship_account", { accountId: account.id }),
      this.callTool("list_relationship_contacts", { accountId: account.id, take: 5 }),
      this.callTool("list_relationship_deals", { accountId: account.id, take: 5 }),
      this.callTool("list_due_relationship_work", { accountId: account.id, take: 5 }),
      this.callTool("list_communication_suggestions", { accountId: account.id, take: 5 }),
    ]);
    assert(detail.account?.id === account.id, "MCP account detail did not match selected account.");
    this.record("MCP reads", {
      contacts: contacts.total ?? contacts.items?.length ?? 0,
      deals: deals.total ?? deals.items?.length ?? 0,
      dueWork: dueWork.total ?? dueWork.items?.length ?? 0,
      suggestions: suggestions.total ?? suggestions.items?.length ?? 0,
    });
  }

  async applyTheme(page, theme) {
    await page.evaluate((selectedTheme) => {
      window.localStorage.setItem("theme", selectedTheme);
      document.documentElement.classList.toggle("dark", selectedTheme === "dark");
      document.documentElement.style.colorScheme = selectedTheme;
    }, theme);
    await page.waitForTimeout(150);
  }

  async kanbanSnapshot(page) {
    return page.evaluate(() => {
      const board = document.querySelector(".nr-kanban");
      const boardRect = board?.getBoundingClientRect();
      const scrollingElement = document.scrollingElement || document.documentElement;
      const viewportHeight = window.innerHeight;
      const scrollHeight = scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight;
      const hasScrollableAncestor = (element) => {
        let current = element.parentElement;
        while (current && current !== document.body && current !== document.documentElement) {
          const style = window.getComputedStyle(current);
          const canScrollY = /(auto|scroll)/.test(style.overflowY);
          if (canScrollY && current.scrollHeight > current.clientHeight + 1) return true;
          current = current.parentElement;
        }
        return scrollHeight > viewportHeight + 1;
      };
      const cardSnapshots = Array.from(document.querySelectorAll(".nr-kanban-draggable"))
        .map((card) => {
          const rect = card.getBoundingClientRect();
          const style = window.getComputedStyle(card);
          return {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            hasScrollPath: hasScrollableAncestor(card),
            visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0",
          };
        })
        .filter((card) => card.visible);
      return {
        boardVisible: Boolean(boardRect && boardRect.width > 0 && boardRect.height > 0),
        cardCount: cardSnapshots.length,
        clippedWithoutPageScrollCount: cardSnapshots.filter((card) => card.bottom > viewportHeight + 1 && !card.hasScrollPath).length,
      };
    });
  }

  async assertKanbanVisible(page, name) {
    await page.locator(".nr-kanban").first().waitFor({ state: "visible", timeout: 10_000 });
    const firstCard = page.locator(".nr-kanban-draggable").first();
    await firstCard.waitFor({ state: "visible", timeout: 10_000 });
    await firstCard.scrollIntoViewIfNeeded();
    const snapshot = await this.kanbanSnapshot(page);
    const issue = evaluateKanbanSnapshot(snapshot);
    assert(!issue, `${name}: ${issue}`);
  }

  async verifyPages(page, account) {
    const targets = crmVisualTargets(this.workspaceId, account.id);
    const screenshots = [];
    for (const theme of ["light", "dark"]) {
      for (const target of targets) {
        const response = await page.goto(`${this.baseUrl}${target.route}`, { waitUntil: "networkidle", timeout: 30_000 });
        assert((response?.status() ?? 0) < 400, `${target.name} returned HTTP ${response?.status() ?? 0}`);
        await this.applyTheme(page, theme);
        await page.locator(target.selector).first().waitFor({ state: "visible", timeout: 10_000 });
        if (target.name === "account-detail-pipeline") {
          await page.getByText(account.name, { exact: false }).first().waitFor({ timeout: 10_000 });
        }
        if (target.kanban) await this.assertKanbanVisible(page, target.name);
        const fileName = crmScreenshotFileName(target.name, theme);
        await page.screenshot({ path: path.join(this.outDir, fileName), fullPage: true }).catch(() => null);
        screenshots.push(fileName);
      }
    }
    this.record("CRM visual pages", { checked: targets.map((target) => target.name), themes: ["light", "dark"], screenshots });
  }

  async dueWorkContains(accountId, activityId, title, dueTo) {
    const due = await this.callTool("list_due_relationship_work", { accountId, dueTo, take: 50 });
    return due.items?.find((item) => item.id === activityId || item.title === title) ?? null;
  }

  async dueWorkMatches(accountId, title, dueTo) {
    const due = await this.callTool("list_due_relationship_work", { accountId, dueTo, take: 50 });
    return due.items?.filter((item) => item.title === title) ?? [];
  }

  async verifyChatAndWriteback(page, account) {
    const title = `${this.validationTag} CRM follow-up`;
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const dueTo = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const conversation = await this.sessionFetch(`/api/workspaces/${this.workspaceId}/conversations`, {
      method: "POST",
      body: JSON.stringify({ agentKey: "assistant", topic: this.validationTag }),
    });
    const conversationId = conversation.body.session.id;
    const conversationCleanupActionId = `delete:ConversationSession:${conversationId}`;
    this.cleanupRegistry.add({
      id: conversationCleanupActionId,
      action: "delete",
      target: { type: "ConversationSession", id: conversationId, label: this.validationTag },
      runner: async () => {
        await this.sessionFetch(`/api/workspaces/${this.workspaceId}/conversations/${conversationId}`, { method: "DELETE" });
        return "Synthetic CRM validation conversation deleted.";
      },
    });
    const context = crmPageContext(this.workspaceId, account);

    const contextAnswer = await this.chat(
      conversationId,
      `Use the current CRM page context. What CRM account am I viewing? Include this exact account id if available: ${account.id}.`,
      context,
    );
    assert(contextAnswer.includes(account.id) || contextAnswer.toLowerCase().includes(account.name.toLowerCase()), "Chat did not answer with CRM page context.");

    const dueAnswer = await this.chat(
      conversationId,
      `Use list_due_relationship_work for selected account ${account.id}. Reply with a short due-work summary.`,
      context,
    );
    assert(/due|follow|task|work|reminder/i.test(dueAnswer), "Chat due-work answer did not look grounded.");

    const askCreate = await this.chat(
      conversationId,
      `Prepare a pending CRM follow-up by calling record_relationship_activity now. Title: ${title}. Type: TASK. accountId: ${account.id}. dueAt: ${dueAt}. Return the pending operation ID for confirmation.`,
      context,
    );
    assert(/confirm|yes|go ahead|do it/i.test(askCreate), "Chat did not ask for confirmation before creating follow-up.");
    const createPendingOperationId = parsePendingOperationId(askCreate);
    assert(!(await this.dueWorkContains(account.id, null, title, dueTo)), "Follow-up was created before confirmation.");

    let createAnswer = await this.chat(conversationId, `confirm ${createPendingOperationId}`, context);
    let activity = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      activity = await this.dueWorkContains(account.id, null, title, dueTo);
      if (activity) break;
      createAnswer = await this.chat(conversationId, `confirm ${createPendingOperationId}`, context);
      await sleep(500);
    }
    assert(activity, `Chat did not create follow-up after confirmation. Last reply: ${createAnswer}`);
    const responseActivityId = parseActivityId(createAnswer);
    assert(!responseActivityId || responseActivityId === activity.id, `Chat confirmed a different activity ID (${responseActivityId}) than production created (${activity.id}).`);
    const activityCleanupActionId = `complete:CrmActivity:${activity.id}`;
    recordCreatedRecord(this.validationRun, {
      type: "CrmActivity",
      id: activity.id,
      label: title,
      tenant: workspaceTenant({ id: this.workspaceId, slug: this.workspaceSlug }),
      cleanupActionId: activityCleanupActionId,
    });
    this.cleanupRegistry.add({
      id: activityCleanupActionId,
      action: "complete",
      target: { type: "CrmActivity", id: activity.id, label: title },
      runner: async () => {
        await this.callTool("complete_relationship_activity", { activityId: activity.id, completedAt: new Date().toISOString() });
        return "CRM activity completed.";
      },
    });

    await page.goto(activity.webUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await page.getByText(title, { exact: false }).first().waitFor({ timeout: 15_000 });
    await page.screenshot({ path: path.join(this.outDir, "chat-created-follow-up.png"), fullPage: true }).catch(() => null);
    const duplicateCreateAnswer = await this.chat(conversationId, `confirm ${createPendingOperationId}`, context);
    assert(duplicateCreateAnswer.includes(createPendingOperationId), "Duplicate CRM confirmation did not return the original pending operation ID.");
    const duplicateMatches = await this.dueWorkMatches(account.id, title, dueTo);
    assert(duplicateMatches.length === 1, `Duplicate confirmation created ${duplicateMatches.length} follow-ups with title ${title}.`);

    const completeContext = crmPageContext(this.workspaceId, account, activity.id, title);
    const askComplete = await this.chat(
      conversationId,
      `Prepare a pending completion by calling complete_relationship_activity now for selected CRM follow-up ${activity.id}. Return the pending operation ID for confirmation.`,
      completeContext,
    );
    assert(/confirm|yes|go ahead|do it/i.test(askComplete), "Chat did not ask for confirmation before completing follow-up.");
    const completePendingOperationId = parsePendingOperationId(askComplete);

    let completeAnswer = await this.chat(conversationId, `confirm ${completePendingOperationId}`, completeContext);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await this.dueWorkContains(account.id, activity.id, title, dueTo))) {
        this.cleanupRegistry.markCompleted(activityCleanupActionId, "CRM activity completed by validation flow.");
        break;
      }
      completeAnswer = await this.chat(
        conversationId,
        `confirm ${completePendingOperationId}`,
        completeContext,
      );
      await sleep(500);
    }
    assert(!(await this.dueWorkContains(account.id, activity.id, title, dueTo)), `Chat did not complete follow-up after confirmation. Last reply: ${completeAnswer}`);
    this.record("chat context and safe writeback", {
      conversationId,
      activityId: activity.id,
      pendingOperationIds: [createPendingOperationId, completePendingOperationId],
    });
  }

  async cleanup() {
    const cleanup = await this.cleanupRegistry.runAll({ throwOnFailure: false });
    for (const entry of cleanup.completed) {
      this.results.push({
        name: `cleanup ${entry.action}`,
        status: "ok",
        cleanupActionId: entry.id,
        target: entry.target,
        message: entry.message,
      });
    }
    for (const { entry, error } of cleanup.failed) {
      this.results.push({
        name: `cleanup ${entry.action}`,
        status: "failed",
        cleanupActionId: entry.id,
        target: entry.target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (cleanup.failed.length > 0) {
      throw new Error(`Validation cleanup failed for ${cleanup.failed.map(({ entry }) => entry.id).join(", ")}`);
    }
  }

  recordValidationOutcome(status, error, smokeResultPath) {
    if (this.validationResultRecorded) return;
    this.validationResultRecorded = true;
    const coveredPrNumbers = this.validationRun.prNumbers.length > 0
      ? this.validationRun.prNumbers
      : [null];
    for (const prNumber of coveredPrNumbers) {
      recordValidationResult(this.validationRun, {
        ...(prNumber ? { prNumber } : {}),
        intent: "CRM pages, MCP reads, chat context, and safe writeback",
        method: "crm-production-smoke",
        result: status === "passed" ? "pass" : "partial",
        blocker: status === "passed" ? null : (error?.message ?? "CRM production smoke failed."),
        evidence: [
          { type: "json", path: smokeResultPath, summary: "CRM production smoke output" },
          ...this.results
            .filter((item) => Array.isArray(item.screenshots))
            .flatMap((item) => item.screenshots.map((fileName) => ({
              type: "screenshot",
              path: path.join(this.outDir, fileName),
              summary: fileName,
            }))),
        ],
        createdRecordIds: this.validationRun.createdRecords.map((record) => record.id),
        cleanupActionIds: this.validationRun.cleanupActions.map((entry) => entry.id),
      });
    }
  }

  async writeResult(status, error = null) {
    await mkdir(this.outDir, { recursive: true });
    const smokeResultPath = path.join(this.outDir, "crm-production-smoke.json");
    this.recordValidationOutcome(status, error, smokeResultPath);
    const validationArtifacts = await writeValidationArtifacts(this.validationRun, this.outDir);
    await writeFile(smokeResultPath, `${JSON.stringify({
      status,
      runId: this.runId,
      baseUrl: this.baseUrl,
      workspaceId: this.workspaceId,
      checkedAt: new Date().toISOString(),
      results: this.results,
      validation: {
        run: this.validationRun,
        artifacts: validationArtifacts,
      },
      error: error ? { message: error.message, stack: error.stack } : null,
    }, null, 2)}\n`);
  }

  async run() {
    await mkdir(this.outDir, { recursive: true });
    await this.verifyHealth();
    await this.login();
    await this.issueCredential();

    const accounts = await this.callTool("list_relationship_accounts", { take: 1 });
    assert(accounts.items?.length, "No CRM account was available.");
    const account = accounts.items[0];
    this.record("CRM account selected", { accountId: account.id, accountName: account.name });
    await this.verifyMcpReads(account);

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: this.headless });
    try {
      const context = await browser.newContext();
      const [cookiePart] = this.cookie.split(";");
      const eq = cookiePart.indexOf("=");
      await context.addCookies([{ name: cookiePart.slice(0, eq), value: cookiePart.slice(eq + 1), url: this.baseUrl }]);
      const page = await context.newPage();
      await this.verifyPages(page, account);
      await this.verifyChatAndWriteback(page, account);
    } finally {
      await browser.close().catch(() => null);
    }
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const [, , baseUrlArg, outDirArg] = process.argv;
  const envWorkspaceSelector = validationWorkspaceSelectorFromEnv(process.env, "CRM_SMOKE");
  const workspaceSelector = envWorkspaceSelector.explicit
    ? envWorkspaceSelector
    : { ...envWorkspaceSelector, workspaceSlug: DEMO_WORKSPACE_SLUG };
  const usePasswordAuth = workspaceSelector.explicit;
  const smoke = new CrmSmoke({
    baseUrl: baseUrlArg || process.env.CRM_SMOKE_BASE_URL || DEFAULT_BASE_URL,
    outDir: outDirArg || process.env.CRM_SMOKE_OUT_DIR || DEFAULT_OUT_DIR,
    expectedGitSha: process.env.CRM_SMOKE_EXPECTED_GIT_SHA?.trim() || null,
    workspaceSelector,
    authEmail: usePasswordAuth
      ? (process.env.CRM_SMOKE_EMAIL?.trim() || process.env.ADMIN_EMAIL?.trim() || null)
      : null,
    authPassword: usePasswordAuth
      ? (process.env.CRM_SMOKE_PASSWORD?.trim() || process.env.ADMIN_PASSWORD?.trim() || null)
      : null,
    requireSafeWorkspace: workspaceSelector.explicit,
    headless: process.env.CRM_SMOKE_HEADLESS !== "false",
    prNumbers: parseValidationPrNumbers(process.env.CRM_SMOKE_PR_NUMBERS ?? process.env.PRODUCTION_VALIDATION_PR_NUMBERS),
  });

  let failed = false;
  let fatalError = null;
  try {
    await smoke.run();
  } catch (error) {
    failed = true;
    fatalError = error;
    console.error(error);
  } finally {
    try {
      await smoke.cleanup();
    } catch (error) {
      failed = true;
      fatalError ??= error;
      console.error(error);
    }
    await smoke.writeResult(failed ? "failed" : "passed", fatalError);
  }

  if (failed) process.exit(1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  CrmSmoke,
  crmPageContext,
  crmHealthReleaseBlocker,
  crmScreenshotFileName,
  crmVisualTargets,
  evaluateKanbanSnapshot,
  normalizeBaseUrl,
  parseActivityId,
  parsePendingOperationId,
  parseSetCookie,
  parseToolResult,
  usage,
};
