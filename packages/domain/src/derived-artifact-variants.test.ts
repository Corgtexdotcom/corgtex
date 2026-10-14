import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known, knownCopiedDocument } from "../../agents/src/agents/model-consumer.test-fixture";
const remote = vi.hoisted(() => ({ transport: vi.fn(), body: { text: "The product team owns onboarding." }, transactionDepth: 0, callsInTransaction: 0 }));
vi.mock("@corgtex/shared", async () => ({ prisma: fixture.prisma, ...await import("../../shared/src/mcp-context"), env: {},
  encryptSecret: (value: string) => `synthetic-encrypted:${value}`, decryptSecret: (value: string) => value.slice("synthetic-encrypted:".length) }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) => fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("./external-mcp", async importOriginal => ({ ...await importOriginal<typeof import("./external-mcp")>(),
  readBoxExternalMcpNativeResponse: remote.transport }));
import { createGraphVariantBundle, graphDiffMeaningHash, graphVariantScopeKey, requestGraphSourceVariant, generateGraphSourceVariant, getReadableGraphSourceVariants, revalidateGraphSourceVariants } from "./derived-artifact-variants";
import { AppError } from "./errors";
import { captureArtifactInputProof, readableArtifactIds } from "./source-lineage";
import { captureExternalProviderFetchInput } from "./external-provider-authority";
import { withMcpToolInputContext } from "./mcp-tool-input-context";
import type { PermittedDerivationSource } from "./permitted-derivation-inputs";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
const sources: PermittedDerivationSource[] = [{ kind: "Document", id: "public-document", title: "Public document",
  content: "The product team owns onboarding.", ingestionGuidanceMd: null }];
function candidate() { return { objects: [{ ref: "team", objectType: "Team", title: "Product team" },
  { ref: "onboarding", objectType: "Process", title: "Onboarding" }],
relationships: [{ ref: "owns", sourceRef: "team", targetRef: "onboarding", relationshipType: "owns" }],
evidenceRefs: [{ relationshipRef: "owns", sourceKind: "Document", sourceId: "public-document", quote: "team owns onboarding" }], reason: "Supported by the permitted document." }; }
describe("fresh pending graph bundle validation", () => {
  it("creates fresh coherent endpoint/evidence identities and never inherits approval", () => {
    const a = createGraphVariantBundle(candidate(), sources); const b = createGraphVariantBundle(candidate(), sources);
    expect(a.relationships[0]).toMatchObject({ sourceObjectId: a.objects[0].id, targetObjectId: a.objects[1].id, status: "proposed" });
    expect(a.evidenceRefs[0].relationshipId).toBe(a.relationships[0].id);
    expect(a.proposedDiff.status).toBe("pending");
    expect(a.objects.every(row => row.status === "proposed")).toBe(true);
    expect(a.objects[0].id).not.toBe(b.objects[0].id);
    expect(a.proposedDiff.id).not.toBe(b.proposedDiff.id);
    expect(a.proposedDiff.diffJson).toEqual({ objects: a.objects, relationships: a.relationships, evidenceRefs: a.evidenceRefs });
  });
  it("compares exact reviewed meaning independently of local refs and evidence, while retaining semantic uncertainty", () => {
    const first = candidate();
    const second = { ...candidate(), objects: [
      { ref: "b", objectType: "Process", title: "Onboarding", summary: null, properties: {} },
      { ref: "a", objectType: "Team", title: " Product team ", status: "approved" },
    ], relationships: [{ sourceRef: "a", targetRef: "b", relationshipType: "owns" }], evidenceRefs: [] };
    // The generator's explanation is not part of the graph diff.
    const { reason: _reason, ...diff } = first;
    const { reason: _otherReason, ...otherDiff } = second;
    expect(graphDiffMeaningHash(diff)).not.toBeNull();
    expect(graphDiffMeaningHash(otherDiff)).toBe(graphDiffMeaningHash(diff));
    expect(graphDiffMeaningHash({ ...otherDiff, relationships: [{ sourceRef: "b", targetRef: "a", relationshipType: "owns" }] }))
      .not.toBe(graphDiffMeaningHash(diff));
    expect(graphDiffMeaningHash({ ...diff, objectUpdates: [] })).toBeNull();
    expect(graphDiffMeaningHash({ ...diff, objects: diff.objects.map(row => ({ ...row, status: "rejected" })) })).toBeNull();
    expect(graphDiffMeaningHash({ ...diff, objects: [...diff.objects, { ...diff.objects[0], ref: "duplicate" }] })).toBeNull();
  });
  it.each(["status", "id", "dedupeKey", "sourceEntityId", "reviewedAt", "approvedByUserId", "layout"])("rejects old %s copied onto a fresh object", field => {
    const input = candidate(); Object.assign(input.objects[0], { [field]: "OLD PRIVATE VALUE" });
    expect(() => createGraphVariantBundle(input, sources)).toThrow("Graph object is invalid");
  });
  it("rejects canonical endpoints, cross-bundle refs, and duplicate local refs", () => {
    const input = candidate(); input.relationships[0].targetRef = "canonical-private-object";
    expect(() => createGraphVariantBundle(input, sources)).toThrow("Graph relationship is invalid");
    const duplicate = candidate(); duplicate.objects[1].ref = "team";
    expect(() => createGraphVariantBundle(duplicate, sources)).toThrow("Graph object is invalid");
  });
  it("rejects hidden/uncaptured evidence source IDs and invented quotes", () => {
    const privateInput = candidate(); privateInput.evidenceRefs[0].sourceId = "private-finance";
    expect(() => createGraphVariantBundle(privateInput, sources)).toThrow("Graph evidence is invalid");
    const invented = candidate(); invented.evidenceRefs[0].quote = "Secret forecast";
    expect(() => createGraphVariantBundle(invented, sources)).toThrow("Graph evidence is invalid");
  });
  it("rejects evidence with neither or both parents, unsupported old operations and invalid probabilities", () => {
    const parents = candidate(); Object.assign(parents.evidenceRefs[0], { objectRef: "team" });
    expect(() => createGraphVariantBundle(parents, sources)).toThrow("Graph evidence is invalid");
    const operation = { ...candidate(), objectUpdates: [{ id: "old", title: "Reclassified" }] };
    expect(() => createGraphVariantBundle(operation, sources)).toThrow("unsupported operations");
    const score = candidate(); Object.assign(score.objects[0], { confidence: Infinity });
    expect(() => createGraphVariantBundle(score, sources)).toThrow("Graph properties are invalid");
  });
  it("has bounded allowlisted default scope and distinct personal view keys", () => {
    expect(graphVariantScopeKey({ kind: "default", mapKey: "critical-path" })).toBe('["default","critical-path"]');
    expect(graphVariantScopeKey({ kind: "view", mapViewId: "mine" })).not.toBe(graphVariantScopeKey({ kind: "view", mapViewId: "other" }));
    expect(() => graphVariantScopeKey({ kind: "default", mapKey: "private-custom" } as never)).toThrow("scope is invalid");
  });
});


// Synthetic SQL transport only; generation, manifests, snapshots and current grants execute actual domain helpers.
let epochFixture: ReturnType<typeof installSourcePermissionEpochFixture>;
let sequence = 0;
function matches(row: any, where: any): boolean {
  return Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "workspaceId_targetKind_targetId_targetManifestId") return matches(row, value);
    if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
    return row[key] === value;
  });
}
function transport(name: string) {
  fixture.rows[name] = [];
  fixture.prisma[name] = {
    findFirst: vi.fn(async ({ where }: any) => fixture.rows[name].find(row => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: any) => fixture.rows[name].find(row => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where, take }: any) => fixture.rows[name].filter(row => matches(row, where)).slice(0, take)),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `${name}-${++sequence}`, createdAt: fixture.timestamp, updatedAt: fixture.timestamp,
        ...(name === "workflowJob" ? { status: "PENDING", attempts: 0, lockedBy: null, lockedAt: null } : {}), ...data };
      if (name === "externalProviderFetchInput") Object.assign(row, { fetchedAt: fixture.timestamp });
      fixture.rows[name].push(row); return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = fixture.rows[name].find(row => matches(row, where)); if (!row) throw new Error("Missing synthetic row");
      Object.assign(row, data); return { ...row };
    }),
  };
}
beforeEach(async () => {
  await resetFixture(); sequence = 0;
  remote.transactionDepth = 0; remote.callsInTransaction = 0; remote.body = { text: "The product team owns onboarding." };
  remote.transport.mockImplementation(async () => {
    if (remote.transactionDepth) { remote.callsInTransaction++; throw new Error("Provider called while interactive transaction is open"); }
    return structuredClone(remote.body);
  });
  for (const name of ["auditLog", "contextGraphObject", "contextGraphRelationship", "contextGraphEvidenceRef", "contextGraphProposedDiff", "genericDerivedArtifactVariant", "derivedArtifactRebuildState", "workflowJob", "workspaceArchiveRecord", "brainArticleVersion", "externalProviderFetchInput", "externalMcpConnection", "externalContentSource"]) transport(name);
  fixture.prisma.$executeRaw = vi.fn(async () => 1);
  fixture.prisma.$queryRaw = vi.fn(async () => []);
  epochFixture = installSourcePermissionEpochFixture(fixture.prisma);
  fixture.prisma.$transaction.mockImplementation(async (run: any) => {
    const before = structuredClone(fixture.rows);
    const tx = new Proxy(fixture.prisma, { get(target, key) { return key === "$transaction" ? undefined : Reflect.get(target, key); } });
    remote.transactionDepth++;
    try { return await run(tx); }
    catch (error) { for (const name of Object.keys(before)) fixture.rows[name] = before[name]; throw error; }
    finally { remote.transactionDepth--; }
  });
});
async function setup() {
  const doc = fixture.add("document", { id: "document", workspaceId, title: "Public document", textContent: "The product team owns onboarding.",
    accessDomain: "WORKSPACE", archivedAt: null, metadata: null, authorMemberId: null });
  await knownCopiedDocument(doc);
  const privateArticle = fixture.add("brainArticle", { id: "private", workspaceId, title: "PRIVATE TITLE", bodyMd: "PRIVATE BODY", slug: "private",
    isPrivate: true, ownerMemberId: "member-beta", authority: "DRAFT", variantOfArticleId: null, archivedAt: null });
  await known("BrainArticle", privateArticle);
  const targets = [];
  for (const id of ["canonical", "cohort-sibling"]) {
    const row = fixture.add("contextGraphObject", { id, workspaceId, objectType: "Team", title: "PRIVATE CANONICAL TITLE", summary: "PRIVATE SUMMARY",
      properties: { private: "PRIVATE PROPERTY" }, status: "approved", createdByType: "agent", createdByUserId: "beta", sourceEntityType: null, sourceEntityId: null });
    await known("ContextGraphObject", row, [{ kind: "Document", id: doc.id }, { kind: "BrainArticle", id: privateArticle.id }]); targets.push(row);
  }
  const request = { workspaceId, target: { kind: "ContextGraphObject" as const, id: targets[0].id }, scope: { kind: "default" as const, mapKey: "critical-path" as const } };
  return { doc, privateArticle, targets, request };
}
async function claimRequest(request: any) {
  const result = await requestGraphSourceVariant(alpha, request);
  if (result.status !== "QUEUED") throw new Error(`Expected queued: ${JSON.stringify(result)}`);
  await fixture.prisma.workflowJob.update({ where: { id: result.jobId }, data: { status: "RUNNING", attempts: 1, lockedBy: "worker" } });
  return { workspaceId, jobId: result.jobId, expectedAttempt: 1, expectedOwner: "worker" };
}
function generated(sources: any[]) {
  expect(JSON.stringify(sources)).not.toContain("PRIVATE");
  return { objects: [{ ref: "new-team", objectType: "Team" as const, title: "Product team" }], relationships: [],
    evidenceRefs: [{ objectRef: "new-team", sourceKind: "Document" as const, sourceId: "document", quote: "product team" }] };
}
async function setupBox() {
  fixture.add("externalMcpConnection", { id: "box-connection", workspaceId, userId: "alpha", providerKey: "box",
    serverUrl: "https://mcp.box.com", providerAccountId: "box-alpha", scopes: ["root_readwrite"], status: "ACTIVE", accessTokenEnc: "synthetic-token" });
  const selection = fixture.add("externalContentSource", { id: "box-selection", workspaceId, connectionId: "box-connection", selectedByUserId: "alpha",
    providerKey: "box", sourceKind: "FILE", externalId: "box-file", title: "Explicit native selection", status: "ACTIVE", archivedAt: null, metadata: null });
  await known("ExternalContentSource", selection, [], alpha);
  const native = await captureExternalProviderFetchInput(alpha, { workspaceId, externalContentSourceId: selection.id, connectionId: "box-connection",
    sourceKind: "FILE", externalId: "box-file", toolName: "get_file_content", arguments: { file_id: "box-file" } });
  const source = fixture.add("brainSource", { id: "box-source", workspaceId, sourceType: "EXTERNAL_CONTENT", title: "Known Box body", content: remote.body.text,
    tier: 2, channel: "box", accessDomain: "WORKSPACE", authorMemberId: null, archivedAt: null, ingestionGuidanceMd: null, metadata: { externalContentSourceId: selection.id } });
  await known("BrainSource", source, [{ kind: "ExternalContentSource", id: selection.id }, { kind: "ExternalProviderFetchInput", id: native.input.id }], alpha);
  const privateArticle = fixture.add("brainArticle", { id: "box-private", workspaceId, title: "PRIVATE OLD INPUT TITLE", bodyMd: "PRIVATE OLD INPUT BODY",
    slug: "box-private", isPrivate: true, ownerMemberId: "member-alpha", authority: "DRAFT", variantOfArticleId: null, archivedAt: null });
  await known("BrainArticle", privateArticle, [], alpha);
  const targets = [];
  for (const id of ["box-canonical", "box-sibling"]) {
    const target = fixture.add("contextGraphObject", { id, workspaceId, objectType: "Team", title: "PRIVATE OLD TARGET TITLE", summary: "PRIVATE OLD TARGET SUMMARY",
      properties: { private: "PRIVATE OLD TARGET PROPERTY" }, status: "approved", createdByType: "agent", createdByUserId: "alpha" });
    await known("ContextGraphObject", target, [{ kind: "BrainSource", id: source.id }, { kind: "BrainArticle", id: privateArticle.id }], alpha);
    targets.push(target);
  }
  // Simulate a current privacy transition. The old original is retained in
  // historical manifests; its newly unproven owner revision is never promoted.
  privateArticle.ownerMemberId = "member-beta";
  epochFixture.bump(workspaceId, "BrainArticle", privateArticle.id);
  const request = { workspaceId, target: { kind: "ContextGraphObject" as const, id: targets[0].id },
    scope: { kind: "default" as const, mapKey: "critical-path" as const } };
  return { source, selection, native, targets, request };
}
function boxCandidate(sources: any[]) {
  expect(sources.map(source => [source.kind, source.id])).toEqual([["BrainSource", "box-source"]]);
  expect(JSON.stringify(sources)).not.toContain("PRIVATE");
  expect(remote.transactionDepth).toBe(0);
  return { objects: [{ ref: "new-team", objectType: "Team" as const, title: "Product team" }], relationships: [],
    evidenceRefs: [{ objectRef: "new-team", sourceKind: "BrainSource" as const, sourceId: "box-source", quote: "product team" }] };
}
describe("legacy graph bundle native publication", () => {
  it("materializes a never-published legacy proposal only after the complete immutable variant proof remains current", async () => {
    const f = await setup(); const lease = await claimRequest(f.request);
    const result = await generateGraphSourceVariant({ ...lease, generate: async () => generated([]) });
    expect(result.phase).toBe("APPLIED");
    const variant = structuredClone(fixture.rows.genericDerivedArtifactVariant[0]);
    const id = variant.payloadJson.proposedDiff.id;
    // Model the old writer's database shape: immutable variant present, native
    // proposal and its tombstone absent. All normal source proof queries remain real.
    fixture.rows.contextGraphProposedDiff = [];
    const query = fixture.prisma.$queryRaw.getMockImplementation();
    fixture.prisma.$queryRaw.mockImplementation(async (...args: any[]) => {
      if (Array.isArray(args[0]) && args[0].join("").includes('FROM "SourcePermissionEpoch"')) return [];
      return query(...args);
    });
    expect(await getReadableGraphSourceVariants(alpha, { workspaceId, scope: f.request.scope })).toHaveLength(1);
    expect(fixture.rows.contextGraphProposedDiff).toHaveLength(1);
    expect(fixture.rows.contextGraphProposedDiff[0]).toMatchObject({ id, status: "pending", proposedByUserId: "alpha" });
    expect(fixture.rows.genericDerivedArtifactVariant[0]).toEqual(variant);
    expect(fixture.rows.contextGraphProposedDiff[0].diffJson.objects[0]).toHaveProperty("ref");
    expect(fixture.rows.contextGraphProposedDiff[0].diffJson.objects[0]).not.toHaveProperty("id");
  });
});

