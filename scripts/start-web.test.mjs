import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  configuredSeedScripts,
  flagEnabled,
  localMigrationNames,
  resolveStartupMode,
  seedCommand,
  startupPlanForMode,
  verifyMigrations,
} from "./start-web.mjs";

const prismaMock = vi.hoisted(() => ({
  migrationQueryStrings: [],
  migrationRows: [],
  disconnect: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn().mockImplementation(function PrismaClient() {
    return {
      $queryRaw(strings) {
        prismaMock.migrationQueryStrings = [...strings];
        return Promise.resolve(prismaMock.migrationRows);
      },
      $disconnect: prismaMock.disconnect,
    };
  }),
}));

describe("start-web startup modes", () => {
  beforeEach(() => {
    prismaMock.migrationQueryStrings = [];
    prismaMock.migrationRows = [];
    prismaMock.disconnect.mockClear();
  });

  function appliedRows(migrations = localMigrationNames()) {
    return migrations.map((migration_name) => ({
      migration_name,
      finished_at: new Date("2026-06-24T12:00:00.000Z"),
      rolled_back_at: null,
    }));
  }

  it("defaults to combined startup so web boot applies migrations", () => {
    expect(resolveStartupMode({})).toBe("combined");
    expect(startupPlanForMode("combined")).toEqual({
      runMigrations: true,
      runSeeds: true,
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

  it("supports migrate-and-web mode for release platforms without seed variables", () => {
    expect(resolveStartupMode({ CORGTEX_STARTUP_MODE: "migrate-and-web" })).toBe("migrate-and-web");
    expect(startupPlanForMode("migrate-and-web")).toEqual({
      runMigrations: true,
      runSeeds: false,
      verifyMigrations: true,
      startWeb: true,
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

  it("runs base and explicit seeds through the pinned tsx runtime", () => {
    expect(seedCommand("prisma/seed.mjs", "/app")).toEqual({
      command: process.execPath,
      args: [
        path.join("/app", "node_modules", "tsx", "dist", "cli.mjs"),
        path.join("/app", "prisma", "seed.mjs"),
      ],
    });
    expect(seedCommand("scripts/seed-jnj-demo.mjs", "/app").args[1]).toBe(
      path.join("/app", "scripts", "seed-jnj-demo.mjs"),
    );
  });

  it("does not add the internal validation seed implicitly for production web startup", () => {
    expect(configuredSeedScripts({ NODE_ENV: "production" })).toEqual([]);
  });

  it("deduplicates the internal validation seed when explicitly configured", () => {
    expect(configuredSeedScripts({
      CORGTEX_AUTO_SEED_INTERNAL_VALIDATION: "true",
      SEED_SCRIPTS: "scripts/seed-internal-validation-workspace.mjs",
    })).toEqual(["scripts/seed-internal-validation-workspace.mjs"]);
  });

  it("parses common enabled flag values", () => {
    expect(flagEnabled("FEATURE", { FEATURE: "on" })).toBe(true);
    expect(flagEnabled("FEATURE", { FEATURE: "false" })).toBe(false);
  });

  it("does not treat rolled-back migration rows as requiring attention", async () => {
    prismaMock.migrationRows = [
      ...appliedRows(),
      {
        migration_name: "20260624000000_rolled_back",
        finished_at: null,
        rolled_back_at: new Date("2026-06-24T12:05:00.000Z"),
      },
    ];

    await verifyMigrations();

    const migrationQuery = prismaMock.migrationQueryStrings.join(" ");
    expect(migrationQuery).toContain("FROM _prisma_migrations");
    expect(prismaMock.disconnect).toHaveBeenCalled();
  });

  it("fails startup verification when a bundled migration is pending", async () => {
    const bundledMigrations = localMigrationNames();
    expect(bundledMigrations.length).toBeGreaterThan(0);
    prismaMock.migrationRows = appliedRows(bundledMigrations.slice(0, -1));

    await expect(verifyMigrations()).rejects.toThrow("pending=");
    expect(prismaMock.disconnect).toHaveBeenCalled();
  });

  it("fails startup verification when a migration row is failed", async () => {
    prismaMock.migrationRows = [
      ...appliedRows(),
      {
        migration_name: "20260624000000_failed",
        finished_at: null,
        rolled_back_at: null,
      },
    ];

    await expect(verifyMigrations()).rejects.toThrow("failed=20260624000000_failed");
    expect(prismaMock.disconnect).toHaveBeenCalled();
  });
});
