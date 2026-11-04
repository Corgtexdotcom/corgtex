import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getArticle } from "./brain";
import * as lineage from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic Brain release", slug: randomUUID()}});
  const owner = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, displayName: "Owner", passwordHash: "synthetic"}});
  const reader = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, displayName: "Reader", passwordHash: "synthetic"}});
  const ownerMember = await prisma.member.create({data: {workspaceId: workspace.id, userId: owner.id, role: "ADMIN"}});
  const readerMember = await prisma.member.create({data: {workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR"}});
  const actor: AppActor = {kind: "user", user: {id: reader.id, email: reader.email, displayName: reader.displayName}};
  const author: AppActor = {kind: "user", user: {id: owner.id, email: owner.email, displayName: owner.displayName}};
  const makeArticle = async (slug: string) => prisma.brainArticle.create({data: {workspaceId: workspace.id,
    slug, title: slug, type: "STRATEGY", authority: "REFERENCE", bodyMd: `${slug} body`, sourceIds: [], ownerMemberId: ownerMember.id}});
  const input = await makeArticle("input");
  const article = await makeArticle("article");
  const linked = await makeArticle("linked");
  for (const row of [input, linked]) await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: author,
    workspaceId: workspace.id, artifact: {kind: "BrainArticle", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: author, workspaceId: workspace.id,
    artifact: {kind: "BrainArticle", id: article.id}, content: article, origin: "DERIVED", inputs: [{kind: "BrainArticle", id: input.id}]}));
  await prisma.brainBacklink.create({data: {workspaceId: workspace.id, fromArticleId: linked.id, toArticleId: article.id}});
  const thread = await prisma.brainDiscussionThread.create({data: {articleId: article.id, authorMemberId: ownerMember.id, targetType: "ARTICLE"}});
  const comment = await prisma.brainDiscussionComment.create({data: {threadId: thread.id, authorMemberId: readerMember.id, bodyMd: "Original comment"}});
  for (const [kind, row] of [["BrainDiscussionThread", thread], ["BrainDiscussionComment", comment]] as const)
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: author, workspaceId: workspace.id,
      artifact: {kind, id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
  return {workspaceId: workspace.id, actor, author, owner, ownerMember, readerMember, input, article, linked, thread, comment};
}
const read = (f: Awaited<ReturnType<typeof fixture>>) => getArticle(f.actor, {workspaceId: f.workspaceId, slug: f.article.slug});
async function replaceHead(workspaceId: string, kind: string, id: string) {
  const head = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId, artifactType: kind, artifactId: id}, orderBy: {revision: "desc"}});
  await prisma.artifactInputLineage.create({data: {...head, id: randomUUID(), revision: head.revision + 1,
    inputsJson: head.inputsJson ?? [], rootsJson: head.rootsJson ?? [], permissionEpochsJson: head.permissionEpochsJson ?? {}}});
}

it("preserves article, backlink labels, discussion order, authors and recipe redaction", async () => {
  const f = await fixture();
  expect(await read(f)).toMatchObject({bodyMd: "article body", ownerMember: {user: {displayName: "Owner"}},
    backlinksTo: [{fromArticle: {slug: "linked", title: "linked", type: "STRATEGY"}}],
    discussions: [{authorMember: {user: {displayName: "Owner"}}, comments: [{bodyMd: "Original comment", authorMember: {user: {displayName: "Reader"}}, agentRunId: null}]}],
    isPermissionVariant: false, variantOfArticleId: null, variantSourceStateJson: null});
});

