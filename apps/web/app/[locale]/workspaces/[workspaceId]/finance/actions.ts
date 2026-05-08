"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { asString, asOptional, refresh } from "../action-utils";
import {
  createLedgerAccount,
  createSpend,
  deleteLedgerAccount,
  deleteSpend,
  linkSpendLedgerAccount,
  markSpendPaid,
  returnSpendToDraft,
  submitSpend,
  updateSpend,
  updateLedgerAccount,
  updateSpendReconciliation,
  uploadSpendStatement,
  addSpendComment,
  resolveSpendObjection,
  escalateSpendToProposal,
  postDeliberationEntry,
  resolveDeliberationEntry,
} from "@corgtex/domain";

async function requireFinanceActionContext(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  return { actor, workspaceId };
}

export async function createSpendAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  
  // Convert dollars from form to cents for the domain
  const rawAmount = asString(formData, "amount");
  const parsedAmount = Number.parseFloat(rawAmount);
  const amountCents = !Number.isNaN(parsedAmount) ? Math.round(parsedAmount * 100) : 0;

  await createSpend(actor, {
    workspaceId,
    amountCents,
    currency: asString(formData, "currency"),
    category: asString(formData, "category"),
    description: asString(formData, "description"),
    vendor: asOptional(formData, "vendor"),
    proposalId: asOptional(formData, "proposalId"),
    ledgerAccountId: asOptional(formData, "ledgerAccountId"),
  });
  refresh(workspaceId);
}

export async function submitSpendAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await submitSpend(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
  });
  refresh(workspaceId);
}

export async function updateSpendAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  const rawAmount = asOptional(formData, "amount");
  const parsedAmount = rawAmount ? Number.parseFloat(rawAmount) : null;
  await updateSpend(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    amountCents: parsedAmount !== null && !Number.isNaN(parsedAmount) ? Math.round(parsedAmount * 100) : undefined,
    currency: formData.has("currency") ? asString(formData, "currency") : undefined,
    category: formData.has("category") ? asString(formData, "category") : undefined,
    description: formData.has("description") ? asString(formData, "description") : undefined,
    vendor: formData.has("vendor") ? asOptional(formData, "vendor") : undefined,
    ledgerAccountId: formData.has("ledgerAccountId") ? asOptional(formData, "ledgerAccountId") : undefined,
  });
  refresh(workspaceId);
}

export async function returnSpendToDraftAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await returnSpendToDraft(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
  });
  refresh(workspaceId);
}

export async function markSpendPaidAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await markSpendPaid(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    receiptUrl: asString(formData, "receiptUrl"),
  });
  refresh(workspaceId);
}

export async function createLedgerAccountAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await createLedgerAccount(actor, {
    workspaceId,
    name: asString(formData, "name"),
    currency: asString(formData, "currency"),
    type: asOptional(formData, "type"),
    balanceCents: formData.has("balanceCents") ? Number.parseInt(asString(formData, "balanceCents"), 10) : 0,
  });
  refresh(workspaceId);
}

export async function updateLedgerAccountAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await updateLedgerAccount(actor, {
    workspaceId,
    accountId: asString(formData, "accountId"),
    name: formData.has("name") ? asOptional(formData, "name") ?? undefined : undefined,
    currency: formData.has("currency") ? asOptional(formData, "currency") ?? undefined : undefined,
    type: formData.has("type") ? asOptional(formData, "type") : undefined,
  });
  refresh(workspaceId);
}

export async function archiveSpendAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await deleteSpend(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
  });
  refresh(workspaceId);
}

export async function archiveLedgerAccountAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await deleteLedgerAccount(actor, {
    workspaceId,
    accountId: asString(formData, "accountId"),
  });
  refresh(workspaceId);
}

export async function linkSpendLedgerAccountAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await linkSpendLedgerAccount(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    ledgerAccountId: asOptional(formData, "ledgerAccountId"),
  });
  refresh(workspaceId);
}

export async function uploadSpendStatementAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await uploadSpendStatement(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    storageKey: asString(formData, "storageKey"),
    fileName: asOptional(formData, "fileName"),
    mimeType: asOptional(formData, "mimeType"),
  });
  refresh(workspaceId);
}

export async function updateSpendReconciliationAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await updateSpendReconciliation(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    status: asString(formData, "status") as "PENDING" | "STATEMENT_ATTACHED" | "RECONCILED",
    note: formData.has("note") ? asOptional(formData, "note") : undefined,
  });
  refresh(workspaceId);
}

export async function addSpendCommentAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await addSpendComment(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    bodyMd: asString(formData, "bodyMd"),
    isObjection: formData.has("isObjection") && formData.get("isObjection") === "true",
  });
  refresh(workspaceId);
}

export async function resolveSpendObjectionAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await resolveSpendObjection(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    commentId: asString(formData, "commentId"),
  });
  refresh(workspaceId);
}

export async function escalateSpendToProposalAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await escalateSpendToProposal(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
  });
  refresh(workspaceId);
}

export async function postSpendDeliberationAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  
  await postDeliberationEntry(actor, {
    workspaceId,
    parentType: "SPEND",
    parentId: asString(formData, "parentId"),
    entryType: asString(formData, "entryType") as any,
    bodyMd: asString(formData, "bodyMd"),
    targetMemberId: asOptional(formData, "targetMemberId") || undefined,
    targetCircleId: asOptional(formData, "targetCircleId") || undefined,
  });
  refresh(workspaceId);
}

export async function resolveSpendDeliberationAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  
  await resolveDeliberationEntry(actor, {
    workspaceId,
    entryId: asString(formData, "entryId"),
    resolvedNote: asString(formData, "resolvedNote"),
  });
  refresh(workspaceId);
}
