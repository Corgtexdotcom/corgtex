import type { BrainArticleAuthority, BrainArticleType, Constitution, ConstitutionSourceReference, PolicyCorpus, BrainArticle } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { privacyFilter } from "./privacy";
import { loadReadableDigestQuery } from "./digest-lineage";
import { readableArtifactIds } from "./source-lineage";

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

  const constitutionalInclude = { sourceReferences: { orderBy: [{ pointOrder: "asc" as const }, { sourceOrder: "asc" as const }] } };
  const constitutionRows = await loadReadableDigestQuery<Constitution & { sourceReferences: ConstitutionSourceReference[] }>({
    actor, workspaceId: params.workspaceId, kind: "Constitution", keyset: true,
    limit: Math.max(1, constitutionVersionTake),
    loadBatch: ({ take, after }) => prisma.constitution.findMany({
      where: { workspaceId: params.workspaceId, ...(after ? { OR: [
        { version: { lt: after.version } }, { version: after.version, id: { lt: after.id } },
      ] } : {}) },
      include: constitutionalInclude, orderBy: [{ version: "desc" }, { id: "desc" }], take,
    }),
  });
  const currentConstitution = constitutionRows[0] ?? null;
  const constitutionVersions = constitutionRows.slice(0, Math.max(0, constitutionVersionTake)).map(({ sourceReferences: _references, ...row }) => row);
  const [policyCorpus, brainArticles] = await Promise.all([
    loadReadableDigestQuery<PolicyCorpus & { circle: { id: string; name: string; [key: string]: unknown } | null }>({
      actor, workspaceId: params.workspaceId, kind: "PolicyCorpus", keyset: true, limit: 100, completeScan: true,
      loadBatch: ({ take, after }) => prisma.policyCorpus.findMany({
        where: { workspaceId: params.workspaceId, ...(after ? { OR: [
          { acceptedAt: { lt: after.acceptedAt } }, { acceptedAt: after.acceptedAt, id: { lt: after.id } },
        ] } : {}) },
        include: { circle: true },
        orderBy: [{ acceptedAt: "desc" }, { id: "desc" }], take,
      }),
    }),
    loadReadableDigestQuery<BrainArticle & { ownerMember: { id: string; user: { displayName: string | null; email: string }; [key: string]: unknown } | null }>({
      actor, workspaceId: params.workspaceId, kind: "BrainArticle", keyset: true, limit: Math.max(0, brainArticleTake),
      loadBatch: ({ take, after }) => prisma.brainArticle.findMany({
        where: { workspaceId: params.workspaceId, archivedAt: null, isPrivate: false,
          authority: { in: [...AGREEMENT_BRAIN_ARTICLE_AUTHORITIES] }, type: { in: [...AGREEMENT_BRAIN_ARTICLE_TYPES] },
          ...(after ? { OR: [
            { authority: { in: [...AGREEMENT_BRAIN_ARTICLE_AUTHORITIES].slice(AGREEMENT_BRAIN_ARTICLE_AUTHORITIES.indexOf(after.authority as typeof AGREEMENT_BRAIN_ARTICLE_AUTHORITIES[number]) + 1) } },
            { authority: after.authority, updatedAt: { lt: after.updatedAt } },
            { authority: after.authority, updatedAt: after.updatedAt, id: { lt: after.id } },
          ] } : {}),
        },
        include: { ownerMember: { include: { user: true } } },
        orderBy: [{ authority: "asc" }, { updatedAt: "desc" }, { id: "desc" }], take,
      }),
    }),
  ]);

  const [circleIdsReadable, ownerIdsReadable] = await Promise.all([
    readableArtifactIds(actor, params.workspaceId, "Circle", policyCorpus.flatMap((row) => row.circle ? [row.circle] : [])),
    readableArtifactIds(actor, params.workspaceId, "Member", brainArticles.flatMap((row) => row.ownerMember ? [row.ownerMember] : [])),
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
    }) : [],
    tensionIds.length ? prisma.tension.findMany({
      where: { id: { in: tensionIds }, workspaceId: params.workspaceId, archivedAt: null, publishedAt: { not: null }, isPrivate: false, ...privacyFilter(actor, membership) },
    }) : [],
  ]);
  const [proposalIdsReadable, tensionIdsReadable] = await Promise.all([
    readableArtifactIds(actor, params.workspaceId, "Proposal", visibleProposals),
    readableArtifactIds(actor, params.workspaceId, "Tension", visibleTensions),
  ]);
  const visibleProposalTitles = new Map(visibleProposals.filter((row) => proposalIdsReadable.has(row.id)).map((proposal) => [proposal.id, proposal.title]));
  const visibleTensionTitles = new Map(visibleTensions.filter((row) => tensionIdsReadable.has(row.id)).map((tension) => [tension.id, tension.title]));
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
  const visiblePolicies = policyCorpus.map((policy) => {
    const proposalTitle = visibleProposalTitles.get(policy.proposalId);
    return {
      id: policy.id, title: policy.title, bodyMd: policy.bodyMd, acceptedAt: policy.acceptedAt,
      circle: policy.circle && circleIdsReadable.has(policy.circle.id) ? { id: policy.circle.id, name: policy.circle.name } : null,
      proposal: proposalTitle?.trim() ? { id: policy.proposalId, title: proposalTitle } : null,
    };
  });
  const visibleBrainArticles = brainArticles.map((row) => ({
    id: row.id, slug: row.slug, title: row.title, type: row.type, authority: row.authority,
    bodyMd: row.bodyMd, frontmatterJson: row.frontmatterJson, updatedAt: row.updatedAt, lastVerifiedAt: row.lastVerifiedAt,
    ownerMember: row.ownerMember && ownerIdsReadable.has(row.ownerMember.id)
      ? { user: { displayName: row.ownerMember.user.displayName, email: row.ownerMember.user.email } } : null,
  }));

  return {
    currentConstitution: currentConstitution ? { ...currentConstitution, sourceReferences: visibleReferences } : null,
    constitutionVersions,
    policyCorpus: visiblePolicies,
    brainArticles: visibleBrainArticles,
    counts: {
      constitutionVersions: constitutionVersions.length,
      policies: visiblePolicies.length,
      brainArticles: visibleBrainArticles.length,
    },
  };
}
