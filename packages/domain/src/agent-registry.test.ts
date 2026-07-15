import { describe, it, expect } from "vitest";
import { AGENT_REGISTRY } from "./agent-registry";

describe("AGENT_REGISTRY", () => {
  it("has correct model tier assignments", () => {
    expect(AGENT_REGISTRY["brain-absorb"].defaultModelTier).toBe("quality");
    expect(AGENT_REGISTRY["company-understanding"].defaultModelTier).toBe("quality");
    expect(AGENT_REGISTRY["meeting-summary"].defaultModelTier).toBe("quality");
    expect(AGENT_REGISTRY["action-extraction"].defaultModelTier).toBe("quality");
    expect(AGENT_REGISTRY["inbox-triage"].defaultModelTier).toBe("fast");
    expect(AGENT_REGISTRY["daily-digest"].defaultModelTier).toBe("excellent");
  });
});
