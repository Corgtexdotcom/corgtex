/**
 * Domain-layer module access: the I/O "gather" step plus admin grant CRUD.
 *
 * The pure resolution logic lives in `@corgtex/domain/modules` (access.ts).
 * This module loads a `ModuleAccessContext` from the database once, so callers
 * can resolve any number of modules in memory. Keeping gather (I/O) separate
 * from resolve (pure) is what lets caching be added later without touching
 * resolution logic or call sites.
 */

import type { ModuleAccessLevel as PrismaModuleAccessLevel, ModuleGrantPrincipalType as PrismaModuleGrantPrincipalType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import {
  defaultWorkspaceFeatureFlags,
  getModuleManifests,
  resolveAllModuleAccess,
  resolveModuleAccess,
} from "./modules";
import type {
  MemberRoleKey,
  ModuleAccessContext,
  ModuleAccessLevel,
  ModuleGrant,
  ModuleGrantPrincipalType,
  ModuleManifest,
} from "./modules";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export function toAccessLevel(level: PrismaModuleAccessLevel): ModuleAccessLevel {
  switch (level) {
    case "WRITE":
      return "write";
    case "READ":
      return "read";
    default:
      return "none";
  }
}

export function toPrismaAccessLevel(level: ModuleAccessLevel): PrismaModuleAccessLevel {
  switch (level) {
    case "write":
      return "WRITE";
    case "read":
      return "READ";
    default:
      return "NONE";
  }
}

/** Read every workspace feature flag as a boolean map, applying registry defaults. */
export async function getWorkspaceModuleFlags(workspaceId: string): Promise<Record<string, boolean>> {
  const [records, defaults] = await Promise.all([
    prisma.workspaceFeatureFlag.findMany({
      where: { workspaceId },
      select: { flag: true, enabled: true },
    }),
    Promise.resolve(defaultWorkspaceFeatureFlags()),
  ]);
  const flags: Record<string, boolean> = { ...defaults };
  for (const record of records) {
    flags[record.flag] = record.enabled;
  }
  return flags;
}

/** Expand a set of circle ids to include all ancestor circles (cascade). */
export function expandCircleAncestors(
  baseCircleIds: string[],
  parentById: Map<string, string | null>,
): string[] {
  const result = new Set<string>();
  for (const start of baseCircleIds) {
    let current: string | null | undefined = start;
    // Guard against cycles with a local visited set per walk.
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      result.add(current);
      current = parentById.get(current) ?? null;
    }
  }
  return [...result];
}

/**
 * Gather everything needed to resolve a member's module access in one batched
 * round of queries. Circle ancestry is pre-expanded here so the pure resolver
 * stays simple.
 */
export async function gatherModuleAccessContext(params: {
  workspaceId: string;
  memberId: string | null;
  role: MemberRoleKey | null;
}): Promise<ModuleAccessContext> {
  const { workspaceId, memberId, role } = params;

  const [flags, grantRows, assignments, circles] = await Promise.all([
    getWorkspaceModuleFlags(workspaceId),
    prisma.workspaceModuleGrant.findMany({
      where: { workspaceId },
      select: { moduleKey: true, principalType: true, principalId: true, accessLevel: true },
    }),
    memberId
      ? prisma.roleAssignment.findMany({
          where: { memberId },
          select: { roleId: true, role: { select: { circleId: true } } },
        })
      : Promise.resolve([]),
    prisma.circle.findMany({
      where: { workspaceId },
      select: { id: true, parentCircleId: true },
    }),
  ]);

  const parentById = new Map<string, string | null>(circles.map((circle) => [circle.id, circle.parentCircleId]));
  const governanceRoleIds = assignments.map((assignment) => assignment.roleId);
  const baseCircleIds = assignments.map((assignment) => assignment.role.circleId);

  const grants: ModuleGrant[] = grantRows.map((row) => ({
    moduleKey: row.moduleKey,
    principalType: row.principalType as ModuleGrantPrincipalType,
    principalId: row.principalId,
    accessLevel: toAccessLevel(row.accessLevel),
  }));

  return {
    role,
    memberId,
    governanceRoleIds,
    circleIds: expandCircleAncestors(baseCircleIds, parentById),
    flags,
    grants,
  };
}

