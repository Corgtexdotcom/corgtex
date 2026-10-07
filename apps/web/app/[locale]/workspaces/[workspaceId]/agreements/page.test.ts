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
    });

    const html = renderToStaticMarkup(await AgreementsPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }) }));

    expect(html).toContain("Accepted public policy");
    expect(html).not.toContain("hidden-proposal");
    expect(html).not.toContain("/proposals/undefined");
  });
});
