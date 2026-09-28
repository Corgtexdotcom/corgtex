import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";

export type DecisionInput = {
  workspaceId: string;
  title: string;
  bodyMd: string;
  tags?: string | readonly string[];
  decidedAt: Date;
  proposalId?: string | null;
  tensionId?: string | null;
};

export function normalizeDecisionTags(value: string | readonly string[] = []) {
  const values = typeof value === "string" ? value.split(",") : value;
  const tags = [...new Set(values.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))];
  invariant(tags.length <= 10 && tags.every((tag) => tag.length <= 40), 400, "INVALID_INPUT", "Use at most 10 tags of 40 characters each.");
  return tags;
}

function cleanInput(input: DecisionInput) {
  const title = input.title.trim();
  const bodyMd = input.bodyMd.trim();
  invariant(title.length > 0 && title.length <= 200, 400, "INVALID_INPUT", "Decision title must be 1 to 200 characters.");
  invariant(bodyMd.length > 0 && bodyMd.length <= 20000, 400, "INVALID_INPUT", "Decision details must be 1 to 20000 characters.");
  invariant(!Number.isNaN(input.decidedAt.getTime()), 400, "INVALID_INPUT", "Decision date is invalid.");
  return {
    title,
    bodyMd,
    tags: normalizeDecisionTags(input.tags),
    decidedAt: input.decidedAt,
    proposalId: input.proposalId?.trim() || null,
    tensionId: input.tensionId?.trim() || null,
  };
}

async function validateLinks(db: Prisma.TransactionClient, workspaceId: string, input: ReturnType<typeof cleanInput>) {
  if (input.proposalId) {
    const proposal = await db.proposal.findFirst({
      where: { id: input.proposalId, workspaceId, archivedAt: null, isPrivate: false, status: { not: "DRAFT" } },
      select: { id: true },
    });
    invariant(proposal, 400, "INVALID_LINK", "Choose a visible proposal from this workspace.");
  }
  if (input.tensionId) {
    const tension = await db.tension.findFirst({
      where: { id: input.tensionId, workspaceId, archivedAt: null, isPrivate: false, status: { not: "DRAFT" } },
      select: { id: true },
    });
    invariant(tension, 400, "INVALID_LINK", "Choose a visible tension from this workspace.");
  }
}

async function attachLinks<T extends { proposalId: string | null; tensionId: string | null }>(workspaceId: string, rows: T[]) {
  const proposalIds = [...new Set(rows.map((row) => row.proposalId).filter((id): id is string => Boolean(id)))];
  const tensionIds = [...new Set(rows.map((row) => row.tensionId).filter((id): id is string => Boolean(id)))];
  const [proposals, tensions] = await Promise.all([
    prisma.proposal.findMany({
      where: { workspaceId, id: { in: proposalIds }, archivedAt: null, isPrivate: false, status: { not: "DRAFT" } },
      select: { id: true, title: true },
    }),
    prisma.tension.findMany({
      where: { workspaceId, id: { in: tensionIds }, archivedAt: null, isPrivate: false, status: { not: "DRAFT" } },
      select: { id: true, title: true },
    }),
  ]);
  const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const tensionById = new Map(tensions.map((tension) => [tension.id, tension]));
  return rows.map((row) => ({
    ...row,
    proposal: row.proposalId ? proposalById.get(row.proposalId) ?? null : null,
    tension: row.tensionId ? tensionById.get(row.tensionId) ?? null : null,
  }));
}

export async function listDecisionRecords(actor: AppActor, params: {
  workspaceId: string;
  query?: string;
  tag?: string;
  page?: number;
  includeArchived?: boolean;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const query = params.query?.trim().slice(0, 120) ?? "";
  const tag = params.tag?.trim().toLocaleLowerCase().slice(0, 40) ?? "";
  const page = Number.isSafeInteger(params.page) && (params.page ?? 0) > 0 ? params.page! : 1;
  const where: Prisma.DecisionRecordWhereInput = {
    workspaceId: params.workspaceId,
    archivedAt: params.includeArchived ? { not: null } : null,
    ...(tag ? { tags: { has: tag } } : {}),
    ...(query ? { OR: [
      { title: { contains: query, mode: "insensitive" } },
      { bodyMd: { contains: query, mode: "insensitive" } },
      { tags: { has: query.toLocaleLowerCase() } },
    ] } : {}),
  };
  const [rows, total, tagRows] = await Promise.all([
    prisma.decisionRecord.findMany({ where, orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }], skip: (page - 1) * 50, take: 50 }),
    prisma.decisionRecord.count({ where }),
    prisma.decisionRecord.findMany({ where: { workspaceId: params.workspaceId, archivedAt: params.includeArchived ? { not: null } : null }, select: { tags: true } }),
  ]);
  return {
    items: await attachLinks(params.workspaceId, rows),
    total,
    page,
    tags: [...new Set(tagRows.flatMap((row) => row.tags))].sort((a, b) => a.localeCompare(b)),
  };
}

