import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, describe, expect, it, vi } from "vitest";
import en from "../../../../../messages/en.json";
import es from "../../../../../messages/es.json";
import { UserSettingsPanel } from "./UserSettingsPanel";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  updateProfileAction: vi.fn(),
  updateNotificationPrefAction: vi.fn(),
  updateMemberNewspaperCadenceAction: vi.fn(),
}));

const profile = {
  user: { displayName: "Synthetic member", email: "member@example.test" },
  member: null,
};

function renderPanel(locale: "en" | "es", count = 1) {
  // next-intl requires children in the provider props type for this server fixture.
  // eslint-disable-next-line react/no-children-prop
  return renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale, timeZone: "UTC", messages: locale === "en" ? en : es,
    children: Array.from({ length: count }, (_, key) => React.createElement(UserSettingsPanel, {
      key, workspaceId: "synthetic-workspace", profile, sessions: [], preferences: [], slackConnected: false,
    })),
  }));
}

describe("User settings accessibility", () => {
  it.each(["en", "es"] as const)("associates every profile and delivery control with its visible %s label", (locale) => {
    const html = renderPanel(locale);
    const labels = new Map([...html.matchAll(/<label[^>]*for="([^"]+)"[^>]*>([^<]+)<\/label>/g)].map((match) => [match[1], match[2]]));
    const controls = [...html.matchAll(/<(?:input|textarea|select)\b[^>]*>/g)].filter(([tag]) => !tag.includes('type="file"') && !tag.includes('type="password"'));
    expect(controls).toHaveLength(21);
    for (const [tag] of controls) {
      const id = /\bid="([^"]+)"/.exec(tag)?.[1];
      expect(id, tag).toBeTruthy();
      expect(labels.get(id!), tag).toBeTruthy();
    }
    const messages = locale === "en" ? en : es;
    for (const key of ["labelDisplayName", "labelBio", "labelLinkedinUrl", "labelWebsiteUrl", "labelEmail", "labelNewspaperCadence"] as const) {
      expect([...labels.values()]).toContain(messages.settings[key]);
    }
  });

  it.each(["en", "es"] as const)("exposes avatar upload as a named native button in %s", (locale) => {
    const html = renderPanel(locale);
    const messages = locale === "en" ? en : es;
    const button = /<button\b[^>]*class="avatar-upload"[^>]*>/.exec(html)?.[0];
    expect(button).toBeTruthy();
    expect(button).toContain('type="button"');
    expect(button).toContain(`aria-label="${messages.settings.btnUploadAvatar}"`);
    const content = /<button[^>]*class="avatar-upload"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1];
    expect(content).not.toContain("<input");
  });

  it("keeps control IDs unique when more than one panel is mounted", () => {
    const html = renderPanel("en", 2);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(40);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
