import { describe, expect, it } from "vitest";

import { CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS } from "../control-plane";
import {
  collectFeatureFlagDefinitions,
  defaultWorkspaceFeatureFlags,
  getSatelliteEmbedForModule,
  listNavModules,
  listWorkspaceFeatureFlagDefinitions,
  listWorkspaceFeatureFlagKeys,
  MODULE_MANIFESTS,
} from "./registry";

/**
 * Snapshot of today's `WORKSPACE_NAV_GROUPS` (apps/web/lib/nav-config.ts).
 * packages/domain cannot import the web nav config (the package-layer ESLint
 * boundary forbids it), so this is the parity anchor the registry must
 * reproduce while the web nav derives from the registry.
 */
const EXPECTED_NAV: Array<{
  href: string;
  labelKey: string;
  icon: string;
  group: string;
  featureFlag?: string;
  mobilePrimaryOrder?: number;
  requiredCapability?: string;
}> = [
  { href: "", labelKey: "home", icon: "home", group: "workspace", mobilePrimaryOrder: 10 },
  { href: "/goals", labelKey: "goals", icon: "goals", group: "workspace", featureFlag: "GOALS" },
  { href: "/brain", labelKey: "brain", icon: "brain", group: "workspace" },
  { href: "/tools", labelKey: "tools", icon: "tools", group: "workspace", featureFlag: "TOOL_LINKS" },
  { href: "/built", labelKey: "built", icon: "built", group: "workspace", featureFlag: "BUILD_ARTIFACTS" },
  { href: "/members", labelKey: "members", icon: "members", group: "workspace" },
  { href: "/tensions", labelKey: "tensions", icon: "tensions", group: "operations", mobilePrimaryOrder: 20 },
  { href: "/actions", labelKey: "actions", icon: "actions", group: "operations", mobilePrimaryOrder: 30 },
  { href: "/meetings", labelKey: "meetings", icon: "meetings", group: "operations" },
  { href: "/leads", labelKey: "relationships", icon: "relationships", group: "operations", featureFlag: "RELATIONSHIPS" },
  { href: "/maps", labelKey: "contextMaps", icon: "contextMaps", group: "operations", featureFlag: "CONTEXT_MAPS" },
  { href: "/agreements", labelKey: "agreements", icon: "agreements", group: "governance" },
  { href: "/proposals", labelKey: "proposals", icon: "proposals", group: "governance", mobilePrimaryOrder: 50 },
  { href: "/circles", labelKey: "circles", icon: "circles", group: "governance" },
  { href: "/roles", labelKey: "roles", icon: "roles", group: "governance" },
  { href: "/finance", labelKey: "finance", icon: "finance", group: "finance", featureFlag: "FINANCE" },
  {
    href: "/agents",
    labelKey: "agentGovernance",
    icon: "agents",
    group: "aiGovernance",
    featureFlag: "AGENT_GOVERNANCE",
    requiredCapability: "canManageAgentGovernance",
  },
  { href: "/governance", labelKey: "osMetrics", icon: "governance", group: "system", featureFlag: "OS_METRICS" },
  { href: "/audit", labelKey: "auditTrail", icon: "audit", group: "system" },
  { href: "/notifications", labelKey: "notifications", icon: "notifications", group: "system", mobilePrimaryOrder: 40 },
  { href: "/settings", labelKey: "settings", icon: "settings", group: "system" },
];

describe("module registry feature flag parity", () => {
  it("covers exactly the control-plane workspace feature flags", () => {
    const registryFlags = new Set(collectFeatureFlagDefinitions().keys());
    const controlPlaneFlags = new Set(CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((entry) => entry.flag));
    expect([...registryFlags].sort()).toEqual([...controlPlaneFlags].sort());
  });

  it("matches control-plane order, labels, descriptions, and defaults", () => {
    const derived = listWorkspaceFeatureFlagDefinitions();
    const expected = CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((entry) => ({
      flag: entry.flag,
      label: entry.label,
      description: entry.description,
      defaultEnabled: entry.defaultEnabled,
    }));
    expect(derived).toEqual(expected);
  });

  it("derives the same default-enabled map as the control-plane defaults", () => {
    const defaults = defaultWorkspaceFeatureFlags();
    for (const entry of CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS) {
      expect(defaults[entry.flag as keyof typeof defaults]).toBe(entry.defaultEnabled);
    }
    expect(Object.keys(defaults).sort()).toEqual(listWorkspaceFeatureFlagKeys().sort());
  });
});

describe("module registry nav parity", () => {
  it("reproduces today's nav items in order", () => {
    const derived = listNavModules().map((mod) => {
      const nav = mod.nav!;
      const entry: {
        href: string;
        labelKey: string;
        icon: string;
        group: string;
        featureFlag?: string;
        mobilePrimaryOrder?: number;
        requiredCapability?: string;
      } = {
        href: nav.href,
        labelKey: nav.labelKey,
        icon: nav.icon,
        group: nav.group,
      };
      if (mod.featureFlag) entry.featureFlag = mod.featureFlag.flag;
      if (typeof nav.mobilePrimaryOrder === "number") entry.mobilePrimaryOrder = nav.mobilePrimaryOrder;
      if (nav.requiredCapability) entry.requiredCapability = nav.requiredCapability;
      return entry;
    });
    expect(derived).toEqual(EXPECTED_NAV);
  });
});

describe("module registry integrity", () => {
  it("has unique module keys", () => {
    const keys = MODULE_MANIFESTS.map((mod) => mod.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has unique flag keys across modules", () => {
    const flags: string[] = [];
    for (const mod of MODULE_MANIFESTS) {
      if (mod.featureFlag) flags.push(mod.featureFlag.flag);
      for (const sub of mod.subFlags ?? []) flags.push(sub.flag);
    }
    expect(new Set(flags).size).toBe(flags.length);
  });

  it("marks satellite modules with satellite data ownership and a spec", () => {
    for (const mod of MODULE_MANIFESTS) {
      if (mod.tier === "satellite") {
        expect(mod.dataOwnership).toBe("satellite");
        expect(mod.satellite).toBeTruthy();
      }
    }
  });
});

describe("practice ledger native module", () => {
  it("has no satellite app identity or embed after the native finance cutover", () => {
    const ledger = MODULE_MANIFESTS.find((mod) => mod.key === "practice-ledger");
    expect(ledger?.tier).toBe("first_party");
    expect(ledger?.dataOwnership).toBe("corgtex_postgres");
    expect(ledger?.satellite).toBeUndefined();
    expect(ledger?.contract).toBeUndefined();
    expect(ledger?.graduation).toBeUndefined();

    expect(getSatelliteEmbedForModule("finance")).toBeUndefined();
    expect(getSatelliteEmbedForModule("goals")).toBeUndefined();
  });
});
