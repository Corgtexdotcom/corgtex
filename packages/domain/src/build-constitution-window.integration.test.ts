import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {prisma, type AppActor} from "@corgtex/shared";
import {truncateAllTables} from "../../shared/src/db-test-utils";
import {listBuildArtifactPage, listBuildArtifacts} from "./build-artifacts";
import {listConstitutionVersionPage, listConstitutionVersions} from "./constitutions";
import {recordArtifactInputLineage} from "./source-lineage";
import {DigestReadRelease} from "./digest-lineage";
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic bounded history", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  return {workspaceId: workspace.id, actor, member};
}
it.each(["build", "constitution"] as const)("continues a200 hidden %s window to proven older rows without false global emptiness", async kind => {
  const f = await fixture(); const now = new Date("2026-01-01T00:00:00Z");
  if (kind === "build") {
    await prisma.buildArtifact.createMany({data: Array.from({length: 202}, (_, index) => ({id: `build-${String(index).padStart(4,"0")}`,
      workspaceId: f.workspaceId, title: `Synthetic ${index}`, repositoryOwner: "synthetic", repositoryName: `repo-${index}`, createdAt: now, updatedAt: now}))});
    const rows = await prisma.buildArtifact.findMany({where: {workspaceId: f.workspaceId, id: {gte: "build-0200"}}});
    for (const row of rows) await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: {kind: "BuildArtifact", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
  } else {
    await prisma.constitution.createMany({data: Array.from({length: 202}, (_, index) => ({workspaceId: f.workspaceId, version: 202-index, bodyMd: `Synthetic ${index}`, modelUsed: "synthetic"}))});
    const rows = await prisma.constitution.findMany({where: {workspaceId: f.workspaceId, version: {lte: 2}}});
    for (const row of rows) await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: {kind: "Constitution", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
  }
  const read = (cursor?: string, workspaceId=f.workspaceId) => kind === "build"
    ? listBuildArtifactPage(f.actor, {workspaceId, take: 1, cursor}) : listConstitutionVersionPage(f.actor, workspaceId, {take: 1, cursor});
  const query = kind === "build" ? vi.spyOn(prisma.buildArtifact, "findMany") : vi.spyOn(prisma.constitution, "findMany");
  const first = await read(); expect(first).toMatchObject({items: [], complete: false, hasMore: true});
  expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][0]?.take).toBe(200);
  const second = await read(first.nextCursor!); const third = await read(second.nextCursor!);
  expect(second.items).toHaveLength(1); expect(second.complete).toBe(false);
  expect(third.items).toHaveLength(1); expect(third.complete).toBe(true);
  expect(second.items[0].id).not.toBe(third.items[0].id);
  await expect(read(first.nextCursor!, "foreign-workspace")).rejects.toMatchObject({code: "INVALID_INPUT"});
  await expect(kind === "build" ? listBuildArtifacts(f.actor, {workspaceId: f.workspaceId}) : listConstitutionVersions(f.actor, f.workspaceId))
    .rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
},60_000);
it.each(["head", "caller-restore"] as const)("retains original build proofs through final %s change", async mode => {
  const f = await fixture();
  const row = await prisma.buildArtifact.create({data: {workspaceId: f.workspaceId, title: "Original build", repositoryOwner: "synthetic", repositoryName: "product"}});
  const mint = () => prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: {kind: "BuildArtifact", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
  await mint();
  expect((await listBuildArtifactPage(f.actor, {workspaceId: f.workspaceId})).items[0]).toMatchObject({id: row.id, title: row.title});
  const finish = DigestReadRelease.prototype.finish; let changed = false;
  vi.spyOn(DigestReadRelease.prototype, "finish").mockImplementation(async function<T>(this: DigestReadRelease, value: T) {
    if (mode === "head") await mint();
    else {
      await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
      await prisma.member.update({where: {id: f.member.id}, data: {isActive: true}});
    }
    changed = true; return finish.call(this, value) as Promise<T>;
  });
  await expect(listBuildArtifactPage(f.actor, {workspaceId: f.workspaceId})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});
