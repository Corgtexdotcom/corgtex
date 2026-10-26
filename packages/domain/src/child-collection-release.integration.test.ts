import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listActionChecklistItems } from "./actions";
import { listArticleVersions } from "./brain";
import * as lineage from "./source-lineage";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const localFixture = database.hostname === "127.0.0.1" && database.port === "63973" && database.pathname === "/child_read_test";
const hostedFixture = process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost"
  && database.port === "5432" && database.pathname === "/corgtex_test";
if ((!localFixture && !hostedFixture) || database.searchParams.get("schema") !== "public") {
  throw new Error("Child collection tests require their assigned disposable database or the documented hosted CI fixture.");
}
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture(kind: "checklist" | "versions") {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic child collection", slug: randomUUID() } });
  const owner = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user: reader };
  const author: AppActor = { kind: "user", user: owner };
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Original child authority" } });
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: author, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const action = await prisma.action.create({ data: { workspaceId: workspace.id, title: "Parent action", authorUserId: owner.id, isPrivate: false } });
  const article = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: randomUUID(), title: "Parent article",
    type: "PROJECT", authority: "REFERENCE", bodyMd: "Current article", ownerMemberId: ownerMember.id, isPrivate: false, sourceIds: [] } });
  for (const [parentKind, parent] of [["Action", action], ["BrainArticle", article]] as const) {
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: author, workspaceId: workspace.id,
      artifact: { kind: parentKind, id: parent.id }, content: parent, origin: "HUMAN_ORIGINAL", inputs: [] }));
  }
  const childKind = kind === "checklist" ? "ActionChecklistItem" : "BrainArticleVersion";
  const child = kind === "checklist"
    ? await prisma.actionChecklistItem.create({ data: { workspaceId: workspace.id, actionId: action.id, title: "Original task", sortOrder: 2 } })
    : await prisma.brainArticleVersion.create({ data: { articleId: article.id, version: 2, bodyMd: "Historical body", changeSummary: "Original change",
      accessEnvelopeJson: { isPrivate: false, ownerMemberId: ownerMember.id } } });
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: author, workspaceId: workspace.id,
    artifact: { kind: childKind, id: child.id }, content: child, origin: "DERIVED", inputs: [{ kind: "BrainSource", id: source.id }] }));
  if (kind === "checklist") await prisma.actionChecklistItem.create({ data: { workspaceId: workspace.id, actionId: action.id, title: "Unknown task", sortOrder: 1 } });
  else await prisma.brainArticleVersion.create({ data: { articleId: article.id, version: 3, bodyMd: "Unknown historical body" } });
  const read = () => kind === "checklist" ? listActionChecklistItems(actor, { workspaceId: workspace.id, actionId: action.id })
    : listArticleVersions(actor, { workspaceId: workspace.id, slug: article.slug });
  return { workspace, actor, member, source, action, article, child, childKind, read };
}

for (const kind of ["checklist", "versions"] as const) {
  it(`${kind} retains admitted bodies and excludes unproven legacy children`, async () => {
    const f = await fixture(kind);
    expect(await f.read()).toEqual([f.child]);
  });

  it.each(["caller-restore", "parent-restore", "child-head", "source-restore"] as const)(
    `${kind} rejects original response after late %s`, async change => {
      const f = await fixture(kind); let changed = false;
      const mutate = async () => {
        if (changed) return;
        changed = true;
        if (change === "caller-restore") {
          await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
          await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
        } else if (change === "parent-restore") {
          if (kind === "checklist") {
            await prisma.action.update({ where: { id: f.action.id }, data: { isPrivate: true } });
            await prisma.action.update({ where: { id: f.action.id }, data: { isPrivate: false } });
          } else {
            await prisma.brainArticle.update({ where: { id: f.article.id }, data: { isPrivate: true } });
            await prisma.brainArticle.update({ where: { id: f.article.id }, data: { isPrivate: false } });
          }
        } else if (change === "source-restore") {
          await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
          await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: null } });
        } else {
          const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id,
            artifactType: f.childKind, artifactId: f.child.id }, orderBy: { revision: "desc" } });
          const { id: _id, ...data } = head;
          await prisma.artifactInputLineage.create({ data: { ...data, revision: head.revision + 1,
            inputsJson: head.inputsJson as Prisma.InputJsonValue, rootsJson: head.rootsJson as Prisma.InputJsonValue,
            permissionEpochsJson: head.permissionEpochsJson ?? Prisma.DbNull } });
        }
      };
      // Mutate only AFTER actual admission has captured the child's original proof.
      // The legacy path calls readableArtifactIds; the corrected collector calls capture.
      const originalReadable = lineage.readableArtifactIds;
      vi.spyOn(lineage, "readableArtifactIds").mockImplementation(async (...args) => {
        const ids = await originalReadable(...args);
        if (args[2] === f.childKind && ids.has(f.child.id)) await mutate();
        return ids;
      });
      const originalCapture = lineage.captureArtifactInputProof;
      vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
        const proof = await originalCapture(...args);
        if (args[2].some(input => input.kind === f.childKind && input.id === f.child.id)) await mutate();
        return proof;
      });
      const result = await f.read().catch(error => error);
      expect(changed).toBe(true);
      expect(result).toBeInstanceOf(Error);
      expect(result).toMatchObject({ code: expect.stringMatching(/SOURCE_CHANGED|SOURCE_RESTRICTED|NOT_A_MEMBER/) });
    });
}
