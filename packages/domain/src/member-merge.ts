import type { MemberRole, Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";

const MEMBER_ALIAS_SOURCE_MANUAL = "MANUAL";
const MEMBER_ALIAS_SOURCE_MERGE = "MERGE";

const memberWithUserInclude = {
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.MemberInclude;

const memberMergeInclude = {
  ...memberWithUserInclude,
  emailAliases: {
    select: {
      email: true,
      source: true,
    },
  },
} satisfies Prisma.MemberInclude;

type MemberWithUser = Prisma.MemberGetPayload<{ include: typeof memberWithUserInclude }>;
type MergeMemberRecord = Prisma.MemberGetPayload<{ include: typeof memberMergeInclude }>;

export type MemberMergeResult = {
  sourceMemberId: string;
  targetMemberId: string;
  targetMember: MemberWithUser;
  aliasEmails: string[];
  rewired: Record<string, number>;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeOptionalText(value?: string | null) {
  return value?.trim() || null;
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function strongestRole(left: MemberRole, right: MemberRole): MemberRole {
  return left === "ADMIN" || right === "ADMIN" ? "ADMIN" : "CONTRIBUTOR";
}

function uniqueNormalizedEmails(emails: Array<string | null | undefined>) {
  return [...new Set(emails.map((email) => normalizeEmail(email ?? "")).filter(Boolean))];
}

async function writeMemberEmailAlias(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  memberId: string;
  email: string;
  source: string;
  createdByUserId: string | null;
  allowedPrimaryMemberIds?: Set<string>;
  allowedAliasMemberIds?: Set<string>;
}) {
  const email = normalizeEmail(params.email);
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");

  const [member, primaryMember, existingAlias] = await Promise.all([
    tx.member.findUnique({
      where: { id: params.memberId },
      select: { id: true, workspaceId: true, user: { select: { email: true } } },
    }),
    tx.member.findFirst({
      where: {
        workspaceId: params.workspaceId,
        user: { email },
      },
      select: { id: true },
    }),
    tx.memberEmailAlias.findUnique({
      where: {
        workspaceId_email: {
          workspaceId: params.workspaceId,
          email,
        },
      },
      select: { id: true, memberId: true },
    }),
  ]);
  invariant(member && member.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found.");

  if (normalizeEmail(member.user.email) === email) {
    return null;
  }

  const allowedPrimaryMemberIds = params.allowedPrimaryMemberIds ?? new Set([params.memberId]);
  if (primaryMember && !allowedPrimaryMemberIds.has(primaryMember.id)) {
    throw new AppError(409, "ALIAS_EMAIL_CONFLICT", "Alias email belongs to another workspace member.");
  }

  const allowedAliasMemberIds = params.allowedAliasMemberIds ?? new Set([params.memberId]);
  if (existingAlias && !allowedAliasMemberIds.has(existingAlias.memberId)) {
    throw new AppError(409, "ALIAS_EMAIL_CONFLICT", "Alias email is already assigned to another workspace member.");
  }

  return tx.memberEmailAlias.upsert({
    where: {
      workspaceId_email: {
        workspaceId: params.workspaceId,
        email,
      },
    },
    update: {
      memberId: params.memberId,
      source: params.source,
    },
    create: {
      workspaceId: params.workspaceId,
      memberId: params.memberId,
      email,
      source: params.source,
      createdByUserId: params.createdByUserId,
    },
  });
}

export async function addMemberEmailAlias(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  email: string;
  source?: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const alias = await prisma.$transaction((tx) => writeMemberEmailAlias(tx, {
    workspaceId: params.workspaceId,
    memberId: params.memberId,
    email: params.email,
    source: normalizeOptionalText(params.source) ?? MEMBER_ALIAS_SOURCE_MANUAL,
    createdByUserId: actorUserId(actor),
  }));
  invariant(alias, 400, "INVALID_INPUT", "Alias email must differ from the member primary email.");
  return alias;
}

export async function resolveWorkspaceMemberByEmail(params: {
  workspaceId: string;
  email: string;
  includeInactive?: boolean;
}) {
  const email = normalizeEmail(params.email);
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");

  const alias = await prisma.memberEmailAlias.findUnique({
    where: {
      workspaceId_email: {
        workspaceId: params.workspaceId,
        email,
      },
    },
    include: {
      member: {
        include: memberWithUserInclude,
      },
    },
  });
  if (alias?.member && (params.includeInactive || alias.member.isActive)) {
    return alias.member;
  }

  return prisma.member.findFirst({
    where: {
      workspaceId: params.workspaceId,
      ...(params.includeInactive ? {} : { isActive: true }),
      user: { email },
    },
    include: memberWithUserInclude,
  });
}

async function findConflictingSingleKeyRows(tx: Prisma.TransactionClient, params: {
  model: "approvalDecision" | "memberExpertise";
  sourceMemberId: string;
  targetMemberId: string;
  key: "flowId" | "expertiseTagId";
}) {
  const model = tx[params.model] as any;
  const sourceRows = await model.findMany({
    where: { memberId: params.sourceMemberId },
    select: { [params.key]: true },
  });
  const sourceKeys = sourceRows.map((row: Record<string, string>) => row[params.key]).filter(Boolean);
  if (sourceKeys.length === 0) return [];

  const targetRows = await model.findMany({
    where: {
      memberId: params.targetMemberId,
      [params.key]: { in: sourceKeys },
    },
    select: { [params.key]: true },
  });
  return targetRows.map((row: Record<string, string>) => row[params.key]);
}

async function findConflictingImpactFootprints(tx: Prisma.TransactionClient, sourceMemberId: string, targetMemberId: string) {
  const sourceRows = await tx.impactFootprint.findMany({
    where: { memberId: sourceMemberId },
    select: {
      periodStart: true,
      periodEnd: true,
    },
  });
  if (sourceRows.length === 0) return [];

  return tx.impactFootprint.findMany({
    where: {
      memberId: targetMemberId,
      OR: sourceRows.map((row) => ({
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
      })),
    },
    select: {
      periodStart: true,
      periodEnd: true,
    },
  });
}

async function assertNoBlockingMergeConflicts(tx: Prisma.TransactionClient, sourceMemberId: string, targetMemberId: string) {
  const [approvalDecisionConflicts, expertiseConflicts, impactFootprintConflicts] = await Promise.all([
    findConflictingSingleKeyRows(tx, {
      model: "approvalDecision",
      sourceMemberId,
      targetMemberId,
      key: "flowId",
    }),
    findConflictingSingleKeyRows(tx, {
      model: "memberExpertise",
      sourceMemberId,
      targetMemberId,
      key: "expertiseTagId",
    }),
    findConflictingImpactFootprints(tx, sourceMemberId, targetMemberId),
  ]);

  const conflicts = [
    approvalDecisionConflicts.length > 0 ? "approval decisions" : null,
    expertiseConflicts.length > 0 ? "member expertise" : null,
    impactFootprintConflicts.length > 0 ? "impact footprints" : null,
  ].filter(Boolean);
  if (conflicts.length > 0) {
    throw new AppError(409, "MEMBER_MERGE_CONFLICT", `Merge would conflict with existing ${conflicts.join(", ")} records.`);
  }
}

async function deleteDuplicateLinks(tx: Prisma.TransactionClient, params: {
  model: "roleAssignment" | "adviceRequestRecipient";
  sourceMemberId: string;
  targetMemberId: string;
  key: "roleId" | "requestId";
}) {
  const model = tx[params.model] as any;
  const sourceRows = await model.findMany({
    where: { memberId: params.sourceMemberId },
    select: { [params.key]: true },
  });
  const sourceKeys = sourceRows.map((row: Record<string, string>) => row[params.key]).filter(Boolean);
  if (sourceKeys.length === 0) return 0;

  const targetRows = await model.findMany({
    where: {
      memberId: params.targetMemberId,
      [params.key]: { in: sourceKeys },
    },
    select: { [params.key]: true },
  });
  const duplicateKeys = targetRows.map((row: Record<string, string>) => row[params.key]).filter(Boolean);
  if (duplicateKeys.length === 0) return 0;

  const result = await model.deleteMany({
    where: {
      memberId: params.sourceMemberId,
      [params.key]: { in: duplicateKeys },
    },
  });
  return result.count ?? 0;
}

async function rewireMemberField(tx: Prisma.TransactionClient, rewired: Record<string, number>, params: {
  model: string;
  field: string;
  sourceMemberId: string;
  targetMemberId: string;
}) {
  const result = await (tx as any)[params.model].updateMany({
    where: { [params.field]: params.sourceMemberId },
    data: { [params.field]: params.targetMemberId },
  });
  const count = result.count ?? 0;
  if (count > 0) {
    rewired[`${params.model}.${params.field}`] = count;
  }
}

async function rewireMemberRelations(tx: Prisma.TransactionClient, sourceMemberId: string, targetMemberId: string) {
  const rewired: Record<string, number> = {};

  const roleDuplicates = await deleteDuplicateLinks(tx, {
    model: "roleAssignment",
    sourceMemberId,
    targetMemberId,
    key: "roleId",
  });
  if (roleDuplicates > 0) rewired["roleAssignment.duplicatesDeleted"] = roleDuplicates;

  const adviceRecipientDuplicates = await deleteDuplicateLinks(tx, {
    model: "adviceRequestRecipient",
    sourceMemberId,
    targetMemberId,
    key: "requestId",
  });
  if (adviceRecipientDuplicates > 0) rewired["adviceRequestRecipient.duplicatesDeleted"] = adviceRecipientDuplicates;

  const steps = [
    ["communicationExternalUser", "memberId"],
    ["memberInviteRequest", "requesterMemberId"],
    ["memberInviteRequest", "deciderMemberId"],
    ["checkIn", "memberId"],
    ["roleHolderHistory", "memberId"],
    ["roleAssignment", "memberId"],
    ["roleOnboardingSession", "memberId"],
    ["action", "assigneeMemberId"],
    ["tension", "assigneeMemberId"],
    ["tension", "raisedByMemberId"],
    ["proposal", "ownerMemberId"],
    ["deliberationEntry", "targetMemberId"],
    ["approvalDecision", "memberId"],
    ["newspaperDelivery", "memberId"],
    ["brainArticle", "ownerMemberId"],
    ["brainSource", "authorMemberId"],
    ["brainDiscussionThread", "authorMemberId"],
    ["brainDiscussionComment", "authorMemberId"],
    ["goal", "ownerMemberId"],
    ["goalUpdate", "authorMemberId"],
    ["adviceProcess", "authorMemberId"],
    ["adviceProcess", "ownerMemberId"],
    ["adviceRequestRecipient", "memberId"],
    ["impactFootprint", "memberId"],
    ["memberExpertise", "memberId"],
    ["recognition", "recipientMemberId"],
    ["recognition", "authorMemberId"],
    ["selfServeSupportSession", "supportMemberId"],
    ["selfServeSupportSession", "targetMemberId"],
  ] as const;

  for (const [model, field] of steps) {
    await rewireMemberField(tx, rewired, { model, field, sourceMemberId, targetMemberId });
  }

  return rewired;
}

function mergeAliasEmails(source: MergeMemberRecord, target: MergeMemberRecord, extraAliasEmails?: string[]) {
  return uniqueNormalizedEmails([
    source.user.email,
    ...source.emailAliases.map((alias) => alias.email),
    ...(extraAliasEmails ?? []),
  ]).filter((email) => email !== normalizeEmail(target.user.email));
}

export async function mergeWorkspaceMembers(actor: AppActor, params: {
  workspaceId: string;
  sourceMemberId: string;
  targetMemberId: string;
  aliasEmails?: string[];
  reason?: string | null;
}): Promise<MemberMergeResult> {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  if (params.sourceMemberId === params.targetMemberId) {
    throw new AppError(400, "INVALID_INPUT", "Choose two different members to merge.");
  }

  return prisma.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.member.findUnique({
        where: { id: params.sourceMemberId },
        include: memberMergeInclude,
      }),
      tx.member.findUnique({
        where: { id: params.targetMemberId },
        include: memberMergeInclude,
      }),
    ]);
    invariant(source && source.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Source member not found.");
    invariant(target && target.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Target member not found.");
    invariant(!source.mergedIntoMemberId, 400, "INVALID_STATE", "Source member has already been merged.");
    invariant(!target.mergedIntoMemberId && target.isActive, 400, "INVALID_STATE", "Target member must be active and unmerged.");
    invariant(source.kind === target.kind, 400, "INVALID_INPUT", "Source and target member kinds must match.");

    await assertNoBlockingMergeConflicts(tx, source.id, target.id);

    const createdByUserId = actorUserId(actor);
    const aliasEmails = mergeAliasEmails(source, target, params.aliasEmails);
    for (const email of aliasEmails) {
      await writeMemberEmailAlias(tx, {
        workspaceId: params.workspaceId,
        memberId: target.id,
        email,
        source: MEMBER_ALIAS_SOURCE_MERGE,
        createdByUserId,
        allowedPrimaryMemberIds: new Set([source.id, target.id]),
        allowedAliasMemberIds: new Set([source.id, target.id]),
      });
    }

    const rewired = await rewireMemberRelations(tx, source.id, target.id);
    const mergedAt = new Date();
    const targetMember = await tx.member.update({
      where: { id: target.id },
      data: {
        role: strongestRole(source.role, target.role),
        ...(target.newspaperCadence === null && source.newspaperCadence !== null
          ? { newspaperCadence: source.newspaperCadence }
          : {}),
      },
      include: memberWithUserInclude,
    });
    await tx.member.update({
      where: { id: source.id },
      data: {
        isActive: false,
        mergedIntoMemberId: target.id,
        mergedAt,
        mergedByUserId: createdByUserId,
        mergeReason: normalizeOptionalText(params.reason),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: createdByUserId,
        action: "member.merged",
        entityType: "Member",
        entityId: target.id,
        meta: {
          sourceMemberId: source.id,
          targetMemberId: target.id,
          aliasEmails,
          rewired,
        },
      },
    });
    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "member.merged",
        aggregateType: "Member",
        aggregateId: target.id,
        payload: {
          sourceMemberId: source.id,
          targetMemberId: target.id,
          aliasEmails,
          rewired,
        },
      },
    ]);

    return {
      sourceMemberId: source.id,
      targetMemberId: target.id,
      targetMember,
      aliasEmails,
      rewired,
    };
  });
}

export function __memberMergeTestOnly() {
  return {
    MEMBER_ALIAS_SOURCE_MANUAL,
    MEMBER_ALIAS_SOURCE_MERGE,
    normalizeEmail,
  };
}
