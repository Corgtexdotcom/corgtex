import { describe, expect, it } from "vitest";
import {
  EXACT_TARGET_INVENTORY_MAX_BYTES,
  EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
  exactTargetInventoryClassDispositions,
  exactTargetInventoryFieldOwnership,
  exactTargetInventoryUseSiteProofRequirements,
  exactTargetInventoryWorkloadClasses,
} from "./exact-target-inventory-contract";

describe("exact target inventory v2 phase 0 contract evidence", () => {
  it("freezes the v2 public boundary, field ownership table, and use-site proof matrix", () => {
    expect(EXACT_TARGET_INVENTORY_SCHEMA_VERSION).toBe("2.0.0");
    expect(EXACT_TARGET_INVENTORY_MAX_BYTES).toBe(96_000);
    expect(exactTargetInventoryWorkloadClasses).toEqual([
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
    ]);
    expect(new Set(exactTargetInventoryWorkloadClasses)).toHaveProperty("size", 14);
    expect(exactTargetInventoryClassDispositions).toEqual(["SELECTABLE", "BLOCKED", "DECISION_REQUIRED", "RETIRE_ONLY"]);
    expect(exactTargetInventoryFieldOwnership).toEqual([
      { fact: "schema version", owner: "document.schemaVersion" },
      { fact: "generation time", owner: "document.generatedAt" },
      { fact: "workload class identity", owner: "class.workloadClass" },
      { fact: "root disposition", owner: "class.disposition" },
      { fact: "target identity", owner: "target.targetId" },
      { fact: "component identity", owner: "target.components[].componentId" },
      { fact: "dependency edge", owner: "consumer component dependencies[]" },
      { fact: "rollback obligation", owner: "owning component rollback" },
      { fact: "claim status", owner: "inline claim proof" },
      { fact: "artifact identity", owner: "inline proof artifact path and digest" },
      { fact: "selection", owner: "evaluateExactTargetInventoryJson invocation" },
    ]);
    expect(exactTargetInventoryUseSiteProofRequirements).toEqual({
      lifecycleClaim: { kind: "LIFECYCLE", purpose: "target-lifecycle" },
      authorityClaim: { kind: "AUTHORITY", purpose: "target-authority" },
      completenessClaim: { kind: "COMPLETENESS", purpose: "target-completeness" },
      policyClaim: { kind: "POLICY", purpose: "target-policy" },
      dependencyClaim: { kind: "DEPENDENCY", purpose: "component-dependency" },
      rollbackClaim: { kind: "ROLLBACK", purpose: "component-rollback" },
    });
  });

  it("records the exact 14-class phase 0 disposition matrix without granting retirement or release authority", () => {
    const matrix = new Map([
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
    expect([...matrix.keys()]).toEqual(exactTargetInventoryWorkloadClasses);
    expect([...matrix.values()].filter((value) => value === "RETIRE_ONLY")).toHaveLength(2);
    expect([...matrix.values()].filter((value) => value === "SELECTABLE")).toHaveLength(5);
  });
});
