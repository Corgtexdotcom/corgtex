import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { CATALOG_ALGORITHM, CATALOG_QUERIES, UNSUPPORTED_CATALOG_SQL, collectSchemaCatalog, expectedCatalogArtifact,
  assertExpectedCatalog, compareSchemaCatalog, validateCatalog } from "./lib/selfserve-schema-catalog.mjs";

const binding = { expectedSha: "a".repeat(40), manifest: { manifestSha256: "b".repeat(64), datamodelSha256: "c".repeat(64) }, runId: "123", runAttempt: "1" };
const catalog = () => ({ algorithm: CATALOG_ALGORITHM, serverMajor: 16,
  categories: Object.fromEntries(Object.keys(CATALOG_QUERIES).map(key => [key, []])) });
const artifact = () => ({ ...expectedCatalogArtifact(catalog(), binding), cleanup: "completed" });

describe("catalog artifact binding and safe comparison", () => {
  it("accepts exact current source/run artifact", () => expect(assertExpectedCatalog(artifact(), binding)).toEqual(catalog()));
  it.each(["schemaVersion", "scope", "target", "origin", "workspaceId", "ownerUserId", "gitSha", "manifestSha256", "datamodelSha256", "runId", "runAttempt", "status", "cleanup", "datamodelMatch"])("rejects wrong %s", key => {
    expect(() => assertExpectedCatalog({ ...artifact(), [key]: "wrong" }, binding)).toThrow("CATALOG_ARTIFACT_MISBOUND");
  });
  it("does not accept a changed catalog under an old digest", () => {
    const proof = artifact(); proof.catalog.categories.enums.push(["private_type", "private_value", 1]);
    expect(() => assertExpectedCatalog(proof, binding)).toThrow("CATALOG_ARTIFACT_DIGEST_MISMATCH");
  });
  it("requires supported version and exact category set", () => {
    expect(() => validateCatalog({ ...catalog(), serverMajor: 18 })).toThrow("VERSION_UNSUPPORTED");
    const missing = catalog(); delete missing.categories.columns;
    expect(() => validateCatalog(missing)).toThrow("SHAPE_INVALID");
  });
  it("rejects oversized, malformed and duplicate rows", () => {
    for (const rows of [[["x"]], Array.from({ length: 10001 }, () => ["x", "y", 1]), [["x", "y", 1], ["x", "y", 1]], [["x", "p".repeat(262145), 1]]]) {
      const value = catalog(); value.categories.enums = rows;
      expect(() => validateCatalog(value)).toThrow(/CATALOG_/);
    }
  });
  it("emits only category/count/hash, even with private constants in both snapshots", () => {
    const a = catalog(), b = catalog();
    a.categories.functions = [["sensitive_fn", "", "PRIVATE EXPECTED BODY"]];
    b.categories.functions = [["sensitive_fn", "", "PRIVATE LIVE BODY"]];
    const result = compareSchemaCatalog(a, b);
    expect(result.supportedSchemaMatch).toBe(false);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({ category: "functions", expectedCount: 1, actualCount: 1 });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|sensitive_fn|BODY/);
  });
  it("does not collapse adjacent bigint sequence values", () => {
    const a = catalog(), b = catalog();
    a.categories.sequences = [["s", "bigint", "1", "1", "9223372036854775807", "1", "1", false, null, null, null, null]];
    b.categories.sequences = [["s", "bigint", "1", "1", "9223372036854775806", "1", "1", false, null, null, null, null]];
    expect(compareSchemaCatalog(a, b).supportedSchemaMatch).toBe(false);
  });
  it("rejects unsupported server or snapshot before collecting data", async () => {
    for (const context of [{ version: 180000, read_only: "on", isolation: "repeatable read" }, { version: 160000, read_only: "off", isolation: "repeatable read" }, { version: 160000, read_only: "on", isolation: "read committed" }]) {
      let calls = 0;
      await expect(collectSchemaCatalog({ query: async () => { calls++; return { rows: [context] }; } })).rejects.toThrow(/CATALOG_/);
      expect(calls).toBe(1);
    }
  });
});

describe("workflow integration", () => {
  it("downloads only same-run isolation before live catalog verification", () => {
    const workflow = parse(readFileSync(new URL("../.github/workflows/production-validation.yml", import.meta.url), "utf8"));
    const live = workflow.jobs["selfserve-live"];
    expect(live.needs).toEqual(["validation-context", "selfserve-isolated"]);
    const download = live.steps.findIndex(step => step.uses === "actions/download-artifact@v4");
    const audit = live.steps.findIndex(step => step.run === "node scripts/selfserve-validation-schema.mjs");
    expect(download).toBeGreaterThan(0); expect(download).toBeLessThan(audit);
    expect(live.steps[download].with).toEqual({ name: "selfserve-validation-isolated", path: ".artifacts/selfserve-catalog" });
  });
  it("captures catalog before fixture writes and finalizes only after cleanup", () => {
    const source = readFileSync(new URL("./selfserve-validation-isolated.mjs", import.meta.url), "utf8");
    expect(source).toContain("migrate deploy && node validation-scripts/selfserve-validation-catalog-fixture.mjs && node --import tsx");
    expect(source.indexOf("ISOLATED_CLEANUP_FAILED")).toBeLessThan(source.indexOf("const completedCatalog"));
    const live = readFileSync(new URL("./selfserve-validation-schema.mjs", import.meta.url), "utf8");
    expect(live.indexOf("assertExpectedCatalog(JSON.parse")).toBeLessThan(live.indexOf("() => client.connect()"));
    expect(live).not.toContain('"--from-schema-datasource"');
    expect(live).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  });
  it("uses catalog-only readers and no PG18 constraint fields", () => {
    const sql = [...Object.values(CATALOG_QUERIES), UNSUPPORTED_CATALOG_SQL].join("\n");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|LOCK|COPY|GRANT|SECURITY DEFINER|information_schema|pg_stats|conenforced|conperiod)\b/i);
    expect(sql).not.toMatch(/\b(?:FROM|JOIN)\s+public\./i);
  });
});
