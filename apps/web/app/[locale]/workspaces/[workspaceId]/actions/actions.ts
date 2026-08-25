"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, duplicateGuardFromFormData, refresh } from "../action-utils";
import {
  AppError,
  createAction,
  createActionChecklistItem,
  createAdviceRequest,
  deleteAction,
  deleteActionChecklistItem,
  updateAction,
  updateActionChecklistItem,
  publishAction,
  returnActionToDraft,
  postDeliberationEntry,
  resolveDeliberationEntry,
  updateDeliberationEntry,
  upsertWorkspaceExternalResourceFromUrl
} from "@corgtex/domain";
import type { AdviceRequestAudienceType, AdviceRequestPreferredChannel } from "@prisma/client";
import type { WorkItemEditActionState } from "@/lib/components/WorkItemEditForm";
import { uploadWorkItemEvidenceDocument } from "../work-item-evidence-upload";
import { redirect } from "next/navigation";

function asStringArray(formData: FormData, key: string) {
  return formData.getAll(key).map((value) => String(value).trim()).filter(Boolean);
}

function asOptionalDate(formData: FormData, key: string) {
  const value = asOptional(formData, key);
  return value ? new Date(value) : null;
}

const ACTION_CONTENT_FIELDS = [
  "title",
  "bodyMd",
  "priority",
  "circleId",
  "assigneeMemberId",
  "dueAt",
  "proposalId",
] as const;

function actionContentExpectedVersion(formData: FormData) {
  return ACTION_CONTENT_FIELDS.some((field) => formData.has(field))
    ? expectedVersionFromForm(formData)
    : undefined;
}

function expectedVersionFromForm(formData: FormData) {
  const value = asString(formData, "expectedVersion");
  if (!/^[1-9]\d*$/.test(value)) {
    throw new AppError(400, "INVALID_INPUT", "Expected version must be a positive integer.");
  }
  const expectedVersion = Number(value);
  if (!Number.isSafeInteger(expectedVersion)) {
    throw new AppError(400, "INVALID_INPUT", "Expected version must be a positive integer.");
  }
  return expectedVersion;
}

function hasEvidenceFile(formData: FormData) {
  const evidenceFile = formData.get("evidenceFile");
  return evidenceFile instanceof File && evidenceFile.size > 0;
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
    dueAt: formData.has("dueAt") ? asOptionalDate(formData, "dueAt") : undefined,
    priority: asOptionalInt(formData, "priority"),
    isPrivate: formData.has("isPrivate") ? formData.get("isPrivate") === "on" : true,
    duplicateGuard: duplicateGuardFromFormData(formData),
  });
  refresh(workspaceId);
}

export async function updateActionAction(formData: FormData) {
  const expectedVersion = actionContentExpectedVersion(formData);
  const status = asOptional(formData, "status") as "DRAFT" | "OPEN" | "IN_PROGRESS" | "COMPLETED" | null;
  if (expectedVersion !== undefined && status === "COMPLETED" && hasEvidenceFile(formData)) {
    throw new AppError(400, "INVALID_INPUT", "Submit content edits and completion evidence separately.");
  }
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const actionId = asString(formData, "actionId");
  const evidenceDocumentIds = status === "COMPLETED"
    ? await uploadWorkItemEvidenceDocument(actor, {
      workspaceId,
      formData,
      entityType: "Action",
      entityId: actionId,
      purpose: "completion_evidence",
    })
    : [];
  try {
    await updateAction(actor, {
      workspaceId,
      actionId,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      title: asOptional(formData, "title") ?? undefined,
      bodyMd: formData.has("bodyMd") ? asOptional(formData, "bodyMd") : undefined,
      assigneeMemberId: formData.has("assigneeMemberId") ? asOptional(formData, "assigneeMemberId") : undefined,
      dueAt: formData.has("dueAt") ? asOptionalDate(formData, "dueAt") : undefined,
      priority: formData.has("priority") ? (asOptionalInt(formData, "priority") ?? 0) : undefined,
      status: status ?? undefined,
      completedVia: asOptional(formData, "completedVia") ?? undefined,
      evidenceDocumentIds,
    });
  } catch (error) {
    if (expectedVersion !== undefined && error instanceof AppError && error.code === "VERSION_CONFLICT") {
      redirect(`/workspaces/${workspaceId}/actions?versionConflict=${encodeURIComponent(actionId)}`);
    }
    throw error;
  }
  refresh(workspaceId);
}

export async function editActionAction(
  _state: WorkItemEditActionState,
  formData: FormData,
): Promise<WorkItemEditActionState> {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  try {
    await updateAction(actor, {
      workspaceId,
      actionId: asString(formData, "actionId"),
      expectedVersion: expectedVersionFromForm(formData),
      title: asOptional(formData, "title") ?? undefined,
      bodyMd: formData.has("bodyMd") ? asOptional(formData, "bodyMd") : undefined,
      assigneeMemberId: formData.has("assigneeMemberId") ? asOptional(formData, "assigneeMemberId") : undefined,
      dueAt: formData.has("dueAt") ? asOptionalDate(formData, "dueAt") : undefined,
      priority: formData.has("priority") ? (asOptionalInt(formData, "priority") ?? 0) : undefined,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "VERSION_CONFLICT") {
      return { status: "conflict" };
    }
    throw error;
  }
  refresh(workspaceId);
  return { status: "success" };
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

export async function createActionChecklistItemAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createActionChecklistItem(actor, {
    workspaceId,
    actionId: asString(formData, "actionId"),
    title: asString(formData, "title"),
  });
  refresh(workspaceId);
}

export async function updateActionChecklistItemAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateActionChecklistItem(actor, {
    workspaceId,
    checklistItemId: asString(formData, "checklistItemId"),
    title: formData.has("title") ? asString(formData, "title") : undefined,
    completed: formData.has("completed") ? asString(formData, "completed") === "true" : undefined,
  });
  refresh(workspaceId);
}

export async function deleteActionChecklistItemAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteActionChecklistItem(actor, {
    workspaceId,
    checklistItemId: asString(formData, "checklistItemId"),
  });
  refresh(workspaceId);
}
