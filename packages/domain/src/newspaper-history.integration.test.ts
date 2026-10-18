import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { DigestReadRelease } from "./digest-lineage";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof, type LineageKind } from "./source-lineage";
import { listNewspaperDeliverySummaries, recordNewspaperDelivery } from "./newspaper-delivery";

async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic newspaper history", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user: {id: user.id, email: user.email, displayName: null}};
  const roots = await captureArtifactInputProof(actor, workspace.id,
    [{kind: "Workspace", id: workspace.id}, {kind: "Member", id: member.id}]);
  await recordNewspaperDelivery({workspaceId: workspace.id, runKey: "readable-run", kind: "MEMBER_NEWSPAPER",
    memberId: member.id, recipientEmail: user.email, subject: "Readable history", status: "SENT", actor, lineageRoots: roots});
  return {workspace, member, actor};
}

describe("newspaper summary history discovery", () => {
  beforeEach(async () => { await truncateAllTables(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("bounds 5001 unknown run keys without claiming complete empty history", async () => {
    const {workspace, member, actor} = await fixture();
    await prisma.newspaperDelivery.createMany({data: Array.from({length: 5_001}, (_, index) => ({
      workspaceId: workspace.id, memberId: member.id, runKey: `unknown-${String(index).padStart(5, "0")}`,
      kind: "MEMBER_NEWSPAPER" as const, recipientEmail: "synthetic@example.test", subject: "UNKNOWN SUBJECT CANARY",
      status: "SENT" as const, createdAt: new Date(Date.now() + 10_000),
    }))});
    const deliveries = vi.spyOn(prisma.newspaperDelivery, "findMany");
    const summaries = await listNewspaperDeliverySummaries(actor, workspace.id, {take: 1});
    expect(summaries).toEqual({items: [], complete: false, deliveriesComplete: false, linksComplete: true, scope: "WINDOW"});
    expect(JSON.stringify(summaries)).not.toContain("UNKNOWN SUBJECT CANARY");
    const discovery = deliveries.mock.calls.filter(([args]) => args?.take === 200);
    expect(discovery).toHaveLength(1);
    expect(discovery[0][0]?.where).toEqual({workspaceId: workspace.id});
    const proofReads = deliveries.mock.calls.filter(([args]) => args?.take !== 200);
    expect(proofReads).toHaveLength(2);
    expect(proofReads.every(([args]) => {
      const filter = args?.where?.id;
      return typeof filter === "object" && filter !== null && Array.isArray(filter.in) && filter.in.length <= 100;
    })).toBe(true);
  }, 300_000);

  it.each(["head", "caller"] as const)("rejects original %s withdrawal after the second admission batch", async mode => {
    const {workspace, member, actor} = await fixture();
    const roots = await captureArtifactInputProof(actor, workspace.id,
      [{kind: "Workspace", id: workspace.id}, {kind: "Member", id: member.id}]);
    for (let index = 0; index < 100; index++) {
      await recordNewspaperDelivery({workspaceId: workspace.id, runKey: `run-${index}`, kind: "MEMBER_NEWSPAPER",
        memberId: member.id, recipientEmail: "synthetic@example.test", subject: "Synthetic", status: "SENT", actor, lineageRoots: roots});
    }
    const original = DigestReadRelease.prototype.capture;
    let batches = 0, firstId = "";
    vi.spyOn(DigestReadRelease.prototype, "capture").mockImplementation((async function(this: DigestReadRelease, kind: LineageKind, rows: Array<{id: string}>) {
      const captured = await original.call(this, kind, rows);
      if (kind === "NewspaperDelivery") {
        firstId ||= rows[0].id;
        if (++batches === 2) {
          if (mode === "caller") {
            await prisma.member.update({where: {id: member.id}, data: {isActive: false}});
            await prisma.member.update({where: {id: member.id}, data: {isActive: true}});
          } else {
            const head = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId: workspace.id, artifactType: "NewspaperDelivery", artifactId: firstId}, orderBy: {revision: "desc"}});
            await prisma.artifactInputLineage.create({data: {...head, id: randomUUID(), revision: head.revision + 1,
              inputsJson: head.inputsJson as Prisma.InputJsonValue, rootsJson: head.rootsJson as Prisma.InputJsonValue,
              permissionEpochsJson: head.permissionEpochsJson as Prisma.InputJsonValue}});
          }
        }
      }
      return captured;
    }) as typeof original);
    await expect(listNewspaperDeliverySummaries(actor, workspace.id)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(batches).toBe(2);
  }, 120_000);

  it("retains the original caller fence after the final tracked-link query", async () => {
    const {workspace, member, actor} = await fixture();
    const original = prisma.newspaperTrackedLink.findMany.bind(prisma.newspaperTrackedLink);
    vi.spyOn(prisma.newspaperTrackedLink, "findMany").mockImplementation(((args: Parameters<typeof original>[0]) =>
      original(args).then(async rows => {
        await prisma.member.update({where: {id: member.id}, data: {isActive: false}});
        await prisma.member.update({where: {id: member.id}, data: {isActive: true}});
        return rows;
      })) as typeof prisma.newspaperTrackedLink.findMany);
    await expect(listNewspaperDeliverySummaries(actor, workspace.id, {take: 1})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });
});
