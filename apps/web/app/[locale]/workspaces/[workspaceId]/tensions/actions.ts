"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createTension,
  createProposalFromTension,
  createAdviceRequest,
  deleteTension,
  updateTension,
  upvoteTension,
  publishTension,
  returnTensionToDraft,
  postDeliberationEntry,
  resolveDeliberationEntry,
  updateDeliberationEntry,
  upsertWorkspaceExternalResourceFromUrl
} from "@corgtex/domain";
import type { AdviceRequestAudienceType, AdviceRequestPreferredChannel } from "@prisma/client";
import { uploadWorkItemEvidenceDocument } from "../work-item-evidence-upload";

function asStringArray(formData: FormData, key: string) {
  return formData.getAll(key).map((value) => String(value).trim()).filter(Boolean);
}

function asOptionalDate(formData: FormData, key: string) {
  const value = asOptional(formData, key);
  return value ? new Date(value) : null;
}

export async function createTensionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createTension(actor, {
    workspaceId,
    title: asString(formData, "title"),
    bodyMd: asOptional(formData, "bodyMd"),
    proposalId: asOptional(formData, "proposalId"),
    assigneeMemberId: asOptional(formData, "assigneeMemberId"),
    raisedByMemberId: asOptional(formData, "raisedByMemberId"),
    priority: asOptionalInt(formData, "priority"),
    isPrivate: formData.get("isPrivate") === "on",
  });
  refresh(workspaceId);
}

export async function requestTensionInputAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const audienceType = asString(formData, "audienceType") as AdviceRequestAudienceType;

  await createAdviceRequest(actor, {
    workspaceId,
    subjectType: "TENSION",
    subjectId: asString(formData, "tensionId"),
    audienceType,
    memberIds: audienceType === "MEMBERS" ? asStringArray(formData, "memberIds") : [],
    targetCircleId: audienceType === "CIRCLE" ? asOptional(formData, "targetCircleId") : null,
    messageMd: asString(formData, "messageMd"),
    deadlineAt: asOptionalDate(formData, "deadlineAt"),
    reminderAt: asOptionalDate(formData, "reminderAt"),
    preferredChannel: asOptional(formData, "preferredChannel") as AdviceRequestPreferredChannel | null,
  });
  refresh(workspaceId);
}

export async function createProposalFromTensionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createProposalFromTension(actor, {
    workspaceId,
    sourceTensionId: asString(formData, "sourceTensionId"),
    relatedActionIds: asStringArray(formData, "relatedActionIds"),
    isPrivate: true,
  });
  refresh(workspaceId);
}

export async function updateTensionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const tensionId = asString(formData, "tensionId");
  const status = asOptional(formData, "status") as "DRAFT" | "OPEN" | "RESOLVED" | null;
  const evidenceDocumentIds = status === "RESOLVED"
    ? await uploadWorkItemEvidenceDocument(actor, {
      workspaceId,
      formData,
      entityType: "Tension",
      entityId: tensionId,
      purpose: "resolution_evidence",
    })
    : [];
  await updateTension(actor, {
    workspaceId,
    tensionId,
    title: asOptional(formData, "title") ?? undefined,
    bodyMd: formData.has("bodyMd") ? asOptional(formData, "bodyMd") : undefined,
    status: status ?? undefined,
    resolvedVia: asOptional(formData, "resolvedVia") ?? undefined,
    evidenceDocumentIds,
    assigneeMemberId: formData.has("assigneeMemberId") ? asOptional(formData, "assigneeMemberId") : undefined,
    raisedByMemberId: formData.has("raisedByMemberId") ? asOptional(formData, "raisedByMemberId") : undefined,
    priority: formData.has("priority") ? Number.parseInt(asString(formData, "priority"), 10) : undefined,
  });
  refresh(workspaceId);
}

export async function attachTensionExternalResourceAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await upsertWorkspaceExternalResourceFromUrl(actor, {
    workspaceId,
    url: asString(formData, "url"),
    descriptionMd: asOptional(formData, "descriptionMd"),
    entityType: "Tension",
    entityId: asString(formData, "tensionId"),
    purpose: "reference",
  });
  refresh(workspaceId);
}

export async function deleteTensionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteTension(actor, {
    workspaceId,
    tensionId: asString(formData, "tensionId"),
  });
  refresh(workspaceId);
}

export async function upvoteTensionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await upvoteTension(actor, {
    workspaceId,
    tensionId: asString(formData, "tensionId"),
  });
  refresh(workspaceId);
}

export async function publishTensionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await publishTension(actor, {
    workspaceId,
    tensionId: asString(formData, "tensionId"),
  });
  refresh(workspaceId);
}

export async function returnTensionToDraftAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await returnTensionToDraft(actor, {
    workspaceId,
    tensionId: asString(formData, "tensionId"),
  });
  refresh(workspaceId);
}

export async function postTensionDeliberationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
  await postDeliberationEntry(actor, {
    workspaceId,
    parentType: "TENSION",
    parentId: asString(formData, "parentId"),
    entryType: asString(formData, "entryType") as any,
    bodyMd: asString(formData, "bodyMd"),
    targetMemberId: asOptional(formData, "targetMemberId") || undefined,
    targetCircleId: asOptional(formData, "targetCircleId") || undefined,
    adviceRequestId: asOptional(formData, "adviceRequestId") || undefined,
  });
  refresh(workspaceId);
}

export async function resolveTensionDeliberationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
  await resolveDeliberationEntry(actor, {
    workspaceId,
    entryId: asString(formData, "entryId"),
    resolvedNote: asString(formData, "resolvedNote"),
  });
  refresh(workspaceId);
}

export async function updateTensionDeliberationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");

  await updateDeliberationEntry(actor, {
    workspaceId,
    entryId: asString(formData, "entryId"),
    entryType: asString(formData, "entryType"),
    bodyMd: asString(formData, "bodyMd"),
  });
  refresh(workspaceId);
}
