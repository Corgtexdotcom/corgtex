import type { Prisma } from "@prisma/client";
import { invariant } from "./errors";
import { prisma, type AppActor } from "@corgtex/shared";

export const CATEGORY_BOUND_SOURCE_KINDS = ["ExternalDataSource", "BrainSource", "Document", "Meeting", "MeetingTranscript", "MeetingAgenda"] as const;
type Restriction = { isRestricted: boolean; allowedRoleIds: string[]; allowedCircleIds: string[] };

/** Company categories restrict, never widen, a source's existing audience. */
export async function canReadInformationCategory(actor: AppActor, workspaceId: string, category: string,
  db: Prisma.TransactionClient = prisma, sourceRestriction?: Restriction): Promise<boolean> {
  const company = await db.informationCategoryPolicy.findUnique({ where: { workspaceId_category: { workspaceId, category } } });
  const restrictions = [company, sourceRestriction].filter((policy): policy is Restriction => Boolean(policy?.isRestricted));
  if (!restrictions.length) return true; // Membership and existing private/source checks belong to the caller.
  if (actor.kind !== "user") return false;
  const member = await db.member.findFirst({ where: { workspaceId, userId: actor.user.id, isActive: true }, select: { id: true } });
  if (!member) return false;
  const assignments = await db.roleAssignment.findMany({ where: { memberId: member.id,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], role: { archivedAt: null,
      circle: { workspaceId, archivedAt: null } } }, select: { roleId: true, role: { select: { circleId: true } } } });
  return restrictions.every(policy => assignments.some(assignment => policy.allowedRoleIds.includes(assignment.roleId)
    || policy.allowedCircleIds.includes(assignment.role.circleId)));
}

/** Rebinding policies changes only current authority; old saved vectors are never refreshed. */
export async function configureInformationCategory(actor: AppActor, input: { workspaceId: string; category: string;
  isRestricted: boolean; allowedRoleIds: string[]; allowedCircleIds: string[] }) {
  const { requireWorkspaceMembership } = await import("./auth");
  invariant(actor.kind === "user", 403, "FORBIDDEN", "A company administrator must configure categories.");
  const params = structuredClone(input);
  invariant(typeof params.category === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/.test(params.category)
    && typeof params.isRestricted === "boolean" && Array.isArray(params.allowedRoleIds) && Array.isArray(params.allowedCircleIds)
    && params.allowedRoleIds.length <= 100 && params.allowedCircleIds.length <= 100
    && [...params.allowedRoleIds, ...params.allowedCircleIds].every(id => typeof id === "string" && id.length > 0),
  400, "INVALID_INPUT", "Choose a category and its allowed roles or circles.");
  return prisma.$transaction(async tx => {
    await requireWorkspaceMembership({actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"], tx});
    const administrators = await tx.$queryRaw<Array<{id: string}>>`SELECT id FROM "Member" WHERE "workspaceId"=${params.workspaceId}
      AND "userId"=${actor.user.id} AND "isActive"=true AND role='ADMIN' FOR SHARE`;
    invariant(administrators.length === 1, 403, "FORBIDDEN", "A current company administrator is required.");
    const roles = await tx.role.findMany({where: {id: {in: [...new Set(params.allowedRoleIds)]}, circle: {workspaceId: params.workspaceId, archivedAt: null}, archivedAt: null}});
    const circles = await tx.circle.findMany({where: {id: {in: [...new Set(params.allowedCircleIds)]}, workspaceId: params.workspaceId, archivedAt: null}});
    invariant(roles.length === new Set(params.allowedRoleIds).size && circles.length === new Set(params.allowedCircleIds).size,
      400, "INVALID_AUDIENCE", "Every selected role and circle must belong to this company.");
    const {workspaceId, category, ...data} = params;
    return tx.informationCategoryPolicy.upsert({where: {workspaceId_category: {workspaceId, category}}, create: params, update: data});
  });
}
export async function classifyInformationSource(actor: AppActor, input: {workspaceId: string;
  kind: "BrainSource" | "Document" | "Meeting"; id: string; category: string}) {
  const {requireWorkspaceMembership} = await import("./auth");
  invariant(actor.kind === "user" && ["BrainSource", "Document", "Meeting"].includes(input.kind)
    && typeof input.category === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/.test(input.category),
  400, "INVALID_INPUT", "Choose a source and company category.");
  return prisma.$transaction(async tx => {
    await requireWorkspaceMembership({actor, workspaceId: input.workspaceId, allowedRoles: ["ADMIN"], tx});
    const administrators = await tx.$queryRaw<Array<{id: string}>>`SELECT id FROM "Member" WHERE "workspaceId"=${input.workspaceId}
      AND "userId"=${actor.user.id} AND "isActive"=true AND role='ADMIN' FOR SHARE`;
    invariant(administrators.length === 1, 403, "FORBIDDEN", "A current company administrator is required.");
    if (input.category !== "GENERAL") {
      const policies = await tx.$queryRaw<Array<{id: string}>>`SELECT id FROM "InformationCategoryPolicy"
        WHERE "workspaceId"=${input.workspaceId} AND category=${input.category} FOR SHARE`;
      invariant(policies.length === 1, 400, "UNKNOWN_INFORMATION_CATEGORY", "Configure this company category before assigning it to a source.");
    }
    const where = {id: input.id, workspaceId: input.workspaceId}, data = {informationCategory: input.category};
    const result = input.kind === "BrainSource" ? await tx.brainSource.updateMany({where, data})
      // This is a permission-only reclassification. Preserve the Document body
      // revision timestamp; the dedicated permission trigger advances authority.
      : input.kind === "Document" ? {count: await tx.$executeRaw`UPDATE "Document" SET "informationCategory"=${input.category}
          WHERE id=${input.id} AND "workspaceId"=${input.workspaceId}`} : await tx.meeting.updateMany({where, data});
    invariant(result.count === 1, 404, "NOT_FOUND", "Source not found.");
    return {id: input.id, informationCategory: input.category};
  });
}

export async function categoryGovernorIdentities(kind: string, row: Record<string, unknown>, workspaceId: string, db: Prisma.TransactionClient) {
  if (!(CATEGORY_BOUND_SOURCE_KINDS as readonly string[]).includes(kind) || typeof row.informationCategory !== "string") return [];
  const company = await db.informationCategoryPolicy.findUnique({where: {workspaceId_category: {workspaceId, category: row.informationCategory}}});
  if (!company?.isRestricted) return [];
  const roles = await db.role.findMany({where: {id: {in: company.allowedRoleIds}, circle: {workspaceId}}, select: {id: true, circleId: true}});
  return [...company.allowedRoleIds.map(id => ({kind: "Role", id})),
    ...[...new Set([...company.allowedCircleIds, ...roles.map(role => role.circleId)])].map(id => ({kind: "Circle", id}))];
}
