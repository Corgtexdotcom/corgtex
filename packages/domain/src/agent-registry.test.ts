import { describe, it, expect } from "vitest";
import { AGENT_REGISTRY } from "./agent-registry";

describe("AGENT_REGISTRY", () => {
  it("has correct model tier assignments", () => {
    expect(AGENT_REGISTRY["finance-reconciliation-prep"].defaultModelTier).toBe("standard");
    expect(AGENT_REGISTRY["brain-absorb"].defaultModelTier).toBe("quality");
    expect(AGENT_REGISTRY["action-extraction"].defaultModelTier).toBe("standard");
    expect(AGENT_REGISTRY["inbox-triage"].defaultModelTier).toBe("fast");
  });
});
