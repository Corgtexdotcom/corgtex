import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

const MEMBER_ALIAS_SOURCE_MANUAL = "MANUAL";

const memberWithUserInclude = {
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.MemberInclude;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeOptionalText(value?: string | null) {
  return value?.trim() || null;
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

async function writeMemberEmailAlias(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  memberId: string;
  email: string;
  source: string;
  createdByUserId: string | null;
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
  invariant(!primaryMember, 409, "ALIAS_EMAIL_CONFLICT", "Alias email belongs to another workspace member.");
  invariant(!existingAlias || existingAlias.memberId === params.memberId, 409, "ALIAS_EMAIL_CONFLICT", "Alias email is already assigned to another workspace member.");

  return tx.memberEmailAlias.upsert({
    where: {
      workspaceId_email: {
        workspaceId: params.workspaceId,
        email,
      },
    },
    update: {
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

export function __memberMergeTestOnly() {
  return {
    MEMBER_ALIAS_SOURCE_MANUAL,
    normalizeEmail,
  };
}
