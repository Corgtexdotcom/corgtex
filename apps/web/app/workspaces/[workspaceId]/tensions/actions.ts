"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createTension,
  deleteTension,
  updateTension,
  upvoteTension,
  publishTension
} from "@corgtex/domain";


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
    isPrivate: formData.get("isPrivate") === "on",
  });
  refresh(workspaceId);
}

export async function updateTensionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateTension(actor, {
    workspaceId,
    tensionId: asString(formData, "tensionId"),
    title: asOptional(formData, "title") ?? undefined,
    status: asOptional(formData, "status") as "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | null ?? undefined,
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
