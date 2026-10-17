import { DigestReadRelease, requireWorkspaceMembership, resolveKnowledgeAccessDomains } from "@corgtex/domain";
import { prisma, type AppActor } from "@corgtex/shared";

type CountParams = {
  workspaceId: string;
  actor: AppActor;
  membership: { id?: string | null; role?: string | null } | null | undefined;
};

export async function listBrainArticleTypeCounts(params: CountParams) {
  await requireWorkspaceMembership({ actor: params.actor, workspaceId: params.workspaceId });
  const release = new DigestReadRelease(params.actor, params.workspaceId);
  const counts = new Map<string, number>();
  // One enumeration snapshot; permission admission remains bounded to100 rows.
  const candidates = await prisma.brainArticle.findMany({
    where: { AND: [
      { workspaceId: params.workspaceId, archivedAt: null },
      { OR: brainArticleVisibility(params.actor, params.membership) },
    ] },
    orderBy: { id: "asc" }, take: 200,
  });
  const complete = candidates.length < 200;
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const captured = await release.captureBrainArticlePage(candidates.slice(offset, offset + 100));
    for (const article of captured) counts.set(article.type, (counts.get(article.type) ?? 0) + 1);
  }
  return release.finish({counts:[...counts].map(([type, count]) => ({ type, count })),complete});
}

/** Page-only pending total; the explicit domain status API retains its exact contract. */
export async function listBrainPendingSourceCount(params: CountParams) {
  await requireWorkspaceMembership({actor:params.actor,workspaceId:params.workspaceId});
  const accessDomains = await resolveKnowledgeAccessDomains(params.actor,params.workspaceId);
  const release = new DigestReadRelease(params.actor,params.workspaceId);
  const candidates = await prisma.brainSource.findMany({where:{workspaceId:params.workspaceId,accessDomain:{in:accessDomains},
    archivedAt:null,absorbedAt:null},orderBy:{id:"asc"},take:200});
  const complete = candidates.length < 200;
  let count = 0;
  for (let offset = 0; offset < candidates.length; offset += 100) {
    count += (await release.capture("BrainSource", candidates.slice(offset, offset + 100))).records.length;
  }
  return release.finish({count,complete});
}

export function brainArticleVisibility(
  actor: AppActor,
  membership: { id?: string | null; role?: string | null } | null | undefined,
) {
  if (actor.kind === "agent" || membership?.role === "ADMIN") {
    return [{ isPrivate: false }, { isPrivate: true, authority: "DRAFT" as const }];
  }

  if (actor.kind === "user" && membership?.id) {
    return [{ isPrivate: false }, { isPrivate: true, ownerMemberId: membership.id }];
  }

  return [{ isPrivate: false }];
}
