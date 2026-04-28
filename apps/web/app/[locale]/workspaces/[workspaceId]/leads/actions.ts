"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
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
  provisionProspectWorkspace
} from "@corgtex/domain";


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
  });
  refresh(workspaceId);
}

export async function updateDealAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
  const rawAmount = asString(formData, "value");
  const parsedAmount = Number.parseFloat(rawAmount);
  const valueCents = !Number.isNaN(parsedAmount) ? Math.round(parsedAmount * 100) : undefined;
  
  await updateDeal(actor, {
    workspaceId,
    dealId: asString(formData, "dealId"),
    title: formData.has("title") ? asOptional(formData, "title") ?? undefined : undefined,
    stage: formData.has("stage") ? (asString(formData, "stage") as any) : undefined,
    valueCents: formData.has("value") ? valueCents : undefined,
    notes: formData.has("notes") ? asOptional(formData, "notes") ?? undefined : undefined,
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
