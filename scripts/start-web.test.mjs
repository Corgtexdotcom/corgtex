import { describe, expect, it, vi } from "vitest";
import {
  configuredSeedScripts,
  flagEnabled,
  resolveStartupMode,
  startupPlanForMode,
  verifyMigrations,
} from "./start-web.mjs";

const prismaMock = vi.hoisted(() => ({
  migrationQueryStrings: [],
  disconnect: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn().mockImplementation(function PrismaClient() {
    return {
      $queryRaw(strings) {
        prismaMock.migrationQueryStrings = [...strings];
        return Promise.resolve([]);
      },
      $disconnect: prismaMock.disconnect,
    };
  }),
}));

describe("start-web startup modes", () => {
  it("defaults to web startup without database mutations", () => {
    expect(resolveStartupMode({})).toBe("web");
    expect(startupPlanForMode("web")).toEqual({
      runMigrations: false,
      runSeeds: false,
      verifyMigrations: true,
      startWeb: true,
    });
  });

  it("preserves combined startup for explicit backward-compatible manual runs", () => {
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

  it("supports explicit web mode without database mutations", () => {
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

  it("keeps seed scripts explicit to release-db and migrate-and-seed paths", () => {
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

  it("does not treat rolled-back migration rows as requiring attention", async () => {
    await verifyMigrations();

    const migrationQuery = prismaMock.migrationQueryStrings.join(" ");
    expect(migrationQuery).toContain("finished_at IS NULL");
    expect(migrationQuery).toContain("rolled_back_at IS NULL");
    expect(migrationQuery).not.toContain("rolled_back_at IS NOT NULL");
    expect(prismaMock.disconnect).toHaveBeenCalled();
  });
});
