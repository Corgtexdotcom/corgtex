import { DigestReadRelease, requireWorkspaceMembership } from "@corgtex/domain";
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
  let afterId: string | undefined;
  for (;;) {
    const candidates = await prisma.brainArticle.findMany({
      where: { AND: [
        { workspaceId: params.workspaceId, archivedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) },
        { OR: brainArticleVisibility(params.actor, params.membership) },
      ] },
      orderBy: { id: "asc" }, take: 100,
    });
    const nextId = candidates.at(-1)?.id;
    const captured = await release.capture("BrainArticle", candidates);
    for (const article of captured.records) counts.set(article.type, (counts.get(article.type) ?? 0) + 1);
    if (candidates.length < 100) break;
    if (nextId === afterId) throw new Error("Brain article count cursor did not advance");
    afterId = nextId;
  }
  return release.finish([...counts].map(([type, count]) => ({ type, count })));
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