export async function getDecisionRecord(actor: AppActor, params: { workspaceId: string; decisionId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const decision = await prisma.decisionRecord.findFirst({ where: { id: params.decisionId, workspaceId: params.workspaceId } });
  invariant(decision, 404, "NOT_FOUND", "Decision not found.");
  return (await attachLinks(params.workspaceId, [decision]))[0];
}

export async function listDecisionLinkOptions(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const [proposals, tensions] = await Promise.all([
    prisma.proposal.findMany({
      where: { workspaceId, archivedAt: null, isPrivate: false, status: { not: "DRAFT" } },
      select: { id: true, title: true }, orderBy: { title: "asc" },
    }),
    prisma.tension.findMany({
      where: { workspaceId, archivedAt: null, isPrivate: false, status: { not: "DRAFT" } },
      select: { id: true, title: true }, orderBy: { title: "asc" },
    }),
  ]);
  return { proposals, tensions };
}

export async function createDecisionRecord(actor: AppActor, input: DecisionInput) {
  await requireWorkspaceMembership({ actor, workspaceId: input.workspaceId });
  const data = cleanInput(input);
  const createdByUserId = await actorUserIdForWorkspace(actor, input.workspaceId);
  return prisma.$transaction(async (tx) => {
    await validateLinks(tx, input.workspaceId, data);
    return tx.decisionRecord.create({ data: { workspaceId: input.workspaceId, createdByUserId, ...data } });
  });
}

export async function updateDecisionRecord(actor: AppActor, input: DecisionInput & { decisionId: string; expectedVersion: number }) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: input.workspaceId });
  invariant(Number.isSafeInteger(input.expectedVersion) && input.expectedVersion > 0, 400, "INVALID_INPUT", "Expected version is invalid.");
  const data = cleanInput(input);
  return prisma.$transaction(async (tx) => {
    const current = await tx.decisionRecord.findFirst({ where: { id: input.decisionId, workspaceId: input.workspaceId, archivedAt: null } });
    invariant(current, 404, "NOT_FOUND", "Decision not found.");
    invariant(actor.kind === "agent" || membership?.role === "ADMIN" || current.createdByUserId === actor.user.id,
      403, "FORBIDDEN", "Only the decision author or a workspace admin can edit it.");
    await validateLinks(tx, input.workspaceId, data);
    const updated = await tx.decisionRecord.updateMany({
      where: { id: input.decisionId, workspaceId: input.workspaceId, archivedAt: null, version: input.expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count === 0) throw new AppError(409, "VERSION_CONFLICT", "Decision changed or was archived. Reload and try again.");
    return tx.decisionRecord.findFirstOrThrow({ where: { id: input.decisionId, workspaceId: input.workspaceId } });
  });
}

export async function archiveDecisionRecord(actor: AppActor, params: { workspaceId: string; decisionId: string; expectedVersion: number }) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(Number.isSafeInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "Expected version is invalid.");
  const current = await prisma.decisionRecord.findFirst({ where: { id: params.decisionId, workspaceId: params.workspaceId, archivedAt: null } });
  invariant(current, 404, "NOT_FOUND", "Decision not found.");
  invariant(actor.kind === "agent" || membership?.role === "ADMIN" || current.createdByUserId === actor.user.id,
    403, "FORBIDDEN", "Only the decision author or a workspace admin can archive it.");
  const updated = await prisma.decisionRecord.updateMany({
    where: { id: params.decisionId, workspaceId: params.workspaceId, archivedAt: null, version: params.expectedVersion },
    data: { archivedAt: new Date(), version: { increment: 1 } },
  });
  if (updated.count === 0) throw new AppError(409, "VERSION_CONFLICT", "Decision changed or was archived. Reload and try again.");
}

export async function restoreDecisionRecord(actor: AppActor, params: { workspaceId: string; decisionId: string; expectedVersion: number }) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(Number.isSafeInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "Expected version is invalid.");
  const current = await prisma.decisionRecord.findFirst({ where: { id: params.decisionId, workspaceId: params.workspaceId, archivedAt: { not: null } } });
  invariant(current, 404, "NOT_FOUND", "Decision not found.");
  invariant(actor.kind === "agent" || membership?.role === "ADMIN" || current.createdByUserId === actor.user.id,
    403, "FORBIDDEN", "Only the decision author or a workspace admin can restore it.");
  const updated = await prisma.decisionRecord.updateMany({
    where: { id: params.decisionId, workspaceId: params.workspaceId, archivedAt: { not: null }, version: params.expectedVersion },
    data: { archivedAt: null, version: { increment: 1 } },
  });
  if (updated.count === 0) throw new AppError(409, "VERSION_CONFLICT", "Decision changed. Reload and try again.");
}
