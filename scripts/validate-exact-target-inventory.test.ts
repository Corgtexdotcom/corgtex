import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const classes = [
  "ACTIVE_CLIENT_PRIMARY",
  "ACTIVE_CLIENT_AUTHORITY_UNPROVEN",
  "ACTIVE_CLIENT_CANARY",
  "ACTIVE_CLIENT_DECISION_REQUIRED",
  "CORE_WEB",
  "CORE_WORKER",
  "MCP",
  "PUBLIC_SITE",
  "SELFSERVE",
  "STAGING_TEST_E2E",
  "DEMO",
  "OPS_CONTROL_PLANE",
  "RESIDUAL_RAILWAY",
  "DUPLICATE_AZURE",
] as const;
const dispositions = new Map<string, string>([
  ["ACTIVE_CLIENT_PRIMARY", "SELECTABLE"],
  ["ACTIVE_CLIENT_AUTHORITY_UNPROVEN", "BLOCKED"],
  ["ACTIVE_CLIENT_CANARY", "BLOCKED"],
  ["ACTIVE_CLIENT_DECISION_REQUIRED", "DECISION_REQUIRED"],
  ["CORE_WEB", "SELECTABLE"],
  ["CORE_WORKER", "SELECTABLE"],
  ["MCP", "SELECTABLE"],
  ["PUBLIC_SITE", "SELECTABLE"],
  ["SELFSERVE", "BLOCKED"],
  ["STAGING_TEST_E2E", "BLOCKED"],
  ["DEMO", "DECISION_REQUIRED"],
  ["OPS_CONTROL_PLANE", "BLOCKED"],
  ["RESIDUAL_RAILWAY", "RETIRE_ONLY"],
  ["DUPLICATE_AZURE", "RETIRE_ONLY"],
]);
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
let proofCounter = 0;
const claim = (owner: string, kind: string, purpose: string) => {
  proofCounter += 1;
  const seed = `${owner}-${kind}-${purpose}-${proofCounter}`;
  return {
    kind,
    owner,
    assertedAt: "2026-08-22T12:00:00.000Z",
    proof: {
      purpose,
      owner,
      claimKind: kind,
      finality: "SETTLED",
      artifact: { path: `evidence/${seed.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}.json`, digest: hash(seed) },
      observedAt: "2026-08-20T12:00:00.000Z",
      verifiedAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-26T12:00:00.000Z",
    },
  };
};
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};
const target = (index: number) => {
  const app = uuid(index * 10 + 1);
  const db = uuid(index * 10 + 2);
  const components = [
    {
      componentId: app,
      kind: "WEB_APP",
      required: true,
      dependencies: [{ componentId: db, kind: "DATABASE", claim: claim(`${app}->${db}`, "DEPENDENCY", "component-dependency") }],
      rollback: { strategy: "PREVIOUS_IMAGE", predecessorRef: app, claim: claim(`${app}->${app}`, "ROLLBACK", "component-rollback") },
    },
    {
      componentId: db,
      kind: "DATABASE",
      required: true,
      dependencies: [],
      rollback: { strategy: "RESTORE_SNAPSHOT", predecessorRef: db, claim: claim(`${db}->${db}`, "ROLLBACK", "component-rollback") },
    },
  ];
  const normalized = components.map((component) => ({
    componentId: component.componentId,
    kind: component.kind,
    required: component.required,
    dependencies: component.dependencies.map((dependency) => ({ componentId: dependency.componentId, kind: dependency.kind })),
    rollback: { strategy: component.rollback.strategy, predecessorRef: component.rollback.predecessorRef },
  }));
  return {
    targetId: uuid(index * 100),
    lifecycleClaim: claim(uuid(index * 100), "LIFECYCLE", "target-lifecycle"),
    authorityClaim: claim(uuid(index * 100), "AUTHORITY", "target-authority"),
    completenessClaim: {
      ...claim(uuid(index * 100), "COMPLETENESS", "target-completeness"),
      topologyDigest: hash(canonicalJson(normalized)),
      componentCount: 2,
      dependencyCount: 1,
      rollbackCount: 2,
    },
    policyClaim: claim(uuid(index * 100), "POLICY", "target-policy"),
    components,
  };
};
const validFixture = () => {
  proofCounter = 0;
  return JSON.stringify({
    schemaVersion: "2.0.0",
    inventoryId: uuid(1),
    generatedAt: "2026-08-23T12:00:00.000Z",
    classes: classes.map((workloadClass, index) => {
      const disposition = dispositions.get(workloadClass);
      return {
        workloadClass,
        disposition,
        rootClaim: claim(`class-${workloadClass.toLowerCase().replaceAll("_", "-")}`, "AUTHORITY", "target-authority"),
        targets: disposition === "SELECTABLE" ? [target(index + 1)] : [],
      };
    }),
  });
};

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

  it("returns non-zero when requested class admission is blocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "exact-target-inventory-"));
    const inventory = join(dir, "inventory.json");
    writeFileSync(inventory, validFixture(), "utf8");
    let output = "";
    try {
      execFileSync("./node_modules/.bin/tsx", ["scripts/validate-exact-target-inventory.ts", inventory, "--class=RESIDUAL_RAILWAY", "--now=2026-08-24T12:00:00.000Z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? "");
    }
    expect(output).toContain("\"status\":\"BLOCKED\"");
    expect(output).toContain("RETIREMENT_BLOCKED");
  }, 30_000);
});
