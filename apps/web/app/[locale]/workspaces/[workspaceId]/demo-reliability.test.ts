import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";

const mocks = vi.hoisted(() => ({
  membership: vi.fn(),
  workspace: vi.fn(),
  archive: vi.fn(),
  audit: vi.fn(),
  summaries: vi.fn(),
  details: vi.fn(),
  feature: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor: async () => ({ kind: "user", user: { id: "synthetic-member" } }),
}));
vi.mock("@/lib/workspace-feature-flags", () => ({
  getWorkspaceFeatureFlags: async () => ({ AGENT_GOVERNANCE: true }),
  requireWorkspaceFeature: mocks.feature,
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
  usePathname: () => "/workspaces/synthetic-demo/leads",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "audit" | "leads" | "workItems") =>
    createTranslator({ locale: "en", messages, namespace }),
}));
vi.mock("@corgtex/shared", async () => {
  const { workspaceBranding } = await import("../../../../../../packages/shared/src/branding");
  return { prisma: { workspace: { findUnique: mocks.workspace } }, workspaceBranding };
});
vi.mock("./actions", () => ({
  archiveContactAction: vi.fn(), archiveCrmAccountAction: vi.fn(),
  archiveDealAction: vi.fn(), archiveActivityAction: vi.fn(), updateDealAction: vi.fn(),
  approveQualificationAction: vi.fn(), completeActivityAction: vi.fn(),
  createConversationMessageAction: vi.fn(), provisionProspectWorkspaceAction: vi.fn(),
  rejectQualificationAction: vi.fn(),
}));
vi.mock("./audit/actions", () => ({
  purgeArchivedArtifactAction: vi.fn(), restoreArchivedArtifactAction: vi.fn(),
}));
vi.mock("./leads/actions", () => ({
  archiveDealAction: vi.fn(), updateDealAction: vi.fn(),
  archiveCrmAccountAction: vi.fn(), archiveActivityAction: vi.fn(), completeActivityAction: vi.fn(),
  declineCommunicationSuggestionAction: vi.fn(), failCommunicationSuggestionAction: vi.fn(),
  markCommunicationSuggestionSentAction: vi.fn(), requestCommunicationSuggestionExecutionAction: vi.fn(),
  updateCommunicationSuggestionAction: vi.fn(),
  archiveContactAction: vi.fn(), convertCrmAccountToClientAction: vi.fn(), updateCrmAccountAction: vi.fn(),
}));
vi.mock("@/lib/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ name }: { name: string }) => React.createElement("textarea", { name }),
}));

vi.mock("@corgtex/domain", () => {
  const date = new Date("2026-01-01T12:00:00Z");
  const account = {
    id: "synthetic-account", name: "Synthetic Research Partner", domain: "example.test",
    relationshipType: "PARTNER", lifecycleStage: "ACTIVE", createdAt: date, updatedAt: date,
    _count: { contacts: 1, deals: 1 },
  };
  const contact = { id: "synthetic-contact", name: "Synthetic Contact", email: "person@example.test", account, createdAt: date };
  const deal = { id: "synthetic-deal", title: "Synthetic research pilot", stage: "PROPOSAL", valueCents: 500000, account, accountId: account.id, contact, createdAt: date, activities: [] };
  const activity = { id: "synthetic-activity", title: "Synthetic follow-up", type: "TASK", account, accountId: account.id, dueAt: date, createdAt: date };
  const suggestion = { id: "synthetic-suggestion", title: "Synthetic draft", status: "SUGGESTED", channel: "EMAIL", source: "MANUAL", bodyMd: "Synthetic draft only.", account, createdAt: date };
  const result = (items: unknown[]) => async () => ({ items, total: items.length });
  return {
    requireWorkspaceMembership: mocks.membership,
    listArchivedWorkspaceArtifacts: mocks.archive,
    listAuditLogs: mocks.audit,
    listNewspaperDeliverySummaries: mocks.summaries,
    listNewspaperDeliveryDetails: mocks.details,
    listCrmAccounts: result([account]), listContacts: result([contact]),
    getCrmAccount: async () => ({
      ...account, contacts: [contact], deals: [deal], activities: [activity],
      crmConversations: [], prospectWorkspaces: [],
    }),
    listDeals: result([deal]), listCrmActivities: result([activity]),
    listCommunicationSuggestions: result([suggestion]),
    listQualifications: result([{ id: "synthetic-qualification", companyName: "Synthetic Prospect", demoLeadId: "synthetic-lead", demoLead: { email: "prospect@example.test" }, createdAt: date }]),
    listCrmConversations: result([{ id: "synthetic-conversation", subject: "Synthetic conversation", status: "OPEN", account }]),
    listCrmProspectWorkspaces: result([]), listMembers: async () => [],
  };
});

