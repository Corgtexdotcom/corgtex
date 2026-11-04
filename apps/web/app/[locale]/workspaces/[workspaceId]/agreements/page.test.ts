import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import messages from "@/messages/en.json";
import esMessages from "@/messages/es.json";

const mocks = vi.hoisted(() => ({ agreements: vi.fn(), locale: "en" as "en" | "es" }));

vi.mock("@/lib/auth", () => ({
  requirePageActor: async () => ({ kind: "user", user: { id: "synthetic-member" } }),
}));
vi.mock("@corgtex/domain", () => ({ listWorkspaceAgreements: mocks.agreements }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "agreements") => createTranslator({
    locale: mocks.locale,
    messages: mocks.locale === "es" ? esMessages : messages,
    namespace,
  }),
}));

import AgreementsPage from "./page";

const currentConstitution = {
  id: "constitution-1",
  version: 1,
  bodyMd: "# Constitution\n\n## 1. Supported point",
  createdAt: new Date("2026-08-10T00:00:00.000Z"),
  sourceReferences: [
    { pointOrder: 1, sourceOrder: 1, sourceKind: "PROPOSAL", targetId: "proposal-1", title: "Visible proposal" },
    { pointOrder: 1, sourceOrder: 2, sourceKind: "TENSION", targetId: "tension-1", title: "Visible tension" },
  ],
};

describe("Agreements Constitution origins", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    mocks.locale = "en";
    mocks.agreements.mockReset().mockResolvedValue({
      currentConstitution,
      constitutionVersions: [currentConstitution],
      policyCorpus: [],
      brainArticles: [],
      policyWindow: {complete: true, nextCursor: null, continued: false},
    });
  });

  it("renders point-grouped links only from authorized returned sources", async () => {
    const html = renderToStaticMarkup(await AgreementsPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }) }));

    expect(html).toContain("Sources by Constitution point");
    expect(html).toContain("Point 1");
    expect(html).toContain('href="/workspaces/synthetic-workspace/proposals/proposal-1"');
    expect(html).toContain('href="/workspaces/synthetic-workspace/tensions/tension-1"');
    expect(html).toContain("Visible proposal");
    expect(html).toContain("Visible tension");
  });

  it("does not infer origin links for an older Constitution without references", async () => {
    mocks.agreements.mockResolvedValue({
      currentConstitution: { ...currentConstitution, sourceReferences: [] },
      constitutionVersions: [currentConstitution],
      policyCorpus: [],
      brainArticles: [],
      policyWindow: {complete: true, nextCursor: null, continued: false},
    });

    const html = renderToStaticMarkup(await AgreementsPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }) }));
    expect(html).toContain("Supported point");
    expect(html).not.toContain("Sources by Constitution point");
    expect(html).not.toContain("Visible proposal");
  });

  it("renders grouped origins with Spanish labels", async () => {
    mocks.locale = "es";

    const html = renderToStaticMarkup(await AgreementsPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }) }));

    expect(html).toContain("Fuentes por punto de la Constitución");
    expect(html).toContain("Punto 1");
    expect(html).toContain('href="/workspaces/synthetic-workspace/proposals/proposal-1"');
  });

  it("keeps an accepted policy visible without disclosing an unavailable proposal origin", async () => {
    mocks.agreements.mockResolvedValue({
      currentConstitution: { ...currentConstitution, sourceReferences: [] },
      constitutionVersions: [currentConstitution],
      policyCorpus: [{ id: "policy-1", title: "Accepted public policy", bodyMd: "Policy body", acceptedAt: new Date("2026-08-10"), circle: null, proposal: null }],
      brainArticles: [],
      policyWindow: {complete: true, nextCursor: null, continued: false},
    });

    const html = renderToStaticMarkup(await AgreementsPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }) }));

    expect(html).toContain("Accepted public policy");
    expect(html).not.toContain("hidden-proposal");
    expect(html).not.toContain("/proposals/undefined");
  });
  it("keeps hidden-window continuation and the selected circle when absent from displayed rows", async () => {
    mocks.agreements.mockResolvedValue({currentConstitution: null, constitutionVersions: [], policyCorpus: [], brainArticles: [],
      policyWindow: {complete: false, nextCursor: "older-window", continued: true}});
    const html = renderToStaticMarkup(await AgreementsPage({params: Promise.resolve({workspaceId: "synthetic-workspace"}),
      searchParams: Promise.resolve({category: "policies", scope: "circle-hidden-window", policyCursor: "incoming"})}));
    expect(mocks.agreements).toHaveBeenCalledWith(expect.anything(), {workspaceId: "synthetic-workspace", policyScope: "circle-hidden-window", policyCursor: "incoming"});
    expect(html).toContain("No visible policies in this window.");
    expect(html).toContain("Counts describe the displayed window.");
    expect(html).toContain("category=policies&amp;scope=circle-hidden-window&amp;policyCursor=older-window");
    expect(html).toContain("Back to latest policies");
    expect(html).not.toContain(messages.agreements.noPolicies);
  });

  it.runIf(process.env.AGREEMENTS_WINDOW_BROWSER_QA === "1")("navigates an empty hidden policy window without losing its scope", async () => {
    const {createServer} = await import("node:http");
    const {mkdir, readFile} = await import("node:fs/promises");
    const {chromium} = await import("playwright");
    mocks.agreements.mockImplementation(async (_actor, options) => ({currentConstitution: null, constitutionVersions: [], brainArticles: [],
      policyCorpus: options.policyCursor === "older-window" ? [{id: "allowed", title: "Visible older policy", bodyMd: "Permitted policy", acceptedAt: new Date(), circle: {id: "circle-a", name: "Circle A"}, proposal: null}] : [],
      policyWindow: options.policyCursor === "older-window" ? {complete: true, nextCursor: null, continued: true} : {complete: false, nextCursor: "older-window", continued: false}}));
    const css = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/animations.css", "styles/pages.css"].map(path => readFile(`apps/web/app/${path}`, "utf8")))).join("\n");
    const server = createServer(async (request,response) => {
      try {
        const url = new URL(request.url!, "http://127.0.0.1");
        const markup = renderToStaticMarkup(await AgreementsPage({params: Promise.resolve({workspaceId: "synthetic-workspace"}), searchParams: Promise.resolve(Object.fromEntries(url.searchParams))}));
        response.setHeader("Content-Type", "text/html; charset=utf-8");response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head><body>${markup}</body></html>`);
      } catch(error) {response.writeHead(500).end(String(error));}
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({headless: true});
    try {
      const page = await browser.newPage();
      await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(`${origin}/workspaces/synthetic-workspace/agreements?category=policies&scope=circle-a`);
      await page.getByText(messages.agreements.noPoliciesInWindow,{exact: true}).waitFor();
      await page.getByRole("link",{name: "Older policies", exact: true}).click();
      await page.getByText("Visible older policy",{exact: true}).waitFor();
      expect(new URL(page.url()).searchParams.get("scope")).toBe("circle-a");
      expect(new URL(page.url()).searchParams.get("category")).toBe("policies");
      await mkdir(".artifacts/source-bb-agreements",{recursive: true});
      await page.screenshot({path: ".artifacts/source-bb-agreements/continued.png",fullPage:true});
      await page.getByRole("link",{name:"Back to latest policies",exact:true}).click();
      expect(new URL(page.url()).searchParams.has("policyCursor")).toBe(false);
      expect(new URL(page.url()).searchParams.get("scope")).toBe("circle-a");
    } finally {await browser.close();await new Promise<void>(resolve => server.close(() => resolve()));}
  });

});
