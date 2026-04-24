import type { Prisma, SpendReconciliationStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { appendEvents } from "./events";
import { getApprovalPolicy } from "./approvals";
import { invariant } from "./errors";

function requireFinanceAccess(actor: AppActor, workspaceId: string) {
  return requireWorkspaceMembership({
    actor,
    workspaceId,
    allowedRoles: ["FINANCE_STEWARD", "ADMIN"],
  });
}

export function normalizeCurrencyCode(currency: string) {
  const normalized = currency.trim().toUpperCase();
  invariant(/^[A-Z]{3,10}$/.test(normalized), 400, "INVALID_INPUT", "currency must be 3-10 uppercase letters.");
  return normalized;
}

export function normalizeReconciliationStatusInput(status: string): SpendReconciliationStatus {
  const normalized = status.trim().toUpperCase();
  invariant(
    normalized === "PENDING" || normalized === "STATEMENT_ATTACHED" || normalized === "RECONCILED",
    400,
    "INVALID_INPUT",
    "Invalid reconciliation status.",
  );
  return normalized;
}

async function findSpendForWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  spendId: string,
) {
  const spend = await tx.spendRequest.findUnique({
    where: { id: spendId },
    include: {
      proposalLinks: {
        include: {
          proposal: {
            select: {
              id: true,
              status: true,
            },
          },
        },
      },
      comments: {
        include: {
          author: {
            select: {
              id: true,
              email: true,
              displayName: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  invariant(spend && spend.workspaceId === workspaceId, 404, "NOT_FOUND", "Spend request not found.");
  return spend;
}

async function findLedgerAccountForWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  accountId: string,
) {
  const account = await tx.ledgerAccount.findUnique({
    where: { id: accountId },
  });
  invariant(account && account.workspaceId === workspaceId, 404, "NOT_FOUND", "Ledger account not found.");
  return account;
}

async function ensureSpendLedgerEntry(tx: Prisma.TransactionClient, spend: {
  id: string;
  workspaceId: string;
  ledgerAccountId: string | null;
  amountCents: number;
  currency: string;
  description: string;
  spentAt: Date | null;
}) {
  if (!spend.ledgerAccountId) {
    return null;
  }

  const existing = await tx.ledgerEntry.findFirst({
    where: {
      referenceType: "SpendRequest",
      referenceId: spend.id,
    },
  });

  if (existing) {
    return existing;
  }

  const account = await findLedgerAccountForWorkspace(tx, spend.workspaceId, spend.ledgerAccountId);
  invariant(account.currency === spend.currency, 400, "INVALID_INPUT", "Ledger account currency must match the spend currency.");

  const entry = await tx.ledgerEntry.create({
    data: {
      workspaceId: spend.workspaceId,
      accountId: spend.ledgerAccountId,
      type: "SPEND_PAID",
      amountCents: spend.amountCents * -1,
      currency: spend.currency,
      description: spend.description,
      referenceType: "SpendRequest",
      referenceId: spend.id,
      effectiveAt: spend.spentAt ?? new Date(),
    },
  });

  await tx.ledgerAccount.update({
    where: { id: spend.ledgerAccountId },
    data: {
      balanceCents: {
        increment: entry.amountCents,
      },
    },
  });

  return entry;
}

export async function listSpends(workspaceId: string, opts?: { take?: number; skip?: number }) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const [items, total] = await Promise.all([
    prisma.spendRequest.findMany({
      where: { workspaceId },
      include: {
        requester: {
          select: {
            email: true,
            displayName: true,
          },
        },
        ledgerAccount: {
          select: {
            id: true,
            name: true,
            currency: true,
            balanceCents: true,
          },
        },
        proposalLinks: {
          include: {
            proposal: {
              select: {
                id: true,
                title: true,
                status: true,
              },
            },
          },
        },
        comments: {
          include: {
            author: { select: { displayName: true, email: true } }
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.spendRequest.count({ where: { workspaceId } }),
  ]);
  return { items, total, take, skip };
}

export async function listLedgerAccounts(workspaceId: string, opts?: { take?: number; skip?: number }) {
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;
  const [items, total] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { workspaceId },
      include: {
        entries: {
          orderBy: { effectiveAt: "desc" },
          take: 5,
        },
        spendRequests: {
          select: {
            id: true,
            status: true,
            amountCents: true,
            currency: true,
            category: true,
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.ledgerAccount.count({ where: { workspaceId } }),
  ]);

  return { items, total, take, skip };
}

export async function createSpend(actor: AppActor, params: {
  workspaceId: string;
  amountCents: number;
  currency: string;
  category: string;
  description: string;
  vendor?: string | null;
  proposalId?: string | null;
  ledgerAccountId?: string | null;
  requesterEmail?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(Number.isInteger(params.amountCents) && params.amountCents > 0, 400, "INVALID_INPUT", "amountCents must be a positive integer.");
  const currency = normalizeCurrencyCode(params.currency);
  const category = params.category.trim();
  const description = params.description.trim();
  invariant(category.length > 0, 400, "INVALID_INPUT", "category is required.");
  invariant(description.length > 0, 400, "INVALID_INPUT", "description is required.");

  // When agent provides requesterEmail, look up the actual user to attribute the spend.
  let requesterUserId: string;
  if (actor.kind === "agent" && params.requesterEmail) {
    const email = params.requesterEmail.trim().toLowerCase();
    const member = await prisma.member.findFirst({
      where: {
        workspaceId: params.workspaceId,
        isActive: true,
        user: { email },
      },
      select: { userId: true },
    });
    invariant(member, 404, "NOT_FOUND", `No active workspace member found with email "${email}".`);
    requesterUserId = member.userId;
  } else {
    requesterUserId = await actorUserIdForWorkspace(actor, params.workspaceId);
  }

  return prisma.$transaction(async (tx) => {
    if (params.ledgerAccountId) {
      const account = await findLedgerAccountForWorkspace(tx, params.workspaceId, params.ledgerAccountId);
      invariant(account.currency === currency, 400, "INVALID_INPUT", "Ledger account currency must match the spend currency.");
    }

    if (params.proposalId) {
      const proposal = await tx.proposal.findUnique({
        where: { id: params.proposalId },
        select: {
          id: true,
          workspaceId: true,
        },
      });
      invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Linked proposal not found.");
    }

    const spend = await tx.spendRequest.create({
      data: {
        workspaceId: params.workspaceId,
        requesterUserId,
        amountCents: params.amountCents,
        currency,
        category,
        description,
        vendor: params.vendor?.trim() || null,
        ledgerAccountId: params.ledgerAccountId || null,
      },
    });

    if (params.proposalId) {
      await tx.spendProposalLink.create({
        data: {
          spendId: spend.id,
          proposalId: params.proposalId,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "spend.created",
        entityType: "SpendRequest",
        entityId: spend.id,
        meta: {
          amountCents: spend.amountCents,
          currency: spend.currency,
          ledgerAccountId: spend.ledgerAccountId,
          requesterEmail: params.requesterEmail?.trim() || null,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "spend.created",
        aggregateType: "SpendRequest",
        aggregateId: spend.id,
        payload: {
          spendId: spend.id,
          amountCents: spend.amountCents,
          currency: spend.currency,
        },
      },
    ]);

    return spend;
  });
}

export async function submitSpend(actor: AppActor, params: { workspaceId: string; spendId: string }) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const policy = await getApprovalPolicy(params.workspaceId, "SPEND");

  return prisma.$transaction(async (tx) => {
    const spend = await findSpendForWorkspace(tx, params.workspaceId, params.spendId);
    invariant(spend.status === "DRAFT", 400, "INVALID_STATE", "Only draft spend requests can be submitted.");

    if (policy.requireProposalLink) {
      if (spend.proposalLinks.length === 0) {
        invariant(false, 400, "INVALID_POLICY", "This workspace requires a linked proposal before spend submission.");
      }

      const hasApprovedProposal = spend.proposalLinks.some((link) => link.proposal.status === "APPROVED");
      invariant(hasApprovedProposal, 400, "INVALID_POLICY", "This workspace requires a linked approved proposal before spend submission.");
    }

    await tx.spendRequest.update({
      where: { id: spend.id },
      data: {
        status: "SUBMITTED",
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "spend.submitted",
        entityType: "SpendRequest",
        entityId: spend.id,
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "spend.submitted",
        aggregateType: "SpendRequest",
        aggregateId: spend.id,
        payload: {
          spendId: spend.id,
        },
      },
    ]);

    return {
      spendId: spend.id,
    };
  });
}

export async function createLedgerAccount(actor: AppActor, params: {
  workspaceId: string;
  name: string;
  currency: string;
  type?: string | null;
  balanceCents?: number;
}) {
  await requireFinanceAccess(actor, params.workspaceId);

  const name = params.name.trim();
  const currency = normalizeCurrencyCode(params.currency);
  const type = params.type?.trim() || "MANUAL";
  const balanceCents = params.balanceCents ?? 0;
  invariant(name.length > 0, 400, "INVALID_INPUT", "name is required.");
  invariant(Number.isInteger(balanceCents), 400, "INVALID_INPUT", "balanceCents must be an integer.");

  return prisma.$transaction(async (tx) => {
    const account = await tx.ledgerAccount.create({
      data: {
        workspaceId: params.workspaceId,
        name,
        currency,
        type,
        balanceCents,
      },
    });

    if (balanceCents !== 0) {
      await tx.ledgerEntry.create({
        data: {
          workspaceId: params.workspaceId,
          accountId: account.id,
          type: "ACCOUNT_OPENED",
          amountCents: balanceCents,
          currency,
          description: "Opening balance",
          effectiveAt: new Date(),
        },
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "ledger-account.created",
        entityType: "LedgerAccount",
        entityId: account.id,
        meta: {
          currency,
          balanceCents,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "ledger-account.created",
        aggregateType: "LedgerAccount",
        aggregateId: account.id,
        payload: {
          accountId: account.id,
        },
      },
    ]);

    return account;
  });
}

export async function updateLedgerAccount(actor: AppActor, params: {
  workspaceId: string;
  accountId: string;
  name?: string;
  currency?: string;
  type?: string | null;
}) {
  await requireFinanceAccess(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const account = await findLedgerAccountForWorkspace(tx, params.workspaceId, params.accountId);
    const data: Record<string, unknown> = {};

    if (params.name !== undefined) {
      const name = params.name.trim();
      invariant(name.length > 0, 400, "INVALID_INPUT", "name is required.");
      data.name = name;
    }

    if (params.currency !== undefined) {
      const currency = normalizeCurrencyCode(params.currency);
      const linkedSpends = await tx.spendRequest.count({
        where: {
          ledgerAccountId: account.id,
        },
      });
      const existingEntries = await tx.ledgerEntry.count({
        where: {
          accountId: account.id,
        },
      });
      invariant(linkedSpends === 0, 400, "INVALID_STATE", "Cannot change currency while spends are linked.");
      invariant(existingEntries === 0, 400, "INVALID_STATE", "Cannot change currency after ledger entries exist.");
      data.currency = currency;
    }

    if (params.type !== undefined) {
      const type = params.type?.trim() || "MANUAL";
      data.type = type;
    }

    invariant(Object.keys(data).length > 0, 400, "INVALID_INPUT", "At least one field must be updated.");

    const updated = await tx.ledgerAccount.update({
      where: { id: account.id },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "ledger-account.updated",
        entityType: "LedgerAccount",
        entityId: updated.id,
        meta: {
          fields: Object.keys(data),
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "ledger-account.updated",
        aggregateType: "LedgerAccount",
        aggregateId: updated.id,
        payload: {
          accountId: updated.id,
          fields: Object.keys(data),
        },
      },
    ]);

    return updated;
  });
}

export async function linkSpendLedgerAccount(actor: AppActor, params: {
  workspaceId: string;
  spendId: string;
  ledgerAccountId: string | null;
}) {
  await requireFinanceAccess(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const spend = await findSpendForWorkspace(tx, params.workspaceId, params.spendId);

    const existingEntry = await tx.ledgerEntry.findFirst({
      where: {
        referenceType: "SpendRequest",
        referenceId: spend.id,
      },
    });

    if (existingEntry) {
      invariant(spend.ledgerAccountId === params.ledgerAccountId, 400, "INVALID_STATE", "Cannot relink a spend after a ledger entry has been posted.");
    }

    if (params.ledgerAccountId) {
      const account = await findLedgerAccountForWorkspace(tx, params.workspaceId, params.ledgerAccountId);
      invariant(account.currency === spend.currency, 400, "INVALID_INPUT", "Ledger account currency must match the spend currency.");
    }

    const updated = await tx.spendRequest.update({
      where: { id: spend.id },
      data: {
        ledgerAccountId: params.ledgerAccountId,
      },
    });

    if (updated.status === "PAID" && updated.ledgerAccountId && !existingEntry) {
      await ensureSpendLedgerEntry(tx, updated);
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "spend.ledger-account-linked",
        entityType: "SpendRequest",
        entityId: updated.id,
        meta: {
          ledgerAccountId: updated.ledgerAccountId,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "spend.ledger-account-linked",
        aggregateType: "SpendRequest",
        aggregateId: updated.id,
        payload: {
          spendId: updated.id,
          ledgerAccountId: updated.ledgerAccountId,
        },
      },
    ]);

    return updated;
  });
}

export async function markSpendPaid(actor: AppActor, params: {
  workspaceId: string;
  spendId: string;
  receiptUrl: string;
}) {
  await requireFinanceAccess(actor, params.workspaceId);

  const receiptUrl = params.receiptUrl.trim();
  invariant(receiptUrl.length > 0, 400, "INVALID_INPUT", "receiptUrl is required.");

  return prisma.$transaction(async (tx) => {
    const spend = await findSpendForWorkspace(tx, params.workspaceId, params.spendId);
    
    // Check if spend can be marked as paid
    const isApproved = spend.status === "APPROVED";
    
    // Can be paid from SUBMITTED if there are no open objections
    let isSubmittedWithoutObjections = false;
    if (spend.status === "SUBMITTED") {
      const openObjectionsCount = await tx.deliberationEntry.count({
        where: {
          parentType: "SPEND",
          parentId: spend.id,
          entryType: "OBJECTION",
          resolvedAt: null,
        }
      });
      isSubmittedWithoutObjections = openObjectionsCount === 0;
    }

    invariant(
      isApproved || isSubmittedWithoutObjections, 
      400, 
      "INVALID_STATE", 
      "Spend must be APPROVED or SUBMITTED with no open objections to be marked paid."
    );

    if (spend.ledgerAccountId) {
      const account = await findLedgerAccountForWorkspace(tx, params.workspaceId, spend.ledgerAccountId);
      invariant(account.currency === spend.currency, 400, "INVALID_INPUT", "Ledger account currency must match the spend currency.");
    }

    const updated = await tx.spendRequest.update({
      where: { id: spend.id },
      data: {
        status: "PAID",
        receiptUrl,
        spentAt: new Date(),
      },
    });

    await ensureSpendLedgerEntry(tx, updated);

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "spend.paid",
        entityType: "SpendRequest",
        entityId: updated.id,
        meta: {
          receiptUrl,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "spend.paid",
        aggregateType: "SpendRequest",
        aggregateId: updated.id,
        payload: {
          spendId: updated.id,
          receiptUrl,
        },
      },
    ]);

    return updated;
  });
}

export async function uploadSpendStatement(actor: AppActor, params: {
  workspaceId: string;
  spendId: string;
  storageKey: string;
  fileName?: string | null;
  mimeType?: string | null;
}) {
  await requireFinanceAccess(actor, params.workspaceId);

  const storageKey = params.storageKey.trim();
  invariant(storageKey.length > 0, 400, "INVALID_INPUT", "storageKey is required.");

  return prisma.$transaction(async (tx) => {
    const spend = await findSpendForWorkspace(tx, params.workspaceId, params.spendId);
    invariant(spend.status === "PAID", 400, "INVALID_STATE", "Only paid spends can attach a statement.");

    const updated = await tx.spendRequest.update({
      where: { id: spend.id },
      data: {
        statementStorageKey: storageKey,
        statementFileName: params.fileName?.trim() || null,
        statementMimeType: params.mimeType?.trim() || null,
        statementUploadedAt: new Date(),
        reconciliationStatus: "STATEMENT_ATTACHED",
        reconciledAt: null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "spend.statement-uploaded",
        entityType: "SpendRequest",
        entityId: updated.id,
        meta: {
          storageKey,
          fileName: updated.statementFileName,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "spend.statement-uploaded",
        aggregateType: "SpendRequest",
        aggregateId: updated.id,
        payload: {
          spendId: updated.id,
          storageKey,
        },
      },
    ]);

    return updated;
  });
}

export async function updateSpendReconciliation(actor: AppActor, params: {
  workspaceId: string;
  spendId: string;
  status: SpendReconciliationStatus;
  note?: string | null;
}) {
  await requireFinanceAccess(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const spend = await findSpendForWorkspace(tx, params.workspaceId, params.spendId);
    invariant(spend.status === "PAID", 400, "INVALID_STATE", "Only paid spends can be reconciled.");
    if (params.status === "STATEMENT_ATTACHED") {
      invariant(Boolean(spend.statementStorageKey), 400, "INVALID_STATE", "Attach a statement before moving to STATEMENT_ATTACHED.");
    }
    if (params.status === "RECONCILED") {
      invariant(Boolean(spend.statementStorageKey), 400, "INVALID_STATE", "Attach a statement before reconciling.");
      invariant(Boolean(spend.ledgerAccountId), 400, "INVALID_STATE", "Link a ledger account before reconciling.");
    }

    const updated = await tx.spendRequest.update({
      where: { id: spend.id },
      data: {
        reconciliationStatus: params.status,
        reconciliationNote: params.note?.trim() || null,
        reconciledAt: params.status === "RECONCILED" ? new Date() : null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "spend.reconciliation.updated",
        entityType: "SpendRequest",
        entityId: updated.id,
        meta: {
          reconciliationStatus: updated.reconciliationStatus,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "spend.reconciliation.updated",
        aggregateType: "SpendRequest",
        aggregateId: updated.id,
        payload: {
          spendId: updated.id,
          reconciliationStatus: updated.reconciliationStatus,
        },
      },
    ]);

    return updated;
  });
}

export async function addSpendComment(actor: AppActor, params: {
  workspaceId: string;
  spendId: string;
  bodyMd: string;
  isObjection?: boolean;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const authorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);
  const bodyMd = params.bodyMd.trim();
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Comment body is required.");
  const isObjection = params.isObjection ?? false;

  return prisma.$transaction(async (tx) => {
    const spend = await findSpendForWorkspace(tx, params.workspaceId, params.spendId);
    
    // Create the comment
    const comment = await tx.spendComment.create({
      data: {
        spendId: spend.id,
        authorUserId,
        bodyMd,
        isObjection,
      },
    });

    // If it's an objection and the spend is SUBMITTED, it moves to OBJECTED
    if (isObjection && spend.status === "SUBMITTED") {
      await tx.spendRequest.update({
        where: { id: spend.id },
        data: { status: "OBJECTED" },
      });
      
      await appendEvents(tx, [{
        workspaceId: params.workspaceId,
        type: "spend.objected",
        aggregateType: "SpendRequest",
        aggregateId: spend.id,
        payload: { spendId: spend.id },
      }]);
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: authorUserId,
        action: "spend.comment_added",
        entityType: "SpendRequest",
        entityId: spend.id,
        meta: { commentId: comment.id, isObjection },
      },
    });

    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "spend.comment_added",
      aggregateType: "SpendRequest",
      aggregateId: spend.id,
      payload: { spendId: spend.id, commentId: comment.id, isObjection },
    }]);

    return comment;
  });
}

export async function resolveSpendObjection(actor: AppActor, params: {
  workspaceId: string;
  spendId: string;
  commentId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const actorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const spend = await findSpendForWorkspace(tx, params.workspaceId, params.spendId);
    
    const comment = await tx.spendComment.findUnique({
      where: { id: params.commentId },
    });
    
    invariant(comment && comment.spendId === spend.id, 404, "NOT_FOUND", "Comment not found.");
    invariant(comment.isObjection, 400, "INVALID_STATE", "Comment is not an objection.");
    invariant(!comment.resolvedAt, 400, "INVALID_STATE", "Objection is already resolved.");
    
    // Note: If agent, membership is null. `canResolve` handles it.
    const isAuthor = comment.authorUserId === actorUserId;
    const canResolve = isAuthor || membership?.role === "FACILITATOR" || membership?.role === "ADMIN";
    invariant(canResolve, 403, "FORBIDDEN", "You cannot resolve this objection.");

    await tx.spendComment.update({
      where: { id: comment.id },
      data: { resolvedAt: new Date() },
    });

    // Check if there are any other open objections
    const otherOpenObjections = await tx.spendComment.count({
      where: {
        spendId: spend.id,
        isObjection: true,
        resolvedAt: null,
      },
    });

    // If spend was OBJECTED and there are no more open objections, it goes back to SUBMITTED
    if (spend.status === "OBJECTED" && otherOpenObjections === 0) {
      await tx.spendRequest.update({
        where: { id: spend.id },
        data: { status: "SUBMITTED" },
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId,
        action: "spend.objection_resolved",
        entityType: "SpendRequest",
        entityId: spend.id,
        meta: { commentId: comment.id },
      },
    });

    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "spend.objection_resolved",
      aggregateType: "SpendRequest",
      aggregateId: spend.id,
      payload: { spendId: spend.id, commentId: comment.id },
    }]);
  });
}

export async function escalateSpendToProposal(actor: AppActor, params: {
  workspaceId: string;
  spendId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const actorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const spend = await findSpendForWorkspace(tx, params.workspaceId, params.spendId);
    invariant(spend.status === "OBJECTED", 400, "INVALID_STATE", "Only objected spends can be escalated.");

    // Create a new proposal
    const proposal = await tx.proposal.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId: spend.requesterUserId, // The original requester becomes the proposal author
        title: `Spend Approval: ${spend.description}`,
        summary: `Escalated from objected spend request for ${spend.amountCents / 100} ${spend.currency}.`,
        bodyMd: `This spend request was objected to and escalated to a formal proposal.\n\n` +
                `**Amount**: ${spend.amountCents / 100} ${spend.currency}\n` +
                `**Category**: ${spend.category}\n` +
                `**Description**: ${spend.description}\n` +
                `**Vendor**: ${spend.vendor || "—"}\n\n` +
                `Please review the discussion thread on the spend request for more context.`,
      },
    });

    // Link the spend to the new proposal
    await tx.spendProposalLink.create({
      data: {
        spendId: spend.id,
        proposalId: proposal.id,
      },
    });

    // Leave the spend in OBJECTED state until the proposal is resolved 
    // We could make an ESCALATED state, but OBJECTED works fine for now as it blocks payment natively
    
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId,
        action: "spend.escalated",
        entityType: "SpendRequest",
        entityId: spend.id,
        meta: { proposalId: proposal.id },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "spend.escalated",
        aggregateType: "SpendRequest",
        aggregateId: spend.id,
        payload: { spendId: spend.id, proposalId: proposal.id },
      },
      {
        workspaceId: params.workspaceId,
        type: "proposal.created",
        aggregateType: "Proposal",
        aggregateId: proposal.id,
        payload: { proposalId: proposal.id },
      }
    ]);

    return proposal;
  });
}
export async function getSpend(actor: AppActor, params: { workspaceId: string; spendId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return findSpendForWorkspace(prisma, params.workspaceId, params.spendId);
}

export async function updateSpend(actor: AppActor, params: {
  workspaceId: string;
  spendId: string;
  amountCents?: number;
  currency?: string;
  category?: string;
  description?: string;
  vendor?: string | null;
  ledgerAccountId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const spend = await findSpendForWorkspace(tx, params.workspaceId, params.spendId);
    invariant(spend.status === "DRAFT", 400, "INVALID_STATE", "Only draft spend requests can be updated.");

    const data: Record<string, unknown> = {};
    if (params.amountCents !== undefined) {
      invariant(Number.isInteger(params.amountCents) && params.amountCents > 0, 400, "INVALID_INPUT", "amountCents must be a positive integer.");
      data.amountCents = params.amountCents;
    }
    if (params.currency !== undefined) {
      data.currency = normalizeCurrencyCode(params.currency);
    }
    if (params.category !== undefined) {
      const category = params.category.trim();
      invariant(category.length > 0, 400, "INVALID_INPUT", "category is required.");
      data.category = category;
    }
    if (params.description !== undefined) {
      const description = params.description.trim();
      invariant(description.length > 0, 400, "INVALID_INPUT", "description is required.");
      data.description = description;
    }
    if (params.vendor !== undefined) data.vendor = params.vendor?.trim() || null;
    if (params.ledgerAccountId !== undefined) {
      if (params.ledgerAccountId) {
        const account = await findLedgerAccountForWorkspace(tx, params.workspaceId, params.ledgerAccountId);
        const cur = typeof data.currency === "string" ? data.currency : spend.currency;
        invariant(account.currency === cur, 400, "INVALID_INPUT", "Ledger account currency must match the spend currency.");
      }
      data.ledgerAccountId = params.ledgerAccountId || null;
    }

    invariant(Object.keys(data).length > 0, 400, "INVALID_INPUT", "At least one field must be updated.");

    const updated = await tx.spendRequest.update({
      where: { id: params.spendId },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "spend.updated",
        entityType: "SpendRequest",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}
