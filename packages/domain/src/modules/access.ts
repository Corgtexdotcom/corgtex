/**
 * Pure module access resolver. No I/O - it operates entirely on a
 * pre-gathered `ModuleAccessContext`, so it is cheap, deterministic, and
 * trivially testable. The accompanying gather step (in the domain layer) loads
 * the context from the database once per request.
 *
 * Resolution unifies four principal kinds (MEMBER, MEMBER_ROLE,
 * GOVERNANCE_ROLE, CIRCLE) into one effective level by taking the highest
 * grant that matches the member, layered on top of the module's default policy
 * and gated by the module's org opt-in flag.
 */

import type {
  MemberRoleKey,
  ModuleAccessContext,
  ModuleAccessLevel,
  ModuleGrant,
  ModuleManifest,
} from "./types";

const ACCESS_LEVEL_RANK: Record<ModuleAccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
};

export function accessLevelRank(level: ModuleAccessLevel): number {
  return ACCESS_LEVEL_RANK[level];
}

/** Returns the higher of two access levels. */
export function maxAccessLevel(a: ModuleAccessLevel, b: ModuleAccessLevel): ModuleAccessLevel {
  return ACCESS_LEVEL_RANK[a] >= ACCESS_LEVEL_RANK[b] ? a : b;
}

export function isAtLeast(level: ModuleAccessLevel, required: ModuleAccessLevel): boolean {
  return ACCESS_LEVEL_RANK[level] >= ACCESS_LEVEL_RANK[required];
}

/** Is the module available at the org level (its opt-in flag is on, or it has none)? */
export function isModuleEnabled(mod: ModuleManifest, flags: Record<string, boolean>): boolean {
  if (!mod.featureFlag) return true;
  return Boolean(flags[mod.featureFlag.flag]);
}

/**
 * The default access level for a coarse member role, before any grants.
 *
 * Behavior-preserving default: a module with a nav entry is visible (`read`)
 * to every role unless it declares an explicit `defaultAccessByRole`; a
 * headless module defaults to `none`. This reproduces today's "flag on -> tab
 * visible to everyone" behavior while letting modules opt into stricter policy.
 */
export function moduleDefaultAccess(
  mod: ModuleManifest,
  role: MemberRoleKey | null,
): ModuleAccessLevel {
  const policy = mod.defaultAccessByRole;
  if (policy) {
    if (!role) return "none";
    return policy[role] ?? "none";
  }
  return mod.nav ? "read" : "none";
}

function grantMatchesContext(grant: ModuleGrant, context: ModuleAccessContext): boolean {
  switch (grant.principalType) {
    case "MEMBER":
      return context.memberId != null && grant.principalId === context.memberId;
    case "MEMBER_ROLE":
      return context.role != null && grant.principalId === context.role;
    case "GOVERNANCE_ROLE":
      return context.governanceRoleIds.includes(grant.principalId);
    case "CIRCLE":
      return context.circleIds.includes(grant.principalId);
    default:
      return false;
  }
}

/**
 * Effective access level for a single module given the gathered context.
 * Returns `none` when the module is not available at the org level.
 */
export function resolveModuleAccess(
  context: ModuleAccessContext,
  mod: ModuleManifest,
): ModuleAccessLevel {
  if (!isModuleEnabled(mod, context.flags)) return "none";

  let level = moduleDefaultAccess(mod, context.role);
  for (const grant of context.grants) {
    if (grant.moduleKey !== mod.key) continue;
    if (grantMatchesContext(grant, context)) {
      level = maxAccessLevel(level, grant.accessLevel);
    }
  }
  return level;
}

const MEMBER_ROLE_KEYS: MemberRoleKey[] = ["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"];

/**
 * The coarse member roles that receive at least `atLeast` access to a module by
 * its default policy. This is the single source of truth domain guards read
 * instead of hardcoding `allowedRoles`.
 */
export function rolesWithDefaultAccess(mod: ModuleManifest, atLeast: ModuleAccessLevel): MemberRoleKey[] {
  return MEMBER_ROLE_KEYS.filter((role) => isAtLeast(moduleDefaultAccess(mod, role), atLeast));
}

/** Effective access level for every provided module, keyed by module key. */
export function resolveAllModuleAccess(
  context: ModuleAccessContext,
  modules: readonly ModuleManifest[],
): Record<string, ModuleAccessLevel> {
  const result: Record<string, ModuleAccessLevel> = {};
  for (const mod of modules) {
    result[mod.key] = resolveModuleAccess(context, mod);
  }
  return result;
}
