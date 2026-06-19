import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://app.corgtex.com";
const DEFAULT_OUT_DIR = ".artifacts/crm-production-smoke";

function usage() {
  return [
    "usage: node scripts/crm-production-smoke.mjs [base-url] [out-dir]",
    "",
    "Runs a production-safe CRM smoke against a test/demo workspace.",
    "Default auth uses /api/auth/demo-login; no local E2E credentials are read.",
    "",
    "Environment:",
    "  CRM_SMOKE_EXPECTED_GIT_SHA  optional /api/health release SHA to require",
    "  CRM_SMOKE_WORKSPACE_SLUG    workspace slug to select after login, default jnj-demo",
    "  CRM_SMOKE_HEADLESS          false to show Chromium, default true",
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
  constructor({ baseUrl, outDir, expectedGitSha, workspaceSlug, headless }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.outDir = path.resolve(outDir || DEFAULT_OUT_DIR);
    this.expectedGitSha = expectedGitSha || null;
    this.workspaceSlug = workspaceSlug || "jnj-demo";
    this.headless = headless;
    this.runId = `crm-smoke-${Date.now().toString(36)}`;
    this.cookie = null;
    this.workspaceId = null;
    this.credentialId = null;
    this.mcpToken = null;
    this.activityIdForCleanup = null;
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
      const actual = body.release?.gitSha || body.release?.imageTag;
      assert(actual === this.expectedGitSha, `/api/health release ${actual} did not match ${this.expectedGitSha}`);
    }
    this.record("health", { gitSha: body.release?.gitSha ?? null });
  }

  async loginDemo() {
    const response = await fetch(`${this.baseUrl}/api/auth/demo-login`, { method: "POST" });
    const text = await response.text();
    const body = JSON.parse(text);
    assert(response.ok, `/api/auth/demo-login failed ${response.status}: ${text.slice(0, 300)}`);
    this.cookie = parseSetCookie(response.headers.get("set-cookie"));
    this.workspaceId = body.workspaceId;

    const session = await this.sessionFetch("/api/session");
    const workspace = session.body.workspaces.find((item) => item.slug === this.workspaceSlug || item.id === this.workspaceId);
    assert(workspace, `Workspace ${this.workspaceSlug} was not available after demo login.`);
    this.workspaceId = workspace.id;
    this.record("demo login", { workspaceId: this.workspaceId, workspaceSlug: workspace.slug ?? null });
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
    this.record("temporary MCP credential issued", { credentialId: this.credentialId });
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

  async verifyPages(page, account) {
    const routes = [
      ["dashboard", `/workspaces/${this.workspaceId}/leads`],
      ["accounts", `/workspaces/${this.workspaceId}/leads/accounts`],
      ["pipeline", `/workspaces/${this.workspaceId}/leads/pipeline`],
      ["activity", `/workspaces/${this.workspaceId}/leads/activity`],
      ["suggestions", `/workspaces/${this.workspaceId}/leads/suggestions`],
      ["account-detail", `/workspaces/${this.workspaceId}/leads/accounts/${account.id}`],
    ];
    for (const [name, route] of routes) {
      const response = await page.goto(`${this.baseUrl}${route}`, { waitUntil: "networkidle", timeout: 30_000 });
      assert((response?.status() ?? 0) < 400, `${name} returned HTTP ${response?.status() ?? 0}`);
      if (name === "account-detail") {
        await page.getByText(account.name, { exact: false }).first().waitFor({ timeout: 10_000 });
      }
      await page.screenshot({ path: path.join(this.outDir, `${name}.png`), fullPage: true }).catch(() => null);
    }
    this.record("CRM pages", { checked: routes.map(([name]) => name) });
  }

  async dueWorkContains(accountId, activityId, title, dueTo) {
    const due = await this.callTool("list_due_relationship_work", { accountId, dueTo, take: 50 });
    return due.items?.find((item) => item.id === activityId || item.title === title) ?? null;
  }

  async verifyChatAndWriteback(page, account) {
    const title = `CRM production smoke follow-up ${this.runId}`;
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const dueTo = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const conversation = await this.sessionFetch(`/api/workspaces/${this.workspaceId}/conversations`, {
      method: "POST",
      body: JSON.stringify({ agentKey: "assistant", topic: `CRM production smoke ${this.runId}` }),
    });
    const conversationId = conversation.body.session.id;
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
      `I want a CRM follow-up created with record_relationship_activity. Title: ${title}. Type: TASK. accountId: ${account.id}. dueAt: ${dueAt}. Ask me to confirm before calling the tool.`,
      context,
    );
    assert(/confirm|yes|go ahead|do it/i.test(askCreate), "Chat did not ask for confirmation before creating follow-up.");
    assert(!(await this.dueWorkContains(account.id, null, title, dueTo)), "Follow-up was created before confirmation.");

    let createAnswer = await this.chat(conversationId, "yes, do it", context);
    let activity = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      activity = await this.dueWorkContains(account.id, null, title, dueTo);
      if (activity) break;
      createAnswer = await this.chat(conversationId, "confirm, create the CRM follow-up now", context);
      await sleep(500);
    }
    assert(activity, `Chat did not create follow-up after confirmation. Last reply: ${createAnswer}`);
    this.activityIdForCleanup = activity.id;

    await page.goto(activity.webUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await page.getByText(title, { exact: false }).first().waitFor({ timeout: 15_000 });
    await page.screenshot({ path: path.join(this.outDir, "chat-created-follow-up.png"), fullPage: true }).catch(() => null);

    const completeContext = crmPageContext(this.workspaceId, account, activity.id, title);
    const askComplete = await this.chat(
      conversationId,
      `Complete the selected CRM follow-up ${activity.id}. Ask me to confirm before calling complete_relationship_activity.`,
      completeContext,
    );
    assert(/confirm|yes|go ahead|do it/i.test(askComplete), "Chat did not ask for confirmation before completing follow-up.");

    let completeAnswer = await this.chat(conversationId, `yes, call complete_relationship_activity for activityId ${activity.id} now`, completeContext);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await this.dueWorkContains(account.id, activity.id, title, dueTo))) {
        this.activityIdForCleanup = null;
        break;
      }
      completeAnswer = await this.chat(
        conversationId,
        `MCP verification still shows activity ${activity.id} open. This write is confirmed. Call complete_relationship_activity with activityId ${activity.id} now.`,
        completeContext,
      );
      await sleep(500);
    }
    assert(!(await this.dueWorkContains(account.id, activity.id, title, dueTo)), `Chat did not complete follow-up after confirmation. Last reply: ${completeAnswer}`);
    this.record("chat context and safe writeback", { conversationId, activityId: activity.id });
  }

  async cleanup() {
    if (this.activityIdForCleanup && this.mcpToken) {
      try {
        await this.callTool("complete_relationship_activity", { activityId: this.activityIdForCleanup, completedAt: new Date().toISOString() });
        this.record("cleanup completed leftover activity", { activityId: this.activityIdForCleanup });
      } catch (error) {
        this.results.push({ name: "cleanup activity", status: "failed", message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.workspaceId && this.credentialId && this.cookie) {
      await this.sessionFetch(`/api/workspaces/${this.workspaceId}/agent-credentials/${this.credentialId}/revoke`, { method: "POST" });
      this.record("temporary MCP credential revoked", { credentialId: this.credentialId });
    }
  }

  async writeResult(status, error = null) {
    await mkdir(this.outDir, { recursive: true });
    await writeFile(path.join(this.outDir, "crm-production-smoke.json"), `${JSON.stringify({
      status,
      runId: this.runId,
      baseUrl: this.baseUrl,
      workspaceId: this.workspaceId,
      checkedAt: new Date().toISOString(),
      results: this.results,
      error: error ? { message: error.message, stack: error.stack } : null,
    }, null, 2)}\n`);
  }

  async run() {
    await mkdir(this.outDir, { recursive: true });
    await this.verifyHealth();
    await this.loginDemo();
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
  const smoke = new CrmSmoke({
    baseUrl: baseUrlArg || process.env.CRM_SMOKE_BASE_URL || DEFAULT_BASE_URL,
    outDir: outDirArg || process.env.CRM_SMOKE_OUT_DIR || DEFAULT_OUT_DIR,
    expectedGitSha: process.env.CRM_SMOKE_EXPECTED_GIT_SHA?.trim() || null,
    workspaceSlug: process.env.CRM_SMOKE_WORKSPACE_SLUG?.trim() || "jnj-demo",
    headless: process.env.CRM_SMOKE_HEADLESS !== "false",
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

export { CrmSmoke, crmPageContext, normalizeBaseUrl, parseSetCookie, parseToolResult, usage };
