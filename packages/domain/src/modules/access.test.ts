import { describe, expect, it } from "vitest";

import {
  isAtLeast,
  maxAccessLevel,
  moduleDefaultAccess,
  resolveModuleAccess,
} from "./access";
import type {
  ModuleAccessContext,
  ModuleGrant,
  ModuleManifest,
} from "./types";

const financeModule: ModuleManifest = {
  key: "finance",
  tier: "first_party",
  title: "Finance",
  description: "Finance.",
  dataOwnership: "corgtex_postgres",
  featureFlag: { flag: "FINANCE", label: "Finance", description: "Finance.", defaultEnabled: true },
  nav: { href: "/finance", labelKey: "finance", icon: "finance", group: "finance" },
  defaultAccessByRole: {
    CONTRIBUTOR: "read",
    FACILITATOR: "read",
    FINANCE_STEWARD: "write",
    ADMIN: "write",
  },
};

const headlessModule: ModuleManifest = {
  key: "execution-packets",
  tier: "core",
  title: "Execution packets",
  description: "Headless.",
  dataOwnership: "corgtex_postgres",
  featureFlag: { flag: "EXECUTION_PACKETS", label: "Execution packets", description: "", defaultEnabled: false },
};

const coreNavModule: ModuleManifest = {
  key: "brain",
  tier: "core",
  title: "Brain",
  description: "Core nav module.",
  dataOwnership: "corgtex_postgres",
  nav: { href: "/brain", labelKey: "brain", icon: "brain", group: "workspace" },
};

// A flagged nav module with NO defaultAccessByRole: when its flag is on it
// broadcasts read to all roles, so it is the case where a flag-flip on approval
// would over-share. Used to prove grants stay requester-only with the flag off.
const flaggedNavModule: ModuleManifest = {
  key: "tools",
  tier: "first_party",
  title: "Tools",
  description: "Flagged nav module without explicit policy.",
  dataOwnership: "corgtex_postgres",
  featureFlag: { flag: "TOOL_LINKS", label: "Tools", description: "", defaultEnabled: false },
  nav: { href: "/tools", labelKey: "tools", icon: "tools", group: "workspace" },
};

function context(overrides: Partial<ModuleAccessContext> = {}): ModuleAccessContext {
  return {
    role: "CONTRIBUTOR",
    memberId: "member-1",
    governanceRoleIds: [],
    circleIds: [],
    flags: { FINANCE: true, EXECUTION_PACKETS: false },
    grants: [],
    ...overrides,
  };
}

describe("access level helpers", () => {
  it("orders levels none < read < write", () => {
    expect(maxAccessLevel("none", "read")).toBe("read");
    expect(maxAccessLevel("read", "write")).toBe("write");
    expect(maxAccessLevel("write", "read")).toBe("write");
    expect(isAtLeast("write", "read")).toBe(true);
    expect(isAtLeast("read", "write")).toBe(false);
  });
});

describe("moduleDefaultAccess", () => {
  it("uses explicit per-role policy when present", () => {
    expect(moduleDefaultAccess(financeModule, "FINANCE_STEWARD")).toBe("write");
    expect(moduleDefaultAccess(financeModule, "CONTRIBUTOR")).toBe("read");
  });

  it("defaults a nav module without policy to read for everyone", () => {
    expect(moduleDefaultAccess(coreNavModule, "CONTRIBUTOR")).toBe("read");
  });

  it("defaults a headless module to none", () => {
    expect(moduleDefaultAccess(headlessModule, "ADMIN")).toBe("none");
  });
});

describe("resolveModuleAccess - flag gating", () => {
  it("returns none when the module org opt-in flag is off", () => {
    expect(resolveModuleAccess(context({ flags: { FINANCE: false } }), financeModule)).toBe("none");
  });

  it("always enables a module without a feature flag", () => {
    expect(resolveModuleAccess(context(), coreNavModule)).toBe("read");
  });

  it("applies the default policy when the flag is on", () => {
    expect(resolveModuleAccess(context({ role: "FINANCE_STEWARD" }), financeModule)).toBe("write");
    expect(resolveModuleAccess(context({ role: "CONTRIBUTOR" }), financeModule)).toBe("read");
  });
});

