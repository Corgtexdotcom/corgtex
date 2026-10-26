import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { advanceHumanArtifactInputLineage, captureArtifactInputProof, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
import { GRAPH_SOURCE_VARIANT_JOB_TYPE, generateGraphSourceVariant, getReadableGraphSourceVariants,
  requestGraphSourceVariant, revalidateGraphSourceVariants, type GraphVariantCandidate } from "./derived-artifact-variants";
import type { PermittedDerivationSource } from "./permitted-derivation-inputs";
import { applyContextGraphProposedDiff, createContextGraphProposedDiff, getContextMapData, listContextGraphProposedDiffs,
  reviewContextGraphProposedDiff } from "./context-graph";

// Exclusive disposable local database only; no gateway, provider, customer or external fixtures.
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic graph variants", slug: `graph-variants-${randomUUID()}` } });
  const foreign = await prisma.workspace.create({ data: { name: "Synthetic foreign workspace", slug: `graph-foreign-${randomUUID()}` } });
  const owner = await prisma.user.create({ data: { email: `graph-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `graph-reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  const readerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
  await prisma.member.create({ data: { workspaceId: foreign.id, userId: reader.id, role: "ADMIN" } });
  const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: null, globalRole: "USER" } };
  const readerActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: null, globalRole: "USER" } };
  const document = await prisma.document.create({ data: { workspaceId: workspace.id, title: "Public native original document", source: "SYNTHETIC",
    storageKey: "DO NOT PROMPT STORAGE KEY", textContent: "The product team owns onboarding.",
    metadata: { internal: "DO NOT PROMPT METADATA" } } });
  const privateArticle = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: "private-original", title: "PRIVATE ARTICLE TITLE CANARY",
    bodyMd: "PRIVATE ARTICLE BODY CANARY", type: "STRATEGY", authority: "DRAFT", isPrivate: true, ownerMemberId: ownerMember.id } });
  for (const [kind, row] of [["Document", document], ["BrainArticle", privateArticle]] as const) {
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
      artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  }
  const inputs = [{ kind: "Document" as const, id: document.id }, { kind: "BrainArticle" as const, id: privateArticle.id }];
  const targets = await prisma.$transaction(async tx => {
    const roots = await captureArtifactInputProof(ownerActor, workspace.id, inputs, tx);
    const rows = [];
    for (const label of ["cohort A", "cohort B"]) {
      const row = await tx.contextGraphObject.create({ data: { workspaceId: workspace.id, objectType: "Team", title: `PRIVATE CANONICAL ${label} CANARY`,
        summary: "PRIVATE CANONICAL SUMMARY CANARY", status: "approved", properties: { oldApproval: "PRIVATE CANONICAL PROPERTY CANARY" },
        createdByType: "agent", createdByUserId: owner.id } });
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id, artifact: { kind: "ContextGraphObject", id: row.id },
        content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots }); rows.push(row);
    }
    return rows;
  });
  const request = { workspaceId: workspace.id, target: { kind: "ContextGraphObject" as const, id: targets[0].id },
    scope: { kind: "default" as const, mapKey: "critical-path" as const } };
  return { workspace, foreign, owner, reader, ownerMember, readerMember, ownerActor, readerActor, document, privateArticle, targets, request };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function candidate(sources: PermittedDerivationSource[]): GraphVariantCandidate {
  expect(sources).toHaveLength(1); expect(sources[0].kind).toBe("Document");
  expect(JSON.stringify(sources)).not.toMatch(/PRIVATE|DO NOT PROMPT/);
  return { objects: [{ ref: "team", objectType: "Team", title: "Product team" }, { ref: "process", objectType: "Process", title: "Onboarding" }],
    relationships: [{ ref: "owns", sourceRef: "team", targetRef: "process", relationshipType: "owns" }],
    evidenceRefs: [{ relationshipRef: "owns", sourceKind: "Document", sourceId: sources[0].id, quote: "product team owns onboarding" }],
    reason: "Fresh proposal from permitted public facts." };
}
async function claim(f: Fixture) {
  const requested = await requestGraphSourceVariant(f.readerActor, f.request);
  if (requested.status !== "QUEUED") throw new Error(`Expected queued recipe: ${JSON.stringify(requested)}`);
  await prisma.workflowJob.update({ where: { id: requested.jobId }, data: { status: "RUNNING", attempts: 1, lockedBy: "synthetic-worker" } });
  return { workspaceId: f.workspace.id, jobId: requested.jobId, expectedAttempt: 1, expectedOwner: "synthetic-worker" };
}
async function generate(f: Fixture) {
  const lease = await claim(f); const model = vi.fn(async (sources: PermittedDerivationSource[]) => candidate(sources));
  const result = await generateGraphSourceVariant({ ...lease, generate: model });
  if (result.phase !== "APPLIED" || !result.variantId) throw new Error(`Expected applied recipe: ${JSON.stringify(result)}`);
  const variant = await prisma.genericDerivedArtifactVariant.findUniqueOrThrow({ where: { id: result.variantId } });
  return { lease, variant, model };
}
async function updateOriginalDocument(f: Fixture, data: { accessDomain?: "WORKSPACE" | "FINANCE"; archivedAt?: Date | null }) {
  return prisma.$transaction(async tx => {
    const before = await tx.document.findUniqueOrThrow({ where: { id: f.document.id } });
    const after = await tx.document.update({ where: { id: f.document.id }, data });
    // A direct human permission/state edit advances proven original authorship, never certifies unknown/copy ancestry.
    await advanceHumanArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
      artifact: { kind: "Document", id: after.id }, before, after });
    return after;
  });
}
describe("mixed-source private graph bundles with real SQL receipts", () => {
  beforeEach(async () => { await truncateAllTables(); });
  it("regenerates whole coherent owner view from public Document while preserving approved broad originals", async () => {
    const f = await fixture(); const original = await prisma.contextGraphObject.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { id: "asc" } });
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "ContextGraphObject", f.targets)).size).toBe(0);
    expect((await readableArtifactIds(f.ownerActor, f.workspace.id, "ContextGraphObject", f.targets)).size).toBe(2);
    const { variant, model } = await generate(f); expect(model).toHaveBeenCalledTimes(1);
    const visible = await getReadableGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, scope: f.request.scope });
    expect(visible).toHaveLength(1); expect(visible[0].targets.map(target => target.id).sort()).toEqual(f.targets.map(row => row.id).sort());
    expect(JSON.stringify(visible[0].bundle)).not.toContain("PRIVATE");
    expect(visible[0].bundle.relationships[0]).toMatchObject({ sourceObjectId: visible[0].bundle.objects[0].id,
      targetObjectId: visible[0].bundle.objects[1].id, status: "proposed" });
    expect(visible[0].bundle.evidenceRefs[0].relationshipId).toBe(visible[0].bundle.relationships[0].id);
    expect(visible[0].bundle.proposedDiff.status).toBe("pending");
    expect((await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "GenericDerivedArtifactVariant", artifactId: variant.id } })).origin).toBe("DERIVED");
    expect(await prisma.contextGraphObject.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { id: "asc" } })).toEqual(original);
    expect((await requestGraphSourceVariant(f.readerActor, { ...f.request, target: { kind: "ContextGraphObject", id: f.targets[1].id } })).status).toBe("READY");
    expect(await prisma.genericDerivedArtifactVariant.count()).toBe(1);
  });
  it("discovers the latest matching cohort beyond 5,001 unrelated historical revisions", async () => {
    const f = await fixture();
    const old = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId: f.workspace.id,
      artifactType: "ContextGraphObject", artifactId: f.targets[0].id}});
    await prisma.artifactInputLineage.createMany({data: [
      ...Array.from({length: 5_001}, (_, index) => ({workspaceId: f.workspace.id, artifactType: "ContextGraphObject",
        artifactId: "000-historical", revision: index + 1, origin: index === 5_000 ? "UNKNOWN" : "DERIVED",
        contentHash: old.contentHash, rootsJson: old.rootsJson!})),
      ...Array.from({length: 120}, (_, index) => ({workspaceId: f.workspace.id, artifactType: "ContextGraphObject",
        artifactId: `000-unrelated-${String(index).padStart(3, "0")}`, revision: 1, origin: "UNKNOWN", contentHash: "unrelated"})),
      {workspaceId: f.foreign.id, artifactType: "ContextGraphObject", artifactId: "foreign", revision: 9_999,
        origin: "DERIVED", contentHash: old.contentHash, rootsJson: old.rootsJson!},
    ]});
    const {variant} = await generate(f);
    const visible = await getReadableGraphSourceVariants(f.readerActor, {workspaceId: f.workspace.id, scope: f.request.scope});
    expect(visible).toHaveLength(1);
    expect(visible[0].targets.map(target => target.id).sort()).toEqual(f.targets.map(target => target.id).sort());
    expect(variant.ownerMemberId).toBe(f.readerMember.id);
  });

  it("does not grant owner-specific variants to another admin/user/workspace or a different map scope", async () => {
    const f = await fixture(); const { variant } = await generate(f);
    expect(await getReadableGraphSourceVariants(f.ownerActor, { workspaceId: f.workspace.id, scope: f.request.scope })).toEqual([]);
    expect(await revalidateGraphSourceVariants(f.ownerActor, { workspaceId: f.workspace.id, variantIds: [variant.id] })).toBe(false);
    expect(await getReadableGraphSourceVariants(f.readerActor, { workspaceId: f.foreign.id, scope: f.request.scope })).toEqual([]);
    expect(await getReadableGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, scope: { kind: "default", mapKey: "org-structure" } })).toEqual([]);
    expect((await readableArtifactIds(f.ownerActor, f.workspace.id, "GenericDerivedArtifactVariant", [variant])).size).toBe(0);
  });
  it("current native source privacy loss and restore cannot redeem old byte-identical derived output", async () => {
    const f = await fixture(); const { variant } = await generate(f);
    await updateOriginalDocument(f, { accessDomain: "FINANCE" });
    await updateOriginalDocument(f, { accessDomain: "WORKSPACE" });
    expect(await revalidateGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, variantIds: [variant.id] })).toBe(false);
    expect(await getReadableGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, scope: f.request.scope })).toEqual([]);
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "GenericDerivedArtifactVariant", [variant])).size).toBe(0);
    const fresh = await generate(f); expect(fresh.variant.id).not.toBe(variant.id);
    expect(fresh.variant.inputSetHash).not.toBe(variant.inputSetHash);
    expect(await prisma.genericDerivedArtifactVariant.count()).toBe(2);
  });
  it("archive plus restoration gets a fresh candidate and retains the older immutable variant", async () => {
    const f = await fixture(); const { variant } = await generate(f);
    const archivedAt = new Date();
    await updateOriginalDocument(f, { archivedAt });
    const history = await prisma.workspaceArchiveRecord.create({ data: { workspaceId: f.workspace.id, entityType: "Document", entityId: f.document.id,
      archivedAt, archivedByUserId: f.owner.id } });
    expect(await getReadableGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, scope: f.request.scope })).toEqual([]);
    await updateOriginalDocument(f, { archivedAt: null });
    await prisma.workspaceArchiveRecord.update({ where: { id: history.id }, data: { restoredAt: new Date(), restoredByUserId: f.owner.id } });
    expect(await revalidateGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, variantIds: [variant.id] })).toBe(false);
    const fresh = await generate(f); expect(fresh.variant.id).not.toBe(variant.id);
    expect(await prisma.genericDerivedArtifactVariant.findUnique({ where: { id: variant.id } })).not.toBeNull();
  });
  it("full body changes invalidate variant reads and regenerate from independently current original body", async () => {
    const f = await fixture(); const { variant } = await generate(f);
    const revised = await prisma.document.update({ where: { id: f.document.id }, data: { textContent: "The product team owns onboarding. Now revised." } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
      artifact: { kind: "Document", id: revised.id }, content: revised, origin: "HUMAN_ORIGINAL", inputs: [] }));
    expect(await revalidateGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, variantIds: [variant.id] })).toBe(false);
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "GenericDerivedArtifactVariant", [variant])).size).toBe(0);
    const fresh = await generate(f); expect(fresh.variant.id).not.toBe(variant.id);
  });
  it("model-time source drift or worker replacement writes no partial bundle", async () => {
    const f = await fixture(); const lease = await claim(f);
    const result = await generateGraphSourceVariant({ ...lease, generate: async sources => {
      await prisma.document.update({ where: { id: f.document.id }, data: { textContent: "Drift during the synthetic model" } });
      return candidate(sources);
    } });
    expect(result.phase).toBe("STALE"); expect(await prisma.genericDerivedArtifactVariant.count()).toBe(0);
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: lease.jobId } }); expect(job.type).toBe(GRAPH_SOURCE_VARIANT_JOB_TYPE);
    const callback = vi.fn(async (sources: PermittedDerivationSource[]) => candidate(sources));
    expect((await generateGraphSourceVariant({ ...lease, expectedAttempt: 7, generate: callback })).phase).toBe("SUPERSEDED");
    expect(callback).not.toHaveBeenCalled();
  });
  it("member departure and deletion/reinvite cannot grant an old member-specific bundle", async () => {
    const f = await fixture(); const { variant } = await generate(f);
    await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
    await expect(getReadableGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, scope: f.request.scope })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await prisma.member.delete({ where: { id: f.readerMember.id } });
    await prisma.member.create({ data: { workspaceId: f.workspace.id, userId: f.reader.id, role: "ADMIN" } });
    expect(await getReadableGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, scope: f.request.scope })).toEqual([]);
    expect(await revalidateGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, variantIds: [variant.id] })).toBe(false);
  });
  it("known original graph bodies stay original and UNKNOWN historical targets remain withheld", async () => {
    const f = await fixture(); const original = await prisma.contextGraphObject.create({ data: { workspaceId: f.workspace.id,
      objectType: "Team", title: "Fresh original human graph card", createdByUserId: f.owner.id } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
      artifact: { kind: "ContextGraphObject", id: original.id }, content: original, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const unknown = await prisma.contextGraphObject.create({ data: { workspaceId: f.workspace.id, objectType: "Team", title: "UNKNOWN OLD BODY" } });
    expect((await requestGraphSourceVariant(f.readerActor, { ...f.request, target: { kind: "ContextGraphObject", id: original.id } })).status).toBe("NOT_NEEDED");
    expect((await requestGraphSourceVariant(f.readerActor, { ...f.request, target: { kind: "ContextGraphObject", id: unknown.id } })).status).toBe("UNAVAILABLE");
    expect(await prisma.workflowJob.count({ where: { type: GRAPH_SOURCE_VARIANT_JOB_TYPE } })).toBe(0);
  });
});

