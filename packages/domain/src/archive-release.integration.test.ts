import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createArticle } from "./brain";
import { lineageContentFingerprint } from "./source-lineage";
import { archiveWorkspaceArtifact, listArchivedWorkspaceArtifacts } from "./archive";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic archive", slug: randomUUID() } });
  const owner = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  const readerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "ADMIN" } });
  const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
  const actor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: "Reader" } };
  const article = await createArticle(ownerActor, { workspaceId: workspace.id, slug: "visible", title: "Synthetic original",
    bodyMd: "Synthetic archive body", type: "PROJECT", authority: "REFERENCE" });
  await archiveWorkspaceArtifact(ownerActor, { workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id });
  const record = await prisma.workspaceArchiveRecord.findFirstOrThrow({ where: { workspaceId: workspace.id, entityId: article.id } });
  return { workspaceId: workspace.id, actor, ownerActor, ownerMember, readerMember, article, record };
}

describe("archive page release", () => {
  it("keeps archived originals readable to an authorized nonpublisher and returns only metadata", async () => {
    const f = await setup();
    const page = await listArchivedWorkspaceArtifacts(f.actor, { workspaceId: f.workspaceId });
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ entityId: f.article.id, entityLabel: "BrainArticle", archiveReason: null });
    expect(page[0].permanentPath).toEqual(expect.any(String));
    expect(JSON.stringify(page)).not.toContain("Synthetic archive body");
  });

  it("replenishes past 5001 denied candidates with stable tied ordering and readable skip/take", async () => {
    const f = await setup();
    const privateArticle = await createArticle(f.ownerActor, { workspaceId: f.workspaceId, slug: "private", title: "Private",
      bodyMd: "Private synthetic", type: "PROJECT", authority: "DRAFT", isPrivate: true });
    await archiveWorkspaceArtifact(f.ownerActor, { workspaceId: f.workspaceId, entityType: "BrainArticle", entityId: privateArticle.id });
    // Existing ADMIN policy permits private originals. An unknown lineage is
    // denied to every caller, including administrators.
    await prisma.artifactInputLineage.updateMany({ where: { workspaceId: f.workspaceId, artifactId: privateArticle.id }, data: { origin: "UNKNOWN" } });
    await prisma.workspaceArchiveRecord.deleteMany({ where: { workspaceId: f.workspaceId } });
    const at = new Date("2026-10-15T00:00:00Z");
    await prisma.workspaceArchiveRecord.createMany({ data: Array.from({ length: 5004 }, (_, i) => ({
      id: `archive-${String(i).padStart(5, "0")}`, workspaceId: f.workspaceId, entityType: "BrainArticle",
      entityId: i < 5001 ? privateArticle.id : f.article.id, entityLabel: "Synthetic", archivedAt: at,
    })) });
    const query = vi.spyOn(prisma.workspaceArchiveRecord, "findMany");
    const page = await listArchivedWorkspaceArtifacts(f.actor, { workspaceId: f.workspaceId, take: 2, skip: 1 });
    expect(page.map(row => row.id)).toEqual(["archive-05002", "archive-05003"]);
    expect(query.mock.calls.length).toBe(51);
    for (const [args] of query.mock.calls) expect(args).toMatchObject({ take: 100, orderBy: [{ archivedAt: "desc" }, { id: "asc" }] });
  }, 120_000);

  for (const phase of ["permalink", "later-candidates"] as const) {
    it.each(["membership-loss", "membership-restore", "source-restore", "head-replacement"] as const)(
      `withholds admitted metadata after %s during ${phase}`, async change => {
        const f = await setup();
        let changed = false;
        const mutate = async () => {
          changed = true;
          if (change.startsWith("membership")) {
            await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
            if (change === "membership-restore") await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: true } });
          } else if (change === "source-restore") {
            const before = await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.article.id } });
            await prisma.brainArticle.update({ where: { id: f.article.id }, data: { isPrivate: true, ownerMemberId: f.ownerMember.id } });
            const restored = await prisma.brainArticle.update({ where: { id: f.article.id }, data: {
              isPrivate: before.isPrivate, ownerMemberId: before.ownerMemberId, updatedAt: before.updatedAt,
            } });
            expect(lineageContentFingerprint("BrainArticle", restored)).toBe(lineageContentFingerprint("BrainArticle", before));
          } else {
            const prior = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspaceId, artifactType: "BrainArticle", artifactId: f.article.id }, orderBy: { revision: "desc" } });
            await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" ("id", "workspaceId", "artifactType", "artifactId", "revision", "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson") SELECT ${randomUUID()}, "workspaceId", "artifactType", "artifactId", "revision" + 1, "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson" FROM "ArtifactInputLineage" WHERE "id" = ${prior.id}`;
          }
        };
        if (phase === "permalink") {
          const original = prisma.workspacePermalink.findMany.bind(prisma.workspacePermalink);
          vi.spyOn(prisma.workspacePermalink, "findMany").mockImplementation((async args => {
            const result = await original(args); await mutate(); return result;
          }) as typeof prisma.workspacePermalink.findMany);
        } else {
          await prisma.workspaceArchiveRecord.createMany({ data: Array.from({ length: 100 }, (_, i) => ({
            workspaceId: f.workspaceId, entityType: "UnknownArtifact", entityId: `denied-${i}`,
            entityLabel: "Synthetic", archivedAt: new Date(0),
          })) });
          const original = prisma.workspaceArchiveRecord.findMany.bind(prisma.workspaceArchiveRecord);
          let calls = 0;
          vi.spyOn(prisma.workspaceArchiveRecord, "findMany").mockImplementation((async args => {
            const result = await original(args);
            if (++calls === 2) await mutate();
            return result;
          }) as typeof prisma.workspaceArchiveRecord.findMany);
        }
        await expect(listArchivedWorkspaceArtifacts(f.actor, { workspaceId: f.workspaceId, take: 2 }))
          .rejects.toMatchObject({ code: change === "membership-loss" ? "NOT_A_MEMBER" : "SOURCE_CHANGED" });
        expect(changed).toBe(true);
      });
  }
});