import AuditPage from "./audit/page";
import LeadsPage from "./leads/page";
import AccountsPage from "./leads/accounts/page";
import ActivityPage from "./leads/activity/page";
import PipelinePage from "./leads/pipeline/page";
import SuggestionsPage from "./leads/suggestions/page";
import AccountDetailPage from "./leads/accounts/[accountId]/page";

const params = () => Promise.resolve({ workspaceId: "synthetic-demo", locale: "en" });
const renderAudit = async (search: Record<string, string> = {}) =>
  renderToStaticMarkup(await AuditPage({ params: params(), searchParams: Promise.resolve(search) }));
const renderLeads = async (view = "dashboard") =>
  renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC",
    children: await LeadsPage({ params: params(), searchParams: Promise.resolve({ view }) }),
  }));

const fullPages = { accounts: AccountsPage, activity: ActivityPage, pipeline: PipelinePage, suggestions: SuggestionsPage };
const renderFullPage = async (section: keyof typeof fullPages, view?: string) =>
  renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC",
    children: await fullPages[section]({ params: params(), searchParams: Promise.resolve(view ? { view } : {}) }),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  // This repository's JSX-preserving TS config needs React for node-only SSR tests.
  vi.stubGlobal("React", React);
  mocks.membership.mockResolvedValue({ role: "CONTRIBUTOR", isActive: true });
  mocks.workspace.mockResolvedValue({ slug: "jnj-demo", name: "Synthetic Demo" });
  mocks.archive.mockRejectedValue(new Error("403: Insufficient permissions"));
  mocks.audit.mockResolvedValue([{
    id: "synthetic-audit", action: "action.created", entityType: "Action",
    entityId: "synthetic-action", createdAt: new Date("2026-01-01T12:00:00Z"), meta: null,
  }]);
  mocks.summaries.mockResolvedValue([]);
  mocks.details.mockResolvedValue([]);
  mocks.feature.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

const accountDetailViews = ["overview", "contacts", "pipeline", "activity", "suggestions", "conversations", "instances"];
const renderAccountDetail = async (view = "overview") =>
  renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC",
    children: await AccountDetailPage({
    params: Promise.resolve({ ...(await params()), accountId: "synthetic-account" }),
    searchParams: Promise.resolve({ view }),
    }),
  }));

