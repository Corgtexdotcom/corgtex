import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createArticle } from "./brain";
import { archiveWorkspaceArtifact, getWorkspaceArchiveRecord, listArchivedWorkspaceArtifacts, purgeWorkspaceArtifact, restoreWorkspaceArtifact } from "./archive";

import { isLineageKind, isPurgedArchiveMetadataPolicyReadable, recordArtifactInputLineage } from "./source-lineage";
import { Prisma } from "@prisma/client";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function setup(options: { kind?: "BrainArticle" | "Meeting"; private?: boolean; unknown?: boolean } = {}) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic purge audit", slug: randomUUID() } });
  const actors = await Promise.all(["Owner", "Reader"].map(async displayName => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
    const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName } };
    return { actor, member };
  }));
  const [owner, reader] = actors;
  const kind = options.kind ?? "BrainArticle";
  const article = kind === "BrainArticle" ? await createArticle(owner.actor, { workspaceId: workspace.id, slug: "purge-audit", title: "Deleted title canary",
    bodyMd: "Deleted body canary", type: "PROJECT", authority: options.private ? "DRAFT" : "REFERENCE", isPrivate: options.private ?? false })
    : await prisma.$transaction(async tx => {
      const row = await tx.meeting.create({ data: { workspaceId: workspace.id, source: "manual", recordedAt: new Date(),
        participantIds: [], transcript: "Deleted body canary", title: "Deleted title canary" } });
      await recordArtifactInputLineage({ tx, actor: owner.actor, workspaceId: workspace.id,
        artifact: { kind: "Meeting", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
      return row;
    });
  await archiveWorkspaceArtifact(owner.actor, { workspaceId: workspace.id, entityType: kind, entityId: article.id });
  if (options.unknown) await prisma.artifactInputLineage.updateMany({ where: { workspaceId: workspace.id, artifactId: article.id }, data: { origin: "UNKNOWN" } });
  await purgeWorkspaceArtifact(owner.actor, { workspaceId: workspace.id, entityType: kind, entityId: article.id, reason: "Deleted reason canary" });
  const record = await prisma.workspaceArchiveRecord.findFirstOrThrow({ where: { workspaceId: workspace.id, entityId: article.id } });
  const params = { workspaceId: workspace.id, entityType: kind, entityId: article.id, includePurged: true };
  return { workspace, owner, reader, article, record, params };
}

describe("retained purge metadata", () => {
  it("returns authorized purge status and path without retaining or releasing deleted content", async () => {
    const f = await setup();
    const detail = await getWorkspaceArchiveRecord(f.reader.actor, f.params);
    const page = await listArchivedWorkspaceArtifacts(f.reader.actor, f.params);
    expect(detail).toMatchObject({ id: f.record.id, entityId: f.article.id, entityLabel: "BrainArticle", purgedAt: expect.any(Date) });
    expect(page).toHaveLength(1);
    expect(page[0].permanentPath).toEqual(expect.any(String));
    expect(JSON.stringify({ detail, page, previousState: f.record.previousState })).not.toContain("canary");
    expect(await prisma.brainArticle.findUnique({ where: { id: f.article.id } })).toBeNull();
    expect(await listArchivedWorkspaceArtifacts(f.reader.actor, { workspaceId: f.workspace.id })).toEqual([]);
  });
  it("keeps legacy snapshots and unknown original receipts hidden", async () => {
    const f = await setup({ unknown: true });
    expect(f.record.previousState).toBeNull();
    expect(await getWorkspaceArchiveRecord(f.reader.actor, f.params)).toBeNull();
    await prisma.workspaceArchiveRecord.update({ where: { id: f.record.id }, data: {
      previousState: { isPrivate: false, bodyMd: "Legacy deleted body canary" },
    } });
    expect(await listArchivedWorkspaceArtifacts(f.reader.actor, f.params)).toEqual([]);
  });

  it("applies the original private audience to a current nonadmin reader", async () => {
    const f = await setup({ private: true });
    await prisma.member.update({ where: { id: f.reader.member.id }, data: { role: "CONTRIBUTOR" } });
    expect(await getWorkspaceArchiveRecord(f.reader.actor, f.params)).toBeNull();
    expect(await getWorkspaceArchiveRecord(f.owner.actor, f.params)).not.toBeNull();
  });

  it("does not admit the receipt as generic content or unsupported policy kinds", async () => {
    const f = await setup();
    expect(isLineageKind("WorkspaceArchiveRecord")).toBe(false);
    for (const kind of ["BrainSource", "ExternalDataSource", "Role", "CrmContact", "WorkspaceArchiveRecord"]) {
      expect(await isPurgedArchiveMetadataPolicyReadable(f.reader.actor, f.workspace.id, kind,
        { id: f.article.id, workspaceId: f.workspace.id, isPrivate: false })).toBe(false);
    }
  });

  it.each(["envelope", "record", "workspace", "original-head", "audit-head"] as const)("rejects %s receipt tampering/replay", async change => {
    const f = await setup();
    if (change === "envelope") {
      const receipt = structuredClone(f.record.previousState) as { purgedMetadata: { envelope: { isPrivate: boolean } } };
      receipt.purgedMetadata.envelope.isPrivate = true;
      await prisma.workspaceArchiveRecord.update({ where: { id: f.record.id }, data: { previousState: receipt } });
    } else if (change === "record" || change === "workspace") {
      const workspaceId = change === "workspace" ? (await prisma.workspace.create({ data: { name: "Foreign", slug: randomUUID() } })).id : f.workspace.id;
      if (change === "workspace") await prisma.member.create({ data: { workspaceId, userId: f.reader.actor.kind === "user" ? f.reader.actor.user.id : "", role: "ADMIN" } });
      const copied = await prisma.workspaceArchiveRecord.create({ data: { workspaceId, entityType: f.params.entityType,
        entityId: randomUUID(), purgedAt: f.record.purgedAt, previousState: f.record.previousState as Prisma.InputJsonValue } });
      expect(await getWorkspaceArchiveRecord(f.reader.actor, { ...f.params, workspaceId, entityId: copied.entityId })).toBeNull();
      return;
    } else {
      const artifactType = change === "original-head" ? f.params.entityType : "WorkspaceArchiveRecord";
      const artifactId = change === "original-head" ? f.article.id : f.record.id;
      const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id, artifactType, artifactId }, orderBy: { revision: "desc" } });
      await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" (id,"workspaceId","artifactType","artifactId",revision,origin,"contentHash","inputsJson","rootsJson","epochProofVersion","permissionEpochsJson")
        SELECT ${randomUUID()},"workspaceId","artifactType","artifactId",revision+1,origin,"contentHash","inputsJson","rootsJson","epochProofVersion","permissionEpochsJson" FROM "ArtifactInputLineage" WHERE id=${head.id}`;
    }
    // A different source head always invalidates. An audit head is also bound
    // to revision one: no legitimate metadata receipt is ever rewritten.
    expect(await getWorkspaceArchiveRecord(f.reader.actor, f.params)).toBeNull();
  });

  it.each(["membership-loss", "membership-restore", "source-head", "receipt", "category-restore"] as const)("fences %s during later permalink reads", async change => {
    const f = await setup({ kind: change === "category-restore" ? "Meeting" : "BrainArticle" });
    const original = prisma.workspacePermalink.findMany.bind(prisma.workspacePermalink);
    vi.spyOn(prisma.workspacePermalink, "findMany").mockImplementation((async args => {
      const rows = await original(args);
      if (change.startsWith("membership")) {
        await prisma.member.update({ where: { id: f.reader.member.id }, data: { isActive: false } });
        if (change === "membership-restore") await prisma.member.update({ where: { id: f.reader.member.id }, data: { isActive: true } });
      } else if (change === "receipt") {
        await prisma.workspaceArchiveRecord.update({ where: { id: f.record.id }, data: { previousState: Prisma.DbNull } });
      } else if (change === "category-restore") {
        await prisma.informationCategoryPolicy.create({ data: { workspaceId: f.workspace.id, category: "GENERAL", isRestricted: true, allowedRoleIds: [], allowedCircleIds: [] } });
        await prisma.informationCategoryPolicy.delete({ where: { workspaceId_category: { workspaceId: f.workspace.id, category: "GENERAL" } } });
      } else {
        await prisma.artifactInputLineage.updateMany({ where: { workspaceId: f.workspace.id, artifactType: f.params.entityType, artifactId: f.article.id }, data: { origin: "UNKNOWN" } });
      }
      return rows;
    }) as typeof prisma.workspacePermalink.findMany);
    await expect(listArchivedWorkspaceArtifacts(f.reader.actor, f.params)).rejects.toMatchObject({ code: change === "membership-loss" ? "NOT_A_MEMBER" : "SOURCE_CHANGED" });
  });

  it("fences caller revoke-and-restore between detail admission and its final transaction", async () => {
    const f = await setup();
    const client = getPrismaClient();
    const original = client.$transaction.bind(client);
    let calls = 0;
    vi.spyOn(client, "$transaction").mockImplementation((async (...args: Parameters<typeof prisma.$transaction>) => {
      const result = await original(...args);
      if (++calls === 1) {
        await prisma.member.update({ where: { id: f.reader.member.id }, data: { isActive: false } });
        await prisma.member.update({ where: { id: f.reader.member.id }, data: { isActive: true } });
      }
      return result;
    }) as typeof prisma.$transaction);
    await expect(getWorkspaceArchiveRecord(f.reader.actor, f.params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("keeps current category restrictions even for admins and never restores erased content", async () => {
    const f = await setup({ kind: "Meeting" });
    expect(await getWorkspaceArchiveRecord(f.reader.actor, f.params)).not.toBeNull();
    await prisma.informationCategoryPolicy.create({ data: { workspaceId: f.workspace.id, category: "GENERAL", isRestricted: true, allowedRoleIds: [], allowedCircleIds: [] } });
    expect(await getWorkspaceArchiveRecord(f.reader.actor, f.params)).toBeNull();
    await expect(restoreWorkspaceArtifact(f.owner.actor, f.params)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(purgeWorkspaceArtifact(f.owner.actor, { ...f.params, reason: "again" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.artifactInputLineage.count({ where: { artifactType: "WorkspaceArchiveRecord", artifactId: f.record.id } })).toBe(1);
  });
});
