"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import { revalidatePath } from "next/cache";
import {
  archiveProposal,
  createProposal,
  createProposalFromTension,
  createAdviceRequest,
  reopenProposal,
  resolveProposal,
  returnProposalToDraft,
  submitProposal,
  updateProposal,
  publishProposal,
  initiateAdviceProcess,
  recordAdvice,
  withdrawAdviceProcess,
  executeAdviceProcessDecision,
  postDeliberationEntry,
  resolveDeliberationEntry,
  updateDeliberationEntry
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

export async function createProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createProposal(actor, {
    workspaceId,
    title: asString(formData, "title"),
    bodyMd: asString(formData, "bodyMd"),
    includeAiSummary: formData.get("includeAiSummary") === "on",
    priority: asOptionalInt(formData, "priority"),
    isPrivate: formData.get("isPrivate") === "on",
    sourceTensionId: asOptional(formData, "sourceTensionId"),
    relatedActionIds: asStringArray(formData, "relatedActionIds"),
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
    title: asOptional(formData, "title"),
    summary: asOptional(formData, "summary"),
    bodyMd: asOptional(formData, "bodyMd"),
    relatedActionIds: asStringArray(formData, "relatedActionIds"),
    isPrivate: formData.has("isPrivate") ? formData.get("isPrivate") === "on" : true,
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
    priority: formData.has("priority") ? (asOptionalInt(formData, "priority") ?? 0) : undefined,
    includeAiSummary: formData.has("includeAiSummaryRendered") ? formData.get("includeAiSummary") === "on" : undefined,
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

export async function returnProposalToDraftAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await returnProposalToDraft(actor, {
    workspaceId,
    proposalId: asString(formData, "proposalId"),
  });
  refresh(workspaceId);
}

export async function reopenProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await reopenProposal(actor, {
    workspaceId,
    proposalId: asString(formData, "proposalId"),
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

export async function resolveProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const proposalId = asString(formData, "proposalId");
  const evidenceDocumentIds = await uploadWorkItemEvidenceDocument(actor, {
    workspaceId,
    formData,
    entityType: "Proposal",
    entityId: proposalId,
    purpose: "resolution_evidence",
  });
  await resolveProposal(actor, {
    workspaceId,
    proposalId,
    outcome: asString(formData, "outcome") as "ADOPTED" | "NOT_ADOPTED" | "WITHDRAWN",
    decisionMd: asString(formData, "decisionMd"),
    evidenceDocumentIds,
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

export async function requestProposalAdviceAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const audienceType = asString(formData, "audienceType") as AdviceRequestAudienceType;

  await createAdviceRequest(actor, {
    workspaceId,
    subjectType: "PROPOSAL",
    subjectId: asString(formData, "proposalId"),
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
    entryType: asString(formData, "entryType"),
    bodyMd: asString(formData, "bodyMd"),
    targetMemberId: asOptional(formData, "targetMemberId") || undefined,
    targetCircleId: asOptional(formData, "targetCircleId") || undefined,
    adviceRequestId: asOptional(formData, "adviceRequestId") || undefined,
  });
  refresh(workspaceId);
}

export async function resolveDeliberationEntryAction(formData: FormData) {
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

export async function updateDeliberationEntryAction(formData: FormData) {
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