describe("Account detail read-only demo", () => {
  it.each(accountDetailViews)("keeps %s readable without mutations", async (view) => {
    const html = await renderAccountDetail(view);
    expect(html).toContain("Synthetic Research Partner");
    expect(html).toContain("Synthetic follow-up");
    expect(html).toContain("?view=contacts");
    expect(html).toContain("?view=pipeline");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("/add?");
    expect(html).not.toContain('draggable="true"');
    expect(html).not.toContain(messages.leads.btnEditAccount);
    expect(html).not.toContain(messages.leads.clientConversionButton);
  });

  it.each([
    ["overview", "name", messages.leads.btnArchiveAccount],
    ["contacts", "contactId", messages.leads.btnArchiveContact],
    ["pipeline", "stage", messages.leads.btnArchiveDeal],
    ["activity", "activityId", messages.leads.btnCompleteFollowUp],
    ["suggestions", "suggestionId", messages.leads.btnRequestExternalExecution],
  ])("retains ordinary-workspace %s actions", async (view, field, label) => {
    mocks.workspace.mockResolvedValue({ slug: "synthetic-member-workspace", name: "Synthetic Workspace" });
    const html = await renderAccountDetail(view);
    expect(html).toContain('name="' + field + '"');
    expect(html).toContain(label);
    expect(html).toContain('action="javascript:');
  });

  it("preserves membership rejection before reading workspace state", async () => {
    mocks.membership.mockRejectedValueOnce(new Error("403: NOT_A_MEMBER"));
    await expect(renderAccountDetail()).rejects.toThrow("403: NOT_A_MEMBER");
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
});

describe("Audit Trail member access", () => {
  it("renders the member decision trail without querying administrator-only archives", async () => {
    const html = await renderAudit();
    expect(html).toContain("Action");
    expect(html).not.toContain("?tab=archive");
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("rejects a direct non-admin archive URL before reading archive data", async () => {
    await expect(renderAudit({ tab: "archive" })).rejects.toThrow("404");
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("loads the archive only on the administrator archive tab", async () => {
    mocks.membership.mockResolvedValue({ role: "ADMIN", isActive: true });
    mocks.archive.mockResolvedValue([]);
    expect(await renderAudit()).toContain("?tab=archive");
    expect(mocks.archive).not.toHaveBeenCalled();
    await renderAudit({ tab: "archive", archiveEntityType: "Action" });
    expect(mocks.archive).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "synthetic-demo", entityType: "Action", take: 100,
    });
  });

  it("preserves membership rejection instead of exposing data", async () => {
    mocks.membership.mockRejectedValueOnce(new Error("403: NOT_A_MEMBER"));
    await expect(renderAudit()).rejects.toThrow("403: NOT_A_MEMBER");
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("does not conceal archive authorization or database failures for admins", async () => {
    mocks.membership.mockResolvedValue({ role: "ADMIN", isActive: true });
    await expect(renderAudit({ tab: "archive" })).rejects.toThrow("403");
  });

  it("keeps newspaper reads independent of the administrator archive", async () => {
    await renderAudit({ tab: "newspapers" });
    expect(mocks.summaries).toHaveBeenCalled();
    expect(mocks.details).toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });
});

describe("Relationships read-only demo", () => {
  const fullPageViews = [
    ["accounts", "table"], ["accounts", "list"],
    ["activity", "table"], ["activity", "list"],
    ["pipeline", "kanban"], ["pipeline", "table"], ["pipeline", "list"],
    ["suggestions", "list"], ["suggestions", "table"], ["suggestions", "kanban"],
  ] as const;
  it.each(fullPageViews)("keeps the actual %s/%s route read-only with filters available", async (section, view) => {
    const html = await renderFullPage(section, view);
    expect(html).not.toContain('action="javascript:');
    expect(html).not.toContain("/add?");
    expect(html).not.toContain('draggable="true"');
    expect(html).toContain("<form");
  });

  it.each([["accounts", "table"], ["activity", "table"], ["pipeline", "kanban"], ["suggestions", "list"]] as const)(
    "retains actual %s/%s route mutations outside the demo", async (section, view) => {
      mocks.workspace.mockResolvedValue({ slug: "synthetic-member-workspace", name: "Synthetic Workspace" });
      expect(await renderFullPage(section, view)).toContain('action="javascript:');
    },
  );
  it.each(["dashboard", "accounts", "contacts", "pipeline", "activity", "suggestions", "review", "conversations", "instances"])(
    "renders %s without mutation forms, add links or draggable deals", async (view) => {
      const html = await renderLeads(view);
      expect(html).not.toContain("<form");
      expect(html).not.toContain("/add?");
      expect(html).not.toContain('draggable="true"');
      expect(html).not.toContain(messages.leads.btnReplyConversation);
      expect(html).not.toContain(messages.leads.btnProvisionInstance);
      expect(html).toContain("Relationships");
    },
  );

  it("preserves visible activities and navigation in the demo dashboard", async () => {
    const html = await renderLeads();
    expect(html).toContain("Synthetic follow-up");
    expect(html).toContain("Synthetic Research Partner");
    expect(html).toContain("/leads/activity");
    expect(html).not.toContain(">Complete<");
    expect(html).not.toContain(">Archive activity<");
  });

  it.each(["dashboard", "accounts", "contacts", "pipeline", "suggestions", "review", "conversations", "instances"])(
    "retains ordinary workspace controls in %s", async (view) => {
      mocks.workspace.mockResolvedValue({ slug: "synthetic-member-workspace", name: "Synthetic Workspace" });
      expect(await renderLeads(view)).toContain("<form");
    },
  );

  it("preserves the Relationships feature gate", async () => {
    mocks.feature.mockRejectedValueOnce(new Error("NEXT_HTTP_ERROR_FALLBACK;404"));
    await expect(renderLeads()).rejects.toThrow("404");
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
});

// Opt-in browser proof uses real page markup and styles with only synthetic domain data.
it.runIf(process.env.DEMO_UI_PROOF === "1")("captures bounded synthetic browser proof", async () => {
  const { createServer } = await import("node:http");
  const { readFile, mkdir, writeFile } = await import("node:fs/promises");
  const { chromium } = await import("playwright");
  const output = new URL("../../../../../../.artifacts/demo-reliability/", import.meta.url);
  await mkdir(output, { recursive: true });
  const styleRoot = new URL("../../../globals.css", import.meta.url);
  const globals = await readFile(styleRoot, "utf8");
  const importedStyles = await Promise.all(
    [...globals.matchAll(/@import "([^"]+)";/g)].map((match) => readFile(new URL(match[1], styleRoot), "utf8")),
  );
  let styleIndex = 0;
  const expandedCss = globals.replace(/@import "[^"]+";/g, () => importedStyles[styleIndex++]);
  const pages = new Map<string, string>();
  for (const view of ["dashboard", "accounts", "contacts", "pipeline", "activity", "suggestions", "review", "conversations", "instances"]) {
    pages.set(view, await renderLeads(view));
  }
  for (const section of Object.keys(fullPages) as Array<keyof typeof fullPages>) {
    pages.set(section, await renderFullPage(section));
  }
  for (const view of accountDetailViews) {
    pages.set("account:" + view, await renderAccountDetail(view));
  }
  pages.set("audit", await renderAudit());
  const { default: postcss } = await import("postcss");
  const { default: tailwindcss } = await import("tailwindcss");
  const { default: tailwindConfig } = await import("../../../../tailwind.config");
  const { css } = await postcss([tailwindcss({
    ...tailwindConfig,
    content: [{ raw: [...pages.values()].join("\n"), extension: "html" }],
  })]).process(expandedCss, { from: styleRoot.pathname });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const section = url.pathname.split("/leads/")[1];
    const key = section === "accounts/synthetic-account"
      ? "account:" + (url.searchParams.get("view") ?? "overview")
      : url.pathname.endsWith("/audit") ? "audit" : section ?? url.searchParams.get("view") ?? "dashboard";
    if (request.method !== "GET" || !pages.has(key)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic demo reliability proof</title><style>'
      + css + ':root{--font-inter:Arial;--font-document:Georgia;--font-playfair:Georgia}</style></head><body><main style="max-width:1200px;margin:auto;padding:24px">'
      + '<p class="demo-banner">Synthetic read-only demo</p>'
      + '<nav><a href="/workspaces/synthetic-demo/audit">Audit Trail</a> | <a href="/workspaces/synthetic-demo/leads">Relationships</a></nav>'
      + pages.get(key) + "</main></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No synthetic server address");
  const base = "http://127.0.0.1:" + address.port;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.DEMO_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const context = await browser.newContext();
    await context.route("**/*", (route) =>
      route.request().url().startsWith(base + "/") ? route.continue() : route.abort());
    const page = await context.newPage();
    const results = [];
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(base + "/workspaces/synthetic-demo/leads");
      expect(await page.getByText("Synthetic follow-up", { exact: true }).count()).toBeGreaterThan(0);
      expect(await page.locator("form").count()).toBe(0);
      await page.screenshot({ path: new URL("relationships-" + viewport.width + ".png", output).pathname, fullPage: true });
      await page.getByRole("link", { name: messages.leads.tabPipeline, exact: true }).click();
      expect(await page.locator('form[action^="javascript:"], [draggable="true"], a[href*="/add?"]').count()).toBe(0);
      expect(await page.getByText("Synthetic research pilot", { exact: true }).count()).toBe(1);
      await page.screenshot({ path: new URL("pipeline-" + viewport.width + ".png", output).pathname, fullPage: true });
      await page.getByRole("link", { name: "Audit Trail", exact: true }).click();
      expect(await page.getByRole("heading", { name: messages.audit.pageTitle, exact: true }).count()).toBe(1);
      expect(await page.locator('a[href*="tab=archive"], form').count()).toBe(0);
      await page.screenshot({ path: new URL("audit-" + viewport.width + ".png", output).pathname, fullPage: true });
      await page.getByRole("link", { name: "Relationships", exact: true }).click();
      await page.getByRole("link", { name: messages.leads.openDetail, exact: true }).first().click();
      expect(new URL(page.url()).pathname).toBe("/workspaces/synthetic-demo/leads/accounts/synthetic-account");
      for (const view of ["overview", "contacts", "pipeline", "activity", "suggestions"]) {
        await page.locator('.nr-filter-bar a[href="?view=' + view + '"]').click();
        expect(await page.getByRole("heading", { name: "Synthetic Research Partner", exact: true }).count()).toBe(1);
        expect(await page.locator('form, [draggable="true"], a[href*="/add?"]').count()).toBe(0);
        expect(await page.getByRole("button", { name: messages.leads.btnCompleteFollowUp, exact: true }).count()).toBe(0);
        if (view === "contacts") expect(await page.getByText("Synthetic Contact", { exact: true }).count()).toBe(1);
        if (view === "pipeline") expect(await page.getByText("Synthetic research pilot", { exact: true }).count()).toBe(1);
        if (view === "suggestions") expect(await page.getByRole("textbox").inputValue()).toBe("Synthetic draft only.");
        await page.screenshot({ path: new URL("account-" + view + "-" + viewport.width + ".png", output).pathname, fullPage: true });
      }
      results.push({ viewport, relationships: "passed", pipeline: "passed", audit: "passed", accountDetail: "passed: Open link, overview, contacts, pipeline, activity, suggestions" });
    }
    await writeFile(new URL("results.json", output), JSON.stringify({
      mode: "synthetic SSR: actual page components and CSS, mocked domain/auth; no Next runtime or client hydration",
      results,
    }, null, 2));
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
