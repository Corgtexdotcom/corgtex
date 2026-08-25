import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("validate exact target inventory CLI static boundary", () => {
  it("imports only local file reading, path resolution, and the public evaluator", () => {
    const source = readFileSync(new URL("./validate-exact-target-inventory.ts", import.meta.url), "utf8");
    expect(source.match(/^import .*$/gm)).toEqual([
      'import { readFileSync, statSync } from "node:fs";',
      'import { resolve } from "node:path";',
      "import {",
    ]);
    expect(source).not.toMatch(/fetch\(|@azure|prisma|DATABASE_URL|SECRET|TOKEN|scripts\/release|child_process|spawn|exec|https?:\/\//);
  });

  it("fails closed for malformed and unreadable files without raw local paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "exact-target-inventory-"));
    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{\"private\":\"customer-secret\",", "utf8");
    let output = "";
    try {
      execFileSync("./node_modules/.bin/tsx", ["scripts/validate-exact-target-inventory.ts", malformed, "--now=2026-08-24T12:00:00.000Z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? "");
    }
    expect(output).toContain("\"JSON_MALFORMED\"");
    expect(output).not.toContain(malformed);
    expect(output).not.toContain("customer-secret");

    try {
      execFileSync("./node_modules/.bin/tsx", ["scripts/validate-exact-target-inventory.ts", join(dir, "missing.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? "");
    }
    expect(output).toBe("{\"ok\":false,\"error\":\"READ_FAILED\"}\n");
  }, 30_000);
});
