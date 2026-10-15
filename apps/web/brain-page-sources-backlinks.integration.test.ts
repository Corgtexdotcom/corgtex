import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../packages/shared/src/db-test-utils";
import { listSources, rebuildBacklinks } from "../../packages/domain/src/brain";
import * as lineage from "../../packages/domain/src/source-lineage";
const pageActor = vi.hoisted(() => ({value: null as AppActor | null}));
vi.mock("@/lib/auth", () => ({requirePageActor: async () => pageActor.value}));
vi.mock("next-intl/server", () => ({getTranslations: async () => (key: string) => key}));
vi.mock("@corgtex/domain", async () => ({...await import("../../packages/domain/src/brain"), ...await import("../../packages/domain/src/auth"), ...await import("../../packages/domain/src/archive")}));
vi.mock("@/lib/components/MarkdownEditor", () => ({MarkdownEditor: () => null}));
vi.mock("@/lib/components/MarkdownRenderer", () => ({MarkdownRenderer: () => null}));
vi.mock("@/lib/components/ArchivedItemBanner", () => ({ArchivedItemBanner: () => null}));
vi.mock("@/app/[locale]/workspaces/[workspaceId]/brain/actions", () => ({publishArticleAction: vi.fn(), returnArticleToDraftAction: vi.fn()}));
vi.mock("@/app/[locale]/workspaces/[workspaceId]/brain/BrainArticleTypeControl", () => ({BrainArticleTypeControl: () => null}));
import ArticlePage from "./app/[locale]/workspaces/[workspaceId]/brain/[slug]/page";

