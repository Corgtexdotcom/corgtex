import type { BrainArticleAuthority, BrainArticleType, Constitution, ConstitutionSourceReference, PolicyCorpus, BrainArticle } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { privacyFilter } from "./privacy";
import { DigestReadRelease, loadReadableDigestQuery } from "./digest-lineage";


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
  policyTake?: number;
  policyCursor?: string;
  policyScope?: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const release = new DigestReadRelease(actor, params.workspaceId);
  const brainArticleTake = params.brainArticleTake ?? 20;
  const constitutionVersionTake = params.constitutionVersionTake ?? 8;

  const policyTake = params.policyTake ?? 50;
  const policyScope = params.policyScope ?? "all";
  invariant(Number.isSafeInteger(policyTake) && policyTake > 0 && policyTake <= 100
    && policyScope.length > 0 && policyScope.length <= 256, 400, "INVALID_INPUT", "Invalid policy window.");
  let policyAfter: { id: string; acceptedAt: Date } | undefined;
  if (params.policyCursor !== undefined) {
    try {
      invariant(params.policyCursor.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(params.policyCursor), 400, "INVALID_INPUT", "Invalid policy cursor.");
      const value = JSON.parse(Buffer.from(params.policyCursor, "base64url").toString("utf8"));
      invariant(value?.purpose === "agreements-policy-v1" && value.workspaceId === params.workspaceId && value.scope === policyScope
        && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256
        && typeof value.acceptedAt === "string" && Number.isFinite(Date.parse(value.acceptedAt)),
      400, "INVALID_INPUT", "Invalid policy cursor.");
      policyAfter = { id: value.id, acceptedAt: new Date(value.acceptedAt) };
    } catch { invariant(false, 400, "INVALID_INPUT", "Invalid policy cursor."); }
  }

  const constitutionRows = await loadReadableDigestQuery<Constitution & {sourceReferences?: ConstitutionSourceReference[]}>({
    actor, workspaceId: params.workspaceId, release, kind: "Constitution", keyset: true,
    limit: Math.max(1, constitutionVersionTake),
    loadBatch: ({ take, after }) => prisma.constitution.findMany({
      where: { workspaceId: params.workspaceId, ...(after ? { OR: [
        { version: { lt: after.version } }, { version: after.version, id: { lt: after.id } },
      ] } : {}) },
      orderBy: [{ version: "desc" }, { id: "desc" }], take,
    }),
  });
  const currentConstitution = constitutionRows[0] ?? null;
  const constitutionVersions = constitutionRows.slice(0, Math.max(0, constitutionVersionTake)).map(({sourceReferences: _references, ...row}) => row);
  const loadPolicyWindow = async () => {
    type Policy = PolicyCorpus & { circle: { id: string; name: string; [key: string]: unknown } | null };
    const records: Policy[] = [];
    let after = policyAfter;
    let examined = 0;
    let complete = false;
    while (records.length < policyTake && examined < 200) {
      const rows = await prisma.policyCorpus.findMany({
        where: { workspaceId: params.workspaceId,
          ...(policyScope === "all" ? {} : {circleId: policyScope === "workspace" ? null : policyScope}),
          ...(after ? { OR: [{acceptedAt: {lt: after.acceptedAt}}, {acceptedAt: after.acceptedAt, id: {lt: after.id}}] } : {}),
        }, include: {circle: true}, orderBy: [{acceptedAt: "desc"}, {id: "desc"}], take: 100,
      });
      invariant(rows.length <= 100, 409, "SOURCE_CHANGED", "Policy page exceeded its bound.");
      let previous = after;
      for (const row of rows) {
        invariant(!previous || row.acceptedAt < previous.acceptedAt
          || (row.acceptedAt.getTime() === previous.acceptedAt.getTime() && row.id < previous.id),
        409, "SOURCE_CHANGED", "Policy history changed during pagination.");
        previous = row;
      }
      examined += rows.length;
      if (!rows.length) { complete = true; break; }
      const captured = await release.capture("PolicyCorpus", rows);
      const selected = captured.records.slice(0, policyTake - records.length);
      records.push(...selected);
      const lastIndex = records.length === policyTake && selected.length
        ? rows.findIndex(row => row.id === selected[selected.length - 1].id) : rows.length - 1;
      after = {id: rows[lastIndex].id, acceptedAt: rows[lastIndex].acceptedAt};
      complete = rows.length < 100 && lastIndex === rows.length - 1;
      if (complete) break;
    }
    return { records, complete, nextCursor: complete || !after ? null : Buffer.from(JSON.stringify({
      purpose: "agreements-policy-v1", workspaceId: params.workspaceId, scope: policyScope,
      id: after.id, acceptedAt: after.acceptedAt.toISOString(),
    })).toString("base64url") };
  };
  const [policyPage, brainArticles] = await Promise.all([
    loadPolicyWindow(),
    loadReadableDigestQuery<BrainArticle & { ownerMember: { id: string; user: { id: string; displayName: string | null; email: string }; [key: string]: unknown } | null }>({
      actor, workspaceId: params.workspaceId, release, kind: "BrainArticle", keyset: true, limit: Math.max(0, brainArticleTake),
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

  const policyCorpus = policyPage.records;
  const circles = await release.capture("Circle", policyCorpus.flatMap(row => row.circle ? [row.circle] : []));
  const circleIdsReadable = new Set(circles.records.map(row => row.id));
  const owners = await release.capture("Member", brainArticles.flatMap(row => row.ownerMember ? [{id: row.ownerMember.id, userId: row.ownerMember.user.id,
    user: {id: row.ownerMember.user.id, email: row.ownerMember.user.email, displayName: row.ownerMember.user.displayName}}] : []));
  const ownerIdsReadable = new Set(owners.records.map(row => row.id));
  const references: ConstitutionSourceReference[] = [];
  if (currentConstitution) {
    let afterId: string | undefined;
    while (true) {
      const page = await prisma.constitutionSourceReference.findMany({where: {workspaceId: params.workspaceId, constitutionId: currentConstitution.id,
        ...(afterId ? {id: {gt: afterId}} : {})}, orderBy: {id: "asc"}, take: 100});
      references.push(...(await release.capture("ConstitutionSourceReference", page)).records);
      if (page.length < 100) break;
      afterId = page.at(-1)!.id;
    }
    references.sort((a,b) => a.pointOrder-b.pointOrder || a.sourceOrder-b.sourceOrder || a.id.localeCompare(b.id));
  }
  const ownerUsers = await release.capture("User", owners.records.map(row => row.user));
  const ownerUserIdsReadable = new Set(ownerUsers.records.map(user => user.id));
  const proposalIds = [...new Set([
    ...policyCorpus.map((policy) => policy.proposalId),
    ...references.flatMap((reference) => reference.sourceKind === "PROPOSAL" && reference.proposalId ? [reference.proposalId] : []),
  ])];
  const tensionIds = [...new Set(references.flatMap((reference) => reference.sourceKind === "TENSION" && reference.tensionId ? [reference.tensionId] : []))];
  const visibleProposalTitles = new Map<string, string>();
  const visibleTensionTitles = new Map<string, string>();
  for (let offset = 0; offset < proposalIds.length; offset += 100) {
    const rows = await prisma.proposal.findMany({where: {id: {in: proposalIds.slice(offset,offset+100)},
      workspaceId: params.workspaceId, archivedAt: null, publishedAt: {not: null}, isPrivate: false, ...privacyFilter(actor, membership)}});
    for (const row of (await release.capture("Proposal", rows)).records) visibleProposalTitles.set(row.id, row.title);
  }
  for (let offset = 0; offset < tensionIds.length; offset += 100) {
    const rows = await prisma.tension.findMany({where: {id: {in: tensionIds.slice(offset,offset+100)},
      workspaceId: params.workspaceId, archivedAt: null, publishedAt: {not: null}, isPrivate: false, ...privacyFilter(actor, membership)}});
    for (const row of (await release.capture("Tension", rows)).records) visibleTensionTitles.set(row.id, row.title);
  }
  const visibleSourceOrders = new Map<number, number>();
  const visibleReferences = references.flatMap((reference) => {
    const targetId = reference.sourceKind === "PROPOSAL" ? reference.proposalId : reference.tensionId;
    const title = reference.sourceKind === "PROPOSAL"
      ? visibleProposalTitles.get(targetId ?? "")
      : visibleTensionTitles.get(targetId ?? "");
    if (!targetId || !title?.trim()) return [];
    const sourceOrder = (visibleSourceOrders.get(reference.pointOrder) ?? 0) + 1;
    visibleSourceOrders.set(reference.pointOrder, sourceOrder);
    return [{
      pointOrder: reference.pointOrder,
      sourceOrder,
      sourceKind: reference.sourceKind,
      targetId,
      title,
    }];
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
    ownerMember: row.ownerMember && ownerIdsReadable.has(row.ownerMember.id) && ownerUserIdsReadable.has(row.ownerMember.user.id)
      ? { user: { displayName: row.ownerMember.user.displayName, email: row.ownerMember.user.email } } : null,
  }));

  return release.finish({
    currentConstitution: currentConstitution ? { ...currentConstitution, sourceReferences: visibleReferences } : null,
    constitutionVersions,
    policyCorpus: visiblePolicies,
    policyWindow: {complete: policyPage.complete, nextCursor: policyPage.nextCursor, continued: Boolean(params.policyCursor)},
    brainArticles: visibleBrainArticles,
    counts: {
      constitutionVersions: constitutionVersions.length,
      policies: visiblePolicies.length,
      brainArticles: visibleBrainArticles.length,
    },
  });
}
