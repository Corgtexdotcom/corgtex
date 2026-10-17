import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listArticles } from "./brain";
import { DigestReadRelease } from "./digest-lineage";
import { recordArtifactInputLineage } from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic backlink counts", slug: randomUUID()}});
  const owner = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const reader = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const ownerMember = await prisma.member.create({data: {workspaceId: workspace.id, userId: owner.id, role: "ADMIN"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR"}});
  const actor: AppActor = {kind: "user", user: {id: reader.id, email: reader.email, displayName: null}};
  const author: AppActor = {kind: "user", user: {id: owner.id, email: owner.email, displayName: null}};
  async function article(slug: string, data: Partial<Prisma.BrainArticleUncheckedCreateInput> = {}, receipt = true) {
    const row = await prisma.brainArticle.create({data: {workspaceId: workspace.id, slug, title: slug, type: "STRATEGY",
      authority: "REFERENCE", bodyMd: `${slug} body`, sourceIds: [], ownerMemberId: ownerMember.id, ...data}});
    if (receipt) await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: author, workspaceId: workspace.id,
      artifact: {kind: "BrainArticle", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
    return row;
  }
  const target = await article("target", {type: "PROJECT", authority: "AUTHORITATIVE", lastVerifiedAt: new Date("2000-01-01")});
  const source = await article("current-strategy", {lastVerifiedAt: new Date()});
  const link = (fromArticleId: string, workspaceId = workspace.id) => prisma.brainBacklink.create({data: {workspaceId, fromArticleId, toArticleId: target.id}});
  await link(source.id);
  return {workspaceId: workspace.id, actor, article, link, target, owner, ownerMember};
}

it.each([
  {type: "PROJECT" as const}, {authority: "AUTHORITATIVE" as const}, {stale: true},
  {type: "PROJECT" as const, authority: "AUTHORITATIVE" as const, stale: true},
])("counts a visible current STRATEGY backlink independently of target filter %j", async filter => {
  const f = await fixture();
  const result = await listArticles(f.actor, {workspaceId: f.workspaceId, ...filter});
  expect(result.total).toBe(1);
  expect(result.items).toMatchObject([{id: f.target.id, _count: {backlinksTo: 1}}]);
});

it("keeps private, unknown, foreign and archived backlink sources excluded while filters select the target", async () => {
  const f = await fixture();
  const hidden = await f.article("private", {isPrivate: true, authority: "DRAFT"});
  const unknown = await f.article("unknown", {}, false);
  const archived = await f.article("archived", {archivedAt: new Date()});
  const foreignWorkspace = await prisma.workspace.create({data: {name: "Synthetic foreign", slug: randomUUID()}});
  const foreign = await prisma.brainArticle.create({data: {workspaceId: foreignWorkspace.id, slug: "foreign", title: "foreign",
    type: "STRATEGY", authority: "REFERENCE", bodyMd: "Foreign body"}});
  await Promise.all([f.link(hidden.id), f.link(unknown.id), f.link(archived.id), f.link(foreign.id), f.link(f.target.id, foreignWorkspace.id)]);
  const result = await listArticles(f.actor, {workspaceId: f.workspaceId, type: "PROJECT", authority: "AUTHORITATIVE", stale: true});
  expect(result.total).toBe(1);
  expect(result.items).toMatchObject([{id: f.target.id, _count: {backlinksTo: 1}}]);
});


it.each(["member", "user"] as const)("withholds a listed article owner after its %s changes during related reads", async change => {
  const f = await fixture();
  expect((await listArticles(f.actor, {workspaceId: f.workspaceId, type: "PROJECT"})).items[0].ownerMember)
    .toMatchObject({id: f.ownerMember.id, user: {email: f.owner.email}});
  const delegate = prisma.brainDiscussionThread;
  const read = delegate.findMany.bind(delegate);
  let changed = false;
  vi.spyOn(delegate, "findMany").mockImplementation((async (...args: Parameters<typeof read>) => {
    if (!changed) {
      changed = true;
      if (change === "member") await prisma.member.update({where: {id: f.ownerMember.id}, data: {isActive: false}});
      else await prisma.user.update({where: {id: f.owner.id}, data: {bio: "Changed after owner capture"}});
    }
    return read(...args);
  }) as typeof delegate.findMany);
  await expect(listArticles(f.actor, {workspaceId: f.workspaceId, type: "PROJECT"}))
    .rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});


it("retains the listed owner profile through a caller-owned final release", async () => {
  const f = await fixture();
  const release = new DigestReadRelease(f.actor, f.workspaceId);
  const result = await listArticles(f.actor, {workspaceId: f.workspaceId, type: "PROJECT"}, release);
  expect(result.items[0].ownerMember).toMatchObject({id: f.ownerMember.id, user: {email: f.owner.email}});
  await prisma.user.update({where: {id: f.owner.id}, data: {bio: "Changed after list returned"}});
  await expect(release.finish(result)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
});
