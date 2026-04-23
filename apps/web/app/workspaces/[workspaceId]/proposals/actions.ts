"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import { revalidatePath } from "next/cache";
import {
  archiveProposal,
  createProposal,
  postReaction,
  resolveReaction,
  submitProposal,
  updateProposal,
  publishProposal,
  initiateAdviceProcess,
  recordAdvice,
  withdrawAdviceProcess,
  executeAdviceProcessDecision,
  postDeliberationEntry,
  resolveDeliberationEntry
} from "@corgtex/domain";


export async function createProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createProposal(actor, {
    workspaceId,
    title: asString(formData, "title"),
    summary: asOptional(formData, "summary"),
    bodyMd: asString(formData, "bodyMd"),
    isPrivate: formData.get("isPrivate") === "on",
  });
  refresh(workspaceId);
}

export async function updateProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateProposal(actor, {
    workspaceId,
    proposalId: asString(formData, "proposalId"),
    title: asOptional(formData, "title") ?? undefined,
    bodyMd: asOptional(formData, "bodyMd") ?? undefined,
    summary: formData.has("summary") ? asOptional(formData, "summary") : undefined,
  });
  refresh(workspaceId);
}

export async function submitProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await submitProposal(actor, {
    workspaceId,
    proposalId: asString(formData, "proposalId"),
    autoApproveHours: asOptionalInt(formData, "autoApproveHours"),
  });
  refresh(workspaceId);
}

export async function archiveProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await archiveProposal(actor, {
    workspaceId,
    proposalId: asString(formData, "proposalId"),
  });
  refresh(workspaceId);
}

export async function publishProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await publishProposal(actor, {
    workspaceId,
    proposalId: asString(formData, "proposalId"),
  });
  refresh(workspaceId);
}

export async function postReactionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await postReaction(actor, {
    workspaceId,
    proposalId: asString(formData, "proposalId"),
    reaction: asString(formData, "reaction"),
    bodyMd: asOptional(formData, "bodyMd") || undefined,
  });
  refresh(workspaceId);
}

export async function resolveReactionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await resolveReaction(actor, {
    workspaceId,
    reactionId: asString(formData, "reactionId"),
    resolvedNote: asString(formData, "resolvedNote"),
  });
  refresh(workspaceId);
}


export async function initiateAdviceProcessAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await initiateAdviceProcess(actor, {
    workspaceId,
    proposalId: asString(formData, "proposalId"),
    adviceDeadlineDays: asOptionalInt(formData, "adviceDeadlineDays"),
  });
  revalidatePath(`/workspaces/${workspaceId}/proposals/${asString(formData, "proposalId")}`);
  refresh(workspaceId);
}

export async function recordAdviceAction(type: string, formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await recordAdvice(actor, {
    workspaceId,
    processId: asString(formData, "processId"),
    type: type as "ENDORSE" | "CONCERN",
    bodyMd: asString(formData, "bodyMd"),
  });
  refresh(workspaceId);
}

export async function withdrawAdviceProcessAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await withdrawAdviceProcess(actor, {
    workspaceId,
    processId: asString(formData, "processId"),
  });
  refresh(workspaceId);
}

export async function executeAdviceProcessDecisionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await executeAdviceProcessDecision(actor, {
    workspaceId,
    processId: asString(formData, "processId"),
    decisionMd: asOptional(formData, "decisionMd") || undefined,
  });
  refresh(workspaceId);
}

export async function postDeliberationEntryAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await postDeliberationEntry(actor, {
    workspaceId,
    parentType: "PROPOSAL",
    parentId: asString(formData, "proposalId"),
    entryType: asString(formData, "entryType") as any,
    bodyMd: asString(formData, "bodyMd"),
  });
  refresh(workspaceId);
  return { success: true };
}

export async function resolveDeliberationEntryAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await resolveDeliberationEntry(actor, {
    workspaceId,
    entryId: asString(formData, "entryId"),
    resolvedNote: asOptional(formData, "resolvedNote") || undefined,
  });
  refresh(workspaceId);
}
