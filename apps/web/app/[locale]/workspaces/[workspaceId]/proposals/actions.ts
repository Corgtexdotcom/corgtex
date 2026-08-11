"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, duplicateGuardFromFormData, refresh } from "../action-utils";
import {
  AppError,
  archiveProposal,
  createProposal,
  createProposalFromTension,
  createAdviceRequest,
  createObjection,
  recordApprovalDecision,
  reopenProposal,
  resolveProposal,
  resolveObjection,
  returnProposalToDraft,
  submitProposal,
  updateProposal,
  postDeliberationEntry,
  resolveDeliberationEntry,
  updateDeliberationEntry,
  upsertWorkspaceExternalResourceFromUrl
} from "@corgtex/domain";
import type { AdviceRequestAudienceType, AdviceRequestPreferredChannel } from "@prisma/client";
import type { WorkItemEditActionState } from "@/lib/components/WorkItemEditForm";
import { uploadWorkItemEvidenceDocument } from "../work-item-evidence-upload";

function asStringArray(formData: FormData, key: string) {
  return formData.getAll(key).map((value) => String(value).trim()).filter(Boolean);
}

function asOptionalDate(formData: FormData, key: string) {
  const value = asOptional(formData, key);
  return value ? new Date(value) : null;
}

function ownerMemberIdFromForm(formData: FormData) {
  return formData.has("ownerMemberId") ? asOptional(formData, "ownerMemberId") : undefined;
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

export async function createProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const ownerMemberId = ownerMemberIdFromForm(formData);
  await createProposal(actor, {
    workspaceId,
    title: asString(formData, "title"),
    bodyMd: asString(formData, "bodyMd"),
    includeAiSummary: formData.get("includeAiSummary") === "on",
    priority: asOptionalInt(formData, "priority"),
    ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
    isPrivate: formData.get("isPrivate") === "on",
    sourceTensionId: asOptional(formData, "sourceTensionId"),
    relatedActionIds: asStringArray(formData, "relatedActionIds"),
    duplicateGuard: duplicateGuardFromFormData(formData),
  });
  refresh(workspaceId);
}

export async function createProposalFromTensionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const ownerMemberId = ownerMemberIdFromForm(formData);
  await createProposalFromTension(actor, {
    workspaceId,
    sourceTensionId: asString(formData, "sourceTensionId"),
    title: asOptional(formData, "title"),
    summary: asOptional(formData, "summary"),
    bodyMd: asOptional(formData, "bodyMd"),
    ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
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
    ownerMemberId: formData.has("ownerMemberId") ? asOptional(formData, "ownerMemberId") : undefined,
    includeAiSummary: formData.has("includeAiSummaryRendered") ? formData.get("includeAiSummary") === "on" : undefined,
  });
  refresh(workspaceId);
}

export async function editProposalAction(
  _state: WorkItemEditActionState,
  formData: FormData,
): Promise<WorkItemEditActionState> {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  try {
    await updateProposal(actor, {
      workspaceId,
      proposalId: asString(formData, "proposalId"),
      expectedVersion: expectedVersionFromForm(formData),
      title: asOptional(formData, "title") ?? undefined,
      bodyMd: asOptional(formData, "bodyMd") ?? undefined,
      priority: formData.has("priority") ? (asOptionalInt(formData, "priority") ?? 0) : undefined,
      ownerMemberId: formData.has("ownerMemberId") ? asOptional(formData, "ownerMemberId") : undefined,
      includeAiSummary: formData.has("includeAiSummaryRendered") ? formData.get("includeAiSummary") === "on" : undefined,
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

export async function attachProposalExternalResourceAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await upsertWorkspaceExternalResourceFromUrl(actor, {
    workspaceId,
    url: asString(formData, "url"),
    descriptionMd: asOptional(formData, "descriptionMd"),
    entityType: "Proposal",
    entityId: asString(formData, "proposalId"),
    purpose: "reference",
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

export async function decideProposalApprovalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await recordApprovalDecision(actor, {
    workspaceId,
    flowId: asString(formData, "flowId"),
    choice: asString(formData, "choice") as "APPROVE" | "REJECT" | "ABSTAIN" | "AGREE" | "BLOCK",
    rationale: asOptional(formData, "rationale"),
  });
  refresh(workspaceId);
}

export async function createProposalObjectionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createObjection(actor, {
    workspaceId,
    flowId: asString(formData, "flowId"),
    bodyMd: asString(formData, "bodyMd"),
  });
  refresh(workspaceId);
}

export async function resolveProposalObjectionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await resolveObjection(actor, {
    workspaceId,
    flowId: asString(formData, "flowId"),
    objectionId: asString(formData, "objectionId"),
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
