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
    expect(DEFAULT_WORKSPACE_FEATURE_FLAGS.CONTEXT_MAP_AI).toBe(false);
    expect(DEFAULT_WORKSPACE_FEATURE_FLAGS.AI_WORKSPACES).toBe(false);
    expect(DEFAULT_WORKSPACE_FEATURE_FLAGS.OPENWORK_DEFAULT).toBe(false);
    expect(DEFAULT_WORKSPACE_FEATURE_FLAGS.EXECUTION_PACKETS).toBe(false);
    expect(DEFAULT_WORKSPACE_FEATURE_FLAGS.MANAGED_ENTERPRISE_SERVICES).toBe(false);
  });

  it("shows finance navigation by default for existing customers", () => {
    expect(visibleLabels({ canManageAgentGovernance: true })).toContain("finance");
  });

  it("hides finance navigation when the feature flag is disabled", () => {
    expect(visibleLabels({ canManageAgentGovernance: true }, { FINANCE: false })).not.toContain("finance");
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

describe("filterNavGroupsByWorkspaceAccess module access gating", () => {
  it("hides a module whose resolved access is none", () => {
    const visible = filterNavGroupsByWorkspaceAccess(
      WORKSPACE_NAV_GROUPS,
      DEFAULT_WORKSPACE_FEATURE_FLAGS,
      { canManageAgentGovernance: true },
      { finance: "none" },
    ).flatMap((group) => group.items.map((item) => item.labelKey));
    expect(visible).not.toContain("finance");
  });

  it("keeps a module visible at read or write access", () => {
    const readVisible = filterNavGroupsByWorkspaceAccess(
      WORKSPACE_NAV_GROUPS,
      DEFAULT_WORKSPACE_FEATURE_FLAGS,
      { canManageAgentGovernance: true },
      { finance: "read" },
    ).flatMap((group) => group.items.map((item) => item.labelKey));
    expect(readVisible).toContain("finance");
  });

  it("is a no-op when no access map is provided (behavior preserved)", () => {
    const withMap = filterNavGroupsByWorkspaceAccess(
      WORKSPACE_NAV_GROUPS,
      DEFAULT_WORKSPACE_FEATURE_FLAGS,
      { canManageAgentGovernance: true },
    ).flatMap((group) => group.items.map((item) => item.labelKey));
    expect(withMap).toContain("finance");
  });
});
