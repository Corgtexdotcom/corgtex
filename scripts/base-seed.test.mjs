import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertCanonicalWorkspaceSeedSources,
  discoverProductionSeedPaths,
  selectRuntimeSeedPaths,
} from "./check-seed-fixtures.mjs";

const source = readFileSync(new URL("../prisma/seed.mjs", import.meta.url), "utf8");

describe("production bootstrap seed", () => {
  it("establishes the workspace baseline through one short canonical transaction", () => {
    expect(source).toContain("ensureCanonicalWorkspace,");
    expect(source).toContain('from "../packages/domain/src/workspaces.ts"');
    expect(source).toContain("prisma.$transaction((tx) => ensureCanonicalWorkspace(tx,");
    expect(source).not.toMatch(/\b[A-Za-z_$][\w$]*\.workspace\.(?:create|upsert)\s*\(/);
  });

  it("does not reuse or reset the human administrator password for the system actor", () => {
    expect(source).not.toContain("systemEmail");
    expect(source).not.toContain("existingSystemUser");
    expect(source).not.toMatch(/approvalPolicy\.upsert\s*\(/);
  });

  it("discovers every runtime-eligible script deterministically and rejects arbitrary direct workspace writes", () => {
    const paths = discoverProductionSeedPaths();
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("prisma/seed.mjs");
    expect(paths).toContain("scripts/lib/client-stable-seed.mjs");
    expect(selectRuntimeSeedPaths([
      "scripts/bootstrap-client.mjs",
      "scripts/bootstrap-client.test.mjs",
      "notes/bootstrap-client.mjs",
    ])).toEqual(["scripts/bootstrap-client.mjs"]);

    expect(() => assertCanonicalWorkspaceSeedSources([{
      relativePath: "scripts/bootstrap-client.mjs",
      source: "await prisma.workspace.create({ data: {} });",
    }])).toThrow("scripts/bootstrap-client.mjs contains a direct workspace create/upsert");
  });
});
