import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { hasSourceReadableRecord } from "./source-scoped-read";

/** Source existence is an admitted-content observation, never a raw tenant count. */
export async function hasWorkspaceInitialKnowledgeSource(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  if (await hasSourceReadableRecord({ actor, workspaceId, kind: "Document", load: (afterId, take) =>
    prisma.document.findMany({ where: { workspaceId, archivedAt: null, accessDomain: { in: domains },
      ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take }) })) return true;
  if (await hasSourceReadableRecord({ actor, workspaceId, kind: "BrainSource", load: (afterId, take) =>
    prisma.brainSource.findMany({ where: { workspaceId, archivedAt: null, accessDomain: { in: domains },
      sourceType: { in: ["FILE_UPLOAD", "DOC", "ARTICLE", "MEETING", "EXTERNAL_CONTENT"] },
      ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take }) })) return true;
  return hasSourceReadableRecord({ actor, workspaceId, kind: "Meeting", load: (afterId, take) =>
    prisma.meeting.findMany({ where: { workspaceId, archivedAt: null,
      OR: [{ transcript: { not: null } }, { summaryMd: { not: null } }],
      ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take }) });
}
