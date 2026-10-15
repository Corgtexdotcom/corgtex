import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof } from "./source-lineage";
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

  it("replenishes past 5,001 unknown run keys without releasing their subjects", async () => {
    const {workspace, member, actor} = await fixture();
    await prisma.newspaperDelivery.createMany({data: Array.from({length: 5_001}, (_, index) => ({
      workspaceId: workspace.id, memberId: member.id, runKey: `unknown-${String(index).padStart(5, "0")}`,
      kind: "MEMBER_NEWSPAPER" as const, recipientEmail: "synthetic@example.test", subject: "UNKNOWN SUBJECT CANARY",
      status: "SENT" as const, createdAt: new Date(Date.now() + 10_000),
    }))});
    const groups = vi.spyOn(prisma.newspaperDelivery, "groupBy");
    const summaries = await listNewspaperDeliverySummaries(actor, workspace.id, {take: 1});
    expect(summaries).toEqual([expect.objectContaining({runKey: "readable-run", recipientCount: 1})]);
    expect(JSON.stringify(summaries)).not.toContain("UNKNOWN SUBJECT CANARY");
    expect(groups.mock.calls.length).toBe(101);
    expect(groups.mock.calls.every(([args]) => args.take === 50)).toBe(true);
  }, 300_000);

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
