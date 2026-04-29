import { describe, expect, it } from "vitest";

import { WORKSPACE_NAV_GROUPS } from "./nav-config";
import {
  DEFAULT_WORKSPACE_FEATURE_FLAGS,
  filterNavGroupsByWorkspaceAccess,
  type WorkspaceFeatureFlagMap,
} from "./workspace-feature-flags";

function visibleLabels(
  capabilities: { canManageAgentGovernance: boolean },
  overrides: Partial<WorkspaceFeatureFlagMap> = {},
) {
  return filterNavGroupsByWorkspaceAccess(
    WORKSPACE_NAV_GROUPS,
    {
      ...DEFAULT_WORKSPACE_FEATURE_FLAGS,
      ...overrides,
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
    expect(visibleLabels({ canManageAgentGovernance: true }, { AGENT_GOVERNANCE: false })).not.toContain("agentGovernance");
  });

  it("hides client-sensitive new surfaces by default", () => {
    const labels = visibleLabels({ canManageAgentGovernance: true });

    expect(labels).not.toContain("tools");
    expect(labels).not.toContain("built");
  });

  it("shows client-sensitive new surfaces only when explicitly enabled", () => {
    const labels = visibleLabels(
      { canManageAgentGovernance: true },
      { TOOL_LINKS: true, BUILD_ARTIFACTS: true },
    );

    expect(labels).toContain("tools");
    expect(labels).toContain("built");
  });
});
