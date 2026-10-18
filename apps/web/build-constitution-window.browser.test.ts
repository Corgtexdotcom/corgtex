import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {createServer} from "node:http";
import {readFile, mkdir} from "node:fs/promises";
import {expect, it, vi} from "vitest";
import messages from "./messages/en.json";

const state = vi.hoisted(() => ({build: vi.fn(), constitution: vi.fn()}));
vi.mock("@corgtex/domain", () => ({DigestReadRelease: class { async finish<T>(value: T) { return value; } }, listBuildArtifactPage: state.build, listConstitutionVersionPage: state.constitution,
  requireWorkspaceMembership: async () => ({}), listPolicyCorpus: async () => [], getApprovalPolicies: async () => [],
  getLatestGovernanceScore: async () => null, listGovernanceScores: async () => [], getCurrentConstitution: async () => null}));
vi.mock("@corgtex/shared", () => ({prisma: {workspace: {findUnique: async () => ({slug: "synthetic"})}}}));
vi.mock("@/lib/auth", () => ({requirePageActor: async () => ({kind: "user", user: {id: "synthetic"}})}));
vi.mock("@/lib/workspace-feature-flags", () => ({requireWorkspaceFeature: async () => {}}));
vi.mock("./app/[locale]/workspaces/[workspaceId]/actions", () => ({updateApprovalPolicyAction: () => {}, recalculateGovernanceScoreAction: () => {}, triggerAgentRunAction: () => {}}));
vi.mock("next/navigation", () => ({useRouter: () => ({refresh: () => {}})}));
vi.mock("next-intl", () => ({useTranslations: (section: keyof typeof messages) => translator(section)}));
vi.mock("next-intl/server", () => ({getTranslations: async (section: keyof typeof messages) => translator(section)}));
vi.mock("@/lib/components/MarkdownEditor", () => ({MarkdownEditor: () => null}));
vi.mock("@/lib/components/MarkdownRenderer", () => ({MarkdownRenderer: ({markdown}: {markdown: string}) => React.createElement("div", null, markdown), MarkdownExcerpt: ({markdown}: {markdown: string}) => React.createElement("div", null, markdown)}));
function translator(section: keyof typeof messages) {
  return (key: string, values: Record<string, unknown> = {}) => String((messages[section] as Record<string, unknown>)[key] ?? key)
    .replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? ""));
}
import BuiltPage from "./app/[locale]/workspaces/[workspaceId]/built/page";
import GovernancePage from "./app/[locale]/workspaces/[workspaceId]/governance/page";

it.runIf(process.env.HISTORY_WINDOW_BROWSER_QA === "1")("renders actual Built and Governance pages with hidden-window continuation and scoped reset", async () => {
  Object.assign(globalThis, {React});
  const date = new Date("2026-01-01T00:00:00Z");
  const artifact = {id: "visible-build", workspaceId: "synthetic", title: "Older readable build", repositoryOwner: "synthetic", repositoryName: "product",
    status: "MERGED", classification: "INTERNAL", visibility: "PRIVATE", canManage: false, summaryMd: "Synthetic proof", createdBy: null,
    createdAt: date, updatedAt: date, mergedAt: date, closedAt: null, publicEnabledAt: null, publicRevokedAt: null, assets: []};
  state.build.mockImplementation(async (_actor, args) => args.cursor
    ? {items: [artifact], complete: true, nextCursor: null, hasMore: false}
    : {items: [], complete: false, nextCursor: "older-build", hasMore: true});
  state.constitution.mockImplementation(async (_actor, _workspaceId, args) => {
    if (args.cursor === "unavailable") throw new Error("Synthetic unavailable");
    return args.cursor ? {items: [{id: "older-version", version: 1, createdAt: date, modelUsed: "synthetic", diffSummary: "Earlier readable version"}], complete: true, nextCursor: null}
      : {items: [], complete: false, nextCursor: "older-constitution"};
  });
  const css = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/pages.css"].map(path => readFile(new URL(`./app/${path}`, import.meta.url), "utf8")))).join("\n");
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://localhost");
      const params = Promise.resolve({workspaceId: "synthetic"});
      const view = url.pathname.endsWith("/built")
        ? await BuiltPage({params, searchParams: Promise.resolve({cursor: url.searchParams.get("cursor") ?? undefined})})
        : await GovernancePage({params, searchParams: Promise.resolve({constitutionCursor: url.searchParams.get("constitutionCursor") ?? undefined})});
      response.writeHead(200, {"Content-Type": "text/html;charset=utf-8"}).end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main style="padding:20px;max-width:1100px;margin:auto">${renderToStaticMarkup(view)}</main></body></html>`);
    })().catch(error => response.writeHead(500).end(String(error)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const {chromium} = await import("playwright"); const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await mkdir(".artifacts/source-7749-build-constitution", {recursive: true});
    for (const width of [1100,390]) {
      await page.setViewportSize({width, height: 900});
      for (const kind of ["built", "governance"] as const) {
        const labels = messages[kind]; const path = `/en/workspaces/synthetic/${kind}`;
        await page.goto(origin + path);
        await page.getByText(labels.historyLimited, {exact: true}).first().waitFor();
        if (kind === "built") expect(await page.getByText(messages.built.emptyTitle, {exact: true}).count()).toBe(0);
        await page.screenshot({path: `.artifacts/source-7749-build-constitution/${kind}-hidden-${width}.png`, fullPage: true});
        await page.getByRole("link", {name: labels.historyOlder, exact: true}).click();
        expect(new URL(page.url()).pathname).toBe(path);
        if (kind === "built") await page.getByText("Older readable build", {exact: true}).first().waitFor();
        else { await page.getByText("Versions in this window (1)", {exact: true}).click(); await page.getByText("Earlier readable version", {exact: true}).waitFor(); }
        expect(await page.getByRole("link", {name: labels.historyOlder, exact: true}).count()).toBe(0);
        await page.screenshot({path: `.artifacts/source-7749-build-constitution/${kind}-older-${width}.png`, fullPage: true});
        await page.getByRole("link", {name: labels.historyLatest, exact: true}).click();
        expect(new URL(page.url()).search).toBe("");
        expect(await page.getByRole("link", {name: labels.historyOlder, exact: true}).isVisible()).toBe(true);
      }
    }
    await page.goto(`${origin}/en/workspaces/synthetic/governance?constitutionCursor=unavailable`);
    await page.getByText(messages.governance.historyUnavailable, {exact: true}).waitFor();
    expect(await page.getByText(messages.governance.historyEmpty, {exact: true}).count()).toBe(0);
    expect(state.build.mock.calls.every(([_actor,args])=>args.workspaceId === "synthetic")).toBe(true);
    expect(state.constitution.mock.calls.every(([_actor,workspaceId])=>workspaceId === "synthetic")).toBe(true);
  } finally {await browser.close(); await new Promise<void>(resolve => server.close(() => resolve()));}
},60_000);
