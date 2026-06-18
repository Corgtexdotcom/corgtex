import { randomUUID } from "node:crypto";
import { env, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { CrmDealStage, CrmActivityType } from "@prisma/client";
import { registerCustomerDeployment } from "./customer-lifecycle";

const DEFAULT_DEMO_WORKSPACE = {
  slug: "corgtex",
  name: "Corgtex",
  description: "Internal company operating environment for Corgtex",
};

export const DEFAULT_CRM_RELATIONSHIP_TYPE = "PROSPECT";
export const DEFAULT_CRM_LIFECYCLE_STAGE = "DISCOVERY";
export const SUGGESTED_CRM_RELATIONSHIP_TYPES = [
  "PROSPECT",
  "CLIENT",
  "PARTNER",
  "VENDOR",
  "INVESTOR",
  "OTHER",
] as const;
export const SUGGESTED_CRM_LIFECYCLE_STAGES = [
  "DISCOVERY",
  "QUALIFYING",
  "PILOT",
  "ACTIVE",
  "ON_HOLD",
  "LOST",
  "DORMANT",
] as const;

const CRM_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const FREE_EMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
]);
const CLOSED_CRM_DEAL_STAGES = new Set<CrmDealStage>([
  CrmDealStage.CLOSED_WON,
  CrmDealStage.CLOSED_LOST,
]);

function normalizeCrmCode(value: string | null | undefined, fallback: string, label: string) {
  const normalized = (value?.trim() || fallback)
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  invariant(CRM_CODE_PATTERN.test(normalized), 400, "INVALID_INPUT", `${label} must be an uppercase code.`);
  return normalized;
}

export function normalizeCrmRelationshipType(value?: string | null) {
  return normalizeCrmCode(value, DEFAULT_CRM_RELATIONSHIP_TYPE, "Relationship type");
}

export function normalizeCrmLifecycleStage(value?: string | null) {
  return normalizeCrmCode(value, DEFAULT_CRM_LIFECYCLE_STAGE, "Lifecycle stage");
}

export function normalizeCrmAccountSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  invariant(slug.length > 0, 400, "INVALID_INPUT", "Account slug could not be derived.");
  return slug;
}

function normalizeCrmAccountDomain(value?: string | null) {
  const domain = value
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    ?.replace(/:\d+$/, "");
  if (!domain || !domain.includes(".")) return null;
  return domain;
}

function emailDomain(email: string) {
  const [, domainPart] = email.trim().toLowerCase().split("@");
  return normalizeCrmAccountDomain(domainPart);
}

function titleFromDomain(domain: string) {
  const root = domain.split(".")[0] || domain;
  return root
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || domain;
}

function crmAccountCandidate(params: {
  email?: string | null;
  company?: string | null;
  website?: string | null;
  source?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
}) {
  const company = params.company?.trim() || null;
  const rawDomain = normalizeCrmAccountDomain(params.website) || (params.email ? emailDomain(params.email) : null);
  const domain = rawDomain && !FREE_EMAIL_DOMAINS.has(rawDomain) ? rawDomain : null;
  if (!company && !domain) return null;

  const name = company || titleFromDomain(domain!);
  return {
    name,
    slug: normalizeCrmAccountSlug(company || domain!),
    domain,
    relationshipType: normalizeCrmRelationshipType(params.relationshipType),
    lifecycleStage: normalizeCrmLifecycleStage(params.lifecycleStage),
    source: params.source?.trim() || "manual",
  };
}

async function findExistingCrmAccount(tx: any, workspaceId: string, candidate: { slug: string; domain: string | null }) {
  const or = [{ slug: candidate.slug }];
  if (candidate.domain) {
    or.push({ domain: candidate.domain } as any);
  }
  return tx.crmAccount.findFirst({
    where: {
      workspaceId,
      archivedAt: null,
      OR: or,
    },
  });
}

async function ensureCrmAccount(tx: any, workspaceId: string, params: {
  email?: string | null;
  company?: string | null;
  website?: string | null;
  source?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
}) {
  const candidate = crmAccountCandidate(params);
  if (!candidate) return null;

  const existing = await findExistingCrmAccount(tx, workspaceId, candidate);
  if (existing) {
    if (!existing.domain && candidate.domain) {
      return tx.crmAccount.update({
        where: { id: existing.id },
        data: { domain: candidate.domain },
      });
    }
    return existing;
  }

  return tx.crmAccount.create({
    data: {
      workspaceId,
      ...candidate,
    },
  });
}

async function requireCrmAccount(tx: any, workspaceId: string, accountId: string) {
  const account = await tx.crmAccount.findUnique({ where: { id: accountId } });
  invariant(account && account.workspaceId === workspaceId && !account.archivedAt, 404, "NOT_FOUND", "Account not found.");
  return account;
}

function dealClosedAtForStage(stage: CrmDealStage) {
  return CLOSED_CRM_DEAL_STAGES.has(stage) ? new Date() : null;
}

