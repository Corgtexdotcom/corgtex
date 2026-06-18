"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, refresh } from "../action-utils";
import {
  createCrmAccount,
  createContact,
  updateContact,
  deleteContact,
  createDeal,
  updateDeal,
  deleteDeal,
  createActivity,
  approveQualification,
  rejectQualification,
  sendSchedulingLinkEmail,
  createConversationMessage,
  provisionProspectWorkspace,
  updateCrmAccount,
} from "@corgtex/domain";

export async function createCrmAccountAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createCrmAccount(actor, {
    workspaceId,
    name: asString(formData, "name"),
    domain: asOptional(formData, "domain"),
    relationshipType: asOptional(formData, "relationshipType"),
    lifecycleStage: asOptional(formData, "lifecycleStage"),
    descriptionMd: asOptional(formData, "descriptionMd"),
  });
  refresh(workspaceId);
}

export async function updateCrmAccountAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateCrmAccount(actor, {
    workspaceId,
    accountId: asString(formData, "accountId"),
    name: formData.has("name") ? asString(formData, "name") : undefined,
    domain: formData.has("domain") ? asOptional(formData, "domain") ?? null : undefined,
    relationshipType: formData.has("relationshipType") ? asOptional(formData, "relationshipType") ?? undefined : undefined,
    lifecycleStage: formData.has("lifecycleStage") ? asOptional(formData, "lifecycleStage") ?? undefined : undefined,
    descriptionMd: formData.has("descriptionMd") ? asOptional(formData, "descriptionMd") ?? null : undefined,
  });
  refresh(workspaceId);
}

export async function createContactAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createContact(actor, {
    workspaceId,
    email: asString(formData, "email"),
    name: asOptional(formData, "name"),
    company: asOptional(formData, "company"),
    title: asOptional(formData, "title"),
    phone: asOptional(formData, "phone"),
    accountId: formData.has("accountId") ? asOptional(formData, "accountId") ?? null : undefined,
  });
  refresh(workspaceId);
}

export async function updateContactAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateContact(actor, {
    workspaceId,
    contactId: asString(formData, "contactId"),
    email: formData.has("email") ? asString(formData, "email") : undefined,
    name: formData.has("name") ? asOptional(formData, "name") ?? undefined : undefined,
    company: formData.has("company") ? asOptional(formData, "company") ?? undefined : undefined,
    title: formData.has("title") ? asOptional(formData, "title") ?? undefined : undefined,
    phone: formData.has("phone") ? asOptional(formData, "phone") ?? undefined : undefined,
    accountId: formData.has("accountId") ? asOptional(formData, "accountId") ?? null : undefined,
  });
  refresh(workspaceId);
}

export async function deleteContactAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteContact(actor, {
    workspaceId,
    contactId: asString(formData, "contactId"),
  });
  refresh(workspaceId);
}

export async function createDealAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
  const rawAmount = asString(formData, "value");
  const parsedAmount = Number.parseFloat(rawAmount);
  const valueCents = !Number.isNaN(parsedAmount) ? Math.round(parsedAmount * 100) : null;

  await createDeal(actor, {
    workspaceId,
    contactId: asString(formData, "contactId"),
    title: asString(formData, "title"),
    valueCents,
    accountId: formData.has("accountId") ? asOptional(formData, "accountId") ?? null : undefined,
    ownerUserId: formData.has("ownerUserId") ? asOptional(formData, "ownerUserId") ?? null : undefined,
  });
  refresh(workspaceId);
}

export async function updateDealAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
  const rawAmount = formData.has("value") ? asString(formData, "value") : "";
  const parsedAmount = Number.parseFloat(rawAmount);
  const valueCents = formData.has("value") && !Number.isNaN(parsedAmount) ? Math.round(parsedAmount * 100) : undefined;
  
  await updateDeal(actor, {
    workspaceId,
    dealId: asString(formData, "dealId"),
    title: formData.has("title") ? asOptional(formData, "title") ?? undefined : undefined,
    stage: formData.has("stage") ? (asString(formData, "stage") as any) : undefined,
    valueCents: formData.has("value") ? valueCents : undefined,
    notes: formData.has("notes") ? asOptional(formData, "notes") ?? undefined : undefined,
    ownerUserId: formData.has("ownerUserId") ? asOptional(formData, "ownerUserId") ?? null : undefined,
  });
  refresh(workspaceId);
}

export async function deleteDealAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteDeal(actor, {
    workspaceId,
    dealId: asString(formData, "dealId"),
  });
  refresh(workspaceId);
}

export async function createActivityAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createActivity(actor, {
    workspaceId,
    title: asString(formData, "title"),
    type: formData.has("type") ? (asString(formData, "type") as any) : undefined,
    bodyMd: asOptional(formData, "bodyMd"),
    accountId: asOptional(formData, "accountId"),
    contactId: asOptional(formData, "contactId"),
    dealId: asOptional(formData, "dealId"),
  });
  refresh(workspaceId);
}

// --- QUALIFICATION REVIEW ACTIONS ---

export async function approveQualificationAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  const qualificationId = asString(formData, "qualificationId");

  await approveQualification(actor, { workspaceId, qualificationId });
  
  sendSchedulingLinkEmail(qualificationId).catch(err => {
    console.error("Failed to send scheduling email:", err);
  });
  
  refresh(workspaceId);
}

export async function rejectQualificationAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  
  await rejectQualification(actor, {
    workspaceId,
    qualificationId: asString(formData, "qualificationId"),
    note: asOptional(formData, "note") ?? undefined,
  });
  
  refresh(workspaceId);
}

// --- CONVERSATION ACTIONS ---

export async function createConversationMessageAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  
  await createConversationMessage(actor, {
    workspaceId,
    conversationId: asString(formData, "conversationId"),
    bodyMd: asString(formData, "bodyMd"),
    senderType: "ADMIN",
  });
  
  refresh(workspaceId);
}

// --- PROVISIONING ACTIONS ---

export async function provisionProspectWorkspaceAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  
  await provisionProspectWorkspace(actor, {
    crmWorkspaceId: workspaceId,
    demoLeadId: asString(formData, "demoLeadId"),
    adminEmail: asString(formData, "adminEmail"),
  });
  
  refresh(workspaceId);
}
