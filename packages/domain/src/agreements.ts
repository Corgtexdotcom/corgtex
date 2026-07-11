import type { BrainArticleAuthority, BrainArticleType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";

export const AGREEMENT_BRAIN_ARTICLE_TYPES = [
  "DECISION",
  "PROCESS",
  "CULTURE",
  "STRATEGY",
] as const satisfies readonly BrainArticleType[];

export const AGREEMENT_BRAIN_ARTICLE_AUTHORITIES = [
  "AUTHORITATIVE",
  "REFERENCE",
] as const satisfies readonly BrainArticleAuthority[];

export async function listWorkspaceAgreements(actor: AppActor, params: {
  workspaceId: string;
  brainArticleTake?: number;
  constitutionVersionTake?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const brainArticleTake = params.brainArticleTake ?? 20;
  const constitutionVersionTake = params.constitutionVersionTake ?? 8;

  const [
    currentConstitution,
    constitutionVersions,
    policyCorpus,
    brainArticles,
  ] = await Promise.all([
    prisma.constitution.findFirst({
      where: { workspaceId: params.workspaceId },
      orderBy: { version: "desc" },
    }),
    prisma.constitution.findMany({
      where: { workspaceId: params.workspaceId },
      orderBy: { version: "desc" },
      take: constitutionVersionTake,
    }),
    prisma.policyCorpus.findMany({
      where: { workspaceId: params.workspaceId },
      include: {
        proposal: {
          select: { id: true, title: true, status: true },
        },
        circle: {
          select: { id: true, name: true },
        },
      },
      orderBy: { acceptedAt: "desc" },
    }),
    prisma.brainArticle.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isPrivate: false,
        authority: { in: [...AGREEMENT_BRAIN_ARTICLE_AUTHORITIES] },
        type: { in: [...AGREEMENT_BRAIN_ARTICLE_TYPES] },
      },
      select: {
        id: true,
        slug: true,
        title: true,
        type: true,
        authority: true,
        bodyMd: true,
        updatedAt: true,
        lastVerifiedAt: true,
        ownerMember: {
          select: {
            user: {
              select: { displayName: true, email: true },
            },
          },
        },
      },
      orderBy: [
        { authority: "asc" },
        { updatedAt: "desc" },
      ],
      take: brainArticleTake,
    }),
  ]);

  return {
    currentConstitution,
    constitutionVersions,
    policyCorpus,
    brainArticles,
    counts: {
      constitutionVersions: constitutionVersions.length,
      policies: policyCorpus.length,
      brainArticles: brainArticles.length,
    },
  };
}