async function recordDealStageTransition(tx: any, params: {
  workspaceId: string;
  dealId: string;
  fromStage: CrmDealStage | null;
  toStage: CrmDealStage;
  actorUserId?: string | null;
  createdAt?: Date;
}) {
  return tx.crmDealStageTransition.create({
    data: {
      workspaceId: params.workspaceId,
      dealId: params.dealId,
      fromStage: params.fromStage,
      toStage: params.toStage,
      actorUserId: params.actorUserId ?? null,
      ...(params.createdAt ? { createdAt: params.createdAt } : {}),
    },
  });
}

async function syncCrmAccountLinksForContact(tx: any, params: { workspaceId: string; contactId: string; email?: string | null; accountId: string }) {
  const [deals, activities, conversations] = await Promise.all([
    tx.crmDeal.updateMany({
      where: { workspaceId: params.workspaceId, contactId: params.contactId, accountId: null },
      data: { accountId: params.accountId },
    }),
    tx.crmActivity.updateMany({
      where: { workspaceId: params.workspaceId, contactId: params.contactId, accountId: null },
      data: { accountId: params.accountId },
    }),
    tx.crmConversation.updateMany({
      where: { workspaceId: params.workspaceId, contactId: params.contactId, accountId: null },
      data: { accountId: params.accountId },
    }),
  ]);

  let prospectWorkspaces = { count: 0 };
  if (params.email) {
    const lead = await tx.demoLead.findFirst({
      where: { workspaceId: params.workspaceId, email: params.email },
      select: { id: true },
    });
    if (lead) {
      prospectWorkspaces = await tx.crmProspectWorkspace.updateMany({
        where: { crmWorkspaceId: params.workspaceId, demoLeadId: lead.id, accountId: null },
        data: { accountId: params.accountId },
      });
    }
  }

  return {
    deals: deals.count,
    activities: activities.count,
    conversations: conversations.count,
    prospectWorkspaces: prospectWorkspaces.count,
  };
}

export async function captureDemoLead(params: {
  email: string;
  source?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  workspaceDescription?: string;
}) {
  const email = params.email.trim().toLowerCase();
  invariant(email.length > 0 && email.includes("@"), 400, "INVALID_INPUT", "Valid email is required.");

  const workspaceSlug = params.workspaceSlug?.trim() || DEFAULT_DEMO_WORKSPACE.slug;
  const workspaceName = params.workspaceName?.trim() || DEFAULT_DEMO_WORKSPACE.name;
  const workspaceDescription = params.workspaceDescription?.trim() || DEFAULT_DEMO_WORKSPACE.description;
  const source = params.source?.trim() || "demo_gate";
  const [localPart, domainPart] = email.split("@");
  const name = localPart.replace(/[^a-zA-Z0-9]/g, " ");

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.upsert({
      where: { slug: workspaceSlug },
      update: {},
      create: {
        slug: workspaceSlug,
        name: workspaceName,
        description: workspaceDescription,
      },
    });

    const demoLead = await tx.demoLead.upsert({
      where: {
        workspaceId_email: {
          workspaceId: workspace.id,
          email,
        },
      },
      update: {
        lastSeenAt: new Date(),
        visitCount: { increment: 1 },
      },
      create: {
        workspaceId: workspace.id,
        email,
        source,
        qualifyToken: randomUUID(),
      },
    });

    const account = await ensureCrmAccount(tx, workspace.id, {
      email,
      source,
    });

    const contact = await tx.crmContact.upsert({
      where: {
        workspaceId_email: {
          workspaceId: workspace.id,
          email,
        },
      },
      update: {
        lastSeenAt: new Date(),
        ...(account ? { accountId: account.id } : {}),
      },
      create: {
        workspaceId: workspace.id,
        accountId: account?.id ?? null,
        email,
        name,
        company: domainPart,
        source,
      },
    });

    if (!demoLead.welcomeEmailSentAt) {
      await appendEvents(tx, [
        {
          workspaceId: workspace.id,
          type: "demo-lead.captured",
          aggregateType: "DemoLead",
          aggregateId: demoLead.id,
          payload: {
            demoLeadId: demoLead.id,
            email,
            source,
          },
        },
      ]);
    }

    return { workspace, demoLead, contact };
  });
}

// --- ACCOUNTS ---