describe("Box graph phase authority with actual lineage helpers", () => {
  it("rebuilds a whole coherent variant while old semantic lineage is unreadable, with zero provider calls in request/claim/publication/read transactions", async () => {
    const f = await setupBox(); const oldTargets = structuredClone(f.targets);
    expect(await readableArtifactIds(alpha, workspaceId, "ContextGraphObject", f.targets)).toEqual(new Set());
    remote.transport.mockClear();
    const lease = await claimRequest(f.request);
    const result = await generateGraphSourceVariant({ ...lease, generate: async sources => boxCandidate(sources) });
    expect(result.phase).toBe("APPLIED");
    const views = await getReadableGraphSourceVariants(alpha, { workspaceId, scope: f.request.scope });
    expect(views).toHaveLength(1); expect(views[0].targets.map(target => target.id)).toEqual(["box-canonical", "box-sibling"]);
    expect(views[0].bundle.proposedDiff.status).toBe("pending");
    expect(JSON.stringify(views[0].bundle)).not.toContain("PRIVATE");
    expect(await revalidateGraphSourceVariants(alpha, { workspaceId, variantIds: [views[0].id] })).toBe(true);
    expect((await requestGraphSourceVariant(alpha, { ...f.request, target: { kind: "ContextGraphObject", id: "box-sibling" } })).status).toBe("READY");
    expect(fixture.rows.contextGraphObject).toEqual(oldTargets);
    expect(remote.transport).toHaveBeenCalled();
    expect(remote.transactionDepth).toBe(0);
    expect(remote.callsInTransaction).toBe(0);
  });
  it.each(["provider-bytes", "native-move", "native-proof", "target-move"])("withholds %s drift after model without publishing partial content", async change => {
    const f = await setupBox(); const lease = await claimRequest(f.request);
    const result = await generateGraphSourceVariant({ ...lease, generate: async sources => {
      const candidate = boxCandidate(sources);
      if (change === "provider-bytes") remote.body.text = "Changed provider bytes";
      if (change === "native-move") fixture.rows.externalProviderFetchInput[0].workspaceId = "ws-b";
      if (change === "native-proof") fixture.manifest("BrainSource", f.source.id).permissionEpochsJson = null;
      if (change === "target-move") fixture.rows.contextGraphObject[0].workspaceId = "ws-b";
      return candidate;
    } });
    expect(result.phase).toBe("STALE"); expect(fixture.rows.genericDerivedArtifactVariant).toEqual([]);
  });
  it("withholds unknown native ancestry before generation without replacing the retained original bodies", async () => {
    const f = await setupBox(); fixture.rows.externalProviderFetchInput = [];
    const old = structuredClone(fixture.rows.contextGraphObject); remote.transport.mockClear();
    expect((await requestGraphSourceVariant(alpha, f.request)).status).toBe("UNAVAILABLE");
    expect(fixture.rows.contextGraphObject).toEqual(old); expect(fixture.rows.workflowJob).toEqual([]);
    expect(remote.transport).not.toHaveBeenCalled();
  });
  it("keeps exact prompt sources immutable and rejects a replaced same-owner lease after generation", async () => {
    const f = await setupBox(); const lease = await claimRequest(f.request);
    const result = await generateGraphSourceVariant({ ...lease, generate: async sources => {
      expect(() => { sources[0].content = "Uncaptured model input"; }).toThrow(TypeError);
      expect(() => { sources.push({ ...sources[0], content: "Extra uncaptured input" }); }).toThrow(TypeError);
      const candidate = boxCandidate(sources);
      fixture.rows.workflowJob[0].lockedAt = new Date(fixture.timestamp.getTime() + 1000);
      return candidate;
    } });
    expect(result.phase).toBe("SUPERSEDED"); expect(fixture.rows.genericDerivedArtifactVariant).toEqual([]);
    expect(remote.callsInTransaction).toBe(0);
  });
  it("rechecks the live provider after publication before releasing a bundle identity", async () => {
    const f = await setupBox(); const lease = await claimRequest(f.request);
    const create = fixture.prisma.genericDerivedArtifactVariant.create.getMockImplementation();
    fixture.prisma.genericDerivedArtifactVariant.create.mockImplementationOnce(async (params: any) => {
      const row = await create(params);
      remote.body.text = "Provider changed after publication began";
      return row;
    });
    const result = await generateGraphSourceVariant({ ...lease, generate: async sources => boxCandidate(sources) });
    expect(result).toEqual({ phase: "STALE" });
    expect(await getReadableGraphSourceVariants(alpha, { workspaceId, scope: f.request.scope })).toEqual([]);
    expect(remote.callsInTransaction).toBe(0);
  });
});
describe("graph bundle generation with actual lineage and worker lease", () => {
  it.each(["target", "historical-derived", "obsolete-policy"])("does not queue regeneration from a legacy %s receipt", async location => {
    const f = await setup();
    const legacy = location === "historical-derived" ? fixture.manifest("Document", f.doc.id)
      : fixture.manifest("ContextGraphObject", f.request.target.id);
    expect(legacy.origin).toBe("DERIVED"); expect(legacy.rootsJson.length).toBeGreaterThan(0);
    const originals = structuredClone(fixture.rows.contextGraphObject);
    if (location === "obsolete-policy") legacy.permissionEpochsJson = { ...legacy.permissionEpochsJson, policyVersion: "pun68-permissions-legacy" };
    else { legacy.epochProofVersion = null; legacy.permissionEpochsJson = null; }
    expect(await requestGraphSourceVariant(alpha, f.request)).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.rows.workflowJob).toEqual([]);
    expect(fixture.rows.genericDerivedArtifactVariant).toEqual([]);
    expect(fixture.rows.contextGraphObject).toEqual(originals);
    expect(legacy.permissionEpochsJson === null || legacy.permissionEpochsJson.policyVersion === "pun68-permissions-legacy").toBe(true);
  });

  it("stores one complete private pending bundle with all cohort targets, preserves broad originals and gates owner/scope", async () => {
    const f = await setup(); const before = structuredClone(f.targets);
    const lease = await claimRequest(f.request); const generate = vi.fn(async (sources: any[]) => generated(sources));
    const result = await generateGraphSourceVariant({ ...lease, generate });
    expect(result.phase).toBe("APPLIED"); expect(generate).toHaveBeenCalledTimes(1);
    const views = await getReadableGraphSourceVariants(alpha, { workspaceId, scope: f.request.scope });
    expect(views).toHaveLength(1); expect(views[0].targets.map(target => target.id)).toEqual(["canonical", "cohort-sibling"]);
    expect(views[0].bundle.objects[0].status).toBe("proposed"); expect(views[0].bundle.proposedDiff.status).toBe("pending");
    expect(fixture.rows.contextGraphObject).toEqual(before);
    expect(fixture.manifest("GenericDerivedArtifactVariant", views[0].id).origin).toBe("DERIVED");
    expect(await revalidateGraphSourceVariants(alpha, { workspaceId, variantIds: [views[0].id] })).toBe(true);
    expect(await getReadableGraphSourceVariants(beta, { workspaceId, scope: f.request.scope })).toEqual([]);
    expect(await getReadableGraphSourceVariants(alpha, { workspaceId, scope: { kind: "default", mapKey: "org-structure" } })).toEqual([]);
    expect((await requestGraphSourceVariant(alpha, { ...f.request, target: { kind: "ContextGraphObject", id: "cohort-sibling" } })).status).toBe("READY");
  });
  it("does not model UNKNOWN targets or proven human originals", async () => {
    const f = await setup(); fixture.rows.artifactInputLineage = fixture.rows.artifactInputLineage.filter(row => row.artifactId !== "canonical");
    expect((await requestGraphSourceVariant(alpha, f.request)).status).toBe("UNAVAILABLE");
    await known("ContextGraphObject", f.targets[0]);
    expect((await requestGraphSourceVariant(alpha, f.request)).status).toBe("NOT_NEEDED");
    expect(fixture.rows.workflowJob).toEqual([]);
  });
  it("rejects worker attempt replacement before model, and source drift after model without partial writes", async () => {
    const f = await setup(); const lease = await claimRequest(f.request);
    const generate = vi.fn(async (sources: any[]) => generated(sources));
    expect(await generateGraphSourceVariant({ ...lease, expectedAttempt: 9, generate })).toEqual({ phase: "SUPERSEDED" });
    expect(generate).not.toHaveBeenCalled();
    const drift = vi.fn(async (sources: any[]) => {
      fixture.rows.document.find(row => row.id === f.doc.id).textContent = "Changed during model";
      return generated(sources);
    });
    expect(await generateGraphSourceVariant({ ...lease, generate: drift })).toEqual({ phase: "STALE" });
    expect(fixture.rows.genericDerivedArtifactVariant).toEqual([]);
    expect(fixture.rows.workflowJob[0].payload.phase).toBe("STALE");
  });
  it("withholds old variants on source privacy loss/restore, membership loss and canonical body change", async () => {
    const f = await setup(); const lease = await claimRequest(f.request);
    const created = await generateGraphSourceVariant({ ...lease, generate: async sources => generated(sources) });
    const id = (created as any).variantId;
    epochFixture.bump(workspaceId, "Document", f.doc.id);
    epochFixture.bump(workspaceId, "Document", f.doc.id);
    expect(await revalidateGraphSourceVariants(alpha, { workspaceId, variantIds: [id] })).toBe(false);
    expect(await getReadableGraphSourceVariants(alpha, { workspaceId, scope: f.request.scope })).toEqual([]);
    fixture.rows.member.find(row => row.id === "member-alpha").isActive = false;
    await expect(getReadableGraphSourceVariants(alpha, { workspaceId, scope: f.request.scope })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    fixture.rows.member.find(row => row.id === "member-alpha").isActive = true;
    fixture.rows.contextGraphObject.find(row => row.id === "canonical").title = "Changed canonical semantics";
    expect(await revalidateGraphSourceVariants(alpha, { workspaceId, variantIds: [id] })).toBe(false);
  });
  it("replays a completed generation without changing immutable bundle or model inputs", async () => {
    const f = await setup(); const lease = await claimRequest(f.request);
    const callback = vi.fn(async (sources: any[]) => generated(sources));
    const a = await generateGraphSourceVariant({ ...lease, generate: callback });
    const before = structuredClone(fixture.rows.genericDerivedArtifactVariant);
    const b = await generateGraphSourceVariant({ ...lease, generate: callback });
    expect(b).toEqual(a); expect(callback).toHaveBeenCalledTimes(1);
    expect(fixture.rows.genericDerivedArtifactVariant).toEqual(before);
  });
  it("uses only a trusted retirement pointer to known historical DERIVED ancestry", async () => {
    const f = await setup(); const original = fixture.manifest("ContextGraphObject", "canonical");
    fixture.add("derivedArtifactRebuildState", { workspaceId, targetKind: "ContextGraphObject", targetId: "canonical",
      targetManifestId: original.id, targetFingerprint: original.contentHash, state: "REBUILD_REQUIRED" });
    fixture.add("artifactInputLineage", { workspaceId, artifactType: "ContextGraphObject", artifactId: "canonical",
      contentHash: original.contentHash, revision: original.revision + 1, origin: "UNKNOWN", rootsJson: [], inputsJson: [] });
    const lease = await claimRequest(f.request);
    expect((await generateGraphSourceVariant({ ...lease, generate: async sources => generated(sources) })).phase).toBe("APPLIED");
    expect(fixture.manifest("ContextGraphObject", "canonical").origin).toBe("UNKNOWN");
    fixture.rows.derivedArtifactRebuildState[0].targetManifestId = "unproven-history";
    expect(await getReadableGraphSourceVariants(alpha, { workspaceId, scope: f.request.scope })).toEqual([]);
  });
  it("a receipt write failure rolls back the created content and keeps the generation unaccepted", async () => {
    const f = await setup(); const lease = await claimRequest(f.request);
    const originalCreate = fixture.prisma.artifactInputLineage.create.getMockImplementation();
    fixture.prisma.artifactInputLineage.create.mockImplementationOnce(async ({ data }: any) => {
      if (data.artifactType === "GenericDerivedArtifactVariant") throw new AppError(409, "SOURCE_RESTRICTED", "Final proof drift");
      return originalCreate!({ data });
    });
    await expect(generateGraphSourceVariant({ ...lease, generate: async sources => generated(sources) })).rejects.toThrow("Final proof drift");
    expect(fixture.rows.genericDerivedArtifactVariant).toEqual([]);
    expect(fixture.rows.workflowJob[0].payload.phase).toBe("GENERATING");
  });

  it("carries actual trusted submission roots across the queued worker boundary without prompting request bodies", async () => {
    const f = await setup();
    const submitted = fixture.add("brainArticle", { id: "submitted-original", workspaceId, title: "PRIVATE REQUEST TITLE", bodyMd: "PRIVATE REQUEST BODY",
      slug: "submitted", isPrivate: true, ownerMemberId: "member-alpha", authority: "DRAFT", variantOfArticleId: null, archivedAt: null });
    await known("BrainArticle", submitted, [], alpha);
    const roots = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "BrainArticle", id: submitted.id }]);
    const request = await withMcpToolInputContext(alpha, workspaceId, roots, () => requestGraphSourceVariant(alpha, f.request));
    if (request.status !== "QUEUED") throw new Error("Expected queued submission");
    const job = fixture.rows.workflowJob[0];
    expect(job.payload.requestRoots).toEqual(roots);
    await fixture.prisma.workflowJob.update({ where: { id: job.id }, data: { status: "RUNNING", attempts: 1, lockedBy: "worker" } });
    const result = await generateGraphSourceVariant({ workspaceId, jobId: job.id, expectedAttempt: 1, expectedOwner: "worker",
      generate: async sources => generated(sources) });
    expect(result.phase).toBe("APPLIED");
    expect(fixture.sources("GenericDerivedArtifactVariant", (result as any).variantId)).toContain("BrainArticle:submitted-original");
    fixture.rows.brainArticle.find(row => row.id === submitted.id).archivedAt = fixture.timestamp;
    expect(await getReadableGraphSourceVariants(alpha, { workspaceId, scope: f.request.scope })).toEqual([]);
  });

});
