import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

const CONSTITUTION_VERSION_RETRY_LIMIT = 3;

function isConstitutionVersionConflict(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const prismaError = error as {
    code?: string;
    meta?: {
      target?: string[] | string;
    };
  };

  if (prismaError.code !== "P2002") {
    return false;
  }

  const target = prismaError.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("workspaceId") && target.includes("version");
  }

  return typeof target !== "string" || target.includes("workspaceId") || target.includes("version");
}

export async function listConstitutionVersions(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  skip?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;

  const [items, total] = await Promise.all([
    prisma.constitution.findMany({
      where: { workspaceId },
      orderBy: { version: "desc" },
      take,
      skip,
    }),
    prisma.constitution.count({ where: { workspaceId } }),
  ]);

  return { items, total, take, skip };
}

export async function getCurrentConstitution(workspaceId: string) {
  return prisma.constitution.findFirst({
    where: { workspaceId },
    orderBy: { version: "desc" },
  });
}

export async function createConstitutionVersion(params: {
  workspaceId: string;
  bodyMd: string;
  diffSummary?: string | null;
  triggerType?: string | null;
  triggerRef?: string | null;
  modelUsed: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
}) {
  for (let attempt = 0; attempt < CONSTITUTION_VERSION_RETRY_LIMIT; attempt += 1) {
    const latest = await getCurrentConstitution(params.workspaceId);
    const nextVersion = (latest?.version ?? 0) + 1;

    try {
      return await prisma.constitution.create({
        data: {
          workspaceId: params.workspaceId,
          version: nextVersion,
          bodyMd: params.bodyMd,
          diffSummary: params.diffSummary ?? null,
          triggerType: params.triggerType ?? null,
          triggerRef: params.triggerRef ?? null,
          modelUsed: params.modelUsed,
          promptTokens: params.promptTokens ?? null,
          completionTokens: params.completionTokens ?? null,
        },
      });
    } catch (error) {
      if (attempt === CONSTITUTION_VERSION_RETRY_LIMIT - 1 || !isConstitutionVersionConflict(error)) {
        throw error;
      }
    }
  }

  throw new Error("Failed to create constitution version.");
}

export async function listPolicyCorpus(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.policyCorpus.findMany({
    where: { workspaceId },
    include: {
      proposal: {
        select: { id: true, title: true, status: true },
      },
      circle: {
        select: { id: true, name: true },
      },
    },
    orderBy: { acceptedAt: "desc" },
  });
}

export async function getApprovalPolicies(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.approvalPolicy.findMany({
    where: { workspaceId },
    orderBy: { subjectType: "asc" },
  });
}

export async function updateApprovalPolicy(actor: AppActor, params: {
  workspaceId: string;
  subjectType: string;
  mode?: string;
  quorumPercent?: number;
  minApproverCount?: number;
  decisionWindowHours?: number;
  requireProposalLink?: boolean;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  const policy = await prisma.approvalPolicy.findUnique({
    where: {
      workspaceId_subjectType: {
        workspaceId: params.workspaceId,
        subjectType: params.subjectType,
      },
    },
  });
  invariant(policy, 404, "NOT_FOUND", "Approval policy not found.");

  const data: Record<string, unknown> = {};
  if (params.mode !== undefined) data.mode = params.mode;
  if (params.quorumPercent !== undefined) data.quorumPercent = params.quorumPercent;
  if (params.minApproverCount !== undefined) data.minApproverCount = params.minApproverCount;
  if (params.decisionWindowHours !== undefined) data.decisionWindowHours = params.decisionWindowHours;
  if (params.requireProposalLink !== undefined) data.requireProposalLink = params.requireProposalLink;

  return prisma.approvalPolicy.update({
    where: { id: policy.id },
    data,
  });
}