/** Resolve effective access for every registered module for a member. */
export async function resolveWorkspaceModuleAccess(params: {
  workspaceId: string;
  memberId: string | null;
  role: MemberRoleKey | null;
}): Promise<Record<string, ModuleAccessLevel>> {
  const context = await gatherModuleAccessContext(params);
  return resolveAllModuleAccess(context, getModuleManifests());
}

/** Resolve effective access for a single module manifest. */
export async function resolveSingleModuleAccess(params: {
  workspaceId: string;
  memberId: string | null;
  role: MemberRoleKey | null;
  module: ModuleManifest;
}): Promise<ModuleAccessLevel> {
  const context = await gatherModuleAccessContext({
    workspaceId: params.workspaceId,
    memberId: params.memberId,
    role: params.role,
  });
  return resolveModuleAccess(context, params.module);
}

const GRANT_PRINCIPAL_TYPES = new Set<ModuleGrantPrincipalType>(["MEMBER", "MEMBER_ROLE", "GOVERNANCE_ROLE", "CIRCLE"]);
const ACCESS_LEVELS = new Set<ModuleAccessLevel>(["none", "read", "write"]);

/** List all per-workspace module grants (admin only). */
export async function listWorkspaceModuleGrants(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
  const rows = await prisma.workspaceModuleGrant.findMany({
    where: { workspaceId },
    orderBy: [{ moduleKey: "asc" }, { principalType: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    moduleKey: row.moduleKey,
    principalType: row.principalType as ModuleGrantPrincipalType,
    principalId: row.principalId,
    accessLevel: toAccessLevel(row.accessLevel),
  }));
}

/** Create or update a module grant for a principal (admin only). */
export async function setWorkspaceModuleGrant(actor: AppActor, params: {
  workspaceId: string;
  moduleKey: string;
  principalType: ModuleGrantPrincipalType;
  principalId: string;
  accessLevel: ModuleAccessLevel;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  invariant(GRANT_PRINCIPAL_TYPES.has(params.principalType), 400, "INVALID_INPUT", "Unknown principal type.");
  invariant(ACCESS_LEVELS.has(params.accessLevel), 400, "INVALID_INPUT", "Unknown access level.");
  const moduleKey = params.moduleKey.trim();
  const principalId = params.principalId.trim();
  invariant(moduleKey.length > 0, 400, "INVALID_INPUT", "moduleKey is required.");
  invariant(getModuleManifests().some((mod) => mod.key === moduleKey), 404, "NOT_FOUND", "Unknown module.");
  invariant(principalId.length > 0, 400, "INVALID_INPUT", "principalId is required.");

  const createdByUserId = actor.kind === "user" ? actor.user.id : null;

  return prisma.workspaceModuleGrant.upsert({
    where: {
      workspaceId_moduleKey_principalType_principalId: {
        workspaceId: params.workspaceId,
        moduleKey,
        principalType: params.principalType as PrismaModuleGrantPrincipalType,
        principalId,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      moduleKey,
      principalType: params.principalType as PrismaModuleGrantPrincipalType,
      principalId,
      accessLevel: toPrismaAccessLevel(params.accessLevel),
      createdByUserId,
    },
    update: {
      accessLevel: toPrismaAccessLevel(params.accessLevel),
    },
  });
}

/** Remove a module grant (admin only). */
export async function deleteWorkspaceModuleGrant(actor: AppActor, params: {
  workspaceId: string;
  grantId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  const existing = await prisma.workspaceModuleGrant.findFirst({
    where: { id: params.grantId, workspaceId: params.workspaceId },
    select: { id: true },
  });
  invariant(existing, 404, "NOT_FOUND", "Module grant not found.");
  await prisma.workspaceModuleGrant.delete({ where: { id: existing.id } });
  return { id: existing.id };
}
