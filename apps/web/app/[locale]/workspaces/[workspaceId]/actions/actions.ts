"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createAction,
  createAdviceRequest,
  deleteAction,
  updateAction,
  publishAction,
  returnActionToDraft,
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

export async function createActionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createAction(actor, {
    workspaceId,
    title: asString(formData, "title"),
    bodyMd: asOptional(formData, "bodyMd"),
    proposalId: asOptional(formData, "proposalId"),
    assigneeMemberId: asOptional(formData, "assigneeMemberId"),
    priority: asOptionalInt(formData, "priority"),
    isPrivate: formData.has("isPrivate") ? formData.get("isPrivate") === "on" : true,
  });
  refresh(workspaceId);
}

export async function updateActionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const actionId = asString(formData, "actionId");
  const status = asOptional(formData, "status") as "DRAFT" | "OPEN" | "IN_PROGRESS" | "COMPLETED" | null;
  const evidenceDocumentIds = status === "COMPLETED"
    ? await uploadWorkItemEvidenceDocument(actor, {
      workspaceId,
      formData,
      entityType: "Action",
      entityId: actionId,
      purpose: "completion_evidence",
    })
    : [];
  await updateAction(actor, {
    workspaceId,
    actionId,
    title: asOptional(formData, "title") ?? undefined,
    bodyMd: formData.has("bodyMd") ? asOptional(formData, "bodyMd") : undefined,
    assigneeMemberId: formData.has("assigneeMemberId") ? asOptional(formData, "assigneeMemberId") : undefined,
    priority: formData.has("priority") ? (asOptionalInt(formData, "priority") ?? 0) : undefined,
    status: status ?? undefined,
    completedVia: asOptional(formData, "completedVia") ?? undefined,
    evidenceDocumentIds,
  });
  refresh(workspaceId);
}

export async function attachActionExternalResourceAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await upsertWorkspaceExternalResourceFromUrl(actor, {
    workspaceId,
    url: asString(formData, "url"),
    descriptionMd: asOptional(formData, "descriptionMd"),
    entityType: "Action",
    entityId: asString(formData, "actionId"),
    purpose: "reference",
  });
  refresh(workspaceId);
}

export async function deleteActionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteAction(actor, {
    workspaceId,
    actionId: asString(formData, "actionId"),
  });
  refresh(workspaceId);
}

export async function publishActionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await publishAction(actor, {
    workspaceId,
    actionId: asString(formData, "actionId"),
  });
  refresh(workspaceId);
}

export async function requestActionInputAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const audienceType = asString(formData, "audienceType") as AdviceRequestAudienceType;

  await createAdviceRequest(actor, {
    workspaceId,
    subjectType: "ACTION",
    subjectId: asString(formData, "actionId"),
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

export async function returnActionToDraftAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await returnActionToDraft(actor, {
    workspaceId,
    actionId: asString(formData, "actionId"),
  });
  refresh(workspaceId);
}

export async function postActionDeliberationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await postDeliberationEntry(actor, {
    workspaceId,
    parentType: "ACTION",
    parentId: asString(formData, "parentId"),
    entryType: asString(formData, "entryType"),
    bodyMd: asString(formData, "bodyMd"),
    targetMemberId: asOptional(formData, "targetMemberId") || undefined,
    targetCircleId: asOptional(formData, "targetCircleId") || undefined,
    adviceRequestId: asOptional(formData, "adviceRequestId") || undefined,
  });
  refresh(workspaceId);
}

export async function resolveActionDeliberationAction(formData: FormData) {
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

export async function updateActionDeliberationAction(formData: FormData) {
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
