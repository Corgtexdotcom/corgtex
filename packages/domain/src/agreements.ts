import type { BrainArticleAuthority, BrainArticleType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { privacyFilter } from "./privacy";

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
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

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
      include: { sourceReferences: { orderBy: [{ pointOrder: "asc" }, { sourceOrder: "asc" }] } },
    }),
    prisma.constitution.findMany({
      where: { workspaceId: params.workspaceId },
      orderBy: { version: "desc" },
      take: constitutionVersionTake,
    }),
    prisma.policyCorpus.findMany({
      where: { workspaceId: params.workspaceId },
      select: {
        id: true,
        title: true,
        bodyMd: true,
        acceptedAt: true,
        proposalId: true,
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
        frontmatterJson: true,
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

  const references = currentConstitution?.sourceReferences ?? [];
  const proposalIds = [...new Set([
    ...policyCorpus.map((policy) => policy.proposalId),
    ...references.flatMap((reference) => reference.sourceKind === "PROPOSAL" && reference.proposalId ? [reference.proposalId] : []),
  ])];
  const tensionIds = [...new Set(references.flatMap((reference) => reference.sourceKind === "TENSION" && reference.tensionId ? [reference.tensionId] : []))];
  const [visibleProposals, visibleTensions] = await Promise.all([
    proposalIds.length ? prisma.proposal.findMany({
      where: { id: { in: proposalIds }, workspaceId: params.workspaceId, archivedAt: null, publishedAt: { not: null }, isPrivate: false, ...privacyFilter(actor, membership) },
      select: { id: true, title: true },
    }) : [],
    tensionIds.length ? prisma.tension.findMany({
      where: { id: { in: tensionIds }, workspaceId: params.workspaceId, archivedAt: null, publishedAt: { not: null }, isPrivate: false, ...privacyFilter(actor, membership) },
      select: { id: true, title: true },
    }) : [],
  ]);
  const visibleProposalTitles = new Map(visibleProposals.map((proposal) => [proposal.id, proposal.title]));
  const visibleTensionTitles = new Map(visibleTensions.map((tension) => [tension.id, tension.title]));
  const visibleReferences = references.flatMap((reference) => {
    const targetId = reference.sourceKind === "PROPOSAL" ? reference.proposalId : reference.tensionId;
    const title = reference.sourceKind === "PROPOSAL"
      ? visibleProposalTitles.get(targetId ?? "")
      : visibleTensionTitles.get(targetId ?? "");
    return targetId && title?.trim() ? [{
      pointOrder: reference.pointOrder,
      sourceOrder: reference.sourceOrder,
      sourceKind: reference.sourceKind,
      targetId,
      title,
    }] : [];
  });
  const visiblePolicies = policyCorpus.map(({ proposalId, ...policy }) => {
    const proposalTitle = visibleProposalTitles.get(proposalId);
    return {
      ...policy,
      proposal: proposalTitle?.trim() ? { id: proposalId, title: proposalTitle } : null,
    };
  });

  return {
    currentConstitution: currentConstitution ? { ...currentConstitution, sourceReferences: visibleReferences } : null,
    constitutionVersions,
    policyCorpus: visiblePolicies,
    brainArticles,
    counts: {
      constitutionVersions: constitutionVersions.length,
      policies: visiblePolicies.length,
      brainArticles: brainArticles.length,
    },
  };
}
