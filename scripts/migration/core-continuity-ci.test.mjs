import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

describe("retired Core continuity gate", () => {
  it("removes the ordinary CI workflow, command and unused transfer typecheck entries", () => {
    expect(existsSync(new URL("../../.github/workflows/core-continuity.yml", import.meta.url))).toBe(false);
    expect(JSON.parse(read("../../package.json")).scripts["test:migration:core-continuity"]).toBeUndefined();
    const includes = JSON.parse(read("./tsconfig.shared-transfer.json")).include;
    for (const file of ["core-crm-continuity.ts", "core-lead-transfer.ts", "core-lead-transfer-cli.ts"]) {
      expect(includes).not.toContain(file);
    }
    expect(includes).toContain("shared-tenant-transfer.ts");
  });
});