export async function listCrmAccounts(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  skip?: number;
  query?: string;
  relationshipType?: string;
  lifecycleStage?: string;
  archiveFilter?: ArchiveFilter;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;

  let where: any = { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) };
  if (opts?.relationshipType) {
    where.relationshipType = normalizeCrmRelationshipType(opts.relationshipType);
  }
  if (opts?.lifecycleStage) {
    where.lifecycleStage = normalizeCrmLifecycleStage(opts.lifecycleStage);
  }
  if (opts?.query) {
    where = {
      ...where,
      OR: [
        { name: { contains: opts.query, mode: "insensitive" } },
        { domain: { contains: opts.query, mode: "insensitive" } },
      ],
    };
  }

  const [items, total] = await Promise.all([
    prisma.crmAccount.findMany({
      where,
      include: {
        _count: {
          select: { contacts: true, deals: true, activities: true, crmConversations: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    }),
    prisma.crmAccount.count({ where }),
  ]);

  return { items, total, take, skip };
}

export async function getCrmAccount(actor: AppActor, params: { workspaceId: string; accountId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const account = await prisma.crmAccount.findUnique({
    where: { id: params.accountId },
    include: {
      contacts: {
        where: { archivedAt: null },
        orderBy: { lastSeenAt: "desc" },
      },
      deals: {
        where: { archivedAt: null },
        orderBy: { updatedAt: "desc" },
        include: {
          contact: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          activities: {
            where: { type: CrmActivityType.TASK },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, title: true, createdAt: true, type: true },
          },
          stageTransitions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, fromStage: true, toStage: true, createdAt: true },
          },
        },
      },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
      crmConversations: {
        orderBy: { updatedAt: "desc" },
        take: 25,
        include: {
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
      prospectWorkspaces: {
        orderBy: { provisionedAt: "desc" },
        take: 25,
        include: {
          targetWorkspace: { select: { id: true, slug: true, name: true } },
        },
      },
    },
  });

  invariant(account && account.workspaceId === params.workspaceId && !account.archivedAt, 404, "NOT_FOUND", "Account not found.");
  return account;
}

export async function createCrmAccount(actor: AppActor, params: {
  workspaceId: string;
  name: string;
  domain?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
  descriptionMd?: string | null;
  source?: string | null;
  tags?: string[];
  ownerUserId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const name = params.name.trim();
  invariant(name.length > 0, 400, "INVALID_INPUT", "Account name is required.");
  const domain = normalizeCrmAccountDomain(params.domain);
  const slug = normalizeCrmAccountSlug(domain || name);
  const relationshipType = normalizeCrmRelationshipType(params.relationshipType);
  const lifecycleStage = normalizeCrmLifecycleStage(params.lifecycleStage);

  return prisma.$transaction(async (tx) => {
    const duplicate = await findExistingCrmAccount(tx, params.workspaceId, { slug, domain });
    invariant(!duplicate, 409, "CONFLICT", "Account already exists.");

    const account = await tx.crmAccount.create({
      data: {
        workspaceId: params.workspaceId,
        name,
        slug,
        domain,
        relationshipType,
        lifecycleStage,
        descriptionMd: params.descriptionMd?.trim() || null,
        source: params.source?.trim() || "manual",
        tags: params.tags || [],
        ownerUserId: params.ownerUserId || null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.account.created",
        entityType: "CrmAccount",
        entityId: account.id,
        meta: { name: account.name, relationshipType: account.relationshipType, lifecycleStage: account.lifecycleStage },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.account.created",
        aggregateType: "CrmAccount",
        aggregateId: account.id,
        payload: { accountId: account.id, name: account.name },
      },
    ]);

    return account;
  });
}

export async function updateCrmAccount(actor: AppActor, params: {
  workspaceId: string;
  accountId: string;
  name?: string;
  domain?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
  descriptionMd?: string | null;
  tags?: string[];
  ownerUserId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const account = await requireCrmAccount(tx, params.workspaceId, params.accountId);
    const data: any = {};

    if (params.name !== undefined) {
      const name = params.name.trim();
      invariant(name.length > 0, 400, "INVALID_INPUT", "Account name is required.");
      data.name = name;
      if (!account.domain) {
        data.slug = normalizeCrmAccountSlug(name);
      }
    }
    if (params.domain !== undefined) {
      const domain = normalizeCrmAccountDomain(params.domain);
      data.domain = domain;
      data.slug = normalizeCrmAccountSlug(domain || data.name || account.name);
    }
    if (params.relationshipType !== undefined) data.relationshipType = normalizeCrmRelationshipType(params.relationshipType);
    if (params.lifecycleStage !== undefined) data.lifecycleStage = normalizeCrmLifecycleStage(params.lifecycleStage);
    if (params.descriptionMd !== undefined) data.descriptionMd = params.descriptionMd?.trim() || null;
    if (params.tags !== undefined) data.tags = params.tags;
    if (params.ownerUserId !== undefined) data.ownerUserId = params.ownerUserId;

    if (data.slug && data.slug !== account.slug) {
      const duplicate = await findExistingCrmAccount(tx, params.workspaceId, { slug: data.slug, domain: data.domain ?? account.domain });
      invariant(!duplicate || duplicate.id === account.id, 409, "CONFLICT", "Account already exists.");
    }

    const updated = await tx.crmAccount.update({
      where: { id: params.accountId },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.account.updated",
        entityType: "CrmAccount",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}

export async function deleteCrmAccount(actor: AppActor, params: { workspaceId: string; accountId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "CrmAccount",
    entityId: params.accountId,
    reason: "Archived from account delete path.",
  });

  return { id: params.accountId };
}

export async function backfillCrmAccountsForWorkspace(actor: AppActor, params: { workspaceId: string; take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const take = params.take ?? 1000;

  return prisma.$transaction(async (tx) => {
    const contacts = await tx.crmContact.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        accountId: null,
      },
      orderBy: { createdAt: "asc" },
      take,
      select: {
        id: true,
        email: true,
        company: true,
        source: true,
      },
    });

    const summary = {
      scanned: contacts.length,
      accountsCreated: 0,
      contactsLinked: 0,
      dealsLinked: 0,
      activitiesLinked: 0,
      conversationsLinked: 0,
      prospectWorkspacesLinked: 0,
      skipped: 0,
    };

    for (const contact of contacts) {
      const candidate = crmAccountCandidate({
        email: contact.email,
        company: contact.company,
        source: contact.source,
      });
      if (!candidate) {
        summary.skipped += 1;
        continue;
      }

      const beforeAccount = await findExistingCrmAccount(tx, params.workspaceId, candidate);
      const account = await ensureCrmAccount(tx, params.workspaceId, {
        email: contact.email,
        company: contact.company,
        source: contact.source,
      });
      if (!account) {
        summary.skipped += 1;
        continue;
      }
      if (!beforeAccount) {
        summary.accountsCreated += 1;
      }

      await tx.crmContact.update({
        where: { id: contact.id },
        data: { accountId: account.id },
      });
      summary.contactsLinked += 1;

      const linked = await syncCrmAccountLinksForContact(tx, {
        workspaceId: params.workspaceId,
        contactId: contact.id,
        email: contact.email,
        accountId: account.id,
      });
      summary.dealsLinked += linked.deals;
      summary.activitiesLinked += linked.activities;
      summary.conversationsLinked += linked.conversations;
      summary.prospectWorkspacesLinked += linked.prospectWorkspaces;
    }

    return summary;
  });
}

// --- CONTACTS ---

export async function listContacts(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number; query?: string; archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  
  let where: any = { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) };
  if (opts?.query) {
    where = {
      ...where,
      OR: [
        { email: { contains: opts.query, mode: "insensitive" } },
        { name: { contains: opts.query, mode: "insensitive" } },
        { company: { contains: opts.query, mode: "insensitive" } },
      ],
    };
  }

  const [items, total] = await Promise.all([
    prisma.crmContact.findMany({
      where,
      include: {
        account: {
          select: { id: true, name: true, slug: true, domain: true, relationshipType: true, lifecycleStage: true },
        },
        _count: {
          select: { deals: true, activities: true },
        },
      },
      orderBy: { lastSeenAt: "desc" },
      take,
      skip,
    }),
    prisma.crmContact.count({ where }),
  ]);
  
  return { items, total, take, skip };
}

export async function getContact(actor: AppActor, params: { workspaceId: string; contactId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  
  const contact = await prisma.crmContact.findUnique({
    where: { id: params.contactId },
    include: {
      account: true,
      deals: {
        where: { archivedAt: null },
        orderBy: { updatedAt: "desc" },
      },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  });
  
  invariant(contact && contact.workspaceId === params.workspaceId && !contact.archivedAt, 404, "NOT_FOUND", "Contact not found.");
  return contact;
}

export async function createContact(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  name?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  source?: string;
  tags?: string[];
  accountId?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const email = params.email.trim().toLowerCase();
  invariant(email.length > 0 && email.includes("@"), 400, "INVALID_INPUT", "Valid email is required.");

  return prisma.$transaction(async (tx) => {
    let account = null;
    if (params.accountId !== undefined) {
      account = params.accountId ? await requireCrmAccount(tx, params.workspaceId, params.accountId) : null;
    } else {
      account = await ensureCrmAccount(tx, params.workspaceId, {
        email,
        company: params.company,
        source: params.source,
        relationshipType: params.relationshipType,
        lifecycleStage: params.lifecycleStage,
      });
    }

    const contact = await tx.crmContact.create({
      data: {
        workspaceId: params.workspaceId,
        accountId: account?.id ?? null,
        email,
        name: params.name?.trim() || null,
        company: params.company?.trim() || null,
        title: params.title?.trim() || null,
        phone: params.phone?.trim() || null,
        source: params.source || "manual",
        tags: params.tags || [],
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.contact.created",
        entityType: "CrmContact",
        entityId: contact.id,
        meta: { email: contact.email },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.contact.created",
        aggregateType: "CrmContact",
        aggregateId: contact.id,
        payload: { contactId: contact.id, email: contact.email },
      },
    ]);

    return contact;
  });
}

export async function updateContact(actor: AppActor, params: {
  workspaceId: string;
  contactId: string;
  email?: string;
  name?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  tags?: string[];
  accountId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const contact = await tx.crmContact.findUnique({ where: { id: params.contactId } });
    invariant(contact && contact.workspaceId === params.workspaceId && !contact.archivedAt, 404, "NOT_FOUND", "Contact not found.");

    const data: any = {};
    if (params.email !== undefined) {
      const email = params.email.trim().toLowerCase();
      invariant(email.length > 0 && email.includes("@"), 400, "INVALID_INPUT", "Valid email is required.");
      data.email = email;
    }
    if (params.name !== undefined) data.name = params.name?.trim() || null;
    if (params.company !== undefined) data.company = params.company?.trim() || null;
    if (params.title !== undefined) data.title = params.title?.trim() || null;
    if (params.phone !== undefined) data.phone = params.phone?.trim() || null;
    if (params.tags !== undefined) data.tags = params.tags;
    if (params.accountId !== undefined) {
      data.accountId = params.accountId ? (await requireCrmAccount(tx, params.workspaceId, params.accountId)).id : null;
    }

    const updated = await tx.crmContact.update({
      where: { id: params.contactId },
      data,
    });

    if (updated.accountId) {
      await syncCrmAccountLinksForContact(tx, {
        workspaceId: params.workspaceId,
        contactId: updated.id,
        email: updated.email,
        accountId: updated.accountId,
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.contact.updated",
        entityType: "CrmContact",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}

export async function deleteContact(actor: AppActor, params: { workspaceId: string; contactId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "CrmContact",
    entityId: params.contactId,
    reason: "Archived from contact delete path.",
  });

  return { id: params.contactId };
}

// --- DEALS ---

export async function listDeals(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number; stage?: CrmDealStage; archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const take = opts?.take ?? 100;
  const skip = opts?.skip ?? 0;
  
  const where: any = { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) };
  if (opts?.stage) {
    where.stage = opts.stage;
  }

  const [items, total] = await Promise.all([
    prisma.crmDeal.findMany({
      where,
      include: {
        account: {
          select: { id: true, name: true, slug: true, domain: true, relationshipType: true, lifecycleStage: true },
        },
        contact: {
          select: { id: true, name: true, company: true, email: true, avatarUrl: true },
        },
        activities: {
          where: { type: CrmActivityType.TASK },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, title: true, createdAt: true, type: true },
        },
        stageTransitions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, fromStage: true, toStage: true, createdAt: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    }),
    prisma.crmDeal.count({ where }),
  ]);
  
  return { items, total, take, skip };
}

export async function createDeal(actor: AppActor, params: {
  workspaceId: string;
  contactId: string;
  title: string;
  stage?: CrmDealStage;
  valueCents?: number | null;
  currency?: string;
  ownerUserId?: string | null;
  accountId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Deal title is required.");

  return prisma.$transaction(async (tx) => {
    const contact = await tx.crmContact.findUnique({ where: { id: params.contactId } });
    invariant(contact && contact.workspaceId === params.workspaceId && !contact.archivedAt, 404, "NOT_FOUND", "Contact not found.");
    let accountId = contact.accountId ?? null;
    if (params.accountId !== undefined) {
      accountId = params.accountId ? (await requireCrmAccount(tx, params.workspaceId, params.accountId)).id : null;
    }
    const stage = params.stage ?? CrmDealStage.LEAD;

    const deal = await tx.crmDeal.create({
      data: {
        workspaceId: params.workspaceId,
        accountId,
        contactId: params.contactId,
        title,
        stage,
        valueCents: params.valueCents ?? null,
        currency: params.currency || "USD",
        closedAt: dealClosedAtForStage(stage),
        ownerUserId: params.ownerUserId || null,
      },
    });

    await recordDealStageTransition(tx, {
      workspaceId: params.workspaceId,
      dealId: deal.id,
      fromStage: null,
      toStage: stage,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      createdAt: deal.createdAt,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.deal.created",
        entityType: "CrmDeal",
        entityId: deal.id,
        meta: { title: deal.title },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.deal.created",
        aggregateType: "CrmDeal",
        aggregateId: deal.id,
        payload: { dealId: deal.id, title: deal.title },
      },
    ]);

    return deal;
  });
}

export async function updateDeal(actor: AppActor, params: {
  workspaceId: string;
  dealId: string;
  title?: string;
  stage?: CrmDealStage;
  valueCents?: number | null;
  currency?: string;
  ownerUserId?: string | null;
  notes?: string | null;
  accountId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const deal = await tx.crmDeal.findUnique({ where: { id: params.dealId } });
    invariant(deal && deal.workspaceId === params.workspaceId && !deal.archivedAt, 404, "NOT_FOUND", "Deal not found.");

    const data: any = {};
    let stageChanged = false;
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Deal title is required.");
      data.title = title;
    }
    if (params.stage !== undefined) {
      stageChanged = params.stage !== deal.stage;
      if (stageChanged) {
        data.stage = params.stage;
        data.closedAt = dealClosedAtForStage(params.stage);
      }
    }
    if (params.valueCents !== undefined) data.valueCents = params.valueCents;
    if (params.currency !== undefined) data.currency = params.currency;
    if (params.ownerUserId !== undefined) data.ownerUserId = params.ownerUserId;
    if (params.notes !== undefined) data.notes = params.notes?.trim() || null;
    if (params.accountId !== undefined) {
      data.accountId = params.accountId ? (await requireCrmAccount(tx, params.workspaceId, params.accountId)).id : null;
    }

    if (Object.keys(data).length === 0) {
      return deal;
    }

    const updated = await tx.crmDeal.update({
      where: { id: params.dealId },
      data,
    });

    if (stageChanged && params.stage) {
      await recordDealStageTransition(tx, {
        workspaceId: params.workspaceId,
        dealId: params.dealId,
        fromStage: deal.stage,
        toStage: params.stage,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.deal.updated",
        entityType: "CrmDeal",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}

export async function deleteDeal(actor: AppActor, params: { workspaceId: string; dealId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "CrmDeal",
    entityId: params.dealId,
    reason: "Archived from deal delete path.",
  });

  return { id: params.dealId };
}

// --- ACTIVITIES ---

export async function listCrmActivities(actor: AppActor, workspaceId: string, opts?: {
  accountId?: string;
  contactId?: string;
  dealId?: string;
  type?: CrmActivityType;
  take?: number;
  skip?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  const where: any = { workspaceId };
  if (opts?.accountId) where.accountId = opts.accountId;
  if (opts?.contactId) where.contactId = opts.contactId;
  if (opts?.dealId) where.dealId = opts.dealId;
  if (opts?.type) where.type = opts.type;

  const [items, total] = await Promise.all([
    prisma.crmActivity.findMany({
      where,
      include: {
        account: {
          select: { id: true, name: true, slug: true, relationshipType: true, lifecycleStage: true },
        },
        contact: {
          select: { id: true, name: true, email: true, company: true },
        },
        deal: {
          select: { id: true, title: true, stage: true, valueCents: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.crmActivity.count({ where }),
  ]);

  return { items, total, take, skip };
}

export async function createActivity(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  type?: CrmActivityType;
  bodyMd?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  accountId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Activity title is required.");
  invariant(params.accountId || params.contactId || params.dealId, 400, "INVALID_INPUT", "Activity must be linked to an account, contact, or deal.");

  return prisma.$transaction(async (tx) => {
    let accountId = params.accountId ?? null;
    if (params.contactId) {
      const contact = await tx.crmContact.findUnique({ where: { id: params.contactId } });
      invariant(contact && contact.workspaceId === params.workspaceId && !contact.archivedAt, 404, "NOT_FOUND", "Contact not found.");
      if (accountId && contact.accountId) {
        invariant(accountId === contact.accountId, 400, "INVALID_INPUT", "Activity account must match the linked contact.");
      }
      accountId = accountId || contact.accountId || null;
    }
    if (params.dealId) {
      const deal = await tx.crmDeal.findUnique({ where: { id: params.dealId } });
      invariant(deal && deal.workspaceId === params.workspaceId && !deal.archivedAt, 404, "NOT_FOUND", "Deal not found.");
      if (accountId && deal.accountId) {
        invariant(accountId === deal.accountId, 400, "INVALID_INPUT", "Activity account must match the linked deal.");
      }
      accountId = accountId || deal.accountId || null;
    }
    if (accountId) {
      await requireCrmAccount(tx, params.workspaceId, accountId);
    }

    invariant(accountId || params.contactId || params.dealId, 400, "INVALID_INPUT", "Activity must be linked to an account, contact, or deal.");

    const activity = await tx.crmActivity.create({
      data: {
        workspaceId: params.workspaceId,
        accountId,
        title,
        type: params.type || CrmActivityType.NOTE,
        bodyMd: params.bodyMd?.trim() || null,
        contactId: params.contactId || null,
        dealId: params.dealId || null,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
      },
    });

    return activity;
  });
}

// --- QUALIFICATIONS ---

export async function submitQualification(params: {
  token: string;
  companyName: string;
  website: string;
  roleTitle?: string;
  aiExperience: string;
  helpNeeded: string;
}) {
  const lead = await prisma.demoLead.findUnique({
    where: { qualifyToken: params.token },
    include: { workspace: true },
  });
  invariant(lead, 400, "INVALID_INPUT", "Invalid qualification token.");

  return prisma.$transaction(async (tx) => {
    const qualification = await tx.crmQualification.create({
      data: {
        workspaceId: lead.workspaceId,
        demoLeadId: lead.id,
        responseChannel: "form",
        companyName: params.companyName.trim(),
        website: params.website.trim(),
        roleTitle: params.roleTitle?.trim() || null,
        aiExperience: params.aiExperience.trim(),
        helpNeeded: params.helpNeeded.trim(),
        status: "PENDING_REVIEW",
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: lead.workspaceId,
        type: "crm.qualification.submitted",
        aggregateType: "CrmQualification",
        aggregateId: qualification.id,
        payload: { qualificationId: qualification.id, email: lead.email },
      },
    ]);

    return qualification;
  });
}

export async function receiveEmailReply(params: {
  fromEmail: string;
  subject: string;
  bodyText: string;
}) {
  const email = params.fromEmail.trim().toLowerCase();
  
  const lead = await prisma.demoLead.findFirst({
    where: { email },
    orderBy: { createdAt: 'desc' },
  });
  
  invariant(lead, 404, "NOT_FOUND", "No matching DemoLead found for inbound reply.");

  return prisma.$transaction(async (tx) => {
    const qualification = await tx.crmQualification.create({
      data: {
        workspaceId: lead.workspaceId,
        demoLeadId: lead.id,
        responseChannel: "email_reply",
        rawEmailReply: params.bodyText.trim(),
        rawEmailSubject: params.subject.trim(),
        status: "PENDING_REVIEW",
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: lead.workspaceId,
        type: "crm.qualification.submitted",
        aggregateType: "CrmQualification",
        aggregateId: qualification.id,
        payload: { qualificationId: qualification.id, email: lead.email, channel: "email_reply" },
      },
    ]);

    return qualification;
  });
}

export async function listQualifications(actor: AppActor, workspaceId: string, opts?: { status?: string; take?: number; skip?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  
  const where: any = { workspaceId };
  if (opts?.status) {
    where.status = opts.status;
  }

  const [items, total] = await Promise.all([
    prisma.crmQualification.findMany({
      where,
      include: {
        demoLead: {
          select: { email: true, source: true, createdAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.crmQualification.count({ where }),
  ]);
  
  return { items, total, take, skip };
}

export async function approveQualification(actor: AppActor, params: { workspaceId: string; qualificationId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const qual = await prisma.crmQualification.findUnique({
    where: { id: params.qualificationId },
    include: { demoLead: true },
  });
  invariant(qual && qual.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Qualification not found.");
  invariant(qual.status === "PENDING_REVIEW", 400, "INVALID_STATE", "Qualification is not pending review.");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.crmQualification.update({
      where: { id: qual.id },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      },
    });

    const account = await ensureCrmAccount(tx, params.workspaceId, {
      email: qual.demoLead.email,
      company: qual.companyName,
      website: qual.website,
      source: "qualification",
    });

    if (qual.companyName || account) {
      const contacts = await tx.crmContact.findMany({
        where: { workspaceId: params.workspaceId, email: qual.demoLead.email },
        select: { id: true, email: true },
      });
      const contactData: any = {};
      if (qual.companyName) contactData.company = qual.companyName;
      if (account) contactData.accountId = account.id;
      await tx.crmContact.updateMany({
        where: { workspaceId: params.workspaceId, email: qual.demoLead.email },
        data: contactData,
      });

      if (account) {
        await tx.crmConversation.updateMany({
          where: { workspaceId: params.workspaceId, demoLeadId: qual.demoLead.id, accountId: null },
          data: { accountId: account.id },
        });
        await tx.crmProspectWorkspace.updateMany({
          where: { crmWorkspaceId: params.workspaceId, demoLeadId: qual.demoLead.id, accountId: null },
          data: { accountId: account.id },
        });
        await Promise.all(contacts.map((contact) => syncCrmAccountLinksForContact(tx, {
          workspaceId: params.workspaceId,
          contactId: contact.id,
          email: contact.email,
          accountId: account.id,
        })));
      }
    }

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.qualification.approved",
        aggregateType: "CrmQualification",
        aggregateId: qual.id,
        payload: { qualificationId: qual.id, email: qual.demoLead.email },
      },
    ]);

    return updated;
  });
}

export async function rejectQualification(actor: AppActor, params: { workspaceId: string; qualificationId: string; note?: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const qual = await prisma.crmQualification.findUnique({ 
    where: { id: params.qualificationId },
    include: { demoLead: true } 
  });
  invariant(qual && qual.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Qualification not found.");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.crmQualification.update({
      where: { id: qual.id },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
        reviewNote: params.note || null,
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.qualification.rejected",
        aggregateType: "CrmQualification",
        aggregateId: qual.id,
        payload: { qualificationId: qual.id, email: qual.demoLead.email },
      },
    ]);

    return updated;
  });
}

export async function sendSchedulingLinkEmail(qualificationId: string) {
  const qual = await prisma.crmQualification.findUnique({
    where: { id: qualificationId },
    include: { demoLead: true },
  });
  invariant(qual, 404, "NOT_FOUND", "Qualification not found");
  invariant(qual.status === "APPROVED", 400, "INVALID_STATE", "Qualification must be approved to send scheduling link.");
  if (qual.schedulingEmailSentAt) return;

  // assume valid usage
  await prisma.crmQualification.update({
    where: { id: qual.id },
    data: { schedulingEmailSentAt: new Date() },
  });
}

// --- CONVERSATIONS ---

export async function syncEmailReplyToConversation(params: {
  fromEmail: string;
  subject: string;
  bodyText: string;
}) {
  const email = params.fromEmail.trim().toLowerCase();
  
  const lead = await prisma.demoLead.findFirst({
    where: { email },
    orderBy: { createdAt: 'desc' },
  });
  
  if (!lead) return null;

  let conversation = await prisma.crmConversation.findFirst({
    where: { workspaceId: lead.workspaceId, demoLeadId: lead.id },
  });

  if (!conversation) {
    const contact = await prisma.crmContact.findFirst({
      where: { workspaceId: lead.workspaceId, email },
    });
    if (!contact) return null;

    conversation = await prisma.crmConversation.create({
      data: {
        workspaceId: lead.workspaceId,
        accountId: contact.accountId ?? null,
        demoLeadId: lead.id,
        contactId: contact.id,
        subject: params.subject.trim(),
      },
    });
  }

  const message = await prisma.crmConversationMessage.create({
    data: {
      conversationId: conversation.id,
      senderType: "LEAD",
      senderEmail: email,
      bodyMd: params.bodyText.trim(),
    },
  });

  await prisma.crmConversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });

  return message;
}

export async function createConversationMessage(actor: AppActor, params: {
  workspaceId: string;
  conversationId: string;
  bodyMd: string;
  senderType: "LEAD" | "ADMIN" | "SYSTEM";
  senderEmail?: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const conversation = await prisma.crmConversation.findUnique({
    where: { id: params.conversationId },
    include: { account: true, contact: true, demoLead: true },
  });
  invariant(conversation && conversation.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Conversation not found.");

  return prisma.$transaction(async (tx) => {
    const message = await tx.crmConversationMessage.create({
      data: {
        conversationId: conversation.id,
        senderType: params.senderType,
        senderEmail: params.senderEmail || (params.senderType === "ADMIN" && actor.kind === "user" ? actor.user.email : null),
        senderUserId: params.senderType === "ADMIN" && actor.kind === "user" ? actor.user.id : null,
        bodyMd: params.bodyMd.trim(),
        isRead: params.senderType === "ADMIN",
      },
    });

    await tx.crmConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    return message;
  });
}

export async function getCrmConversation(actor: AppActor, params: { workspaceId: string; conversationId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const conversation = await prisma.crmConversation.findUnique({
    where: { id: params.conversationId },
    include: {
      account: true,
      contact: true,
      demoLead: true,
      deal: true,
      messages: {
        orderBy: { createdAt: "asc" },
        include: { senderUser: { select: { id: true, email: true } } },
      },
    },
  });
  invariant(conversation && conversation.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Conversation not found.");

  return conversation;
}

export async function listCrmConversations(actor: AppActor, workspaceId: string, opts?: { accountId?: string; contactId?: string; demoLeadId?: string; take?: number; skip?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  
  const where: any = { workspaceId };
  if (opts?.accountId) where.accountId = opts.accountId;
  if (opts?.contactId) where.contactId = opts.contactId;
  if (opts?.demoLeadId) where.demoLeadId = opts.demoLeadId;

  const [items, total] = await Promise.all([
    prisma.crmConversation.findMany({
      where,
      include: {
        account: { select: { id: true, name: true, slug: true, relationshipType: true, lifecycleStage: true } },
        contact: { select: { id: true, name: true, email: true, company: true } },
        demoLead: { select: { id: true, email: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    }),
    prisma.crmConversation.count({ where }),
  ]);
  
  return { items, total, take, skip };
}

// --- PROVISIONING ---

export async function listCrmProspectWorkspaces(actor: AppActor, workspaceId: string, opts?: {
  accountId?: string;
  status?: string;
  take?: number;
  skip?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  const where: any = { crmWorkspaceId: workspaceId };
  if (opts?.accountId) where.accountId = opts.accountId;
  if (opts?.status) where.status = opts.status;

  const [items, total] = await Promise.all([
    prisma.crmProspectWorkspace.findMany({
      where,
      include: {
        account: {
          select: { id: true, name: true, slug: true, relationshipType: true, lifecycleStage: true },
        },
        demoLead: true,
        targetWorkspace: { select: { id: true, slug: true, name: true } },
      },
      orderBy: { provisionedAt: "desc" },
      take,
      skip,
    }),
    prisma.crmProspectWorkspace.count({ where }),
  ]);

  return { items, total, take, skip };
}

export async function provisionProspectWorkspace(actor: AppActor, params: {
  demoLeadId: string;
  adminEmail: string;
  crmWorkspaceId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.crmWorkspaceId });
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only human users can provision prospect workspaces.");

  const lead = await prisma.demoLead.findUnique({ where: { id: params.demoLeadId } });
  invariant(lead && lead.workspaceId === params.crmWorkspaceId, 404, "NOT_FOUND", "Demo lead not found");
  const contact = await prisma.crmContact.findFirst({
    where: { workspaceId: params.crmWorkspaceId, email: lead.email },
    select: { accountId: true },
  });

  const existing = await prisma.crmProspectWorkspace.findFirst({
    where: { demoLeadId: lead.id, crmWorkspaceId: params.crmWorkspaceId },
  });
  if (existing) return existing;

  return prisma.$transaction(async (tx) => {
    const newWorkspaceName = `Demo Workspace (${lead.email})`;
    const newWorkspaceSlug = `demo-${Date.now()}`;
    const targetWorkspace = await tx.workspace.create({
      data: {
        name: newWorkspaceName,
        slug: newWorkspaceSlug,
      },
    });

    await registerCustomerDeployment({
      accountSlug: targetWorkspace.slug,
      accountDisplayName: targetWorkspace.name,
      accountStatus: "PROSPECT",
      managementAuthority: "CORGTEX",
      label: targetWorkspace.name,
      url: `${env.APP_URL.replace(/\/$/, "")}/workspaces/${targetWorkspace.id}`,
      environment: "production",
      notes: `CRM prospect workspace for ${lead.email}.`,
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      customerSlug: targetWorkspace.slug,
      managedWorkspaceId: targetWorkspace.id,
      primary: true,
    }, tx);

    const prospectWorkspace = await tx.crmProspectWorkspace.create({
      data: {
        crmWorkspaceId: params.crmWorkspaceId,
        accountId: contact?.accountId ?? null,
        demoLeadId: lead.id,
        targetWorkspaceId: targetWorkspace.id,
        adminEmail: params.adminEmail,
        status: "ACTIVE",
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.crmWorkspaceId,
        type: "crm.prospect_workspace.provisioned",
        aggregateType: "CrmProspectWorkspace",
        aggregateId: prospectWorkspace.id,
        payload: { targetWorkspaceId: targetWorkspace.id, adminEmail: params.adminEmail },
      },
    ]);

    return prospectWorkspace;
  });
}
