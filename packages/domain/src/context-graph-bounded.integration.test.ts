import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { contextGraphSystemActor, getContextMapData, markStaleContextGraphFacts } from "./context-graph";
import { recordArtifactInputLineage, readableArtifactIds, type LineageKind } from "./source-lineage";

beforeEach(async () => { await truncateAllTables(); });
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const workspace = await prisma.workspace.create({data: {slug: `graph-bounded-${randomUUID()}`, name: "Synthetic bounded graph"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  async function original(kind: LineageKind, row: {id: string}) {
    await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor, workspaceId: workspace.id,
      artifact: {kind, id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
    return row;
  }
  await original("Workspace", workspace);
  const map = await prisma.contextMapView.create({data: {workspaceId: workspace.id, name: "All tasks", viewType: "process", query: {objectTypes: ["Task"]}}});
  await original("ContextMapView", map);
  async function object(id: string, stale = false) {
    const row = await prisma.contextGraphObject.create({data: {id, workspaceId: workspace.id, objectType: "Task", title: id,
      status: "approved", createdByUserId: user.id, updatedAt: new Date(stale ? "2020-01-01Z" : "2021-01-01Z")}});
    await original("ContextGraphObject", row); return row;
  }
  return {actor, workspace, member, map, original, object};
}

it("replenishes map objects beyond 5001 unproved rows and only hydrates bounded selected evidence", async () => {
  const f = await fixture();
  for (let n=0;n<5001;n+=100) await prisma.contextGraphObject.createMany({data: Array.from({length: Math.min(100,5001-n)},(_,i)=>({
    id: `unknown-${n+i}`, workspaceId: f.workspace.id, objectType: "Task", title: "Withheld", status: "approved", updatedAt: new Date("2025-01-01Z")}))});
  const visible = await f.object("visible");
  for (let n=0;n<105;n++) await prisma.contextGraphEvidenceRef.create({data: {workspaceId: f.workspace.id, objectId: visible.id, sourceType: "manual", sourceId: "unknown", quote: "WITHHELD", createdAt: new Date("2025-01-01Z")}});
  const evidence = await prisma.contextGraphEvidenceRef.create({data: {workspaceId: f.workspace.id, objectId: visible.id, sourceType: "manual", sourceId: "known", quote: "Visible evidence", createdAt: new Date("2021-01-01Z")}});
  await f.original("ContextGraphEvidenceRef", evidence);
  await prisma.contextGraphRelationship.createMany({data: Array.from({length: 301}, (_, i) => ({
    id: `a-denied-relation-${i}`, workspaceId: f.workspace.id, sourceObjectId: visible.id, targetObjectId: visible.id, relationshipType: "depends_on", status: "approved"}))});
  const relationship = await prisma.contextGraphRelationship.create({data: {id: "z-readable-relation", workspaceId: f.workspace.id,
    sourceObjectId: visible.id, targetObjectId: visible.id, relationshipType: "depends_on", status: "approved"}});
  await f.original("ContextGraphRelationship", relationship);
  await prisma.contextGraphProposedDiff.createMany({data: Array.from({length: 21}, () => ({workspaceId: f.workspace.id,
    proposedByType: "human", diffJson: {}, createdAt: new Date("2025-01-01Z")}))});
  const diff = await prisma.contextGraphProposedDiff.create({data: {workspaceId: f.workspace.id,
    proposedByType: "human", diffJson: {}, createdAt: new Date("2021-01-01Z")}});
  await f.original("ContextGraphProposedDiff", diff);
  const objects = vi.spyOn(prisma.contextGraphObject, "findMany"), refs = vi.spyOn(prisma.contextGraphEvidenceRef, "findMany");
  const relationships = vi.spyOn(prisma.contextGraphRelationship, "findMany"), diffs = vi.spyOn(prisma.contextGraphProposedDiff, "findMany");
  const result = await getContextMapData(f.actor, {workspaceId: f.workspace.id, mapViewId: f.map.id});
  expect(result.objects.map(row => row.id)).toEqual([visible.id]);
  expect(result.objects[0].evidenceRefs.map(row=>row.id)).toEqual([evidence.id]);
  expect(result.relationships.map(row => row.id)).toEqual([relationship.id]);
  expect(result.proposedDiffs.map(row => row.id)).toEqual([diff.id]);
  expect(objects.mock.calls.length).toBeGreaterThan(50);
  for (const [q] of objects.mock.calls) { expect(q?.take).toBeLessThanOrEqual(100); expect(q).not.toHaveProperty("include"); }
  for (const [q] of refs.mock.calls) {
    expect(q?.take).toBeLessThanOrEqual(5);
    expect(q?.where?.objectId === visible.id || q?.where?.relationshipId === relationship.id).toBe(true);
  }
  for (const [q] of relationships.mock.calls) {expect(q?.take).toBeLessThanOrEqual(100); expect(q).not.toHaveProperty("include");}
  for (const [q] of diffs.mock.calls) expect(q?.take).toBeLessThanOrEqual(20);
}, 60000);

it.each(["head", "membership"] as const)("map retains original %s through later relationship reads", async mode => {
  const f = await fixture(); const visible = await f.object("visible");
  const read = prisma.contextGraphRelationship.findMany.bind(prisma.contextGraphRelationship);
  let changed = false;
  vi.spyOn(prisma.contextGraphRelationship, "findMany").mockImplementation(((args: Prisma.ContextGraphRelationshipFindManyArgs = {}) => {
    const run = async () => {
      const rows = await read(args);
      if (!changed) {
        changed = true;
        if (mode === "head") await f.original("ContextGraphObject", visible);
        else { await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}}); await prisma.member.update({where: {id: f.member.id}, data: {isActive: true}}); }
      }
      return rows;
    };
    return run() as ReturnType<typeof read>;
  }) as typeof prisma.contextGraphRelationship.findMany);
  await expect(getContextMapData(f.actor, {workspaceId: f.workspace.id, mapViewId: f.map.id})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

it("staleness makes committed progress beyond 5001 unproved objects and relationships with current canonical proofs", async () => {
  const f = await fixture();
  const source = await f.object("endpoint-a"), target = await f.object("endpoint-b");
  for (let n=0;n<5001;n+=100) {
    const ids = Array.from({length: Math.min(100,5001-n)},(_,i)=>`a-unknown-${String(n+i).padStart(5,"0")}`);
    await prisma.contextGraphObject.createMany({data: ids.map(id=>({id, workspaceId: f.workspace.id, objectType: "Task", title: "Unknown", status: "approved", updatedAt: new Date("2020-01-01Z")}))});
    await prisma.contextGraphRelationship.createMany({data: ids.map(id=>({id, workspaceId: f.workspace.id, sourceObjectId: source.id, targetObjectId: target.id, relationshipType: "depends_on", status: "approved", updatedAt: new Date("2020-01-01Z")}))});
  }
  // Endpoints are fresh at the frozen cutoff; relationship admission must retain their authority.
  const object = await f.object("z-readable", true);
  const relationship = await prisma.contextGraphRelationship.create({data: {id: "z-readable", workspaceId: f.workspace.id, sourceObjectId: source.id, targetObjectId: target.id, relationshipType: "depends_on", status: "approved", updatedAt: new Date("2020-01-01Z")}});
  await f.original("ContextGraphRelationship", relationship);
  const objectReads = vi.spyOn(prisma.contextGraphObject, "findMany"), relationshipReads = vi.spyOn(prisma.contextGraphRelationship, "findMany");
  const result = await markStaleContextGraphFacts(f.actor, {workspaceId: f.workspace.id, now: new Date("2021-01-02Z")});
  expect(result).toMatchObject({staleObjects: 1, staleRelationships: 1});
  for (const spy of [objectReads, relationshipReads]) for (const [q] of spy.mock.calls) expect(q?.take).toBe(100);
  const after = await prisma.contextGraphObject.findUniqueOrThrow({where: {id: object.id}});
  expect(after.status).toBe("stale"); expect((await readableArtifactIds(f.actor, f.workspace.id, "ContextGraphObject", [after])).has(after.id)).toBe(true);
  expect(await prisma.contextGraphObject.count({where: {workspaceId: f.workspace.id, status: "approved"}})).toBe(5003);
  expect(await prisma.contextGraphRelationship.count({where: {workspaceId: f.workspace.id, status: "approved"}})).toBe(5001);
}, 60000);

it("staleness rolls back the selected row when lineage publication fails", async () => {
  const f = await fixture(); const object = await f.object("rollback", true);
  await prisma.$executeRawUnsafe(`CREATE FUNCTION graph_test_reject_stale_manifest() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."artifactType"='ContextGraphObject' AND NEW.revision>1 THEN RAISE EXCEPTION 'synthetic lineage failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER graph_test_reject_stale_manifest BEFORE INSERT ON "ArtifactInputLineage" FOR EACH ROW EXECUTE FUNCTION graph_test_reject_stale_manifest()`);
  try {
    await expect(markStaleContextGraphFacts(f.actor, {workspaceId: f.workspace.id, now: new Date("2021-01-02Z")})).rejects.toThrow("synthetic lineage failure");
    expect(await prisma.contextGraphObject.findUniqueOrThrow({where: {id: object.id}})).toEqual(object);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER graph_test_reject_stale_manifest ON "ArtifactInputLineage"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION graph_test_reject_stale_manifest()`);
  }
});

it.each(["fresh-row", "departed-caller"] as const)("staleness rechecks %s after discovery before mutation", async mode => {
  const f = await fixture(); const object = await f.object("rechecked", true);
  const read = prisma.contextGraphObject.findMany.bind(prisma.contextGraphObject);
  let changed = false;
  vi.spyOn(prisma.contextGraphObject, "findMany").mockImplementation(((args: Prisma.ContextGraphObjectFindManyArgs = {}) => {
    const run = async () => {
      const result = await read(args);
      if (!changed && args.take === 100) {
        changed = true;
        if (mode === "fresh-row") await prisma.contextGraphObject.update({where: {id: object.id}, data: {lastVerifiedAt: new Date("2021-01-02Z")}});
        else await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
      }
      return result;
    };
    return run() as ReturnType<typeof read>;
  }) as typeof prisma.contextGraphObject.findMany);
  const pending = markStaleContextGraphFacts(f.actor, {workspaceId: f.workspace.id, now: new Date("2021-01-02Z")});
  if (mode === "fresh-row") expect(await pending).toMatchObject({staleObjects: 0, staleRelationships: 0});
  else await expect(pending).rejects.toMatchObject({code: "NOT_A_MEMBER"});
  expect(changed).toBe(true);
  expect((await prisma.contextGraphObject.findUniqueOrThrow({where: {id: object.id}})).status).toBe("approved");
  expect(await prisma.artifactInputLineage.count({where: {artifactType: "ContextGraphObject", artifactId: object.id}})).toBe(1);
});


it("keeps the existing scheduled actor limited to genuinely readable facts", async () => {
  const f = await fixture(); const publicObject = await f.object("public-stale", true);
  const privateArticle = await prisma.brainArticle.create({data: {workspaceId: f.workspace.id, slug: "private-source", title: "Private",
    bodyMd: "Private input", type: "STRATEGY", authority: "DRAFT", isPrivate: true, ownerMemberId: f.member.id}});
  await f.original("BrainArticle", privateArticle);
  const privateObject = await prisma.contextGraphObject.create({data: {workspaceId: f.workspace.id, objectType: "Task", title: "Private derivative",
    status: "approved", updatedAt: new Date("2020-01-01Z")}});
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id,
    artifact: {kind: "ContextGraphObject", id: privateObject.id}, content: privateObject, origin: "DERIVED", inputs: [{kind: "BrainArticle", id: privateArticle.id}]}));
  const system = contextGraphSystemActor(f.workspace.id);
  expect(await markStaleContextGraphFacts(system, {workspaceId: f.workspace.id, now: new Date("2021-01-02Z")})).toMatchObject({staleObjects: 1, staleRelationships: 0});
  expect((await prisma.contextGraphObject.findUniqueOrThrow({where: {id: publicObject.id}})).status).toBe("stale");
  expect(await prisma.contextGraphObject.findUniqueOrThrow({where: {id: privateObject.id}})).toEqual(privateObject);
});
