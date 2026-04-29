import { describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_FEATURE_FLAGS } from "./workspace-feature-flags";
import { buildWorkspaceCapabilities } from "./workspace-capabilities";

describe("buildWorkspaceCapabilities", () => {
  it("disables agent capabilities when agent governance is disabled", () => {
    const capabilities = buildWorkspaceCapabilities({
      featureFlags: {
        ...DEFAULT_WORKSPACE_FEATURE_FLAGS,
        AGENT_GOVERNANCE: false,
      },
      role: "ADMIN",
    });

    expect(capabilities.canReviewAgentRuns).toBe(false);
    expect(capabilities.canUseOperatorConsole).toBe(false);
    expect(capabilities.canManageAgentGovernance).toBe(false);
  });

  it("does not grant agent review capabilities to normal workspace members", () => {
    const capabilities = buildWorkspaceCapabilities({
      featureFlags: DEFAULT_WORKSPACE_FEATURE_FLAGS,
      role: "CONTRIBUTOR",
    });

    expect(capabilities.canReviewAgentRuns).toBe(false);
    expect(capabilities.canUseOperatorConsole).toBe(false);
    expect(capabilities.canManageAgentGovernance).toBe(false);
  });

  it("allows facilitators to review agent runs and use the operator console", () => {
    const capabilities = buildWorkspaceCapabilities({
      featureFlags: DEFAULT_WORKSPACE_FEATURE_FLAGS,
      role: "FACILITATOR",
    });

    expect(capabilities.canReviewAgentRuns).toBe(true);
    expect(capabilities.canUseOperatorConsole).toBe(true);
    expect(capabilities.canManageAgentGovernance).toBe(false);
  });

  it("allows admins to review agent runs, use the operator console, and manage agent governance", () => {
    const capabilities = buildWorkspaceCapabilities({
      featureFlags: DEFAULT_WORKSPACE_FEATURE_FLAGS,
      role: "ADMIN",
    });

    expect(capabilities.canReviewAgentRuns).toBe(true);
    expect(capabilities.canUseOperatorConsole).toBe(true);
    expect(capabilities.canManageAgentGovernance).toBe(true);
  });

  it("treats global operators as admins once membership resolution returns the synthetic admin role", () => {
    const capabilities = buildWorkspaceCapabilities({
      featureFlags: DEFAULT_WORKSPACE_FEATURE_FLAGS,
      role: "ADMIN",
    });

    expect(capabilities.role).toBe("ADMIN");
    expect(capabilities.canReviewAgentRuns).toBe(true);
    expect(capabilities.canUseOperatorConsole).toBe(true);
    expect(capabilities.canManageAgentGovernance).toBe(true);
  });
});
