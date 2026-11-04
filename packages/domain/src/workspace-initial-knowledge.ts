import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { DigestReadRelease, captureReadableDigestInputs } from "./digest-lineage";
import { sealArtifactInputActor } from "./source-lineage";
import { invariant } from "./errors";
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

/** A bounded existence observation for the ordinary shell. Incomplete discovery
 * is unknown, never evidence that onboarding is required. */
export async function getWorkspaceInitialKnowledgeSummary(actor: AppActor, workspaceId: string) {
  sealArtifactInputActor(actor);
  await requireWorkspaceMembership({ actor, workspaceId });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const release = new DigestReadRelease(actor, workspaceId);
  const families: Array<{ kind: "Document" | "BrainSource" | "Meeting";
    load: (afterId: string | undefined, take: number) => Promise<Array<{ id: string }>> }> = [
    { kind: "Document", load: (afterId, take) => prisma.document.findMany({
      where: { workspaceId, archivedAt: null, accessDomain: { in: domains }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: "asc" }, take }) },
    { kind: "BrainSource", load: (afterId, take) => prisma.brainSource.findMany({
      where: { workspaceId, archivedAt: null, accessDomain: { in: domains },
        sourceType: { in: ["FILE_UPLOAD", "DOC", "ARTICLE", "MEETING", "EXTERNAL_CONTENT"] },
        ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take }) },
    { kind: "Meeting", load: (afterId, take) => prisma.meeting.findMany({
      where: { workspaceId, archivedAt: null, OR: [{ transcript: { not: null } }, { summaryMd: { not: null } }],
        ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take }) },
  ];
  let examined = 0;
  for (const family of families) {
    let afterId: string | undefined;
    for (;;) {
      if (examined === 200) return release.finish({ found: false, complete: false });
      const take = Math.min(100, 200 - examined);
      const page = await release.observeRead(async () => {
        const rows = await family.load(afterId, take);
        invariant(rows.length <= take && rows.every(row => !afterId || row.id > afterId),
          503, "SOURCE_READ_SCAN_CHANGED", "Initial knowledge page changed; retry.");
        const admitted = await captureReadableDigestInputs({ actor, workspaceId, kind: family.kind, records: rows });
        return { rows, admitted };
      });
      examined += page.rows.length;
      const first = page.admitted.records[0];
      if (first) {
        release.add(page.admitted.proofs.get(first.id)!);
        return release.finish({ found: true, complete: true });
      }
      if (page.rows.length < take) break;
      afterId = page.rows.at(-1)!.id;
    }
  }
  return release.finish({ found: false, complete: true });
}
