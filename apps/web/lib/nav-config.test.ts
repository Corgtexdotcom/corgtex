import { describe, expect, it } from "vitest";

import { WORKSPACE_NAV_GROUPS, type NavGroup } from "./nav-config";
import { DEFAULT_WORKSPACE_FEATURE_FLAGS } from "./workspace-feature-flags";

/**
 * Byte-for-byte parity anchor: the exact `WORKSPACE_NAV_GROUPS` and default
 * flag map that existed before they were derived from the Module Manifest
 * registry. These tests prove the derivation is behavior-preserving.
 */
const EXPECTED_NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "workspace",
    items: [
      { moduleKey: "home", href: "", labelKey: "home", icon: "home", mobilePrimaryOrder: 10 },
      { moduleKey: "goals", href: "/goals", labelKey: "goals", icon: "goals", featureFlag: "GOALS" },
      { moduleKey: "brain", href: "/brain", labelKey: "brain", icon: "brain" },
      { moduleKey: "tools", href: "/tools", labelKey: "tools", icon: "tools", featureFlag: "TOOL_LINKS" },
      { moduleKey: "built", href: "/built", labelKey: "built", icon: "built", featureFlag: "BUILD_ARTIFACTS" },
      { moduleKey: "members", href: "/members", labelKey: "members", icon: "members" },
    ],
  },
  {
    labelKey: "operations",
    items: [
      { moduleKey: "tensions", href: "/tensions", labelKey: "tensions", icon: "tensions", mobilePrimaryOrder: 20 },
      { moduleKey: "actions", href: "/actions", labelKey: "actions", icon: "actions", mobilePrimaryOrder: 30 },
      { moduleKey: "meetings", href: "/meetings", labelKey: "meetings", icon: "meetings" },
      { moduleKey: "relationships", href: "/leads", labelKey: "relationships", icon: "relationships", featureFlag: "RELATIONSHIPS" },
      { moduleKey: "context-maps", href: "/maps", labelKey: "contextMaps", icon: "contextMaps", featureFlag: "CONTEXT_MAPS" },
    ],
  },
  {
    labelKey: "governance",
    items: [
      { moduleKey: "agreements", href: "/agreements", labelKey: "agreements", icon: "agreements" },
      { moduleKey: "proposals", href: "/proposals", labelKey: "proposals", icon: "proposals", mobilePrimaryOrder: 50 },
      { moduleKey: "circles", href: "/circles", labelKey: "circles", icon: "circles" },
      { moduleKey: "roles", href: "/roles", labelKey: "roles", icon: "roles" },
    ],
  },
  {
    labelKey: "finance",
    items: [
      { moduleKey: "finance", href: "/finance", labelKey: "finance", icon: "finance", featureFlag: "FINANCE" },
    ],
  },
  {
    labelKey: "aiGovernance",
    items: [
      {
        moduleKey: "agent-governance",
        href: "/agents",
        labelKey: "agentGovernance",
        icon: "agents",
        featureFlag: "AGENT_GOVERNANCE",
        requiredCapability: "canManageAgentGovernance",
      },
    ],
  },
  {
    labelKey: "system",
    items: [
      { moduleKey: "os-metrics", href: "/governance", labelKey: "osMetrics", icon: "governance", featureFlag: "OS_METRICS" },
      { moduleKey: "audit", href: "/audit", labelKey: "auditTrail", icon: "audit" },
      { moduleKey: "notifications", href: "/notifications", labelKey: "notifications", icon: "notifications", mobilePrimaryOrder: 40 },
      { moduleKey: "settings", href: "/settings", labelKey: "settings", icon: "settings" },
    ],
  },
];

const EXPECTED_DEFAULT_FLAGS = {
  GOALS: true,
  TOOL_LINKS: false,
  FINANCE: true,
  BUILD_ARTIFACTS: false,
  RELATIONSHIPS: true,
  CONTEXT_MAPS: false,
  AGENT_GOVERNANCE: true,
  OS_METRICS: true,
  SETTINGS_GENERAL: true,
  MULTILINGUAL: false,
  MEETING_TRANSCRIPT_SOURCES: false,
  MEETING_RECORDERS: false,
  MEETING_CONTEXTUAL_INTELLIGENCE: false,
  CONTEXT_MAP_AI: false,
  SLACK_MEETING_ACTION_REVIEW: false,
  AI_WORKSPACES: true,
  OPENWORK_DEFAULT: false,
  EXECUTION_PACKETS: false,
  MANAGED_ENTERPRISE_SERVICES: false,
};

describe("registry-derived nav and flags parity", () => {
  it("derives the same WORKSPACE_NAV_GROUPS as before", () => {
    expect(WORKSPACE_NAV_GROUPS).toEqual(EXPECTED_NAV_GROUPS);
  });

  it("derives the same default feature flag map as before", () => {
    expect(DEFAULT_WORKSPACE_FEATURE_FLAGS).toEqual(EXPECTED_DEFAULT_FLAGS);
  });
});
