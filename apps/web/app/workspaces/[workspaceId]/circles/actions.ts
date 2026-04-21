"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createCircle,
  deleteCircle,
  updateCircle,
  assignRole,
  createRole,
  deleteRole,
  unassignRole,
  updateRole
} from "@corgtex/domain";


export async function createCircleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createCircle(actor, {
    workspaceId,
    name: asString(formData, "name"),
    purposeMd: asOptional(formData, "purposeMd"),
    domainMd: asOptional(formData, "domainMd"),
    parentCircleId: asOptional(formData, "parentCircleId"),
  });
  refresh(workspaceId);
}

export async function updateCircleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateCircle(actor, {
    workspaceId,
    circleId: asString(formData, "circleId"),
    name: asOptional(formData, "name") ?? undefined,
    purposeMd: formData.has("purposeMd") ? asOptional(formData, "purposeMd") : undefined,
    domainMd: formData.has("domainMd") ? asOptional(formData, "domainMd") : undefined,
  });
  refresh(workspaceId);
}

export async function deleteCircleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteCircle(actor, {
    workspaceId,
    circleId: asString(formData, "circleId"),
  });
  refresh(workspaceId);
}


export async function createRoleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createRole(actor, {
    workspaceId,
    circleId: asString(formData, "circleId"),
    name: asString(formData, "name"),
    purposeMd: asOptional(formData, "purposeMd"),
    accountabilities: asString(formData, "accountabilities")
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  });
  refresh(workspaceId);
}

export async function updateRoleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateRole(actor, {
    workspaceId,
    roleId: asString(formData, "roleId"),
    name: asOptional(formData, "name") ?? undefined,
    purposeMd: formData.has("purposeMd") ? asOptional(formData, "purposeMd") : undefined,
    accountabilities: formData.has("accountabilities")
      ? asString(formData, "accountabilities").split("\n").map((v) => v.trim()).filter(Boolean)
      : undefined,
  });
  refresh(workspaceId);
}

export async function deleteRoleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteRole(actor, {
    workspaceId,
    roleId: asString(formData, "roleId"),
  });
  refresh(workspaceId);
}

export async function assignRoleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await assignRole(actor, {
    workspaceId,
    roleId: asString(formData, "roleId"),
    memberId: asString(formData, "memberId"),
  });
  refresh(workspaceId);
}

export async function unassignRoleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await unassignRole(actor, {
    workspaceId,
    roleId: asString(formData, "roleId"),
    memberId: asString(formData, "memberId"),
  });
  refresh(workspaceId);
}