describe("regenerated graph native review and publication", () => {
  beforeEach(async () => { await truncateAllTables(); });
  async function approverFixture() {
    const f = await fixture();
    await prisma.member.update({ where: { id: f.readerMember.id }, data: { role: "FACILITATOR" } });
    return f;
  }
  async function reviewedOriginal(f: Fixture, changed = false) {
    const diff = { objects: [{ ref: "a", objectType: "Team", title: changed ? "Different team" : "Product team" },
      { ref: "b", objectType: "Process", title: "Onboarding" }],
    relationships: [{ ref: "r", sourceRef: "a", targetRef: "b", relationshipType: "owns" }], evidenceRefs: [] };
    const proposal = await createContextGraphProposedDiff(f.ownerActor, { workspaceId: f.workspace.id, diff,
      lineageInputs: [{ kind: "Document", id: f.document.id }, { kind: "BrainArticle", id: f.privateArticle.id }] });
    return reviewContextGraphProposedDiff(f.ownerActor, { workspaceId: f.workspace.id, proposedDiffId: proposal.id, status: "approved" });
  }
  it("reviews and applies the actual generated proposal through ordinary APIs, retaining private materialized rows", async () => {
    const f = await approverFixture(); const { variant } = await generate(f);
    const id = (variant.payloadJson as any).proposedDiff.id;
    expect((await listContextGraphProposedDiffs(f.readerActor, { workspaceId: f.workspace.id })).some(row => row.id === id)).toBe(true);
    await reviewContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id, status: "approved" });
    const applied = await applyContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id });
    expect(applied).toMatchObject({ id, status: "applied", reviewedByUserId: f.reader.id });
    const objects = await prisma.contextGraphObject.findMany({ where: { workspaceId: f.workspace.id, id: { notIn: f.targets.map(row => row.id) } } });
    expect(objects).toHaveLength(2);
    expect(objects.every(row => row.status === "approved")).toBe(true);
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "ContextGraphObject", objects)).size).toBe(2);
    expect((await readableArtifactIds(f.ownerActor, f.workspace.id, "ContextGraphObject", objects)).size).toBe(0);
    expect(await prisma.contextGraphRelationship.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.contextGraphEvidenceRef.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    const map = await getContextMapData(f.readerActor, { workspaceId: f.workspace.id });
    expect(map.objects.map(row => row.id).sort()).toEqual(objects.map(row => row.id).sort());
    expect(map.relationships).toHaveLength(1);
    expect(map.relationships[0].evidenceRefs).toHaveLength(1);
    expect(map.proposedDiffs).toHaveLength(0);
    await expect(applyContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await updateOriginalDocument(f, { accessDomain: "FINANCE" });
    await updateOriginalDocument(f, { accessDomain: "WORKSPACE" });
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "ContextGraphObject", objects)).size).toBe(0);
    expect(await prisma.genericDerivedArtifactVariant.findUnique({ where: { id: variant.id } })).toEqual(variant);
  });
  it("denies ordinary contributors, foreign tenants, other admins and membership revoke/restore", async () => {
    const f = await fixture(); const { variant } = await generate(f); const id = (variant.payloadJson as any).proposedDiff.id;
    await expect(reviewContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id, status: "approved" })).rejects.toBeDefined();
    await expect(reviewContextGraphProposedDiff(f.ownerActor, { workspaceId: f.workspace.id, proposedDiffId: id, status: "approved" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(applyContextGraphProposedDiff(f.readerActor, { workspaceId: f.foreign.id, proposedDiffId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
    await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: true, role: "FACILITATOR" } });
    await expect(applyContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.contextGraphObject.count({ where: { workspaceId: f.workspace.id } })).toBe(f.targets.length);
  });
  it("carries the authentic reviewer for identical reviewed meaning and targets without another approval cycle", async () => {
    const f = await approverFixture(); const original = await reviewedOriginal(f);
    await applyContextGraphProposedDiff(f.ownerActor, { workspaceId: f.workspace.id, proposedDiffId: original.id });
    const { variant } = await generate(f); const id = (variant.payloadJson as any).proposedDiff.id;
    const proposal = await prisma.contextGraphProposedDiff.findUniqueOrThrow({ where: { id } });
    expect(proposal).toMatchObject({ status: "approved", reviewedByUserId: f.owner.id, reviewedAt: original.reviewedAt });
    expect(proposal.evidenceJson).toMatchObject({ approvalDisposition: "UNCHANGED_REVIEWED_MEANING" });
    const applied = await applyContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id });
    expect(applied.reviewedByUserId).toBe(f.owner.id);
  });
  it("keeps materially changed meaning pending and rejects client-forged approval metadata", async () => {
    const f = await approverFixture(); const original = await reviewedOriginal(f, true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: original.id, action: "context-graph.diff.approved" } });
    // Even copying genuine metadata to a different proposal does not copy its server review.
    await createContextGraphProposedDiff(f.ownerActor, { workspaceId: f.workspace.id,
      diff: { objects: [{ ref: "a", objectType: "Team", title: "Product team" }, { ref: "b", objectType: "Process", title: "Onboarding" }],
        relationships: [{ ref: "r", sourceRef: "a", targetRef: "b", relationshipType: "owns" }], evidenceRefs: [] },
      evidence: audit.meta as any, lineageInputs: [{ kind: "Document", id: f.document.id }, { kind: "BrainArticle", id: f.privateArticle.id }] });
    const { variant } = await generate(f);
    expect(await prisma.contextGraphProposedDiff.findUniqueOrThrow({ where: { id: (variant.payloadJson as any).proposedDiff.id } }))
      .toMatchObject({ status: "pending", reviewedByUserId: null });
  });
  it("does not refresh reviewer authority after demotion and restoration", async () => {
    const f = await approverFixture(); await reviewedOriginal(f);
    await prisma.member.update({ where: { id: f.ownerMember.id }, data: { role: "CONTRIBUTOR" } });
    await prisma.member.update({ where: { id: f.ownerMember.id }, data: { role: "ADMIN" } });
    const { variant } = await generate(f);
    expect(await prisma.contextGraphProposedDiff.findUniqueOrThrow({ where: { id: (variant.payloadJson as any).proposedDiff.id } }))
      .toMatchObject({ status: "pending", reviewedByUserId: null });
  });
  it("serializes competing apply attempts and preserves one committed effect", async () => {
    const f = await approverFixture(); const { variant } = await generate(f); const id = (variant.payloadJson as any).proposedDiff.id;
    await reviewContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id, status: "approved" });
    const attempts = await Promise.allSettled([1, 2].map(() => applyContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id })));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.event.count({ where: { workspaceId: f.workspace.id, type: "context-graph.diff.applied", aggregateId: id } })).toBe(1);
    // Idempotent generation retains the same committed effect, never a second proposal.
    expect(await requestGraphSourceVariant(f.readerActor, f.request)).toMatchObject({ status: "READY", variantId: variant.id });
    await updateOriginalDocument(f, { accessDomain: "FINANCE" });
    await expect(applyContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id })).rejects.toBeDefined();
    expect(await prisma.event.count({ where: { workspaceId: f.workspace.id, type: "context-graph.diff.applied", aggregateId: id } })).toBe(1);
  });
  it("withholds approval and publication when source authority is withdrawn and restored between review and apply", async () => {
    const f = await approverFixture(); const { variant } = await generate(f); const id = (variant.payloadJson as any).proposedDiff.id;
    await reviewContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id, status: "approved" });
    await updateOriginalDocument(f, { accessDomain: "FINANCE" });
    await updateOriginalDocument(f, { accessDomain: "WORKSPACE" });
    await expect(applyContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.contextGraphObject.count({ where: { workspaceId: f.workspace.id } })).toBe(f.targets.length);
    expect(await prisma.contextGraphRelationship.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.event.count({ where: { workspaceId: f.workspace.id, type: "context-graph.diff.applied", aggregateId: id } })).toBe(0);
  });
  it("does not recreate a deleted native proposal from its retained immutable variant", async () => {
    const f = await approverFixture(); const { variant } = await generate(f); const id = (variant.payloadJson as any).proposedDiff.id;
    await prisma.contextGraphProposedDiff.delete({ where: { id } });
    expect(await getReadableGraphSourceVariants(f.readerActor, { workspaceId: f.workspace.id, scope: f.request.scope })).toEqual([]);
    expect(await prisma.contextGraphProposedDiff.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.genericDerivedArtifactVariant.findUniqueOrThrow({ where: { id: variant.id } })).toEqual(variant);
  });
  it("rolls materialization, proposal status, audit and outbox back together on a late failure", async () => {
    const f = await approverFixture(); const { variant } = await generate(f); const id = (variant.payloadJson as any).proposedDiff.id;
    const before = await prisma.contextGraphProposedDiff.findUniqueOrThrow({ where: { id } });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION graph_test_reject_applied_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'context-graph.diff.applied' THEN RAISE EXCEPTION 'synthetic final outbox failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER graph_test_reject_applied_event BEFORE INSERT ON "Event" FOR EACH ROW EXECUTE FUNCTION graph_test_reject_applied_event()`);
    try {
      await expect(applyContextGraphProposedDiff(f.readerActor, { workspaceId: f.workspace.id, proposedDiffId: id })).rejects.toThrow("synthetic final outbox failure");
      expect(await prisma.contextGraphObject.count({ where: { workspaceId: f.workspace.id } })).toBe(f.targets.length);
      expect(await prisma.contextGraphRelationship.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await prisma.contextGraphProposedDiff.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect(await prisma.auditLog.count({ where: { entityId: id, action: "context-graph.diff.applied" } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER graph_test_reject_applied_event ON "Event"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION graph_test_reject_applied_event()`);
    }
  });
});
