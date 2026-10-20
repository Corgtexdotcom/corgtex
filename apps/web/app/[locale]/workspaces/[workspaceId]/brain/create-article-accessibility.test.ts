import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";

const current = vi.hoisted(() => ({ locale: "en" as "en" | "es" }));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "brain") => {
    const { createTranslator } = await import("next-intl");
    const messages = current.locale === "en"
      ? (await import("@/messages/en.json")).default
      : (await import("@/messages/es.json")).default;
    return createTranslator({ locale: current.locale, messages, namespace });
  },
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor: async () => ({ kind: "user", user: { id: "synthetic-user" } }),
}));

vi.mock("@corgtex/domain", () => ({
  requireWorkspaceMembership: async () => ({ id: "synthetic-member", role: "ADMIN" }),
  listArticles: async () => ({ items: [] }),
  listMeetings: async () => [],
  listDocuments: async () => [],
  resolveKnowledgeAccessDomains: async () => [],
  readableArtifactIds: async () => new Set(),
}));

// This render fixture supplies an empty backend result. The real count helper's
// admission/release behavior is covered by article-type-counts and PG tests.
vi.mock("./article-type-counts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./article-type-counts")>(),
  listBrainArticleTypeCounts: vi.fn(async () => ({counts:[],complete:true})),
  listBrainPendingSourceCount: vi.fn(async () => ({count:0,complete:true})),
}));

vi.mock("@corgtex/knowledge", () => ({
  answerKnowledgeQuestion: async () => null,
  searchIndexedKnowledge: async () => [],
}));

vi.mock("@corgtex/shared", () => ({
  prisma: { brainArticle: { findMany: async () => [] } },
}));

vi.mock("../KnowledgeFileUploader", () => ({ KnowledgeFileUploader: () => null }));
vi.mock("./actions", () => ({
  createArticleAction: async () => undefined,
  publishArticleAction: async () => undefined,
  returnArticleToDraftAction: async () => undefined,
}));

import BrainPage from "./page";

describe("Brain Create Article accessible names", () => {
  it.each(["en", "es"] as const)("names type and authority selects in %s", async (locale) => {
    current.locale = locale;
    const tree = await BrainPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }) });
    // next-intl requires children in the provider props type for this server render fixture.
    // eslint-disable-next-line react/no-children-prop
    const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale, messages: locale === "en" ? en : es, timeZone: "UTC", children: tree }));
    const t = createTranslator({ locale, messages: locale === "en" ? en : es, namespace: "brain" });

    expect(html).toContain(`<select name="type" aria-label="${t("labelType")}">`);
    expect(html).toContain(`<select name="authority" aria-label="${t("labelAuthority")}">`);
    expect(html).toContain('name="bodyMd"');
    expect(html).toContain('name="workspaceId" value="synthetic-workspace"');
  });
});
