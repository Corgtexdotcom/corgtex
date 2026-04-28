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

    if (qual.companyName || qual.website) {
      await tx.crmContact.updateMany({
        where: { workspaceId: params.workspaceId, email: qual.demoLead.email },
        data: {
          company: qual.companyName || undefined,
        },
      });
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
    include: { contact: true, demoLead: true },
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

export async function listCrmConversations(actor: AppActor, workspaceId: string, opts?: { contactId?: string; demoLeadId?: string; take?: number; skip?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  
  const where: any = { workspaceId };
  if (opts?.contactId) where.contactId = opts.contactId;
  if (opts?.demoLeadId) where.demoLeadId = opts.demoLeadId;

  const [items, total] = await Promise.all([
    prisma.crmConversation.findMany({
      where,
      include: {
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

export async function provisionProspectWorkspace(actor: AppActor, params: {
  demoLeadId: string;
  adminEmail: string;
  crmWorkspaceId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.crmWorkspaceId });
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only human users can provision prospect workspaces.");

  const lead = await prisma.demoLead.findUnique({ where: { id: params.demoLeadId } });
  invariant(lead && lead.workspaceId === params.crmWorkspaceId, 404, "NOT_FOUND", "Demo lead not found");

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

    const prospectWorkspace = await tx.crmProspectWorkspace.create({
      data: {
        crmWorkspaceId: params.crmWorkspaceId,
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
