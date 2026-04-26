"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createAction,
  deleteAction,
  updateAction,
  publishAction
} from "@corgtex/domain";


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
    isPrivate: formData.get("isPrivate") === "on",
  });
  refresh(workspaceId);
}

export async function updateActionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateAction(actor, {
    workspaceId,
    actionId: asString(formData, "actionId"),
    title: asOptional(formData, "title") ?? undefined,
    status: asOptional(formData, "status") as "DRAFT" | "OPEN" | "IN_PROGRESS" | "COMPLETED" | null ?? undefined,
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
