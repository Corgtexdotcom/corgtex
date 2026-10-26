import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known, knownCopiedDocument } from "../../agents/src/agents/model-consumer.test-fixture";
vi.mock("@corgtex/shared", async () => ({ prisma: fixture.prisma, ...await import("../../shared/src/mcp-context"), env: {} }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) => fixture.domains.get(actor.user.id) ?? [] }));
import { buildSelectedRegionContext, listContextGraphProposedDiffs } from "./context-graph";
import { generateGraphSourceVariant } from "./derived-artifact-variants";
// Synthetic SQL transport only; generation, manifests, snapshots and current grants execute actual domain helpers.
const epochs = new Map<string, bigint>();
let sequence = 0;
function matches(row: any, where: any): boolean {
  return Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "workspaceId_targetKind_targetId_targetManifestId") return matches(row, value);
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
    if (key === "OR") return value.some((part: any) => matches(row, part));
    if (value && typeof value === "object" && "notIn" in value) return !value.notIn.includes(row[key]);
    if (value && typeof value === "object" && "not" in value) return row[key] !== value.not;
    if (value && typeof value === "object" && "gt" in value) return row[key] > value.gt;
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
      fixture.rows[name].push(row); return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = fixture.rows[name].find(row => matches(row, where)); if (!row) throw new Error("Missing synthetic row");
      Object.assign(row, data); return { ...row };
    }),
  };
}
beforeEach(async () => {
  await resetFixture(); epochs.clear(); sequence = 0;
  for (const name of ["auditLog", "contextGraphObject", "contextGraphRelationship", "contextGraphEvidenceRef", "contextGraphProposedDiff", "genericDerivedArtifactVariant", "derivedArtifactRebuildState", "workflowJob", "workspaceArchiveRecord", "brainArticleVersion", "contextMapView", "contextMapLayoutItem"]) transport(name);
  fixture.prisma.$executeRaw = vi.fn(async (sql: any) => {
    if (sql.strings?.join("").includes('INSERT INTO "SourcePermissionEpoch"')) for (let i = 0; i < sql.values.length; i += 4) {
      const [, ws, kind, id] = sql.values.slice(i, i + 4); const key = JSON.stringify([ws, kind, id]); if (!epochs.has(key)) epochs.set(key, 0n);
    }
    return 1;
  });
  fixture.prisma.$queryRaw = vi.fn(async (sql: any) => {
    if (sql.sql?.includes('FROM "ArtifactInputLineage"') && sql.sql.includes("DISTINCT ON")) {
      const [ws, kind, ...ids] = sql.values;
      const rows = fixture.rows.artifactInputLineage.filter(row => row.workspaceId === ws
        && row.artifactType === kind && ids.includes(row.artifactId)).sort((a, b) => b.revision - a.revision);
      return [...new Set(rows.map(row => row.artifactId))].map(id => ({ ...rows.find(row => row.artifactId === id) }));
    }
    if (!sql.strings?.join("").includes('FROM "SourcePermissionEpoch"')) return [];
    const [ws, ...pairs] = sql.values; const result = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const [sourceKind, sourceId] = pairs.slice(i, i + 2); const epoch = epochs.get(JSON.stringify([ws, sourceKind, sourceId]));
      if (epoch !== undefined) result.push({ sourceKind, sourceId, epoch });
    }
    return result;
  });
  fixture.prisma.$transaction.mockImplementation(async (run: any) => {
    const before = structuredClone(fixture.rows);
    // A real transaction has its own client identity while sharing the same
    // database state. Native commit preflights reject the root Prisma client.
    try { return await run({ ...fixture.prisma }); }
    catch (error) { for (const name of Object.keys(before)) fixture.rows[name] = before[name]; throw error; }
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

describe("automatic graph fallback with actual provenance and recipe helpers", () => {
  it("queues one independent cohort before a denied region fails, then exposes fresh pending output", async () => {
    const f = await setup(); const originals = structuredClone(f.targets);
    for (const id of ["canonical", "cohort-sibling", "canonical"]) {
      await expect(buildSelectedRegionContext(alpha, { workspaceId, objectIds: [id] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(fixture.rows.workflowJob).toHaveLength(1);
    const job = fixture.rows.workflowJob[0];
    expect(job.type).toBe("agent.graph-source-variant");
    expect(job.payload).toMatchObject({ userId: "alpha", memberId: "member-alpha", mode: "MEMBER_VARIANT", scope: { kind: "default", mapKey: "critical-path" } });
    expect(JSON.stringify(job.payload)).not.toContain("PRIVATE");
    Object.assign(job, { status: "RUNNING", attempts: 1, lockedBy: "worker" });
    const generate = vi.fn(async (sources: any[]) => {
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      return { objects: [{ ref: "team", objectType: "Team" as const, title: "Product team" }], relationships: [],
        evidenceRefs: [{ objectRef: "team", sourceKind: "Document" as const, sourceId: "document", quote: "product team" }] };
    });
    expect(await generateGraphSourceVariant({ workspaceId, jobId: job.id, expectedAttempt: 1, expectedOwner: "worker", generate })).toMatchObject({ phase: "APPLIED" });
    const pending = await listContextGraphProposedDiffs(alpha, { workspaceId });
    expect(pending).toHaveLength(1); expect(pending[0].status).toBe("pending");
    expect(JSON.stringify(pending)).not.toContain("PRIVATE");
    expect(fixture.rows.contextGraphObject).toEqual(originals);
    expect(generate).toHaveBeenCalledOnce();
    const childId = (pending[0].diffJson as any).objects[0].ref;
    const region = await buildSelectedRegionContext(alpha, { workspaceId, objectIds: [childId], depth: 0 });
    expect(region.objects[0].id).toBe(childId);
    expect(region.lineageInputs).toEqual([]);
    expect(region.lineageRoots.some(root => root.kind === "GenericDerivedArtifactVariant")).toBe(true);
    expect(JSON.stringify(region)).not.toContain("PRIVATE");
  });
  it("does not enqueue originals, missing receipts, or unclassified legacy before known derivations", async () => {
    const f = await setup();
    for (let index = 0; index < 12; index++) fixture.add("contextGraphProposedDiff", {
      id: `unknown-${index}`, workspaceId, status: "pending", reason: "PRIVATE LEGACY", diffJson: {}, createdByType: "agent",
    });
    const original = fixture.add("contextGraphProposedDiff", { id: "original", workspaceId, status: "pending", reason: "Original", diffJson: {} });
    await known("ContextGraphProposedDiff", original);
    original.reason = "UNATTESTED MUTATION";
    const derived = fixture.add("contextGraphProposedDiff", { id: "derived", workspaceId, status: "pending", reason: "PRIVATE DERIVED", diffJson: {} });
    await known("ContextGraphProposedDiff", derived, [{ kind: "Document", id: f.doc.id }, { kind: "BrainArticle", id: f.privateArticle.id }]);
    expect(await listContextGraphProposedDiffs(alpha, { workspaceId, take: 1 })).toEqual([]);
    expect(fixture.rows.workflowJob).toHaveLength(1);
    expect(fixture.rows.workflowJob[0].payload.target).toEqual({ kind: "ContextGraphProposedDiff", id: "derived" });
    expect(JSON.stringify(fixture.rows.workflowJob[0].payload)).not.toMatch(/PRIVATE|UNATTESTED/);
  });
  it("keeps requester/workspace isolation and rejects revoked members before queueing", async () => {
    await setup();
    // Beta can read the complete canonical inputs, so no fallback is needed.
    await buildSelectedRegionContext(beta, { workspaceId, objectIds: ["canonical"], depth: 0 });
    expect(fixture.rows.workflowJob).toEqual([]);
    await expect(buildSelectedRegionContext(alpha, { workspaceId: "ws-b", objectIds: ["canonical"] })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    const member = fixture.rows.member.find(row => row.id === "member-alpha"); member.isActive = false;
    await expect(buildSelectedRegionContext(alpha, { workspaceId, objectIds: ["canonical"] })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(fixture.rows.workflowJob).toEqual([]);
  });
  it("rechecks the actual source before a queued fallback invokes the model", async () => {
    const f = await setup();
    await expect(buildSelectedRegionContext(alpha, { workspaceId, objectIds: ["canonical"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const job = fixture.rows.workflowJob[0]; Object.assign(job, { status: "RUNNING", attempts: 1, lockedBy: "worker" });
    f.doc.textContent = "Changed after the automatic request";
    const generate = vi.fn();
    expect(await generateGraphSourceVariant({ workspaceId, jobId: job.id, expectedAttempt: 1, expectedOwner: "worker", generate })).toMatchObject({ phase: "STALE" });
    expect(generate).not.toHaveBeenCalled(); expect(fixture.rows.genericDerivedArtifactVariant).toEqual([]);
    expect(fixture.rows.contextGraphObject[0].title).toBe("PRIVATE CANONICAL TITLE");
  });
  it("does not queue client-invented target IDs absent from the scoped server query", async () => {
    await setup();
    await expect(buildSelectedRegionContext(alpha, { workspaceId, objectIds: ["invented"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.rows.workflowJob).toEqual([]);
  });
});
