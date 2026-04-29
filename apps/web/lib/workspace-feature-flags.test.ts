import { describe, expect, it } from "vitest";

import { WORKSPACE_NAV_GROUPS } from "./nav-config";
import { DEFAULT_WORKSPACE_FEATURE_FLAGS, filterNavGroupsByWorkspaceAccess } from "./workspace-feature-flags";

function visibleLabels(capabilities: { canManageAgentGovernance: boolean }, agentGovernanceEnabled = true) {
  return filterNavGroupsByWorkspaceAccess(
    WORKSPACE_NAV_GROUPS,
    {
      ...DEFAULT_WORKSPACE_FEATURE_FLAGS,
      AGENT_GOVERNANCE: agentGovernanceEnabled,
    },
    capabilities,
  ).flatMap((group) => group.items.map((item) => item.labelKey));
}

describe("filterNavGroupsByWorkspaceAccess", () => {
  it("hides agent governance navigation from users without the management capability", () => {
    expect(visibleLabels({ canManageAgentGovernance: false })).not.toContain("agentGovernance");
  });

  it("shows agent governance navigation to users with the management capability", () => {
    expect(visibleLabels({ canManageAgentGovernance: true })).toContain("agentGovernance");
  });

  it("hides agent governance navigation when the feature flag is disabled", () => {
    expect(visibleLabels({ canManageAgentGovernance: true }, false)).not.toContain("agentGovernance");
  });
});