describe("resolveModuleAccess - grant layering", () => {
  it("raises access via a MEMBER grant", () => {
    const grants: ModuleGrant[] = [
      { moduleKey: "finance", principalType: "MEMBER", principalId: "member-1", accessLevel: "write" },
    ];
    expect(resolveModuleAccess(context({ role: "CONTRIBUTOR", grants }), financeModule)).toBe("write");
  });

  it("raises access via a MEMBER_ROLE grant", () => {
    const grants: ModuleGrant[] = [
      { moduleKey: "finance", principalType: "MEMBER_ROLE", principalId: "FACILITATOR", accessLevel: "write" },
    ];
    expect(resolveModuleAccess(context({ role: "FACILITATOR", grants }), financeModule)).toBe("write");
  });

  it("raises access via a GOVERNANCE_ROLE grant the member holds", () => {
    const grants: ModuleGrant[] = [
      { moduleKey: "finance", principalType: "GOVERNANCE_ROLE", principalId: "role-finance-lead", accessLevel: "write" },
    ];
    expect(
      resolveModuleAccess(context({ role: "CONTRIBUTOR", governanceRoleIds: ["role-finance-lead"], grants }), financeModule),
    ).toBe("write");
  });

  it("raises access via a CIRCLE grant (cascade pre-expanded in circleIds)", () => {
    const grants: ModuleGrant[] = [
      { moduleKey: "finance", principalType: "CIRCLE", principalId: "circle-parent", accessLevel: "write" },
    ];
    // member is in a child circle; gather pre-expands ancestors into circleIds
    expect(
      resolveModuleAccess(
        context({ role: "CONTRIBUTOR", circleIds: ["circle-child", "circle-parent"], grants }),
        financeModule,
      ),
    ).toBe("write");
  });

  it("ignores grants for other modules and non-matching principals", () => {
    const grants: ModuleGrant[] = [
      { moduleKey: "goals", principalType: "MEMBER", principalId: "member-1", accessLevel: "write" },
      { moduleKey: "finance", principalType: "MEMBER", principalId: "someone-else", accessLevel: "write" },
      { moduleKey: "finance", principalType: "CIRCLE", principalId: "circle-not-mine", accessLevel: "write" },
    ];
    expect(resolveModuleAccess(context({ role: "CONTRIBUTOR", grants }), financeModule)).toBe("read");
  });

  it("never lowers access below the default policy", () => {
    const grants: ModuleGrant[] = [
      { moduleKey: "finance", principalType: "MEMBER", principalId: "member-1", accessLevel: "read" },
    ];
    expect(resolveModuleAccess(context({ role: "FINANCE_STEWARD", grants }), financeModule)).toBe("write");
  });

  it("applies an explicit grant even when the module flag is off (no flag flip needed)", () => {
    const grants: ModuleGrant[] = [
      { moduleKey: "finance", principalType: "MEMBER", principalId: "member-1", accessLevel: "write" },
    ];
    expect(resolveModuleAccess(context({ flags: { FINANCE: false }, grants }), financeModule)).toBe("write");
  });

  it("keeps non-granted members at none when the flag is off (requester-only, no broadcast)", () => {
    // `tools` is a flagged nav module with no defaultAccessByRole - flipping its
    // flag on would broadcast read to everyone. With the flag off, a grant for
    // one member must NOT give other members access.
    const grants: ModuleGrant[] = [
      { moduleKey: "tools", principalType: "MEMBER", principalId: "member-1", accessLevel: "read" },
    ];
    expect(resolveModuleAccess(context({ memberId: "member-1", flags: { TOOL_LINKS: false }, grants }), flaggedNavModule)).toBe("read");
    expect(resolveModuleAccess(context({ memberId: "member-2", flags: { TOOL_LINKS: false }, grants }), flaggedNavModule)).toBe("none");
  });
});
