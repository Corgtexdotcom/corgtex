import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { CrmDealStage, CrmActivityType } from "@prisma/client";

const DEFAULT_DEMO_WORKSPACE = {
  slug: "corgtex",
  name: "Corgtex",
  description: "Internal company operating environment for Corgtex",
};

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
      },
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
      },
      create: {
        workspaceId: workspace.id,
        email,
        name,
        company: domainPart,
        source,
      },
    });

    return { workspace, demoLead, contact };
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
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const email = params.email.trim().toLowerCase();
  invariant(email.length > 0 && email.includes("@"), 400, "INVALID_INPUT", "Valid email is required.");

  return prisma.$transaction(async (tx) => {
    const contact = await tx.crmContact.create({
      data: {
        workspaceId: params.workspaceId,
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

    const updated = await tx.crmContact.update({
      where: { id: params.contactId },
      data,
    });

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
        contact: {
          select: { id: true, name: true, company: true, email: true, avatarUrl: true },
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
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Deal title is required.");

  return prisma.$transaction(async (tx) => {
    const contact = await tx.crmContact.findUnique({ where: { id: params.contactId } });
    invariant(contact && contact.workspaceId === params.workspaceId && !contact.archivedAt, 404, "NOT_FOUND", "Contact not found.");

    const deal = await tx.crmDeal.create({
      data: {
        workspaceId: params.workspaceId,
        contactId: params.contactId,
        title,
        stage: params.stage || CrmDealStage.LEAD,
        valueCents: params.valueCents || null,
        currency: params.currency || "USD",
        ownerUserId: params.ownerUserId || null,
      },
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
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const deal = await tx.crmDeal.findUnique({ where: { id: params.dealId } });
    invariant(deal && deal.workspaceId === params.workspaceId && !deal.archivedAt, 404, "NOT_FOUND", "Deal not found.");

    const data: any = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Deal title is required.");
      data.title = title;
    }
    if (params.stage !== undefined) {
      data.stage = params.stage;
      if (params.stage === CrmDealStage.CLOSED_WON || params.stage === CrmDealStage.CLOSED_LOST) {
        data.closedAt = new Date();
      } else {
        data.closedAt = null;
      }
    }
    if (params.valueCents !== undefined) data.valueCents = params.valueCents;
    if (params.currency !== undefined) data.currency = params.currency;
    if (params.ownerUserId !== undefined) data.ownerUserId = params.ownerUserId;
    if (params.notes !== undefined) data.notes = params.notes?.trim() || null;

    const updated = await tx.crmDeal.update({
      where: { id: params.dealId },
      data,
    });

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

export async function createActivity(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  type?: CrmActivityType;
  bodyMd?: string | null;
  contactId?: string | null;
  dealId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Activity title is required.");
  invariant(params.contactId || params.dealId, 400, "INVALID_INPUT", "Activity must be linked to a contact or deal.");

  return prisma.$transaction(async (tx) => {
    if (params.contactId) {
      const contact = await tx.crmContact.findUnique({ where: { id: params.contactId } });
      invariant(contact && contact.workspaceId === params.workspaceId && !contact.archivedAt, 404, "NOT_FOUND", "Contact not found.");
    }
    if (params.dealId) {
      const deal = await tx.crmDeal.findUnique({ where: { id: params.dealId } });
      invariant(deal && deal.workspaceId === params.workspaceId && !deal.archivedAt, 404, "NOT_FOUND", "Deal not found.");
    }

    const activity = await tx.crmActivity.create({
      data: {
        workspaceId: params.workspaceId,
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
