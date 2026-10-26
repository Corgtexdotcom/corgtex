import { randomUUID } from "node:crypto";
import { Prisma, type ArtifactInputLineage } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma as db, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { inspectLegacyRecovery } from "./legacy-recovery";
import * as lineage from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Synthetic recovery preview", slug: randomUUID() } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@preview.test`, passwordHash: "synthetic" } });
  const member = await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const input = await db.brainArticle.create({ data: { workspaceId: workspace.id, title: "Known private contributor", bodyMd: "Private source text", slug: randomUUID(), type: "PROJECT", authority: "DRAFT", isPrivate: true, ownerMemberId: member.id } });
  const goal = await db.goal.create({ data: { workspaceId: workspace.id, authorUserId: user.id, title: "Readable parent", status: "ACTIVE", isPrivate: false } });
  for (const [kind, row] of [["BrainArticle", input], ["Goal", goal]] as const) await db.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const update = await db.goalUpdate.create({ data: { goalId: goal.id, bodyMd: "Unknown historical update" } });
  const roots = await lineage.captureArtifactInputProof(actor, workspace.id, [{ kind: "BrainArticle", id: input.id }]);
  const head = await db.artifactInputLineage.create({ data: { workspaceId: workspace.id, artifactType: "GoalUpdate", artifactId: update.id, revision: 1, origin: "UNKNOWN", contentHash: lineage.lineageContentFingerprint("GoalUpdate", update), inputsJson: [], rootsJson: JSON.parse(JSON.stringify(roots)) } });
  const selection = { workspaceId: workspace.id, kind: "GoalUpdate" as const, id: update.id };
  const afterPreviewCapture = (change: () => Promise<unknown>) => {
    const original = lineage.captureArtifactReadHeadObservation;
    let changed = false;
    vi.spyOn(lineage, "captureArtifactReadHeadObservation").mockImplementation(async read => {
      const observed = await original(read);
      if (!changed) {
        changed = true;
        await change();
      }
      return observed;
    });
    return () => changed;
  };
  return { workspace, user, actor, member, input, goal, update, head, selection, afterPreviewCapture };
}

function cloneHead(head: ArtifactInputLineage): Prisma.ArtifactInputLineageUncheckedCreateInput {
  return { ...head, inputsJson: head.inputsJson ?? Prisma.JsonNull, rootsJson: head.rootsJson ?? Prisma.JsonNull,
    permissionEpochsJson: head.permissionEpochsJson ?? Prisma.DbNull };
}

describe("original legacy recovery preview release", () => {
  it.each(["caller", "source", "caller-restore", "source-restore", "role-restore", "target-body", "target-head", "source-head", "parent-private"] as const)("rejects %s change after original preview capture", async change => {
    const f = await fixture();
    let completedChanges = 0;
    const changed = f.afterPreviewCapture(async () => {
      if (change === "caller" || change === "caller-restore") {
        await db.member.update({ where: { id: f.member.id }, data: { isActive: false } });
        if (change === "caller-restore") await db.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      } else if (change === "source" || change === "source-restore") {
        await db.brainArticle.update({ where: { id: f.input.id }, data: { archivedAt: new Date() } });
        if (change === "source-restore") await db.brainArticle.update({ where: { id: f.input.id }, data: { archivedAt: null } });
      } else if (change === "role-restore") {
        await db.member.update({ where: { id: f.member.id }, data: { role: "CONTRIBUTOR" } });
        await db.member.update({ where: { id: f.member.id }, data: { role: "ADMIN" } });
      } else if (change === "target-body") await db.goalUpdate.update({ where: { id: f.update.id }, data: { bodyMd: "Changed preview" } });
      else if (change === "target-head") await db.artifactInputLineage.create({ data: { ...cloneHead(f.head), id: randomUUID(), revision: 2 } });
      else if (change === "source-head") {
        const head = await db.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "BrainArticle", artifactId: f.input.id }, orderBy: { revision: "desc" } });
        await db.artifactInputLineage.create({ data: { ...cloneHead(head), id: randomUUID(), revision: head.revision + 1 } });
      } else await db.goal.update({ where: { id: f.goal.id }, data: { isPrivate: true, status: "DRAFT" } });
      completedChanges++;
    });
    await expect(inspectLegacyRecovery(f.actor, f.selection)).rejects.toThrow();
    expect(changed()).toBe(true);
    expect(completedChanges).toBe(1);
    if (change === "target-head" || change === "source-head") {
      const target = change === "target-head" ? { artifactType: "GoalUpdate", artifactId: f.update.id }
        : { artifactType: "BrainArticle", artifactId: f.input.id };
      expect(await db.artifactInputLineage.count({ where: { workspaceId: f.workspace.id, ...target, revision: 2 } })).toBe(1);
    }
  });

  it("preserves eligible UNKNOWN target metadata without admitting its content", async () => {
    const f = await fixture();
    expect(await lineage.readableArtifactIds(f.actor, f.workspace.id, "GoalUpdate", [f.update])).toEqual(new Set());
    expect(await inspectLegacyRecovery(f.actor, f.selection)).toEqual({ ...f.selection,
      fingerprint: lineage.lineageContentFingerprint("GoalUpdate", f.update), knownContributors: 2,
      requiresConfirmation: true, private: false, hasFile: false });
    expect(await db.artifactInputLineage.findUnique({ where: { id: f.head.id } })).toEqual(f.head);
    expect(await db.conversationOperationOutcome.count()).toBe(0);
  });

  it("preserves empty-ancestry file metadata and owner-only conversation previews", async () => {
    const f = await fixture();
    const source = await db.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "ARTICLE", tier: 1, content: "Unknown extract", fileStorageKey: `workspaces/${f.workspace.id}/uploads/file.txt` } });
    expect(await inspectLegacyRecovery(f.actor, { workspaceId: f.workspace.id, kind: "BrainSource", id: source.id })).toMatchObject({ knownContributors: 0, private: false, hasFile: true });
    const conversation = await db.conversationSession.create({ data: { workspaceId: f.workspace.id, userId: f.user.id, topic: "Original private conversation" } });
    expect(await inspectLegacyRecovery(f.actor, { workspaceId: f.workspace.id, kind: "ConversationSession", id: conversation.id })).toMatchObject({ knownContributors: 0, private: true, hasFile: false });
  });

  it("denies cross-tenant selection and an ineligible operator", async () => {
    const f = await fixture();
    const other = await db.workspace.create({ data: { name: "Other tenant", slug: randomUUID() } });
    await expect(inspectLegacyRecovery(f.actor, { ...f.selection, workspaceId: other.id })).rejects.toThrow();
    await db.member.update({ where: { id: f.member.id }, data: { role: "CONTRIBUTOR" } });
    await expect(inspectLegacyRecovery(f.actor, f.selection)).rejects.toMatchObject({ code: "RECOVERY_ADMIN_REQUIRED" });
  });
});
