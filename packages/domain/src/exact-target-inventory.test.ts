import { describe, expect, it } from "vitest";
import {
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
