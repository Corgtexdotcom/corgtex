"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createAllocation,
  createCycle,
  deleteAllocation,
  updateAllocation,
  updateCycle,
  upsertCycleUpdate
} from "@corgtex/domain";


export async function createCycleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createCycle(actor, {
    workspaceId,
    name: asString(formData, "name"),
    cadence: asString(formData, "cadence"),
    startDate: new Date(asString(formData, "startDate")),
    endDate: new Date(asString(formData, "endDate")),
    pointsPerUser: Number.parseInt(asString(formData, "pointsPerUser"), 10),
  });
  refresh(workspaceId);
}

export async function updateCycleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateCycle(actor, {
    workspaceId,
    cycleId: asString(formData, "cycleId"),
    name: formData.has("name") ? asOptional(formData, "name") ?? undefined : undefined,
    cadence: formData.has("cadence") ? asOptional(formData, "cadence") ?? undefined : undefined,
    status: formData.has("status")
      ? (asString(formData, "status") as "PLANNED" | "OPEN_UPDATES" | "OPEN_ALLOCATIONS" | "REVIEW" | "FINALIZED")
      : undefined,
    startDate: formData.has("startDate") ? new Date(asString(formData, "startDate")) : undefined,
    endDate: formData.has("endDate") ? new Date(asString(formData, "endDate")) : undefined,
    pointsPerUser: formData.has("pointsPerUser") ? Number.parseInt(asString(formData, "pointsPerUser"), 10) : undefined,
  });
  refresh(workspaceId);
}

export async function upsertCycleUpdateAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await upsertCycleUpdate(actor, {
    workspaceId,
    cycleId: asString(formData, "cycleId"),
    updateMd: asString(formData, "updateMd"),
    cashPaidCents: asOptionalInt(formData, "cashPaidCents"),
    cashPaidCurrency: asOptional(formData, "cashPaidCurrency"),
    valueEstimateCents: asOptionalInt(formData, "valueEstimateCents"),
    valueEstimateCurrency: asOptional(formData, "valueEstimateCurrency"),
    valueConfidence: asOptional(formData, "valueConfidence"),
  });
  refresh(workspaceId);
}

export async function createAllocationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createAllocation(actor, {
    workspaceId,
    cycleId: asString(formData, "cycleId"),
    fromUserId: asOptional(formData, "fromUserId"),
    toUserId: asString(formData, "toUserId"),
    points: Number.parseInt(asString(formData, "points"), 10),
    note: asOptional(formData, "note"),
  });
  refresh(workspaceId);
}

export async function updateAllocationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateAllocation(actor, {
    workspaceId,
    cycleId: asString(formData, "cycleId"),
    allocationId: asString(formData, "allocationId"),
    toUserId: formData.has("toUserId") ? asOptional(formData, "toUserId") ?? undefined : undefined,
    points: formData.has("points") ? Number.parseInt(asString(formData, "points"), 10) : undefined,
    note: formData.has("note") ? asOptional(formData, "note") : undefined,
  });
  refresh(workspaceId);
}

export async function deleteAllocationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteAllocation(actor, {
    workspaceId,
    cycleId: asString(formData, "cycleId"),
    allocationId: asString(formData, "allocationId"),
  });
  refresh(workspaceId);
}
