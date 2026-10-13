import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createArticle, ingestSource, readableArtifactIds, isArtifactInputProofReadable, captureArtifactInputProof } from "@corgtex/domain";
import { absorbSource } from "./brain-absorb";

vi.mock("@corgtex/knowledge", () => ({ syncBrainArticleKnowledge: vi.fn(async () => 0) }));

beforeEach(truncateAllTables);

it("does not match or expose another member's private human draft", async () => {
  const workspace = await prisma.workspace.create({ data: {
    name: "Private draft isolation", slug: `private-absorb-${randomUUID()}`,
  } });
  const owner = await prisma.user.create({ data: { email: `private-owner-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "CONTRIBUTOR" } });
  const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
  const original = await createArticle(ownerActor, { workspaceId: workspace.id, slug: "owner-draft",
    title: "Owner draft", type: "PROJECT", bodyMd: "Private human text", authority: "DRAFT" });
  const source = await ingestSource(ownerActor, { workspaceId: workspace.id, sourceType: "RESEARCH",
    tier: 2, title: "Unrelated source", content: "Shared synthetic fact" });
  const extract = vi.spyOn(defaultModelGateway, "extract").mockResolvedValue({ output: {
    articleType: "PROJECT", createNew: { title: "Owner draft", slug: "owner-draft" }, summary: "Shared fact",
  } } as never);
  const chat = vi.spyOn(defaultModelGateway, "chat").mockResolvedValue({ content: "Shared synthetic fact" } as never);
  try {
    const result = await absorbSource({ workspaceId: workspace.id, sourceId: source.id, agentRunId: "private-run" });
    expect(result).toMatchObject({ absorbed: true, updatedSlugs: [], createdSlug: expect.stringMatching(/^owner-draft-[a-f0-9]{16}$/), touchedArticleCount: 1 });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: original.id } }))
      .toMatchObject({ bodyMd: "Private human text", sourceIds: [] });
    const generated = await prisma.brainArticle.findFirstOrThrow({ where: {
      workspaceId: workspace.id, sourceIds: {has: source.id}, isPrivate: false,
    } });
    expect(generated.sourceIds).toEqual([source.id]);
  } finally {
    extract.mockRestore();
    chat.mockRestore();
  }
});

it("records both verified sources in a fresh proposal while preserving the prior generated draft", async () => {
  const workspace = await prisma.workspace.create({ data: {
    name: "Multi-source absorption", slug: `multi-absorb-${randomUUID()}`,
  } });
  const user = await prisma.user.create({ data: { email: `multi-absorb-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const admin: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Admin" } };
  const first = await ingestSource(admin, {
    workspaceId: workspace.id, sourceType: "RESEARCH", tier: 2, title: "First source", content: "First verified facts",
  });
  const second = await ingestSource(admin, {
    workspaceId: workspace.id, sourceType: "RESEARCH", tier: 2, title: "Second source", content: "Second verified facts",
  });
  const extract = vi.spyOn(defaultModelGateway, "extract")
    .mockResolvedValueOnce({ output: { articleType: "PROJECT", updateSlugs: [],
      createNew: { title: "Synthetic project", slug: "synthetic-project" }, summary: "Created" } } as never)
    .mockResolvedValueOnce({ output: { articleType: "PROJECT",
      createNew: { title: "Synthetic project", slug: "synthetic-project" }, summary: "Updated" } } as never);
  const chat = vi.spyOn(defaultModelGateway, "chat")
    .mockResolvedValueOnce({ content: "Body from first source" } as never)
    .mockResolvedValueOnce({ content: "Body from both sources" } as never);
  try {
    expect(await absorbSource({ workspaceId: workspace.id, sourceId: first.id, agentRunId: "first-run" }))
      .toMatchObject({ absorbed: true, createdSlug: expect.stringMatching(/^synthetic-project-[a-f0-9]{16}$/) });
    const prior = await prisma.brainArticle.findFirstOrThrow({where: {workspaceId: workspace.id, sourceIds: {equals: [first.id]}}});
    expect(await absorbSource({ workspaceId: workspace.id, sourceId: second.id, agentRunId: "second-run" }))
      .toMatchObject({ absorbed: true, updatedSlugs: [] });
    const article = await prisma.brainArticle.findFirstOrThrow({ where: { workspaceId: workspace.id, sourceIds: {hasEvery: [first.id, second.id]} } });
    expect(article.sourceIds).toEqual([first.id, second.id]);
    expect(article.bodyMd).toBe("Body from both sources");
    expect(article.id).not.toBe(prior.id);
    expect(article.isPrivate).toBe(false);
    expect(await prisma.brainArticle.findUniqueOrThrow({where: {id: prior.id}})).toMatchObject({bodyMd: "Body from first source", sourceIds: [first.id]});
    expect(await prisma.brainArticleVersion.count({where: {articleId: prior.id}})).toBe(0);
    expect(await readableArtifactIds(admin, workspace.id, "BrainArticle", [article])).toEqual(new Set([article.id]));
    const proof = await captureArtifactInputProof(admin, workspace.id, [{kind: "BrainArticle", id: article.id}]);
    const snapshots = await prisma.artifactInputSnapshot.findMany({where: {workspaceId: workspace.id}});
    expect(snapshots.some(row => row.sourceKind === "BrainArticle" && row.sourceId === prior.id)).toBe(true);
    expect(await isArtifactInputProofReadable(admin, workspace.id, proof)).toBe(true);
    await prisma.brainSource.update({where: {id: first.id}, data: {archivedAt: new Date()}});
    expect(await readableArtifactIds(admin, workspace.id, "BrainArticle", [article])).toEqual(new Set());
    expect((await prisma.brainArticle.findUniqueOrThrow({where: {id: article.id}})).bodyMd).toBe("Body from both sources");
  } finally {
    extract.mockRestore();
    chat.mockRestore();
  }
});


it.each([false, true])("rejects an uncited article privacy transition before further generation (restore=%s)", async (restore) => {
  const workspace = await prisma.workspace.create({data: {name: "Absorption proof pause", slug: `absorb-pause-${randomUUID()}`}});
  const user = await prisma.user.create({data: {email: `absorb-pause-${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  const uncited = await createArticle(actor, {workspaceId: workspace.id, title: "Independent index entry", type: "PROJECT",
    authority: "REFERENCE", bodyMd: "Independent human original"});
  const source = await ingestSource(actor, {workspaceId: workspace.id, sourceType: "RESEARCH", tier: 2,
    title: "Fresh human input", content: "Fresh independent source fact"});
  const extract = vi.spyOn(defaultModelGateway, "extract").mockImplementation(async () => {
    await prisma.brainArticle.update({where: {id: uncited.id}, data: {isPrivate: true, ownerMemberId: member.id}});
    if (restore) await prisma.brainArticle.update({where: {id: uncited.id}, data: {isPrivate: false, ownerMemberId: null}});
    return {output: {articleType: "PROJECT", createNew: {title: "New source proposal", slug: "new-source-proposal"}, summary: "Fresh fact"}} as never;
  });
  const chat = vi.spyOn(defaultModelGateway, "chat").mockResolvedValue({content: "New proposed body"} as never);
  try {
    await expect(absorbSource({workspaceId: workspace.id, sourceId: source.id, agentRunId: "synthetic-proof-pause"}))
      .rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(chat).not.toHaveBeenCalled();
    expect(await prisma.brainArticle.count({where: {workspaceId: workspace.id, sourceIds: {has: source.id}}})).toBe(0);
    expect((await prisma.brainSource.findUniqueOrThrow({where: {id: source.id}})).absorbedAt).toBeNull();
  } finally {extract.mockRestore(); chat.mockRestore();}
});

it("excludes unknown legacy article labels and bodies from model and proposal proof", async () => {
  const workspace = await prisma.workspace.create({data: {name: "Unknown article isolation", slug: `absorb-unknown-${randomUUID()}`}});
  const user = await prisma.user.create({data: {email: `absorb-unknown-${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  const legacy = await prisma.brainArticle.create({data: {workspaceId: workspace.id, slug: "legacy-hidden", title: "Unknown legacy label",
    type: "PROJECT", authority: "DRAFT", isPrivate: false, bodyMd: "Unknown legacy body"}});
  const source = await ingestSource(actor, {workspaceId: workspace.id, sourceType: "RESEARCH", tier: 2,
    title: "Shared authored input", content: "Independent shared fact"});
  const extract = vi.spyOn(defaultModelGateway, "extract").mockResolvedValue({output: {articleType: "PROJECT",
    createNew: {title: "Shared fact", slug: "shared-fact"}, summary: "Shared fact"}} as never);
  const chat = vi.spyOn(defaultModelGateway, "chat").mockResolvedValue({content: "Proposed shared fact"} as never);
  try {
    expect(await absorbSource({workspaceId: workspace.id, sourceId: source.id, agentRunId: "synthetic-unknown"})).toMatchObject({absorbed: true});
    const rendered = JSON.stringify([...extract.mock.calls, ...chat.mock.calls]);
    expect(rendered).not.toContain("Unknown legacy label"); expect(rendered).not.toContain("Unknown legacy body");
    expect(await prisma.artifactInputSnapshot.count({where: {workspaceId: workspace.id, sourceKind: "BrainArticle", sourceId: legacy.id}})).toBe(0);
    expect((await prisma.brainArticle.findUniqueOrThrow({where: {id: legacy.id}})).bodyMd).toBe("Unknown legacy body");
  } finally {extract.mockRestore(); chat.mockRestore();}
});
