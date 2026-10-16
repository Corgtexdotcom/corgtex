import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
const probe = vi.hoisted(() => ({ queries: 0 }));
vi.mock("@corgtex/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return { ...actual, prisma: actual.prisma.$extends({ query: {
    async $allOperations({ args, query }) { probe.queries++; return query(args); },
  } }) };
});
import { truncateAllTables } from "../../../../../../../packages/shared/src/db-test-utils";
import { capturePermissionEpochs } from "../../../../../../../packages/domain/src/source-permission-epochs";
import { lineageContentFingerprint, recordArtifactInputLineage } from "../../../../../../../packages/domain/src/source-lineage";
import { DigestReadRelease } from "../../../../../../../packages/domain/src/digest-lineage";
import { listBrainArticleTypeCounts } from "./article-type-counts";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture(size = 201) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic Brain count", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  await prisma.brainArticle.createMany({ data: Array.from({ length: size }, (_, i) => ({
    id: `article-${String(i).padStart(5, "0")}`, workspaceId: workspace.id, slug: `article-${i}`,
    title: `Article ${i}`, type: i % 2 ? "STRATEGY" : "PROJECT", authority: "REFERENCE", bodyMd: "Synthetic public body",
  })) });
  const rows = await prisma.brainArticle.findMany({ where: { workspaceId: workspace.id } });
  await prisma.$transaction(async tx => {
    const epochs = await capturePermissionEpochs(tx, workspace.id, [{ kind: "Workspace", id: workspace.id },
      { kind: "MemberUserPolicy", id: user.id }, { kind: "WorkspaceSupportPolicy", id: user.id },
      ...rows.map(row => ({ kind: "BrainArticle", id: row.id }))]);
    await tx.artifactInputLineage.createMany({ data: rows.map(row => ({ workspaceId: workspace.id,
      artifactType: "BrainArticle", artifactId: row.id, revision: 1, origin: "HUMAN_ORIGINAL",
      contentHash: lineageContentFingerprint("BrainArticle", row), inputsJson: [], rootsJson: [], epochProofVersion: 1,
      permissionEpochsJson: { ...epochs, entries: epochs.entries.filter(entry => entry.kind !== "BrainArticle" || entry.id === row.id) },
    })) });
  });
  const params = { actor, workspaceId: workspace.id, membership: member };
  return { params, rows, user, member };
}

it("batches canonical counts and final proof replay instead of querying each article", async () => {
  const f = await fixture();
  probe.queries = 0;
  expect(await listBrainArticleTypeCounts(f.params)).toEqual([{ type: "PROJECT", count: 101 }, { type: "STRATEGY", count: 100 }]);
  const batchedQueries = probe.queries;
  expect(batchedQueries).toBeGreaterThan(10);
  expect(batchedQueries).toBeLessThan(350);
  // Replay the previous per-record admission against the same real corpus.
  // Keep the new final release, so this understates the original query cost.
  vi.spyOn(DigestReadRelease.prototype, "captureBrainArticlePage").mockImplementation(async function(this: DigestReadRelease, rows) {
    return (await this.capture("BrainArticle", rows)).records;
  });
  probe.queries = 0;
  expect(await listBrainArticleTypeCounts(f.params)).toEqual([{ type: "PROJECT", count: 101 }, { type: "STRATEGY", count: 100 }]);
  expect(probe.queries).toBeGreaterThan(batchedQueries * 3);
});

it("retains derived ancestry authorization and omits unknown and private entries", async () => {
  const f = await fixture(2);
  const hidden = await prisma.brainArticle.create({ data: { workspaceId: f.params.workspaceId, slug: "hidden", title: "Hidden", bodyMd: "private", type: "PROJECT", authority: "DRAFT", isPrivate: true, ownerMemberId: f.member.id } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.params.actor, workspaceId: f.params.workspaceId,
    artifact: { kind: "BrainArticle", id: hidden.id }, content: hidden, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const derived = await prisma.brainArticle.create({ data: { workspaceId: f.params.workspaceId, slug: "derived", title: "Derived", bodyMd: "derived", type: "PROJECT", authority: "REFERENCE" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.params.actor, workspaceId: f.params.workspaceId,
    artifact: { kind: "BrainArticle", id: derived.id }, content: derived, origin: "DERIVED",
    inputs: [{ kind: "BrainArticle", id: hidden.id }] }));
  await prisma.brainArticle.create({ data: { workspaceId: f.params.workspaceId, slug: "unknown", title: "Unknown", bodyMd: "unknown", type: "PROJECT", authority: "REFERENCE" } });
  const reader = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const membership = await prisma.member.create({ data: { workspaceId: f.params.workspaceId, userId: reader.id, role: "CONTRIBUTOR" } });
  expect(await listBrainArticleTypeCounts({ ...f.params, actor: { kind: "user", user: reader }, membership })).toEqual([{ type: "PROJECT", count: 1 }, { type: "STRATEGY", count: 1 }]);
});

it.each(["membership", "body", "head"])("withholds the full count after late %s change", async change => {
  const f = await fixture(2);
  const original = DigestReadRelease.prototype.finish;
  vi.spyOn(DigestReadRelease.prototype, "finish").mockImplementation(async function(this: DigestReadRelease, ...args: Parameters<typeof original>) {
    if (change === "membership") await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    if (change === "body") await prisma.brainArticle.update({ where: { id: f.rows[0].id }, data: { bodyMd: "changed" } });
    if (change === "head") await prisma.artifactInputLineage.updateMany({ where: { artifactId: f.rows[0].id }, data: { origin: "DERIVED" } });
    return original.apply(this, args);
  });
  await expect(listBrainArticleTypeCounts(f.params)).rejects.toBeTruthy();
});
