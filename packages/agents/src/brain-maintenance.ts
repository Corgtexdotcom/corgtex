import { Prisma, type BrainArticle } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { markThreadAbsorbed, captureImmutableArtifactInputProof,
  captureReadableDigestInputs, mergeArtifactInputProofs, invariant, type LineageRoot, type LineageKind } from "@corgtex/domain";
import {isArtifactInputProofReadableAtObservedHeads, captureArtifactReadHeadObservation} from "../../domain/src/source-lineage";
import { lookupMaintenanceWikiReference, maintenanceRefCouldNameTarget, referencesInMaintenanceBody } from "../../domain/src/brain-maintenance-links";
import type { MaintenanceBatchReport, MaintenanceState, MaintenanceRelationScan } from "./brain-maintenance-state";

const DAY = 24 * 60 * 60 * 1000;
const REFERENCE_BATCH = 25;
const TARGET_OBSERVATIONS = 8;

type PreparedMaintenanceBatch = {
  report: MaintenanceBatchReport;
  lineageRoots: LineageRoot[];
  next: MaintenanceState;
  /** Called only by the claimed workflow's final transaction, before completion. */
  assertCurrent(): Promise<void>;
  apply(tx: Prisma.TransactionClient): Promise<void>;
};

/** Prepare one bounded observation. Workflow cursors are deliberately separate
 * from report/receipt data. A page is not a workspace-wide maintenance total. */