beforeEach(async () => { vi.stubGlobal("React", React); await truncateAllTables(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic Brain boundaries", slug: randomUUID()}});
  await prisma.workspaceFeatureFlag.create({data: {workspaceId: workspace.id, flag: "FINANCE", enabled: false}});
  const owner = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, displayName: "Original author", passwordHash: "synthetic"}});
  const reader = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const ownerMember = await prisma.member.create({data: {workspaceId: workspace.id, userId: owner.id, role: "ADMIN"}});
  const readerMember = await prisma.member.create({data: {workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR"}});
  const actor: AppActor = {kind: "user", user: {id: reader.id, email: reader.email, displayName: null}};
  const author: AppActor = {kind: "user", user: {id: owner.id, email: owner.email, displayName: owner.displayName}};
  pageActor.value = actor;
  async function article(slug: string, bodyMd = "Original body", isPrivate = false, sourceIds: string[] = []) {
    const row = await prisma.brainArticle.create({data: {workspaceId: workspace.id, slug, title: slug, type: "STRATEGY",
      authority: isPrivate ? "DRAFT" : "REFERENCE", bodyMd, isPrivate, ownerMemberId: ownerMember.id, sourceIds}});
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: author, workspaceId: workspace.id,
      artifact: {kind: "BrainArticle", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
    return row;
  }
  async function source(title: string, accessDomain: "WORKSPACE" | "FINANCE" = "WORKSPACE") {
    const row = await prisma.brainSource.create({data: {workspaceId: workspace.id, title, content: `${title} content`, tier: 1,
      sourceType: "RESEARCH", accessDomain, authorMemberId: ownerMember.id}});
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: author, workspaceId: workspace.id,
      artifact: {kind: "BrainSource", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
    return row;
  }
  return {workspaceId: workspace.id, actor, author, owner, ownerMember, readerMember, article, source};
}
async function replaceHead(workspaceId: string, kind: string, id: string) {
  const head = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId, artifactType: kind, artifactId: id}, orderBy: {revision: "desc"}});
  await prisma.artifactInputLineage.create({data: {...head, id: randomUUID(), revision: head.revision + 1,
    inputsJson: head.inputsJson ?? [], rootsJson: head.rootsJson ?? [], permissionEpochsJson: head.permissionEpochsJson ?? {}}});
}

it("withholds the actual article page after a main head replacement in its later sidebar query", async () => {
  const f = await fixture(); const article = await f.article("main"); let changed = false;
  const original = prisma.brainArticle.findMany.bind(prisma.brainArticle);
  vi.spyOn(prisma.brainArticle, "findMany").mockImplementation((async args => {
    if (!changed && args?.take === 100) {changed = true; await replaceHead(f.workspaceId, "BrainArticle", article.id);}
    return original(args);
  }) as typeof prisma.brainArticle.findMany);
  await expect(ArticlePage({params: Promise.resolve({workspaceId: f.workspaceId, slug: article.slug})})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

it("omits denied direct source labels and file-link contributions from the actual article page", async () => {
  const f = await fixture(); const hidden = await f.source("HIDDEN FINANCE SOURCE", "FINANCE");
  const article = await f.article("main", "Original body", false, [hidden.id]);
  const result = await ArticlePage({params: Promise.resolve({workspaceId: f.workspaceId, slug: article.slug})});
  expect(renderToStaticMarkup(result)).not.toContain(hidden.title);
});

it("withholds an early source after its head changes during a later source page", async () => {
  const f = await fixture(); const selected = await f.source("selected");
  await prisma.brainSource.createMany({data: Array.from({length: 100}, (_, i) => ({workspaceId: f.workspaceId,
    sourceType: "CONVERSATION" as const, tier: 1, title: `unknown-${i}`, content: "Unknown body",
    createdAt: new Date(selected.createdAt.getTime() - i - 1)}))});
  let changed = false; const original = prisma.brainSource.findMany.bind(prisma.brainSource);
  vi.spyOn(prisma.brainSource, "findMany").mockImplementation((async args => {
    if (!changed && args?.cursor) {changed = true; await replaceHead(f.workspaceId, "BrainSource", selected.id);}
    return original(args);
  }) as typeof prisma.brainSource.findMany);
  await expect(listSources(f.actor, {workspaceId: f.workspaceId, take: 1})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

it("preserves hidden target edges while replacing only the admitted backlink cohort", async () => {
  const f = await fixture(); const from = await f.article("from", "[[hidden]] [[new]]");
  const hidden = await f.article("hidden", "Private body", true); const old = await f.article("old"); const added = await f.article("new");
  await prisma.brainBacklink.createMany({data: [hidden, old].map(target => ({workspaceId: f.workspaceId, fromArticleId: from.id, toArticleId: target.id}))});
  const agent: AppActor = {kind: "agent", authProvider: "bootstrap", label: "brain-absorb", workspaceIds: [f.workspaceId]};
  await rebuildBacklinks(agent, {workspaceId: f.workspaceId});
  const edges = await prisma.brainBacklink.findMany({where: {workspaceId: f.workspaceId, fromArticleId: from.id}});
  expect(edges.map(edge => edge.toArticleId).sort()).toEqual([hidden.id, added.id].sort());
});

it.each(["caller-restore", "input-restore"] as const)("withholds the page after %s during the final source query", async change => {
  const f = await fixture(); const source = await f.source("Visible source"); const input = await f.article("input");
  const article = await f.article("main", "Derived body", false, [source.id]);
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: f.author, workspaceId: f.workspaceId,
    artifact: {kind: "BrainArticle", id: article.id}, content: article, origin: "DERIVED", inputs: [{kind: "BrainArticle", id: input.id}]}));
  let changed = false; const original = prisma.brainSource.findMany.bind(prisma.brainSource);
  vi.spyOn(prisma.brainSource, "findMany").mockImplementation((async args => {
    if (!changed && args?.where?.id) {
      changed = true;
      if (change === "caller-restore") {
        await prisma.member.update({where: {id: f.readerMember.id}, data: {isActive: false}});
        await prisma.member.update({where: {id: f.readerMember.id}, data: {isActive: true}});
      } else {
        await prisma.brainArticle.update({where: {id: input.id}, data: {isPrivate: true}});
        await prisma.brainArticle.update({where: {id: input.id}, data: {isPrivate: false}});
      }
    }
    return original(args);
  }) as typeof prisma.brainSource.findMany);
  await expect(ArticlePage({params: Promise.resolve({workspaceId: f.workspaceId, slug: article.slug})})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

it("renders admitted page source labels and sidebar links while excluding foreign sources", async () => {
  const f = await fixture(); const visible = await f.source("VISIBLE SOURCE"); const foreign = await fixture();
  const excluded = await foreign.source("FOREIGN SOURCE"); pageActor.value = f.actor;
  const article = await f.article("main", "Original body", false, [visible.id, excluded.id]);
  await f.article("sidebar");
  const html = renderToStaticMarkup(await ArticlePage({params: Promise.resolve({workspaceId: f.workspaceId, slug: article.slug})}));
  expect(html).toContain(visible.title); expect(html).toContain("sidebar"); expect(html).not.toContain(excluded.title);
});

async function deniedTail(workspaceId: string, before: Date) {
  await prisma.brainSource.createMany({data: Array.from({length: 100}, (_, i) => ({workspaceId,
    sourceType: "CONVERSATION" as const, tier: 1, title: `unknown-${i}`, content: "Unknown body",
    createdAt: new Date(before.getTime() - i - 1)}))});
}
it.each(["caller-restore", "counted-source-restore", "author-label", "author-head"] as const)(
  "withholds source items and exact total after %s during the later page", async change => {
    const f = await fixture(); const selected = await f.source("selected"); const counted = await f.source("counted only");
    await deniedTail(f.workspaceId, selected.createdAt);
    let changed = false; const original = prisma.brainSource.findMany.bind(prisma.brainSource);
    vi.spyOn(prisma.brainSource, "findMany").mockImplementation((async args => {
      if (!changed && args?.cursor) {
        changed = true;
        if (change === "caller-restore") {
          await prisma.member.update({where: {id: f.readerMember.id}, data: {isActive: false}});
          await prisma.member.update({where: {id: f.readerMember.id}, data: {isActive: true}});
        } else if (change === "counted-source-restore") {
          await prisma.brainSource.update({where: {id: counted.id}, data: {accessDomain: "FINANCE"}});
          await prisma.brainSource.update({where: {id: counted.id}, data: {accessDomain: "WORKSPACE"}});
        } else if (change === "author-label") await prisma.user.update({where: {id: f.owner.id}, data: {displayName: "Changed author"}});
        else await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: f.author, workspaceId: f.workspaceId,
          artifact: {kind: "User", id: f.owner.id}, content: f.owner, origin: "HUMAN_ORIGINAL", inputs: []}));
      }
      return original(args);
    }) as typeof prisma.brainSource.findMany);
    await expect(listSources(f.actor, {workspaceId: f.workspaceId, take: 1, skip: 1})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(changed).toBe(true);
  });

it("preserves source pagination, exact visible total, complete body and author labels", async () => {
  const f = await fixture(); await prisma.user.update({where: {id: f.owner.id}, data: {bio: "Author biography"}});
  const first = await f.source("first"); await f.source("second"); await f.source("hidden", "FINANCE");
  const result = await listSources(f.actor, {workspaceId: f.workspaceId, take: 1, skip: 1});
  expect(result).toMatchObject({total: 2, take: 1, skip: 1, items: [{id: first.id, content: first.content,
    authorMember: {user: {displayName: "Original author", email: f.owner.email}}}]});
  expect(Object.keys(result.items[0].authorMember!.user).sort()).toEqual(["displayName", "email"]);
});

it.each(["head", "caller-restore"] as const)("withholds backlink mutations after an original cohort %s change", async change => {
  const f = await fixture(); const from = await f.article("from", "[[new]]"); const old = await f.article("old"); await f.article("new");
  const edge = await prisma.brainBacklink.create({data: {workspaceId: f.workspaceId, fromArticleId: from.id, toArticleId: old.id}});
  let changed = false; const original = lineage.captureArtifactInputProof;
  vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
    const proof = await original(...args);
    if (!changed && args[2].some(input => input.kind === "BrainArticle" && input.id === from.id)) {
      changed = true;
      if (change === "head") await replaceHead(f.workspaceId, "BrainArticle", from.id);
      else {
        await prisma.member.update({where: {id: f.readerMember.id}, data: {isActive: false}});
        await prisma.member.update({where: {id: f.readerMember.id}, data: {isActive: true}});
      }
    }
    return proof;
  });
  await expect(rebuildBacklinks(f.actor, {workspaceId: f.workspaceId})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
  expect(await prisma.brainBacklink.findMany({where: {workspaceId: f.workspaceId}})).toEqual([edge]);
});

it("honors a supplied transaction and rolls back replacement when the enclosing owner fence is lost", async () => {
  const f = await fixture(); const from = await f.article("from", "[[new]]"); const old = await f.article("old"); const target = await f.article("new");
  const edge = await prisma.brainBacklink.create({data: {workspaceId: f.workspaceId, fromArticleId: from.id, toArticleId: old.id}});
  let checks = 0;
  await expect(lineage.withArtifactInputWriteFence(async () => { if (++checks === 2) throw new Error("Synthetic owner lost"); },
    () => prisma.$transaction(tx => rebuildBacklinks(f.actor, {workspaceId: f.workspaceId, tx}))))
    .rejects.toThrow("Synthetic owner lost");
  expect(await prisma.brainBacklink.findMany({where: {workspaceId: f.workspaceId}})).toEqual([edge]);
  await prisma.$transaction(tx => rebuildBacklinks(f.actor, {workspaceId: f.workspaceId, tx}));
  expect(await prisma.brainBacklink.findMany({where: {workspaceId: f.workspaceId}})).toMatchObject([{fromArticleId: from.id, toArticleId: target.id}]);
});

it("retains original heads inside a supplied backlink transaction", async () => {
  const f = await fixture(); const from = await f.article("from", "[[new]]"); const old = await f.article("old"); await f.article("new");
  const edge = await prisma.brainBacklink.create({data: {workspaceId: f.workspaceId, fromArticleId: from.id, toArticleId: old.id}});
  let changed = false; const original = lineage.captureArtifactInputProof;
  vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
    const proof = await original(...args);
    if (!changed && args[2].some(input => input.id === from.id)) {
      changed = true; const tx = args[3]!;
      const head = await tx.artifactInputLineage.findFirstOrThrow({where: {workspaceId: f.workspaceId, artifactType: "BrainArticle", artifactId: from.id}, orderBy: {revision: "desc"}});
      await tx.artifactInputLineage.create({data: {...head, id: randomUUID(), revision: head.revision + 1,
        inputsJson: head.inputsJson ?? [], rootsJson: head.rootsJson ?? [], permissionEpochsJson: head.permissionEpochsJson ?? {}}});
    }
    return proof;
  });
  await expect(prisma.$transaction(tx => rebuildBacklinks(f.actor, {workspaceId: f.workspaceId, tx}))).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
  expect(await prisma.brainBacklink.findMany({where: {workspaceId: f.workspaceId}})).toEqual([edge]);
});
