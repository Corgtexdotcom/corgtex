import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { brainSourceContentFingerprint, generateBrainSourceRemovalCandidate,
  requestBrainSourceRemoval, resolveBrainSourceRemoval } from "@corgtex/domain";
import { absorbSource } from "./brain-absorb";

vi.mock("@corgtex/knowledge", () => ({ syncBrainArticleKnowledge: vi.fn(async () => 0) }));

beforeEach(truncateAllTables);

it("records both verified sources through real absorption before reviewed removal", async () => {
  const workspace = await prisma.workspace.create({ data: {
    name: "Multi-source absorption", slug: `multi-absorb-${randomUUID()}`,
  } });
  const user = await prisma.user.create({ data: { email: `multi-absorb-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const admin: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Admin" } };
  const first = await prisma.brainSource.create({ data: {
    workspaceId: workspace.id, sourceType: "RESEARCH", tier: 2, title: "First source", content: "First verified facts",
  } });
  const second = await prisma.brainSource.create({ data: {
    workspaceId: workspace.id, sourceType: "RESEARCH", tier: 2, title: "Second source", content: "Second verified facts",
  } });
  const extract = vi.spyOn(defaultModelGateway, "extract")
    .mockResolvedValueOnce({ output: { articleType: "PROJECT", updateSlugs: [],
      createNew: { title: "Synthetic project", slug: "synthetic-project" }, summary: "Created" } } as never)
    .mockResolvedValueOnce({ output: { articleType: "PROJECT", updateSlugs: ["synthetic-project"],
      createNew: null, summary: "Updated" } } as never);
  const chat = vi.spyOn(defaultModelGateway, "chat")
    .mockResolvedValueOnce({ content: "Body from first source" } as never)
    .mockResolvedValueOnce({ content: "Body from both sources" } as never);
  try {
    expect(await absorbSource({ workspaceId: workspace.id, sourceId: first.id, agentRunId: "first-run" }))
      .toMatchObject({ absorbed: true, createdSlug: "synthetic-project" });
    expect(await absorbSource({ workspaceId: workspace.id, sourceId: second.id, agentRunId: "second-run" }))
      .toMatchObject({ absorbed: true, updatedSlugs: ["synthetic-project"] });
    const article = await prisma.brainArticle.findFirstOrThrow({ where: { workspaceId: workspace.id, slug: "synthetic-project" } });
    expect(article.sourceIds).toEqual([first.id, second.id]);
    expect(article.bodyMd).toBe("Body from both sources");
    expect(article.derivationJson).toEqual({ version: 1, origin: "brain-absorb", agentRunId: "second-run", sources: [
      { sourceId: first.id, fingerprint: brainSourceContentFingerprint(first) },
      { sourceId: second.id, fingerprint: brainSourceContentFingerprint(second) },
    ] });
    const requested = await requestBrainSourceRemoval(admin, { workspaceId: workspace.id, sourceId: first.id });
    expect(requested).toMatchObject({ status: "pending" });
    if (requested.status !== "pending") throw new Error("Expected reviewed removal.");
    await prisma.workflowJob.update({ where: { id: requested.jobId }, data: { status: "RUNNING" } });
    let generationInput: string[] = [];
    expect(await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: requested.jobId,
      expectedAttempt: 0, expectedOwner: null,
      generate: async (_article, sources) => {
        generationInput = sources.map((item) => item.content);
        return "Reviewed body from second source";
      },
    })).toMatchObject({ phase: "READY", candidateCount: 1 });
    expect(generationInput).toEqual(["Second verified facts"]);
    await prisma.workflowJob.update({ where: { id: requested.jobId }, data: { status: "COMPLETED" } });
    expect(await resolveBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: requested.jobId, decision: "accept" }))
      .toMatchObject({ status: "applied", sourceId: first.id });
    const reviewed = await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id }, include: { versions: true } });
    expect(reviewed.bodyMd).toBe("Reviewed body from second source");
    expect(reviewed.sourceIds).toEqual([second.id]);
    expect(reviewed.versions.map((version) => version.bodyMd)).toContain("Body from both sources");
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: first.id } })).archivedAt).toBeInstanceOf(Date);
  } finally {
    extract.mockRestore();
    chat.mockRestore();
  }
});
