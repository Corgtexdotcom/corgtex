import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import FindAccountPage from "./page";

const fixture = vi.hoisted(() => ({ pendingHref: "", locale: "en" as "en" | "es" }));
vi.mock("next/link", async importOriginal => {
  const { default: Link } = await importOriginal<typeof import("next/link")>();
  const status = React.createContext({ pending: false });
  return {
    default: (props: React.ComponentProps<typeof Link>) => React.createElement(Link, props,
      React.createElement(status.Provider, { value: { pending: props.href === fixture.pendingHref } }, props.children)),
    useLinkStatus: () => React.useContext(status),
  };
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "fixture" }) }) }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => createTranslator({ locale: fixture.locale, messages: fixture.locale === "es" ? es : en, namespace: "auth" }),
}));
vi.mock("@corgtex/domain", () => ({
  resolveSessionActor: async () => ({ kind: "user" }), hasActiveWorkspaceSupport: async () => false,
  listActorWorkspaces: async () => [{ id: "first", name: "First workspace", slug: "first-slug" }, { id: "second", name: "Second workspace", slug: "second-slug" }],
}));
vi.mock("@corgtex/shared", () => ({ sessionCookieName: () => "session" }));
vi.mock("@/lib/deployment-workspace-scope", () => ({ filterWorkspacesForDeploymentScope: (rows: unknown) => rows }));
vi.mock("./FindAccountForm", () => ({ FindAccountForm: () => null }));

vi.stubGlobal("React", React);
afterEach(() => { fixture.pendingHref = ""; });

it.each([
  ["en", "/workspaces/first", "Opening First workspace…"],
  ["es", "/es/workspaces/first", "Abriendo First workspace…"],
] as const)("keeps the %s link navigable and reports only the pending workspace", async (locale, href, label) => {
  fixture.locale = locale;
  const page = await FindAccountPage({ params: Promise.resolve({ locale }) });
  const idle = renderToStaticMarkup(page);
  expect(idle).toContain(`href="${href}"`);
  expect(idle).toContain("first-slug");
  expect(idle).not.toContain(label);

  fixture.pendingHref = href;
  const pending = renderToStaticMarkup(page);
  expect(pending).toContain(`href="${href}"`);
  expect(pending).toContain(`role="status">${label}</span>`);
  expect(pending).not.toContain("first-slug");
  expect(pending).toContain("second-slug");

  fixture.pendingHref = "";
  expect(renderToStaticMarkup(page)).toBe(idle);
});
