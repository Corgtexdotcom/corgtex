import type { Prisma } from "@prisma/client";
import { lockWorkspaceArchiveArtifact, type ArchiveFilter } from "./archive";

export type CrmArchiveParent = "account" | "contact" | "deal" | "activity";
export type CrmLinks = { accountId?: string | null; contactId?: string | null; dealId?: string | null; activityId?: string | null };
const CRM_LOCK_FIELDS = [["CrmActivity", "activityId"], ["CrmDeal", "dealId"], ["CrmContact", "contactId"], ["CrmAccount", "accountId"]] as const;

export function activeCrmParentWhere(parents: readonly CrmArchiveParent[], filter: ArchiveFilter = "active", required: readonly CrmArchiveParent[] = []) {
  if (filter !== "active") return {};
  const activeContact = { archivedAt: null, OR: [{ accountId: null }, { account: { archivedAt: null } }] };
  const activeParent = (parent: CrmArchiveParent) => parent === "deal"
    ? { archivedAt: null, contact: activeContact, OR: [{ accountId: null }, { account: { archivedAt: null } }] }
    : parent === "contact" ? activeContact : { archivedAt: null };
  return { AND: parents.map((parent) => required.includes(parent)
    ? { [parent]: activeParent(parent) }
    : { OR: [{ [`${parent}Id`]: null }, { [parent]: activeParent(parent) }] }) };
}

export async function lockCrmLinks(tx: Prisma.TransactionClient, ...links: CrmLinks[]) {
  const linked = links.flatMap((link) => CRM_LOCK_FIELDS.map(([type, field]) => [type, link[field]] as const))
    .filter((entry): entry is readonly [typeof CRM_LOCK_FIELDS[number][0], string] => Boolean(entry[1]));
  const unique = [...new Map(linked.map(([type, id]) => [`${type}:${id}`, [type, id] as const])).values()]
    .sort(([leftType, leftId], [rightType, rightId]) => CRM_LOCK_FIELDS.findIndex(([type]) => type === leftType)
      - CRM_LOCK_FIELDS.findIndex(([type]) => type === rightType) || leftId.localeCompare(rightId));
  for (const [entityType, id] of unique) await lockWorkspaceArchiveArtifact(tx, entityType, id);
}

export async function lockCrmLinkClosure(tx: Prisma.TransactionClient, workspaceId: string, ...links: CrmLinks[]) {
  const activityIds = new Set(links.flatMap((link) => link.activityId ? [link.activityId] : []));
  await lockCrmLinks(tx, ...[...activityIds].map((activityId) => ({ activityId })));
  const activities = activityIds.size ? await tx.crmActivity.findMany({ where: { workspaceId, id: { in: [...activityIds] } },
    select: { id: true, accountId: true, contactId: true, dealId: true } }) : [];
  const dealIds = new Set([...links, ...activities].flatMap((link) => link.dealId ? [link.dealId] : []));
  await lockCrmLinks(tx, ...[...dealIds].map((dealId) => ({ dealId })));
  const deals = dealIds.size ? await tx.crmDeal.findMany({ where: { workspaceId, id: { in: [...dealIds] } },
    select: { id: true, accountId: true, contactId: true } }) : [];
  const contactIds = new Set([...links, ...activities, ...deals].flatMap((link) => link.contactId ? [link.contactId] : []));
  await lockCrmLinks(tx, ...[...contactIds].map((contactId) => ({ contactId })));
  const contacts = contactIds.size ? await tx.crmContact.findMany({ where: { workspaceId, id: { in: [...contactIds] } },
    select: { id: true, accountId: true } }) : [];
  const accountIds = new Set([...links, ...activities, ...deals, ...contacts].flatMap((link) => link.accountId ? [link.accountId] : []));
  await lockCrmLinks(tx, ...[...accountIds].map((accountId) => ({ accountId })));
  return { activities, deals, contacts, accountIds: [...accountIds].sort() };
}

export async function lockCrmProspectProvisioning(tx: Prisma.TransactionClient, workspaceId: string, demoLeadId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm_prospect:${workspaceId}:${demoLeadId}`}, 0))`;
}
