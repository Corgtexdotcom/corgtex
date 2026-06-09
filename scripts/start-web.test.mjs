import { describe, expect, it } from "vitest";
import {
  configuredSeedScripts,
  flagEnabled,
  resolveStartupMode,
  startupPlanForMode,
} from "./start-web.mjs";

describe("start-web startup modes", () => {
  it("keeps combined startup as the default Railway-compatible mode", () => {
    expect(resolveStartupMode({})).toBe("combined");
    expect(startupPlanForMode("combined")).toEqual({
      runMigrations: true,
      runSeeds: true,
      verifyMigrations: true,
      startWeb: true,
    });
  });

  it("supports one-shot migrate-and-seed mode for Azure jobs", () => {
    expect(resolveStartupMode({ CORGTEX_STARTUP_MODE: "migrate-and-seed" })).toBe("migrate-and-seed");
    expect(startupPlanForMode("migrate-and-seed")).toEqual({
      runMigrations: true,
      runSeeds: true,
      verifyMigrations: true,
      startWeb: false,
    });
  });

  it("supports web mode without database mutations for Azure web replicas", () => {
    expect(resolveStartupMode({ CORGTEX_STARTUP_MODE: "web" })).toBe("web");
    expect(startupPlanForMode("web")).toEqual({
      runMigrations: false,
      runSeeds: false,
      verifyMigrations: true,
      startWeb: true,
    });
  });

  it("rejects unknown startup modes", () => {
    expect(() => resolveStartupMode({ CORGTEX_STARTUP_MODE: "worker" })).toThrow(
      'Unsupported CORGTEX_STARTUP_MODE "worker".',
    );
  });

  it("deduplicates explicit seed scripts and optional demo seed entries", () => {
    expect(configuredSeedScripts({
      SEED_SCRIPTS: "scripts/seed-a.mjs, scripts/seed-a.mjs, scripts/seed-b.mjs",
      CORGTEX_AUTO_SEED_JNJ_DEMO: "yes",
    })).toEqual([
      "scripts/seed-a.mjs",
      "scripts/seed-b.mjs",
      "scripts/seed-jnj-demo.mjs",
    ]);
  });

  it("parses common enabled flag values", () => {
    expect(flagEnabled("FEATURE", { FEATURE: "on" })).toBe(true);
    expect(flagEnabled("FEATURE", { FEATURE: "false" })).toBe(false);
  });
});
