"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createLedgerAccount,
  createSpend,
  deleteLedgerAccount,
  deleteSpend,
  linkSpendLedgerAccount,
  markSpendPaid,
  submitSpend,
  updateLedgerAccount,
  updateSpendReconciliation,
  uploadSpendStatement,
  addSpendComment,
  resolveSpendObjection,
  escalateSpendToProposal,
  postDeliberationEntry,
  resolveDeliberationEntry,
} from "@corgtex/domain";


export async function createSpendAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
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
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await submitSpend(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
  });
  refresh(workspaceId);
}

export async function markSpendPaidAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await markSpendPaid(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    receiptUrl: asString(formData, "receiptUrl"),
  });
  refresh(workspaceId);
}

export async function createLedgerAccountAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
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
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
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
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteSpend(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
  });
  refresh(workspaceId);
}

export async function archiveLedgerAccountAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteLedgerAccount(actor, {
    workspaceId,
    accountId: asString(formData, "accountId"),
  });
  refresh(workspaceId);
}

export async function linkSpendLedgerAccountAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await linkSpendLedgerAccount(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    ledgerAccountId: asOptional(formData, "ledgerAccountId"),
  });
  refresh(workspaceId);
}

export async function uploadSpendStatementAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
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
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateSpendReconciliation(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    status: asString(formData, "status") as "PENDING" | "STATEMENT_ATTACHED" | "RECONCILED",
    note: formData.has("note") ? asOptional(formData, "note") : undefined,
  });
  refresh(workspaceId);
}

export async function addSpendCommentAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await addSpendComment(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    bodyMd: asString(formData, "bodyMd"),
    isObjection: formData.has("isObjection") && formData.get("isObjection") === "true",
  });
  refresh(workspaceId);
}

export async function resolveSpendObjectionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await resolveSpendObjection(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
    commentId: asString(formData, "commentId"),
  });
  refresh(workspaceId);
}

export async function escalateSpendToProposalAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await escalateSpendToProposal(actor, {
    workspaceId,
    spendId: asString(formData, "spendId"),
  });
  refresh(workspaceId);
}

export async function postSpendDeliberationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
  await postDeliberationEntry(actor, {
    workspaceId,
    parentType: "SPEND",
    parentId: asString(formData, "parentId"),
    entryType: asString(formData, "entryType") as any,
    bodyMd: asString(formData, "bodyMd"),
  });
  refresh(workspaceId);
}

export async function resolveSpendDeliberationAction(formData: FormData) {
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
