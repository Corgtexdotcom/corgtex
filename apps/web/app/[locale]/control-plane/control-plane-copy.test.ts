import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readJson(path: string) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
    controlPlane: {
      nav?: Record<string, string>;
      commandPalette?: {
        placeholder?: string;
        items?: Record<string, string>;
      };
    };
  };
}

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("control-plane copy", () => {
  it("defines the root navigation and command palette keys used by the shell", () => {
    for (const locale of ["en", "es"] as const) {
      const messages = readJson(`../../../messages/${locale}.json`);

      expect(messages.controlPlane.nav).toMatchObject({
        dashboard: expect.any(String),
        customers: expect.any(String),
        agents: expect.any(String),
        releases: expect.any(String),
        operations: expect.any(String),
        users: expect.any(String),
        details: expect.any(String),
      });
      expect(messages.controlPlane.commandPalette?.placeholder).toEqual(expect.any(String));
      expect(messages.controlPlane.commandPalette?.placeholder).not.toMatch(/customer name/i);
      expect(messages.controlPlane.commandPalette?.items).toMatchObject({
        dashboard: expect.any(String),
        customers: expect.any(String),
        agents: expect.any(String),
        releases: expect.any(String),
        operations: expect.any(String),
        users: expect.any(String),
      });
    }
  });

  it("does not keep production control-plane mock fallback rows in route sources", () => {
    const sources = [
      "./agents/page.tsx",
      "./operations/page.tsx",
      "./users/page.tsx",
      "./releases/page.tsx",
      "./_components/ops-agent-chat.tsx",
    ].map(readSource).join("\n");

    for (const forbidden of [
      "Atlas Workspace",
      "Beacon Manufacturing",
      "Summit Media",
      "Slack Triage Agent",
      "realistic mock",
      "demo/dogfooding",
    ]) {
      expect(sources).not.toContain(forbidden);
    }
  });
});
