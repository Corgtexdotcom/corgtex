import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createArticle, getArticlePageData } from "./brain";
import { ArchiveMetadataReadRelease, archiveWorkspaceArtifact, getWorkspaceArchiveRecord } from "./archive";
import { DigestReadRelease } from "./digest-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture(archived = true) {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic archive release", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user: {id: user.id, email: user.email, displayName: null}};
  const article = await createArticle(actor, {workspaceId: workspace.id, slug: "original", title: "Original title canary",
    bodyMd: "Original body canary", type: "PROJECT", authority: "REFERENCE"});
  const params = {workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id};
  if (archived) await archiveWorkspaceArtifact(actor, params);
  return {workspace, actor, article, member, params};
}

it("releases authorized archive metadata alone and with the caller's content collector", async () => {
  const f = await fixture();
  const release = new ArchiveMetadataReadRelease(f.actor, f.workspace.id);
  const record = await getWorkspaceArchiveRecord(f.actor, f.params, release);
  expect(record).toMatchObject({entityId: f.article.id, entityLabel: "BrainArticle", archiveReason: null});
  const content = new DigestReadRelease(f.actor, f.workspace.id);
  expect((await content.capture("Member", [f.member])).records).toHaveLength(1);
  expect(await release.finish({record}, content)).toEqual({record});
  expect(await getWorkspaceArchiveRecord(f.actor, f.params)).toEqual(record);
  expect(JSON.stringify(record)).not.toContain("canary");
});

it.each(["caller-aba", "source", "head", "restored", "purged", "deleted"] as const)(
  "withholds original archive metadata after %s during a later caller await", async change => {
    const f = await fixture(); const release = new ArchiveMetadataReadRelease(f.actor, f.workspace.id);
    const record = await getWorkspaceArchiveRecord(f.actor, f.params, release);
    expect(record).not.toBeNull();
    // This is the real caller gap: original metadata was already admitted.
    if (change === "caller-aba") {
      await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
      await prisma.member.update({where: {id: f.member.id}, data: {isActive: true}});
    } else if (change === "source") {
      await prisma.brainArticle.update({where: {id: f.article.id}, data: {isPrivate: true}});
    } else if (change === "head") {
      const head = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId: f.workspace.id,
        artifactType: "BrainArticle", artifactId: f.article.id}, orderBy: {revision: "desc"}});
      await prisma.artifactInputLineage.create({data: {...head, id: randomUUID(), revision: head.revision + 1,
        inputsJson: head.inputsJson ?? [], rootsJson: head.rootsJson ?? [], permissionEpochsJson: head.permissionEpochsJson ?? {}}});
    } else if (change === "deleted") await prisma.workspaceArchiveRecord.delete({where: {id: record!.id}});
    else await prisma.workspaceArchiveRecord.update({where: {id: record!.id}, data: change === "restored"
      ? {restoredAt: new Date()} : {purgedAt: new Date()}});
    await expect(release.finish({record})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });

it("preserves actual Brain page active success and archived content denial", async () => {
  const f = await fixture(false);
  expect(await getArticlePageData(f.actor, {workspaceId: f.workspace.id, slug: f.article.slug}))
    .toMatchObject({article: {id: f.article.id}, archiveRecord: null, isArchived: false});
  await archiveWorkspaceArtifact(f.actor, f.params);
  await expect(getArticlePageData(f.actor, {workspaceId: f.workspace.id, slug: f.article.slug}))
    .rejects.toMatchObject({code: "NOT_FOUND"});
  expect(await getWorkspaceArchiveRecord(f.actor, f.params)).not.toBeNull();
});
