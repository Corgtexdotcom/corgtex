"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createAction,
  deleteAction,
  updateAction,
  publishAction,
  returnActionToDraft
} from "@corgtex/domain";
import { uploadWorkItemEvidenceDocument } from "../work-item-evidence-upload";


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
    status: status ?? undefined,
    completedVia: asOptional(formData, "completedVia") ?? undefined,
    evidenceDocumentIds,
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
