import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listDeliberationEntries, listDeliberationEntriesForParents } from "./deliberation";
import * as lineage from "./source-lineage";
const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!(process.env.CORGTEX_DISPOSABLE_TEST_DATABASE_URL === process.env.DATABASE_URL && url.hostname === "127.0.0.1" && url.pathname === "/deliberation_release_test")
  && !(process.env.GITHUB_ACTIONS === "true" && url.hostname === "localhost" && url.port === "5432")) throw new Error("Assigned disposable deliberation fixture required.");
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const ws = await prisma.workspace.create({ data: { name: "Synthetic deliberation", slug: randomUUID() } });
  const owner = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: "Author", passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: "Reader", passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: ws.id, userId: owner.id, role: "ADMIN" } });
  const readerMember = await prisma.member.create({ data: { workspaceId: ws.id, userId: reader.id, role: "CONTRIBUTOR" } });
  const author: AppActor = { kind: "user", user: owner }; const actor: AppActor = { kind: "user", user: reader };
  const parent = await prisma.proposal.create({ data: { workspaceId: ws.id, title: "Public parent", bodyMd: "Original proposal", authorUserId: owner.id, isPrivate: false, status: "OPEN" } });
  const circle = await prisma.circle.create({ data: { workspaceId: ws.id, name: "Circle" } });
  const entry = await prisma.deliberationEntry.create({ data: { workspaceId: ws.id, parentType: "PROPOSAL", parentId: parent.id,
    authorUserId: owner.id, entryType: "REACTION", bodyMd: "Original entry", targetMemberId: member.id, targetCircleId: circle.id } });
  for (const [kind, row] of [["Proposal", parent], ["Circle", circle], ["DeliberationEntry", entry]] as const)
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: author, workspaceId: ws.id,
      artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const read = async (mode: "single" | "multi") => mode === "single" ? listDeliberationEntries(actor, { workspaceId: ws.id, parentType: "PROPOSAL", parentId: parent.id })
    : (await listDeliberationEntriesForParents(actor, { workspaceId: ws.id, parentType: "PROPOSAL", parentIds: [parent.id] })).get(parent.id)!;
  return { ws, owner, reader, member, readerMember, author, actor, parent, circle, entry, read };
}
it.each(["single", "multi"] as const)("preserves %s DTO and canonical joined proofs", async mode => {
  const f = await fixture(); const rows = await f.read(mode);
  expect(rows).toMatchObject([{ bodyMd: "Original entry", author: { displayName: "Author" }, targetMember: { user: { displayName: "Author" } }, targetCircle: { name: "Circle" } }]);
  expect(Object.keys(rows[0].author!)).toEqual(["id", "displayName", "email"]);
  expect(Object.keys(rows[0].targetCircle!)).toEqual(["id", "name"]);
});
it.each((["single", "multi"] as const).flatMap(mode => (["entry", "entry-head", "author", "member", "circle", "caller"] as const).map(change => ({ mode, change }))))(
  "withholds %s original joined data after late authority/content change", async ({ mode, change }) => {
    const f = await fixture(); let changed = false; const original = lineage.captureArtifactInputProof;
    vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!changed && args[2].some(input => input.kind === "Circle" && input.id === f.circle.id)) {
        changed = true;
        if (change === "entry-head") {
          const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.ws.id, artifactType: "DeliberationEntry", artifactId: f.entry.id }, orderBy: { revision: "desc" } });
          await prisma.artifactInputLineage.create({ data: { ...head, id: randomUUID(), revision: head.revision + 1,
            inputsJson: head.inputsJson ?? [], rootsJson: head.rootsJson ?? [], permissionEpochsJson: head.permissionEpochsJson ?? {} } });
        }
        if (change === "entry") await prisma.deliberationEntry.update({ where: { id: f.entry.id }, data: { bodyMd: "Changed" } });
        if (change === "author") await prisma.user.update({ where: { id: f.owner.id }, data: { displayName: "Changed" } });
        if (change === "circle") await prisma.circle.update({ where: { id: f.circle.id }, data: { name: "Changed" } });
        if (change === "member" || change === "caller") {
          const id = change === "member" ? f.member.id : f.readerMember.id;
          await prisma.member.update({ where: { id }, data: { isActive: false } });
          await prisma.member.update({ where: { id }, data: { isActive: true } });
        }
      }
      return result;
    });
    await expect(f.read(mode)).rejects.toMatchObject({ code: "SOURCE_CHANGED" }); expect(changed).toBe(true);
  });
it.each(["single", "multi"] as const)("redacts %s restricted target while preserving readable entry", async mode => {
  const f = await fixture();
  const member = await prisma.member.findUniqueOrThrow({ where: { id: f.member.id }, include: { user: { select: { id: true, email: true, displayName: true } } } });
  await prisma.$transaction(tx => lineage.invalidateArtifactInputLineage({ tx, workspaceId: f.ws.id, artifact: { kind: "Member", id: member.id }, content: member }));
  const rows = await f.read(mode); expect(rows).toMatchObject([{ bodyMd: "Original entry", targetMember: null }]);
});
