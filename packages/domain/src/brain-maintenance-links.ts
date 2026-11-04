import { Prisma, type BrainArticle } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { captureArtifactReadHeadObservation, type LineageRoot } from "./source-lineage";
import {captureReadableDigestInputs} from "./digest-lineage";

const MAINTENANCE_TARGET_PAGE = 100;
export type WikiLookupCursor = { priority: 0 | 1 | 2 | 3; afterId?: string };
export type WikiLookupResult = {
  target: BrainArticle | null;
  roots: LineageRoot[];
  next: WikiLookupCursor | null;
  heads: Array<[string, string]>;
};
function maintenanceWikiSlug(ref: string) {
  return ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

/** One bounded candidate observation. A denied candidate cannot crowd out the
 * next permitted match. Slugs use the unique key; title/alias matches are exact
 * predicates, not a claim that those fields have an index. */
export async function lookupMaintenanceWikiReference(actor: AppActor, workspaceId: string, ref: string,
  cursor: WikiLookupCursor = {priority: 0}): Promise<WikiLookupResult> {
  const where = {workspaceId, archivedAt: null, ...(cursor.afterId ? {id: {gt: cursor.afterId}} : {})};
  const ids = cursor.priority === 3 ? await prisma.$queryRaw<Array<{id: string}>>(Prisma.sql`
    SELECT article.id FROM "BrainArticle" article
    WHERE article."workspaceId" = ${workspaceId} AND article."archivedAt" IS NULL
      ${cursor.afterId ? Prisma.sql`AND article.id > ${cursor.afterId}` : Prisma.empty}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(article."frontmatterJson"->'also') = 'array'
          THEN article."frontmatterJson"->'also' ELSE '[]'::jsonb END) alias(value)
        WHERE jsonb_typeof(alias.value) = 'string' AND lower(alias.value #>> '{}') = lower(${ref})
      )
    ORDER BY article.id ASC LIMIT ${MAINTENANCE_TARGET_PAGE}
  `) : null;
  const candidates = await prisma.brainArticle.findMany({where: {
    ...where,
    ...(cursor.priority === 0 ? {slug: maintenanceWikiSlug(ref)}
      : cursor.priority === 1 ? {slug: ref}
        : cursor.priority === 2 ? {title: {equals: ref, mode: "insensitive" as const}}
          : {id: {in: ids!.map(row => row.id)}}),
  }, orderBy: {id: "asc"}, take: cursor.priority < 2 ? 1 : MAINTENANCE_TARGET_PAGE});
  for (const candidate of candidates) {
    const observed = await captureArtifactReadHeadObservation(() => captureReadableDigestInputs({actor, workspaceId, kind: "BrainArticle", records: [candidate]}));
    if (observed.value.records.length) return {target: candidate, roots: observed.value.roots, heads: [...observed.heads], next: null};
  }
  const scanned = ids ?? candidates;
  if (cursor.priority >= 2 && scanned.length === MAINTENANCE_TARGET_PAGE) {
    return {target: null, roots: [], heads: [], next: {...cursor, afterId: scanned[scanned.length - 1].id}};
  }
  return {target: null, roots: [], heads: [], next: cursor.priority < 3 ? {priority: (cursor.priority + 1) as 1 | 2 | 3} : null};
}

export function referencesInMaintenanceBody(body: string, after = 0, take = 25) {
  const pattern = /\[\[([^\]]+)\]\]/g;
  pattern.lastIndex = after;
  const refs: Array<{ref: string; offset: number; nextOffset: number}> = [];
  let match: RegExpExecArray | null;
  while (refs.length <= take && (match = pattern.exec(body))) {
    refs.push({ref: match[1].trim(), offset: match.index, nextOffset: pattern.lastIndex});
  }
  return {refs: refs.slice(0, take), more: refs.length > take};
}

/** A cheap conservative filter before exact priority resolution. Never use it
 * alone to delete an ambiguous existing edge. */
export function maintenanceRefCouldNameTarget(ref: string, target: BrainArticle) {
  if ([ref, maintenanceWikiSlug(ref)].includes(target.slug) || ref.toLowerCase() === target.title.toLowerCase()) return true;
  const metadata = target.frontmatterJson;
  const aliases = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.also : null;
  return Array.isArray(aliases) && aliases.some(alias => typeof alias === "string" && alias.toLowerCase() === ref.toLowerCase());
}
