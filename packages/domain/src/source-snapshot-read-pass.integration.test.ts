import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputSnapshotProof, recordArtifactInputLineage } from "./source-lineage";
import { isArtifactInputPermissionEpochCoverageComplete } from "./source-permission-coverage";

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic snapshot inspection", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: null, globalRole: "USER" } };
  const source = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: "original", type: "STRATEGY",
    title: "Synthetic original", bodyMd: "Original bytes", isPrivate: false } });
  const roots = await prisma.$transaction(async tx => {
    await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "BrainArticle", id: source.id },
      content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    return captureArtifactInputSnapshotProof(actor, workspace.id, { kind: "BrainArticle", id: source.id }, tx);
  });
  const snapshot = await prisma.artifactInputSnapshot.findUniqueOrThrow({ where: { id: roots[0].id } });
  return { workspace, source, roots, snapshot };
}

describe("fresh snapshot comparison after coverage-local reuse", () => {
  beforeEach(truncateAllTables);

  it.each([
    ["own transaction", "content"], ["own transaction", "roots"],
    ["other transaction", "envelope"], ["other transaction", "delete"],
  ])("rejects %s %s mutation after actual cached-row use without an epoch transition", async (writer, mutation) => {
    const f = await fixture();
    const params = { workspaceId: f.workspace.id, artifact: { kind: "BrainArticle" as const, id: f.source.id },
      content: f.source, roots: f.roots, permissionEpochs: f.snapshot.permissionEpochsJson };
    expect(await isArtifactInputPermissionEpochCoverageComplete({ ...params, db: prisma })).toBe(true);
    const beforeEpochs = await prisma.sourcePermissionEpoch.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { id: "asc" } });
    let reads = 0, comparisons = 0;
    await prisma.$transaction(async tx => {
      const observed = new Proxy(tx, { get(client, model) {
        if (model !== "artifactInputSnapshot") return Reflect.get(client, model, client);
        return new Proxy(client.artifactInputSnapshot, { get(delegate, method) {
          if (method === "findFirst") return async (args: Parameters<typeof delegate.findFirst>[0]) => {
            reads++; return delegate.findFirst(args);
          };
          if (method === "findMany") return async (args: Parameters<typeof delegate.findMany>[0]) => {
            comparisons++;
            // Dependency inspection performed the only individual SQL read;
            // evidence validation AND permission metadata reused that exact row.
            expect(reads).toBe(1);
            const db = writer === "own transaction" ? tx : prisma;
            if (mutation === "delete") await db.artifactInputSnapshot.delete({ where: { id: f.snapshot.id } });
            else await db.artifactInputSnapshot.update({ where: { id: f.snapshot.id }, data: {
              ...(mutation === "content" ? { contentJson: { bodyMd: "Changed during coverage" } } : {}),
              ...(mutation === "roots" ? { rootsJson: [{ kind: "BrainArticle", id: "other", fingerprint: "0".repeat(64) }] } : {}),
              ...(mutation === "envelope" ? { accessEnvelopeJson: { isPrivate: true } } : {}),
            } });
            if (mutation !== "delete") {
              const afterEpochs = await db.sourcePermissionEpoch.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { id: "asc" } });
              expect(afterEpochs).toEqual(beforeEpochs);
            }
            return delegate.findMany(args);
          };
          return Reflect.get(delegate, method, delegate);
        } });
      } });
      expect(await isArtifactInputPermissionEpochCoverageComplete({ ...params, db: observed })).toBe(false);
    });
    expect(comparisons).toBe(1);
    expect(reads).toBe(1);
    if (mutation !== "delete") {
      // Restore only fixture bytes; each new inspection must read again, never
      // retain a prior rejection or a prior positive across calls.
      await prisma.artifactInputSnapshot.update({ where: { id: f.snapshot.id }, data: {
        contentJson: f.snapshot.contentJson as Prisma.InputJsonValue,
        rootsJson: f.snapshot.rootsJson as Prisma.InputJsonValue,
        accessEnvelopeJson: f.snapshot.accessEnvelopeJson as Prisma.InputJsonValue,
      } });
      expect(await isArtifactInputPermissionEpochCoverageComplete({ ...params, db: prisma })).toBe(true);
    }
  });
});