export async function runBrainMaintenance(params: {
  workspaceId: string;
  actor: AppActor;
  state: MaintenanceState;
}): Promise<PreparedMaintenanceBatch> {
  const {workspaceId, actor} = params;
  const next = structuredClone(params.state);
  const observedAt = new Date(next.admittedAt);
  const report: MaintenanceBatchReport = {scope: "BATCH", phase: next.phase,
    observation: "Current admitted records in this batch; not a workspace total", status: "OBSERVED"};
  let roots: LineageRoot[] = [];
  const heads = new Map<string, string>();
  const mergeHeads = (entries: Array<[string, string]>) => {
    for (const [key, stamp] of entries) {
      invariant(!heads.has(key) || heads.get(key) === stamp, 409, "SOURCE_CHANGED", "Maintenance source head changed.");
      heads.set(key, stamp);
    }
  };
  const admit = async <T extends {id: string}>(kind: LineageKind, records: T[]) => {
    const observation = await captureArtifactReadHeadObservation(() => captureReadableDigestInputs({actor, workspaceId, kind, records}));
    mergeHeads([...observation.heads]);
    return {...observation.value, heads: [...observation.heads]};
  };
  const current = async (original: LineageRoot[], observed: Array<[string, string]>, tx?: Prisma.TransactionClient) => {
    mergeHeads(observed);
    return isArtifactInputProofReadableAtObservedHeads(actor, workspaceId, original, new Map(observed), tx);
  };
  const retain = (proof: LineageRoot[]) => { roots = mergeArtifactInputProofs(roots, proof); };
  const upserts: Array<{fromArticleId: string; toArticleId: string}> = [];
  const deletes: string[] = [];
  const absorptions: Array<{id: string; roots: LineageRoot[]}> = [];
  const retention: string[] = [];
  let retentionRoots: LineageRoot[] = [];
  const remainingIds = next.selectedIds.slice(next.index);

  const mergeHeadEntries = (left: Array<[string, string]>, right: Array<[string, string]>) => {
    const union = new Map(left);
    for (const [key, stamp] of right) {
      invariant(!union.has(key) || union.get(key) === stamp, 409, "SOURCE_CHANGED", "Relationship lineage head changed.");
      union.set(key, stamp);
    }
    return [...union];
  };
  const scanRelation = async (source: BrainArticle, target: BrainArticle, scan: MaintenanceRelationScan, budget: number) => {
    let work = 0;
    if (budget <= 0) return {done: false, found: false, work};
    const page = referencesInMaintenanceBody(source.bodyMd, scan.refOffset, REFERENCE_BATCH);
    work++;
    for (const item of page.refs) {
      if (!maintenanceRefCouldNameTarget(item.ref, target)) { scan.refOffset = item.nextOffset; continue; }
      if (work >= budget) return {done: false, found: false, work};
      let result = await lookupMaintenanceWikiReference(actor, workspaceId, item.ref, scan.lookup); work++;
      while (result.next && work < budget) { result = await lookupMaintenanceWikiReference(actor, workspaceId, item.ref, result.next); work++; }
      if (result.next) { scan.lookup = result.next; scan.refOffset = item.offset; return {done: false, found: false, work}; }
      delete scan.lookup; scan.refOffset = item.nextOffset;
      scan.original = mergeArtifactInputProofs(scan.original, result.roots);
      scan.heads = mergeHeadEntries(scan.heads, result.heads);
      if (result.target?.id === target.id) return {done: true, found: true, work};
    }
    return {done: !page.more, found: false, work};
  };

  if (next.phase === "LINKS") {
    report.staleArticleCount = 0; report.unresolvedReferenceCount = 0;
    report.unresolvedReferences = []; report.backlinksWritten = 0; report.obsoleteBacklinksRemoved = 0;
    let observations = 0;
    while (next.index < next.selectedIds.length && observations < TARGET_OBSERVATIONS) {
      const id = next.selectedIds[next.index];
      if (next.source) invariant(next.source.id === id && await current(next.source.original, next.source.heads),
        409, "SOURCE_CHANGED", "The original article observation changed; restart this cohort.");
      const article = await prisma.brainArticle.findFirst({where: {id, workspaceId, archivedAt: null}});
      if (!article) { next.index++; delete next.source; continue; }
      if (!next.source) {
        const admitted = await admit("BrainArticle", [article]);
        if (!admitted.records.length) { next.index++; continue; }
        next.source = {id, original: admitted.roots, heads: admitted.heads, refOffset: 0, stage: "REFERENCES"};
        if (observedAt.getTime() - (article.lastVerifiedAt ?? article.createdAt).getTime() > article.staleAfterDays * DAY) report.staleArticleCount++;
      }
      invariant(next.source.id === id && await current(next.source.original, next.source.heads),
        409, "SOURCE_CHANGED", "The article changed during its maintenance observation; restart this cohort.");
      retain(next.source.original);
      if (next.source.stage === "REFERENCES") {
        const page = referencesInMaintenanceBody(article.bodyMd, next.source.refOffset, REFERENCE_BATCH);
        let paused = false;
        for (const item of page.refs) {
          let result = await lookupMaintenanceWikiReference(actor, workspaceId, item.ref, next.source.lookup);
          observations++;
          while (result.next && observations < TARGET_OBSERVATIONS) {
            result = await lookupMaintenanceWikiReference(actor, workspaceId, item.ref, result.next);
            observations++;
          }
          if (result.next) {
            next.source.lookup = result.next;
            next.source.refOffset = item.offset;
            paused = true; break;
          }
          delete next.source.lookup;
          next.source.refOffset = item.nextOffset;
          if (result.target) {
            retain(result.roots); mergeHeads(result.heads);
            if (result.target.id !== id) upserts.push({fromArticleId: id, toArticleId: result.target.id});
          } else {
            report.unresolvedReferenceCount++;
            if (report.unresolvedReferences.length < 20) report.unresolvedReferences.push({articleSlug: article.slug, reference: item.ref});
          }
          if (observations >= TARGET_OBSERVATIONS) { paused = true; break; }
        }
        if (paused || page.more) break;
        next.source.stage = "CLEANUP";
      }
      if (next.source.stage === "CLEANUP") {
        const edge = next.source.edge;
        if (edge) invariant(await current(edge.original, edge.heads), 409, "SOURCE_CHANGED", "Original backlink inputs changed.");
        const row = edge ? {id: edge.edgeId, toArticleId: edge.otherId} : await prisma.brainBacklink.findFirst({where: {workspaceId, fromArticleId: id,
          ...(next.source.edgeAfterId ? {id: {gt: next.source.edgeAfterId}} : {})}, orderBy: {id: "asc"}});
        observations++;
        if (!row) { next.index++; delete next.source; continue; }
        const target = await prisma.brainArticle.findFirst({where: {workspaceId, id: row.toArticleId, archivedAt: null}});
        if (!target) { next.source.edgeAfterId = row.id; delete next.source.edge; continue; }
        if (!next.source.edge) {
          const admitted = await admit("BrainArticle", [target]);
          if (!admitted.records.length) { next.source.edgeAfterId = row.id; continue; }
          next.source.edge = {edgeId: row.id, otherId: target.id, original: admitted.roots, heads: admitted.heads, refOffset: 0};
        }
        const scan = next.source.edge;
        const result = await scanRelation(article, target, scan, TARGET_OBSERVATIONS - observations);
        observations += result.work;
        retain(scan.original); mergeHeads(scan.heads);
        if (!result.done) break;
        if (!result.found) deletes.push(row.id);
        next.source.edgeAfterId = row.id; delete next.source.edge;
      }
    }
    report.backlinksWritten = new Set(upserts.map(edge => `${edge.fromArticleId}:${edge.toArticleId}`)).size;
    report.obsoleteBacklinksRemoved = deletes.length;
  } else if (next.phase === "ORPHANS") {
    report.orphanCount = 0; report.orphans = [];
    let observations = 0;
    while (next.index < next.selectedIds.length && observations < TARGET_OBSERVATIONS) {
      const id = next.selectedIds[next.index];
      if (next.orphan) invariant(next.orphan.id === id && await current(next.orphan.original, next.orphan.heads),
        409, "SOURCE_CHANGED", "Original incoming relationship observation changed.");
      const target = await prisma.brainArticle.findFirst({where: {id, workspaceId, archivedAt: null}});
      if (!target) { next.index++; delete next.orphan; continue; }
      if (!next.orphan) {
        const admitted = await admit("BrainArticle", [target]);
        if (!admitted.records.length) { next.index++; continue; }
        next.orphan = {id, original: admitted.roots, heads: admitted.heads};
      }
      const progress = next.orphan;
      const edge = progress.edge;
      if (edge) invariant(await current(edge.original, edge.heads), 409, "SOURCE_CHANGED", "Original incoming source changed.");
      const row = edge ? {id: edge.edgeId, fromArticleId: edge.otherId} : await prisma.brainBacklink.findFirst({where: {workspaceId, toArticleId: id,
        ...(progress.edgeAfterId ? {id: {gt: progress.edgeAfterId}} : {})}, orderBy: {id: "asc"}});
      observations++;
      if (!row) {
        retain(progress.original); mergeHeads(progress.heads);
        report.orphanCount++; if (report.orphans.length < 20) report.orphans.push(target.slug);
        next.index++; delete next.orphan; continue;
      }
      const source = await prisma.brainArticle.findFirst({where: {workspaceId, id: row.fromArticleId, archivedAt: null}});
      if (!source || source.id === id) { progress.edgeAfterId = row.id; delete progress.edge; continue; }
      if (!progress.edge) {
        const admitted = await admit("BrainArticle", [source]);
        if (!admitted.records.length) { progress.edgeAfterId = row.id; continue; }
        progress.edge = {edgeId: row.id, otherId: source.id, original: admitted.roots, heads: admitted.heads, refOffset: 0};
      }
      const result = await scanRelation(source, target, progress.edge, TARGET_OBSERVATIONS - observations);
      observations += result.work;
      progress.original = mergeArtifactInputProofs(progress.original, progress.edge.original);
      progress.heads = mergeHeadEntries(progress.heads, progress.edge.heads);
      retain(progress.original); mergeHeads(progress.heads);
      if (!result.done) break;
      if (result.found) { next.index++; delete next.orphan; continue; }
      progress.edgeAfterId = row.id; delete progress.edge;
    }
  } else if (next.phase === "SOURCES") {
    const candidates = await prisma.brainSource.findMany({where: {workspaceId, id: {in: remainingIds}, tier: 3,
      createdAt: {lt: new Date(observedAt.getTime() - 180 * DAY)}}, take: remainingIds.length});
    const admitted = await admit("BrainSource", candidates);
    retain(admitted.roots);
    report.tier3CleanupCandidates = admitted.records.length;
    next.index = next.selectedIds.length;
  } else if (next.phase === "DISCUSSIONS") {
    report.staleThreadCount = 0; report.absorbedThreadCount = 0;
    for (const id of remainingIds) {
      if (next.comment) invariant(next.comment.threadId === id && await current(next.comment.original, next.comment.heads),
        409, "SOURCE_CHANGED", "Original discussion observation changed.");
      const thread = await prisma.brainDiscussionThread.findFirst({where: {id, article: {workspaceId}, status: {in: ["OPEN", "RESOLVED"]}}});
      if (!thread) { next.index++; delete next.comment; continue; }
      const admitted = next.comment ? {records: [thread], roots: next.comment.original, heads: next.comment.heads} : await admit("BrainDiscussionThread", [thread]);
      if (!admitted.records.length) { next.index++; continue; }
      const proof = admitted.roots;
      invariant(!next.comment || next.comment.threadId === id, 409, "SOURCE_CHANGED", "Discussion continuation changed.");
      invariant(await current(proof, admitted.heads), 409, "SOURCE_CHANGED", "Discussion changed during maintenance.");
      retain(proof);
      if (thread.status === "RESOLVED") {
        // Absorbing a resolved thread changes status, not comment content.
        absorptions.push({id, roots: proof}); report.absorbedThreadCount++;
      } else {
        const after = next.comment;
        const comments = await prisma.brainDiscussionComment.findMany({where: {threadId: id,
          ...(after ? {OR: [{createdAt: {lt: new Date(after.afterCreatedAt)}}, {createdAt: new Date(after.afterCreatedAt), id: {lt: after.afterId}}]} : {})},
        orderBy: [{createdAt: "desc"}, {id: "desc"}], take: 100});
        const commentInputs = await admit("BrainDiscussionComment", comments);
        const latest = commentInputs.records[0];
        if (latest) retain(commentInputs.proofs.get(latest.id)!);
        else if (comments.length === 100) {
          const last = comments[comments.length - 1];
          next.comment = {threadId: id, original: proof, heads: admitted.heads, afterCreatedAt: last.createdAt.toISOString(), afterId: last.id};
          break;
        }
        if ((latest?.createdAt ?? thread.createdAt).getTime() < observedAt.getTime() - 30 * DAY) report.staleThreadCount++;
      }
      next.index++; delete next.comment;
    }
  } else if (next.phase === "RETENTION") {
    const candidates = await prisma.knowledgeChunk.findMany({where: {workspaceId, id: {in: remainingIds}, sourceType: "EVENT",
      createdAt: {lt: new Date(observedAt.getTime() - 15 * DAY)}}, take: remainingIds.length});
    const admitted = await admit("KnowledgeChunk", candidates);
    retentionRoots = admitted.roots;
    retention.push(...admitted.records.map(row => row.id));
    // Deletion revokes the chunk's serving receipt. Publish operation status,
    // never a Workspace-only count or copy of deleted source content.
    report.status = "RETAINED_UNSUPPORTED_CUSTODY";
    report.observation = "Event retention is withheld until event source custody is supported; originals are retained.";
    next.index = next.selectedIds.length;
  }

  const assertProof = async (proof: LineageRoot[], tx?: Prisma.TransactionClient) => {
    if (proof.length) invariant(await isArtifactInputProofReadableAtObservedHeads(actor, workspaceId, proof, heads, tx),
      409, "SOURCE_CHANGED", "Original maintenance input heads changed.");
  };
  return {report, lineageRoots: roots, next, assertCurrent: () => assertProof(mergeArtifactInputProofs(roots, retentionRoots)), apply: async tx => {
    const all = mergeArtifactInputProofs(roots, retentionRoots);
    if (all.length) await assertProof(all, tx);
    // Observation-only batches already have the runtime's frozen input receipt.
    // Keep the original head/epoch fence above in this claimed final transaction,
    // but do not recapture and discard a second snapshot when nothing is mutated.
    if (!upserts.length && !deletes.length && !absorptions.length && !retention.length) return;
    if (all.length) await captureImmutableArtifactInputProof(actor, workspaceId, all, tx);
    if (upserts.length) await tx.brainBacklink.createMany({data: upserts.map(edge => ({workspaceId, ...edge})), skipDuplicates: true});
    if (deletes.length) await tx.brainBacklink.deleteMany({where: {workspaceId, id: {in: deletes}}});
    for (const thread of absorptions) await markThreadAbsorbed(actor, {workspaceId, threadId: thread.id, expectedInputRoots: thread.roots, tx});
    if (retention.length) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "KnowledgeChunk" WHERE "workspaceId" = ${workspaceId} AND id IN (${Prisma.join(retention)}) FOR UPDATE`);
      await assertProof(retentionRoots, tx);
      await tx.knowledgeChunk.deleteMany({where: {workspaceId, id: {in: retention}, sourceType: "EVENT", createdAt: {lt: new Date(observedAt.getTime() - 15 * DAY)}}});
    }
    const stable = roots.filter(root => !absorptions.some(thread => root.kind === "BrainDiscussionThread" && root.id === thread.id));
    await assertProof(stable, tx);
  }};
}