it.each(["caller-restore", "input-restore", "article-head"] as const)("withholds original article after %s during backlink read", async change => {
  const f = await fixture(); let changed = false;
  const original = prisma.brainArticle.findMany.bind(prisma.brainArticle);
  vi.spyOn(prisma.brainArticle, "findMany").mockImplementation((async args => {
    if (!changed && args?.where?.id) {
      changed = true;
      if (change === "caller-restore") {
        await prisma.member.update({where: {id: f.readerMember.id}, data: {isActive: false}});
        await prisma.member.update({where: {id: f.readerMember.id}, data: {isActive: true}});
      } else if (change === "input-restore") {
        await prisma.brainArticle.update({where: {id: f.input.id}, data: {isPrivate: true}});
        await prisma.brainArticle.update({where: {id: f.input.id}, data: {isPrivate: false}});
      } else await replaceHead(f.workspaceId, "BrainArticle", f.article.id);
    }
    return original(args);
  }) as typeof prisma.brainArticle.findMany);
  await expect(read(f)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

it.each(["owner-label", "owner-restore", "owner-user-head", "thread-head", "comment-head", "linked-restore"] as const)(
  "withholds joined original inputs after %s during final comment-author admission", async change => {
    const f = await fixture(); let changed = false;
    const original = lineage.captureArtifactInputProof;
    vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
      const proof = await original(...args);
      if (!changed && args[2].some(input => input.kind === "Member" && input.id === f.readerMember.id)) {
        changed = true;
        if (change === "owner-label") await prisma.user.update({where: {id: f.owner.id}, data: {displayName: "Changed owner"}});
        else if (change === "owner-restore") {
          await prisma.member.update({where: {id: f.ownerMember.id}, data: {isActive: false}});
          await prisma.member.update({where: {id: f.ownerMember.id}, data: {isActive: true}});
        } else if (change === "owner-user-head") {
          await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: f.author, workspaceId: f.workspaceId,
            artifact: {kind: "User", id: f.owner.id}, content: f.owner, origin: "HUMAN_ORIGINAL", inputs: []}));
        } else if (change === "linked-restore") {
          await prisma.brainArticle.update({where: {id: f.linked.id}, data: {isPrivate: true}});
          await prisma.brainArticle.update({where: {id: f.linked.id}, data: {isPrivate: false}});
        } else await replaceHead(f.workspaceId, change === "thread-head" ? "BrainDiscussionThread" : "BrainDiscussionComment",
          change === "thread-head" ? f.thread.id : f.comment.id);
      }
      return proof;
    });
    await expect(read(f)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(changed).toBe(true);
  });


it("uses the admitted backlink label instead of the earlier include projection", async () => {
  const f = await fixture(); let changed = false;
  const original = prisma.brainArticle.findMany.bind(prisma.brainArticle);
  vi.spyOn(prisma.brainArticle, "findMany").mockImplementation((async args => {
    if (!changed && args?.where?.id) {
      changed = true;
      const updated = await prisma.brainArticle.update({where: {id: f.linked.id}, data: {title: "Current linked title"}});
      await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: f.author, workspaceId: f.workspaceId,
        artifact: {kind: "BrainArticle", id: updated.id}, content: updated, origin: "HUMAN_ORIGINAL", inputs: []}));
    }
    return original(args);
  }) as typeof prisma.brainArticle.findMany);
  expect((await read(f)).backlinksTo).toMatchObject([{fromArticle: {title: "Current linked title"}}]);
  expect(changed).toBe(true);
});

it("redacts an unproven owner and discussion author while preserving the readable article", async () => {
  const f = await fixture();
  const member = await prisma.member.findUniqueOrThrow({where: {id: f.ownerMember.id}, include: {user: true}});
  await prisma.$transaction(tx => lineage.invalidateArtifactInputLineage({tx, workspaceId: f.workspaceId,
    artifact: {kind: "Member", id: member.id}, content: member}));
  const result = await read(f);
  expect(result.ownerMember).toBeNull();
  expect(result.discussions[0]).toMatchObject({authorMember: null, authorMemberId: null});
  expect(result.bodyMd).toBe("article body");
});

it("preserves private, tenant and includeArchived admission boundaries", async () => {
  const f = await fixture();
  const foreign = await prisma.workspace.create({data: {name: "Foreign synthetic", slug: randomUUID()}});
  await prisma.member.create({data: {workspaceId: foreign.id, userId: f.readerMember.userId, role: "ADMIN"}});
  await expect(getArticle(f.actor, {workspaceId: foreign.id, slug: f.article.slug})).rejects.toMatchObject({code: "NOT_FOUND"});
  await prisma.brainArticle.update({where: {id: f.article.id}, data: {isPrivate: true}});
  await expect(read(f)).rejects.toMatchObject({code: "NOT_FOUND"});
  await prisma.brainArticle.update({where: {id: f.article.id}, data: {isPrivate: false, archivedAt: new Date()}});
  await expect(read(f)).rejects.toMatchObject({code: "NOT_FOUND"});
  await expect(getArticle(f.actor, {workspaceId: f.workspaceId, slug: f.article.slug, includeArchived: true}))
    .rejects.toMatchObject({code: "NOT_FOUND"});
});
