"use server";

import { redirect } from "next/navigation";
import { archiveDecisionRecord, createDecisionRecord, restoreDecisionRecord, updateDecisionRecord } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { enforceDemoGuard } from "@/lib/demo-guard";
import { asOptional, asString, refresh } from "../action-utils";

function decisionInput(formData: FormData) {
  const date = asString(formData, "decidedAt");
  return {
    workspaceId: asString(formData, "workspaceId"),
    title: asString(formData, "title"),
    bodyMd: asString(formData, "bodyMd"),
    tags: asString(formData, "tags"),
    decidedAt: new Date(`${date}T12:00:00.000Z`),
    proposalId: asOptional(formData, "proposalId"),
    tensionId: asOptional(formData, "tensionId"),
  };
}

function expectedVersion(formData: FormData) {
  return Number(asString(formData, "expectedVersion"));
}

export async function createDecisionAction(formData: FormData) {
  const input = decisionInput(formData);
  await enforceDemoGuard(input.workspaceId);
  const actor = await requirePageActor();
  const decision = await createDecisionRecord(actor, input);
  refresh(input.workspaceId);
  redirect(`/workspaces/${input.workspaceId}/decisions/${decision.id}`);
}

export async function updateDecisionAction(formData: FormData) {
  const input = decisionInput(formData);
  await enforceDemoGuard(input.workspaceId);
  const actor = await requirePageActor();
  const decisionId = asString(formData, "decisionId");
  await updateDecisionRecord(actor, { ...input, decisionId, expectedVersion: expectedVersion(formData) });
  refresh(input.workspaceId);
  redirect(`/workspaces/${input.workspaceId}/decisions/${decisionId}`);
}

export async function archiveDecisionAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);
  const actor = await requirePageActor();
  await archiveDecisionRecord(actor, {
    workspaceId,
    decisionId: asString(formData, "decisionId"),
    expectedVersion: expectedVersion(formData),
  });
  refresh(workspaceId);
  redirect(`/workspaces/${workspaceId}/decisions`);
}

export async function restoreDecisionAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);
  const actor = await requirePageActor();
  await restoreDecisionRecord(actor, {
    workspaceId,
    decisionId: asString(formData, "decisionId"),
    expectedVersion: expectedVersion(formData),
  });
  refresh(workspaceId);
  redirect(`/workspaces/${workspaceId}/decisions/${asString(formData, "decisionId")}`);
}
