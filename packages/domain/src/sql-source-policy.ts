import type { ExternalDataSource, Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { canReadInformationCategory } from "./information-category-policy";

type Db = Prisma.TransactionClient | typeof prisma;

/** Current membership and both explicit source and company category restrictions
 * bind every read. Administrator status does not waive a selected audience. */
export async function canReadSqlSource(actor: AppActor, workspaceId: string,
  source: ExternalDataSource, db: Db = prisma): Promise<boolean> {
  if (actor.kind !== "user" || source.workspaceId !== workspaceId || !source.isActive || source.archivedAt) return false;
  if (!(await resolveKnowledgeAccessDomains(actor, workspaceId, db)).includes(source.accessDomain)) return false;
  const member = await db.member.findFirst({where: {workspaceId, userId: actor.user.id, isActive: true}, select: {id: true}});
  if (!member) return false;
  return canReadInformationCategory(actor, workspaceId, source.informationCategory, db, source);
}
