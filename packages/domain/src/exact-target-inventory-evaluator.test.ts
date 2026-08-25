import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  EXACT_TARGET_INVENTORY_MAX_OUTPUT_BYTES,
  exactTargetInventoryWorkloadClasses,
  type ExactTargetInventoryClassDisposition,
  type ExactTargetInventoryDocument,
  type ExactTargetInventoryIssueCode,
  type ExactTargetInventoryWorkloadClass,
} from "./exact-target-inventory-contract";
import { evaluateExactTargetInventoryJson } from "./exact-target-inventory-evaluator";

const NOW = "2026-08-24T12:00:00.000Z";
const EXPIRED_NOW = "2026-08-27T00:00:00.000Z";
const generatedAt = "2026-08-23T12:00:00.000Z";
const assertedAt = "2026-08-22T12:00:00.000Z";
const verifiedAt = "2026-08-21T12:00:00.000Z";
const observedAt = "2026-08-20T12:00:00.000Z";
const expiresAt = "2026-08-26T12:00:00.000Z";

let proofCounter = 0;

const proofDigest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`;
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};
const topology = (components: any[]) => {
  const normalized = components.map((component) => ({
    componentId: component.componentId,
    kind: component.kind,
    required: component.required,
    dependencies: component.dependencies.map((dependency: any) => ({
      componentId: dependency.componentId,
      kind: dependency.kind,
    })).sort((a: any, b: any) => a.componentId.localeCompare(b.componentId)),
    rollback: component.rollback === undefined ? null : {
      strategy: component.rollback.strategy,
      predecessorRef: component.rollback.predecessorRef,
    },
  })).sort((a, b) => a.componentId.localeCompare(b.componentId));
  return {
    topologyDigest: `sha256:${createHash("sha256").update(canonicalJson(normalized)).digest("hex")}`,
    componentCount: components.length,
    dependencyCount: components.reduce((count, component) => count + component.dependencies.length, 0),
    rollbackCount: components.reduce((count, component) => count + (component.rollback === undefined ? 0 : 1), 0),
  };
};

const claim = (owner: string, kind: string, purpose: string) => {
  proofCounter += 1;
  const seed = `${owner}-${kind}-${purpose}-${proofCounter}`;
  const fileSeed = seed.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-");
  return {
    kind,
    owner,
    assertedAt,
    proof: {
      purpose,
      owner,
      claimKind: kind,
      finality: "SETTLED",
      artifact: {
        path: `evidence/${fileSeed}.json`,
        digest: proofDigest(seed),
      },
      observedAt,
      verifiedAt,
      expiresAt,
    },
  };
};

const target = (targetId: string, componentPrefix: string) => {
  const seed = exactTargetInventoryWorkloadClasses.indexOf(componentPrefix as ExactTargetInventoryWorkloadClass) + 1;
  const appComponent = uuid(seed * 10 + 1);
  const dbComponent = uuid(seed * 10 + 2);
  const components = [
    {
      componentId: appComponent,
      kind: "WEB_APP",
      required: true,
      dependencies: [{
        componentId: dbComponent,
        kind: "DATABASE",
        claim: claim(`${appComponent}->${dbComponent}`, "DEPENDENCY", "component-dependency"),
      }],
      rollback: {
        strategy: "PREVIOUS_IMAGE",
        predecessorRef: appComponent,
        claim: claim(`${appComponent}->${appComponent}`, "ROLLBACK", "component-rollback"),
      },
    },
    {
      componentId: dbComponent,
      kind: "DATABASE",
      required: true,
      dependencies: [],
      rollback: {
        strategy: "RESTORE_SNAPSHOT",
        predecessorRef: dbComponent,
        claim: claim(`${dbComponent}->${dbComponent}`, "ROLLBACK", "component-rollback"),
      },
    },
  ];
  return {
    targetId,
    lifecycleClaim: claim(targetId, "LIFECYCLE", "target-lifecycle"),
    authorityClaim: claim(targetId, "AUTHORITY", "target-authority"),
    completenessClaim: {
      ...claim(targetId, "COMPLETENESS", "target-completeness"),
      ...topology(components),
    },
    policyClaim: claim(targetId, "POLICY", "target-policy"),
    components,
  };
};

const dispositions = new Map<ExactTargetInventoryWorkloadClass, ExactTargetInventoryClassDisposition>([
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

const fixture = (): ExactTargetInventoryDocument => {
  proofCounter = 0;
  return {
    schemaVersion: "2.0.0",
    inventoryId: uuid(1),
    generatedAt,
    classes: exactTargetInventoryWorkloadClasses.map((workloadClass) => {
      const disposition = dispositions.get(workloadClass) ?? "BLOCKED";
      const classOwner = `class-${workloadClass.toLowerCase().replaceAll("_", "-")}`;
      const selectable = disposition === "SELECTABLE";
      return {
        workloadClass,
        disposition,
        rootClaim: claim(classOwner, "AUTHORITY", "target-authority"),
        targets: selectable ? [target(uuid((exactTargetInventoryWorkloadClasses.indexOf(workloadClass) + 1) * 100), workloadClass)] : [],
      };
    }),
  } as ExactTargetInventoryDocument;
};

const serialize = (value: unknown) => JSON.stringify(value);
const evaluate = (value: unknown, requestedWorkloadClass: ExactTargetInventoryWorkloadClass = "CORE_WEB") =>
  evaluateExactTargetInventoryJson(typeof value === "string" ? value : serialize(value), { now: NOW, requestedWorkloadClass });
const outputBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

const admitThroughPublicBoundary = (inputText: string, requestedWorkloadClass: ExactTargetInventoryWorkloadClass, permit: boolean) => {
  const effects = Array.from({ length: 8 }, () => vi.fn());
  const result = evaluateExactTargetInventoryJson(inputText, { now: NOW, requestedWorkloadClass });
  if (permit && result.ok && result.artifactStatus === "VALID" && result.selection?.status === "SELECTED") {
    effects.forEach((effect) => effect(result.selection?.opaqueTargetId));
  }
  return { result, effectCount: effects.reduce((count, effect) => count + effect.mock.calls.length, 0) };
};

const expectOracle = (
  name: string,
  mutate: (value: any) => unknown,
  issueCode: ExactTargetInventoryIssueCode,
  requestedWorkloadClass: ExactTargetInventoryWorkloadClass = "CORE_WEB",
) => {
  const value = fixture() as any;
  const input = mutate(value);
  const { result, effectCount } = admitThroughPublicBoundary(typeof input === "string" ? input : serialize(input), requestedWorkloadClass, true);
  const publicCodes = [
    ...result.issueCodes,
    ...result.classes.flatMap((item) => item.issueCodes),
    ...(result.selection?.issueCodes ?? []),
  ];
  expect(publicCodes, name).toContain(issueCode);
  expect(`${JSON.stringify(result)}|${name}`).not.toMatch(/customer|secret|password|azurecr\.io|subscription|evidence\/|private-trap/);
  expect(effectCount, name).toBe(0);
};

describe("exact target inventory evaluator", () => {
  it("accepts bounded JSON string input and emits a bounded opaque projection for the full 14-class fixture", () => {
    const result = evaluate(fixture(), "CORE_WEB");
    expect(result.artifactStatus).toBe("VALID");
    expect(result.schemaVersion).toBe("2.0.0");
    expect(result.ok).toBe(true);
    expect(result.evaluatedAt).toBe(NOW);
    expect(result.validUntil).toBe(expiresAt);
    expect(result.canonicalDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.classes).toHaveLength(14);
    expect(result.classes.map((item) => item.workloadClass)).toEqual(exactTargetInventoryWorkloadClasses);
    expect(result.selection).toEqual({
      workloadClass: "CORE_WEB",
      status: "SELECTED",
      opaqueTargetId: expect.stringMatching(/^[a-f0-9]{32}$/),
      issueCodes: [],
    });
    expect(JSON.stringify(result)).not.toContain("evidence/");
    expect(outputBytes(result)).toBeLessThanOrEqual(EXACT_TARGET_INVENTORY_MAX_OUTPUT_BYTES);
  });

  it("keeps global ok layered over artifact validity and explicit selected admission", () => {
    const input = serialize(fixture());
    const noRequest = evaluateExactTargetInventoryJson(input, { now: NOW });
    expect(noRequest.artifactStatus).toBe("VALID");
    expect(noRequest.ok).toBe(true);
    expect(noRequest.issueCodes).toEqual([]);
    expect(noRequest.selection).toBeUndefined();
    expect(noRequest.classes.find((item) => item.workloadClass === "DUPLICATE_AZURE")?.issueCodes).toEqual(["RETIREMENT_BLOCKED"]);

    const selected = admitThroughPublicBoundary(input, "CORE_WEB", true);
    expect(selected.result.ok).toBe(true);
    expect(selected.result.issueCodes).toEqual([]);
    expect(selected.result.selection?.status).toBe("SELECTED");
    expect(selected.effectCount).toBe(8);

    const blocked = admitThroughPublicBoundary(input, "DUPLICATE_AZURE", true);
    expect(blocked.result.artifactStatus).toBe("VALID");
    expect(blocked.result.ok).toBe(false);
    expect(blocked.result.issueCodes).toEqual([]);
    expect(blocked.result.selection).toEqual({ workloadClass: "DUPLICATE_AZURE", status: "BLOCKED", issueCodes: ["RETIREMENT_BLOCKED"] });
    expect(blocked.effectCount).toBe(0);
  });

  it("bounds hostile requested-class handling without reflecting raw caller input", () => {
    const hostile = `SECRET_${"x".repeat(12_000)}`;
    const result = evaluateExactTargetInventoryJson(serialize(fixture()), { now: NOW, requestedWorkloadClass: hostile as ExactTargetInventoryWorkloadClass });
    const output = JSON.stringify(result);
    expect(result.artifactStatus).toBe("VALID");
    expect(result.ok).toBe(false);
    expect(result.issueCodes).toEqual(["REQUESTED_CLASS_NOT_FOUND"]);
    expect(result.selection).toEqual({ status: "INVALID", issueCodes: ["REQUESTED_CLASS_NOT_FOUND"] });
    expect(output).not.toContain(hostile);
    expect(output).not.toContain("SECRET");
    expect(outputBytes(result)).toBeLessThanOrEqual(EXACT_TARGET_INVENTORY_MAX_OUTPUT_BYTES);
  });

  it("re-evaluates the same exact bytes against current time and closes after expiry", () => {
    const input = serialize(fixture());
    expect(evaluateExactTargetInventoryJson(input, { now: NOW, requestedWorkloadClass: "CORE_WEB" }).selection?.status).toBe("SELECTED");
    const expired = evaluateExactTargetInventoryJson(input, { now: EXPIRED_NOW, requestedWorkloadClass: "CORE_WEB" });
    expect(expired.artifactStatus).toBe("INVALID");
    expect(expired.issueCodes).toContain("PROOF_EXPIRED");
    expect(expired.selection?.status).toBe("INVALID");
  });

  it("uses one black-box admission harness: valid selected baseline reaches eight fakes exactly once", () => {
    const { result, effectCount } = admitThroughPublicBoundary(serialize(fixture()), "CORE_WEB", true);
    expect(result.selection?.status).toBe("SELECTED");
    expect(effectCount).toBe(8);
  });

  it("blocks retirement and unresolved classes without invalidating the artifact", () => {
    const residual = evaluate(fixture(), "RESIDUAL_RAILWAY");
    expect(residual.artifactStatus).toBe("VALID");
    expect(residual.ok).toBe(false);
    expect(residual.issueCodes).toEqual([]);
    expect(residual.selection).toEqual({ workloadClass: "RESIDUAL_RAILWAY", status: "BLOCKED", issueCodes: ["RETIREMENT_BLOCKED"] });
    const decision = evaluate(fixture(), "ACTIVE_CLIENT_DECISION_REQUIRED");
    expect(decision.ok).toBe(false);
    expect(decision.issueCodes).toEqual([]);
    expect(decision.selection).toEqual({ workloadClass: "ACTIVE_CLIENT_DECISION_REQUIRED", status: "BLOCKED", issueCodes: ["CLASS_BLOCKED"] });
  });

  it("binds validUntil to every accepted proof layer including dependencies and rollback", () => {
    const cases: Array<readonly [string, (value: any) => void]> = [
      ["root", (value) => { value.classes[0].rootClaim.proof.expiresAt = "2026-08-25T00:00:00.000Z"; }],
      ["lifecycle", (value) => { value.classes[4].targets[0].lifecycleClaim.proof.expiresAt = "2026-08-25T01:00:00.000Z"; }],
      ["authority", (value) => { value.classes[4].targets[0].authorityClaim.proof.expiresAt = "2026-08-25T02:00:00.000Z"; }],
      ["completeness", (value) => { value.classes[4].targets[0].completenessClaim.proof.expiresAt = "2026-08-25T03:00:00.000Z"; }],
      ["policy", (value) => { value.classes[4].targets[0].policyClaim.proof.expiresAt = "2026-08-25T04:00:00.000Z"; }],
      ["dependency", (value) => { value.classes[4].targets[0].components[0].dependencies[0].claim.proof.expiresAt = "2026-08-25T05:00:00.000Z"; }],
      ["rollback", (value) => { value.classes[4].targets[0].components[0].rollback.claim.proof.expiresAt = "2026-08-25T06:00:00.000Z"; }],
    ];

    for (const [name, mutate] of cases) {
      const value = fixture() as any;
      mutate(value);
      const result = evaluate(value, "CORE_WEB");
      expect(result.artifactStatus, name).toBe("VALID");
      expect(result.validUntil, name).toMatch(/^2026-08-25T0[0-6]:00:00\.000Z$/);
    }
  });

  it("keeps the exported class cardinality immutable at runtime", () => {
    expect(Object.isFrozen(exactTargetInventoryWorkloadClasses)).toBe(true);
    expect(() => (exactTargetInventoryWorkloadClasses as unknown as string[]).pop()).toThrow(TypeError);
    expect(exactTargetInventoryWorkloadClasses).toHaveLength(14);

    const value = fixture() as any;
    value.classes = value.classes.slice(0, 13);
    const result = evaluate(value, "CORE_WEB");
    expect(result.artifactStatus).toBe("INVALID");
    expect(result.issueCodes).toContain("CLASS_CARDINALITY_INVALID");
  });

  it("maps every protected-lineage finding into the common mutation oracle with zero effects", () => {
    expectOracle("hostile object boundary", () => "{}", "UNKNOWN_KEY");
    expectOracle("malformed json", () => "{\"schemaVersion\":\"2.0.0\",", "JSON_MALFORMED");
    expectOracle("duplicate json key", () => "{\"schemaVersion\":\"2.0.0\",\"schemaVersion\":\"2.0.0\"}", "DUPLICATE_JSON_KEY");
    expectOracle("missing class", (value) => ({ ...value, classes: value.classes.slice(1) }), "CLASS_CARDINALITY_INVALID");
    expectOracle("extra class", (value) => ({ ...value, classes: [...value.classes, value.classes[0]] }), "CLASS_CARDINALITY_INVALID");
    expectOracle("duplicate workload target identity", (value) => {
      const coreWorker = value.classes.find((item: any) => item.workloadClass === "CORE_WORKER");
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWorker && coreWeb) coreWorker.targets = coreWeb.targets as never;
      return value;
    }, "TARGET_IDENTITY_REUSED");
    expectOracle("stale proof", (value) => {
      value.classes[0].rootClaim.proof.expiresAt = "2026-08-24T00:00:00.000Z";
      return value;
    }, "PROOF_EXPIRED");
    expectOracle("future proof chronology", (value) => {
      value.classes[0].rootClaim.assertedAt = "2026-08-25T00:00:00.000Z";
      return value;
    }, "PROOF_CHRONOLOGY_INVALID");
    expectOracle("artifact alias", (value) => {
      const first = value.classes[0].rootClaim.proof.artifact;
      value.classes[1].rootClaim.proof.artifact = first;
      return value;
    }, "PROOF_ARTIFACT_REUSED");
    expectOracle("artifact path alias with changed digest", (value) => {
      const first = value.classes[0].rootClaim.proof.artifact;
      value.classes[1].rootClaim.proof.artifact.path = first.path;
      return value;
    }, "PROOF_ARTIFACT_REUSED");
    expectOracle("artifact digest alias with changed path", (value) => {
      const first = value.classes[0].rootClaim.proof.artifact;
      value.classes[1].rootClaim.proof.artifact.digest = first.digest;
      return value;
    }, "PROOF_ARTIFACT_REUSED");
    expectOracle("wrong owner", (value) => {
      value.classes[0].rootClaim.proof.owner = "class-other";
      return value;
    }, "PROOF_INVALID");
    expectOracle("wrong purpose", (value) => {
      value.classes[0].rootClaim.proof.purpose = "target-lifecycle" as never;
      return value;
    }, "PROOF_INVALID");
    expectOracle("pending detail proof", (value) => {
      value.classes[0].rootClaim.proof.finality = "PENDING" as never;
      return value;
    }, "PROOF_INVALID");
    expectOracle("missing dependency endpoint", (value) => {
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWeb) coreWeb.targets[0].components[0].dependencies[0].componentId = "missing-db";
      return value;
    }, "DEPENDENCY_INVALID");
    expectOracle("dependency cycle", (value) => {
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWeb) coreWeb.targets[0].components[1].dependencies = [{
        componentId: coreWeb.targets[0].components[0].componentId,
        kind: "WEB_APP",
        claim: claim(`${coreWeb.targets[0].components[1].componentId}->${coreWeb.targets[0].components[0].componentId}`, "DEPENDENCY", "component-dependency"),
      }] as never;
      return value;
    }, "DEPENDENCY_CYCLE");
    expectOracle("missing rollback", (value) => {
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWeb) delete (coreWeb.targets[0].components[0] as { rollback?: unknown }).rollback;
      return value;
    }, "ROLLBACK_INVALID");
    expectOracle("ambiguous class selection", (value) => {
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWeb) coreWeb.targets = [...coreWeb.targets, target(uuid(1002), "CORE_WEB")] as never;
      return value;
    }, "TARGET_CARDINALITY_INVALID");
    expectOracle("blocked authority class", (value) => value, "CLASS_BLOCKED", "ACTIVE_CLIENT_AUTHORITY_UNPROVEN");
    expectOracle("retirement always blocked", (value) => value, "RETIREMENT_BLOCKED", "DUPLICATE_AZURE");
    expectOracle("fixed disposition cannot be overridden", (value) => {
      const duplicate = value.classes.find((item: any) => item.workloadClass === "DUPLICATE_AZURE");
      if (duplicate) {
        duplicate.disposition = "SELECTABLE";
        duplicate.targets = [target(uuid(998), "DUPLICATE_AZURE")];
      }
      return value;
    }, "DISPOSITION_MISMATCH", "DUPLICATE_AZURE");
    expectOracle("dependency proof is required", (value) => {
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWeb) delete coreWeb.targets[0].components[0].dependencies[0].claim;
      return value;
    }, "UNKNOWN_KEY");
    expectOracle("dependency endpoint kind must match", (value) => {
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWeb) coreWeb.targets[0].components[0].dependencies[0].kind = "QUEUE";
      return value;
    }, "DEPENDENCY_INVALID");
    expectOracle("completeness binds normalized topology", (value) => {
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWeb) coreWeb.targets[0].components.push({
        componentId: uuid(999),
        kind: "QUEUE",
        required: false,
        dependencies: [],
      });
      return value;
    }, "PROOF_INVALID");
    expectOracle("optional rollback data cannot bypass validation", (value) => {
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWeb) coreWeb.targets[0].components.push({
        componentId: uuid(1000),
        kind: "QUEUE",
        required: false,
        dependencies: [],
        rollback: { strategy: "RESTORE_SNAPSHOT", predecessorRef: uuid(1000), claim: { invalid: true } },
      });
      return value;
    }, "ROLLBACK_INVALID");
    expectOracle("rollback predecessor must resolve", (value) => {
      const coreWeb = value.classes.find((item: any) => item.workloadClass === "CORE_WEB");
      if (coreWeb) coreWeb.targets[0].components[0].rollback.predecessorRef = uuid(1001);
      return value;
    }, "ROLLBACK_INVALID");
    expectOracle("slug ids are rejected", (value) => {
      value.inventoryId = "p0-05-v2";
      return value;
    }, "TYPE_MISMATCH");
    expectOracle("evidence traversal is rejected", (value) => {
      value.classes[0].rootClaim.proof.artifact.path = "evidence/a/../../private.json";
      return value;
    }, "INVALID_VALUE");
  });

  it("sanitizes hostile non-string and oversize input without reflection or raw values", () => {
    const proxy = new Proxy({}, { get: () => { throw new Error("private-trap"); } });
    const result = evaluateExactTargetInventoryJson(proxy, { now: NOW });
    expect(result.issueCodes).toEqual(["INPUT_NOT_STRING"]);
    expect(JSON.stringify(result)).not.toContain("private-trap");
    const oversize = " ".repeat(96_001);
    expect(evaluateExactTargetInventoryJson(oversize, { now: NOW }).issueCodes).toEqual(["INPUT_TOO_LARGE"]);
  });

  it("keeps the implementation offline and free of retained validation authority", () => {
    const evaluatorSource = readFileSync(new URL("./exact-target-inventory-evaluator.ts", import.meta.url), "utf8");
    const facadeSource = readFileSync(new URL("./exact-target-inventory.ts", import.meta.url), "utf8");
    expect(evaluatorSource.match(/^import .*$/gm)).toEqual([
      'import { createHash } from "node:crypto";',
      "import {",
    ]);
    expect(`${evaluatorSource}\n${facadeSource}`).not.toMatch(/WeakSet|fetch\(|@azure|prisma|DATABASE_URL|process\.env|scripts\/release|child_process|spawn\(|exec\(|https?:\/\//);
    expect(evaluatorSource).toContain("evaluateExactTargetInventoryJson");
  });
});
