import type { ExternalDataSource, Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { resolveKnowledgeAccessDomains } from "./brain-access";

type Db = Prisma.TransactionClient | typeof prisma;
type Restriction = {isRestricted: boolean; allowedRoleIds: string[]; allowedCircleIds: string[]};

/** Current membership and both explicit source and company category restrictions
 * bind every read. Administrator status does not waive a selected audience. */
export async function canReadSqlSource(actor: AppActor, workspaceId: string,
  source: ExternalDataSource, db: Db = prisma): Promise<boolean> {
  if (actor.kind !== "user" || source.workspaceId !== workspaceId || !source.isActive || source.archivedAt) return false;
  if (!(await resolveKnowledgeAccessDomains(actor, workspaceId, db)).includes(source.accessDomain)) return false;
  const member = await db.member.findFirst({where: {workspaceId, userId: actor.user.id, isActive: true}, select: {id: true}});
  if (!member) return false;
  const company = await db.informationCategoryPolicy.findUnique({where: {workspaceId_category: {
    workspaceId, category: source.informationCategory}}});
  const restrictions: Restriction[] = [source, ...(company ? [company] : [])];
  if (restrictions.every(policy => !policy.isRestricted)) return true;
  const assignments = await db.roleAssignment.findMany({where: {memberId: member.id,
    OR: [{expiresAt: null}, {expiresAt: {gt: new Date()}}], role: {archivedAt: null,
      circle: {workspaceId, archivedAt: null}}}, select: {roleId: true, role: {select: {circleId: true}}}});
  return restrictions.every(policy => !policy.isRestricted || assignments.some(assignment =>
    policy.allowedRoleIds.includes(assignment.roleId) || policy.allowedCircleIds.includes(assignment.role.circleId)));
}
