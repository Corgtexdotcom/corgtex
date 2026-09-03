import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { boundOwnerConfig, runCoreCheckRepair, treeDigest, validateCatalog } from "./repair-core-check.mjs";

describe("exact Core CHECK repair", () => {
  it("rejects other endpoints even when owner and reader match", () => {
    expect(() => boundOwnerConfig("postgres://postgres:secret@fixture.invalid:5432/railway", "postgres://reader:secret@fixture.invalid:5432/railway", "")).toThrow("CORE_ENDPOINT_MISMATCH");
  });
  it.each([
    "sslmode=disable", "sslmode=no-verify", "sslmode=require&sslmode=require",
    "sslrootcert=/tmp/other", "options=-csearch_path=public", "schema=other", "connection_limit=-1",
  ])("rejects connection option %s before opening a connection", (query) => {
    expect(() => boundOwnerConfig(`postgres://postgres:secret@fixture.invalid/railway?${query}`, "postgres://reader:secret@fixture.invalid/railway", "")).toThrow("UNSUPPORTED_CONNECTION_OPTION");
  });
  it("rejects malformed credentials without disclosing them", () => {
    expect(() => boundOwnerConfig("private credential", "", "")).toThrow("INVALID_CONNECTION_INPUT");
  });
  it("normalizes only tree source offsets", () => {
    expect(treeDigest("{CONST :location 10 :constvalue 1}")).toBe(treeDigest("{CONST :location -1 :constvalue 1}"));
    expect(treeDigest("{CONST :location 10 :constvalue 1}")).not.toBe(treeDigest("{CONST :location 10 :constvalue 2}"));
    expect(treeDigest("{OPEXPR :opno 1 :location 10}")).not.toBe(treeDigest("{OPEXPR :opno 2 :location 10}"));
    expect(() => treeDigest("x".repeat(16385))).toThrow("TREE_UNAVAILABLE");
  });
  it("rejects missing or drifted catalog evidence", () => {
    expect(() => validateCatalog(null)).toThrow("RELATION_PRECONDITION_FAILED");
    expect(() => validateCatalog({ ordinary: true, owner: true, no_dependents: true })).toThrow("CATALOG_DRIFT");
  });
  it("rejects unknown mode before creating a client", async () => {
    const factory = vi.fn();
    await expect(runCoreCheckRepair("anything", factory)).rejects.toThrow("INVALID_MODE");
    expect(factory).not.toHaveBeenCalled();
  });
  it("redacts TLS/connection exceptions and never sends SQL after connection failure", async () => {
    const client = { connect: vi.fn().mockRejectedValue(new Error("secret and raw private SQL")), query: vi.fn(), end: vi.fn().mockResolvedValue() };
    const result = await runCoreCheckRepair("apply", () => client);
    expect(result.status).toBe("ABORTED");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(client.query).not.toHaveBeenCalled();
  });
  it("keeps credentials scoped to the protected execution step and shares restore concurrency", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/core-check-repair.yml", import.meta.url), "utf8");
    expect(workflow).toContain("environment: azure-migration-foundation");
    expect(workflow).toContain("group: azure-migration-postgres-rehearsal");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain('[[ "$current_main" == "$GITHUB_SHA" ]]');
    expect(workflow).toContain("gh api repos/Corgtexdotcom/corgtex/git/ref/heads/main --jq .object.sha");
    expect(workflow.indexOf('[[ "$current_main" == "$GITHUB_SHA" ]]')).toBeLessThan(workflow.indexOf("node scripts/migration/repair-core-check.mjs"));
    expect(workflow.indexOf("npm ci")).toBeLessThan(workflow.indexOf("secrets.PRODUCTION_DATABASE_URL"));
    expect(workflow).not.toMatch(/id-token:|azure\/login|release:db|migrate-and-seed/u);
    expect(workflow).toContain("options: [inspect, apply]");
  });
});
