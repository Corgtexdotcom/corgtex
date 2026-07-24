import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readMessages(locale: "en" | "es") {
  return JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")) as {
    controlPlane: Record<string, unknown>;
  };
}

describe("control-plane messages", () => {
  it("does not keep stale command-palette copy after the shell removed the palette", () => {
    for (const locale of ["en", "es"] as const) {
      const messages = readMessages(locale);

      expect(messages.controlPlane).not.toHaveProperty("search");
      expect(messages.controlPlane).not.toHaveProperty("commandPalette");
    }
  });
});
