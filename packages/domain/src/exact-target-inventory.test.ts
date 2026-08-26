import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXACT_TARGET_INVENTORY_MAX_BYTES,
  EXACT_TARGET_INVENTORY_MAX_OUTPUT_BYTES,
  evaluateExactTargetInventoryJson,
  exactTargetInventoryFieldOwnership,
  exactTargetInventoryWorkloadClasses,
} from "./exact-target-inventory";

describe("exact target inventory public facade", () => {
  it("exports only the public evaluator contract and no reusable selector authority", () => {
    expect(typeof evaluateExactTargetInventoryJson).toBe("function");
    expect(exactTargetInventoryWorkloadClasses).toHaveLength(14);
    expect(exactTargetInventoryFieldOwnership.at(-1)).toEqual({
      fact: "selection",
      owner: "evaluateExactTargetInventoryJson invocation",
    });
  });
});

const cliDispositions = new Map<string, string>([
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
const cliUuid = (index: number) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const cliHash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
let cliProofCounter = 0;
const cliClaim = (owner: string, kind: string, purpose: string) => {
  cliProofCounter += 1;
  const seed = `${owner}-${kind}-${purpose}-${cliProofCounter}`;
  return {
    kind,
    owner,
    assertedAt: "2026-08-22T12:00:00.000Z",
    proof: {
      purpose,
      owner,
      claimKind: kind,
      finality: "SETTLED",
      artifact: { path: `evidence/${seed.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}.json`, digest: cliHash(seed) },
      observedAt: "2026-08-20T12:00:00.000Z",
      verifiedAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-26T12:00:00.000Z",
    },
  };
};
const cliCanonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => cliCanonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${cliCanonicalJson(record[key])}`).join(",")}}`;
};
const cliTargetProofOwner = (workloadClass: string, targetId: string) =>
  `class-${workloadClass.toLowerCase().replaceAll("_", "-")}:${targetId}`;
const cliTarget = (index: number, workloadClass: string) => {
  const targetId = cliUuid(index * 100);
  const proofOwner = cliTargetProofOwner(workloadClass, targetId);
  const app = cliUuid(index * 10 + 1);
  const db = cliUuid(index * 10 + 2);
  const components = [
    {
      componentId: app,
      kind: "WEB_APP",
      required: true,
      dependencies: [{ componentId: db, kind: "DATABASE", claim: cliClaim(`${app}->${db}`, "DEPENDENCY", "component-dependency") }],
      rollback: { strategy: "PREVIOUS_IMAGE", predecessorRef: app, claim: cliClaim(`${app}->${app}`, "ROLLBACK", "component-rollback") },
    },
    {
      componentId: db,
      kind: "DATABASE",
      required: true,
      dependencies: [],
      rollback: { strategy: "RESTORE_SNAPSHOT", predecessorRef: db, claim: cliClaim(`${db}->${db}`, "ROLLBACK", "component-rollback") },
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
    targetId,
    lifecycleClaim: cliClaim(proofOwner, "LIFECYCLE", "target-lifecycle"),
    authorityClaim: cliClaim(proofOwner, "AUTHORITY", "target-authority"),
    completenessClaim: {
      ...cliClaim(proofOwner, "COMPLETENESS", "target-completeness"),
      topologyDigest: cliHash(cliCanonicalJson(normalized)),
      componentCount: 2,
      dependencyCount: 1,
      rollbackCount: 2,
    },
    policyClaim: cliClaim(proofOwner, "POLICY", "target-policy"),
    components,
  };
};
const cliValidFixture = () => {
  cliProofCounter = 0;
  return JSON.stringify({
    schemaVersion: "2.0.0",
    inventoryId: cliUuid(1),
    generatedAt: "2026-08-23T12:00:00.000Z",
    classes: exactTargetInventoryWorkloadClasses.map((workloadClass, index) => {
      const disposition = cliDispositions.get(workloadClass);
      return {
        workloadClass,
        disposition,
        rootClaim: cliClaim(`class-${workloadClass.toLowerCase().replaceAll("_", "-")}`, "AUTHORITY", "target-authority"),
        targets: disposition === "SELECTABLE" ? [cliTarget(index + 1, workloadClass)] : [],
      };
    }),
  });
};
const runCli = (args: readonly string[]) => {
  try {
    return {
      status: 0,
      output: execFileSync("./node_modules/.bin/tsx", ["scripts/validate-exact-target-inventory.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (error) {
    return {
      status: Number((error as { status?: number }).status ?? 0),
      output: String((error as { stdout?: string }).stdout ?? ""),
    };
  }
};

describe("validate exact target inventory CLI static boundary", () => {
  it("imports only local file reading, path resolution, and the public evaluator", () => {
    const source = readFileSync(new URL("../../../scripts/validate-exact-target-inventory.ts", import.meta.url), "utf8");
    expect(source.match(/^import .*$/gm)).toEqual([
      'import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";',
      'import { resolve } from "node:path";',
      "import {",
    ]);
    expect(source).toContain("from \"@corgtex/domain/exact-target-inventory\"");
    expect(source).not.toContain("from \"@corgtex/domain\"");
    expect(source).not.toMatch(/readFileSync|\bstatSync\(|fetch\(|@azure|prisma|DATABASE_URL|SECRET|TOKEN|scripts\/release|child_process|spawn\(|exec\(|https?:\/\//);
    expect(source).not.toMatch(/process\.exit\(/);
    expect(source).toContain("process.exitCode = status;");
    expect(source).toContain("process.exitCode = result.ok ? 0 : 1;");
    expect(source).toContain("fd = openSync(filePath, constants.O_RDONLY);");
    expect(source).toContain("const stat = fstatSync(fd);");
    expect(source).toContain("Buffer.allocUnsafe(EXACT_TARGET_INVENTORY_MAX_BYTES + 1)");
    expect(source).toContain("readSync(fd, buffer, offset, buffer.length - offset, null)");
    expect(source).toContain("if (bytesRead === 0) return buffer.subarray(0, offset).toString(\"utf8\");");
    expect(source).toContain("finally");
    expect(source).toContain("closeSync(fd);");
  });

  it("exposes and uses an offline exact-target package subpath without the domain barrel", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(packageJson.exports["./exact-target-inventory"]).toBe("./src/exact-target-inventory.ts");

    const facade = readFileSync(new URL("./exact-target-inventory.ts", import.meta.url), "utf8");
    const evaluator = readFileSync(new URL("./exact-target-inventory-evaluator.ts", import.meta.url), "utf8");
    const contract = readFileSync(new URL("./exact-target-inventory-contract.ts", import.meta.url), "utf8");
    const closure = `${facade}\n${evaluator}\n${contract}`;
    expect(facade).not.toContain("./index");
    expect(closure).not.toMatch(/@corgtex\/domain["']|@corgtex\/shared|@corgtex\/storage|prisma|DATABASE_URL|REDIS|railway|fetch\(|https?:\/\/|scripts\/release|process\.env|child_process|spawn|exec/);

    const imported = execFileSync("./node_modules/.bin/tsx", ["-e", "import('@corgtex/domain/exact-target-inventory').then((m) => process.stdout.write(String(typeof m.evaluateExactTargetInventoryJson)))"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "postgresql://poison.invalid/db", RAILWAY_TOKEN: "poison" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(imported).toBe("function");
  }, 30_000);

  it("fails closed for malformed and unreadable files without raw local paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "exact-target-inventory-"));
    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{\"private\":\"customer-secret\",", "utf8");
    let output = "";
    output = runCli([malformed, "--now=2026-08-24T12:00:00.000Z"]).output;
    expect(output).toContain("\"JSON_MALFORMED\"");
    expect(output).not.toContain(malformed);
    expect(output).not.toContain("customer-secret");

    output = runCli([join(dir, "missing.json")]).output;
    expect(output).toBe("{\"ok\":false,\"error\":\"READ_FAILED\"}\n");
  }, 30_000);

  it("distinguishes exact-limit evaluator input from descriptor-level read failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "exact-target-inventory-"));
    const exactLimit = join(dir, "exact-limit.json");
    const overLimit = join(dir, "over-limit.json");
    writeFileSync(exactLimit, " ".repeat(EXACT_TARGET_INVENTORY_MAX_BYTES), "utf8");
    writeFileSync(overLimit, " ".repeat(EXACT_TARGET_INVENTORY_MAX_BYTES + 1), "utf8");

    const exact = runCli([exactLimit, "--now=2026-08-24T12:00:00.000Z"]);
    expect(exact.status).toBe(1);
    expect(exact.output).toContain("\"JSON_MALFORMED\"");
    expect(exact.output).not.toContain(exactLimit);

    const oversized = runCli([overLimit, "--now=2026-08-24T12:00:00.000Z"]);
    expect(oversized.status).toBe(2);
    expect(oversized.output).toBe("{\"ok\":false,\"error\":\"READ_FAILED\"}\n");
    expect(oversized.output).not.toContain(overLimit);

    const directory = runCli([dir, "--now=2026-08-24T12:00:00.000Z"]);
    expect(directory.status).toBe(2);
    expect(directory.output).toBe("{\"ok\":false,\"error\":\"READ_FAILED\"}\n");
    expect(directory.output).not.toContain(dir);
  }, 30_000);

  it("returns non-zero when requested class admission is blocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "exact-target-inventory-"));
    const inventory = join(dir, "inventory.json");
    writeFileSync(inventory, cliValidFixture(), "utf8");
    let output = "";
    output = runCli([inventory, "--class=RESIDUAL_RAILWAY", "--now=2026-08-24T12:00:00.000Z"]).output;
    expect(output).toContain("\"status\":\"BLOCKED\"");
    expect(output).toContain("RETIREMENT_BLOCKED");
  }, 30_000);

  it("returns zero only for valid no-request and selected-class admission", () => {
    const dir = mkdtempSync(join(tmpdir(), "exact-target-inventory-"));
    const inventory = join(dir, "inventory.json");
    writeFileSync(inventory, cliValidFixture(), "utf8");

    const noRequest = execFileSync("./node_modules/.bin/tsx", ["scripts/validate-exact-target-inventory.ts", inventory, "--now=2026-08-24T12:00:00.000Z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(noRequest).toContain("\"ok\":true");
    expect(noRequest).not.toContain("\"selection\"");

    const selected = execFileSync("./node_modules/.bin/tsx", ["scripts/validate-exact-target-inventory.ts", inventory, "--class=CORE_WEB", "--now=2026-08-24T12:00:00.000Z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(selected).toContain("\"ok\":true");
    expect(selected).toContain("\"status\":\"SELECTED\"");
  }, 30_000);

  it("rejects hostile requested classes before evaluation without echoing caller input", () => {
    const dir = mkdtempSync(join(tmpdir(), "exact-target-inventory-"));
    const inventory = join(dir, "inventory.json");
    writeFileSync(inventory, cliValidFixture(), "utf8");
    const hostile = `SECRET_${"x".repeat(12_000)}`;
    const { output, status } = runCli([inventory, `--class=${hostile}`, "--now=2026-08-24T12:00:00.000Z"]);
    expect(status).toBe(2);
    expect(output).toBe("{\"ok\":false,\"error\":\"INVALID_CLASS\"}\n");
    expect(output).not.toContain(hostile);
    expect(output).not.toContain("SECRET");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(EXACT_TARGET_INVENTORY_MAX_OUTPUT_BYTES);
  }, 30_000);

  it("rejects every unconsumed, malformed, duplicate, or invalid CLI argument before admission", () => {
    const dir = mkdtempSync(join(tmpdir(), "exact-target-inventory-"));
    const inventory = join(dir, "inventory.json");
    writeFileSync(inventory, cliValidFixture(), "utf8");
    const rows: Array<readonly [string, readonly string[], string]> = [
      ["no args", [], "MISSING_FILE"],
      ["option-like file", ["--class=CORE_WEB"], "MISSING_FILE"],
      ["misspelled option", [inventory, "--clas=CORE_WEB"], "INVALID_ARGS"],
      ["spaced class option", [inventory, "--class", "CORE_WEB"], "INVALID_ARGS"],
      ["extra positional", [inventory, "extra.json"], "INVALID_ARGS"],
      ["empty class", [inventory, "--class="], "INVALID_CLASS"],
      ["duplicate class", [inventory, "--class=CORE_WEB", "--class=CORE_WORKER"], "INVALID_CLASS"],
      ["invalid now", [inventory, "--now=not-a-date"], "INVALID_NOW"],
      ["offset now", [inventory, "--now=2026-08-24T12:00:00.000+00:00"], "INVALID_NOW"],
      ["duplicate now", [inventory, "--now=2026-08-24T12:00:00.000Z", "--now=2026-08-24T12:00:01.000Z"], "INVALID_NOW"],
    ];

    for (const [name, args, code] of rows) {
      const result = runCli(args);
      expect(result.status, name).toBe(2);
      expect(result.output, name).toBe(`${JSON.stringify({ ok: false, error: code })}\n`);
      expect(result.output, name).not.toContain(inventory);
      expect(Buffer.byteLength(result.output, "utf8"), name).toBeLessThanOrEqual(EXACT_TARGET_INVENTORY_MAX_OUTPUT_BYTES);
    }
  }, 30_000);
});
