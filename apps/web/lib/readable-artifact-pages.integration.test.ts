import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { prisma as db, type AppActor } from "@corgtex/shared";
import { DigestReadRelease } from "../../../packages/domain/src/digest-lineage";
import { lineageContentFingerprint, recordArtifactInputLineage } from "../../../packages/domain/src/source-lineage";
import { scanReadableArtifactPages } from "./readable-artifact-pages";

const workspaces: string[] = [];
const users: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of workspaces.splice(0)) await db.workspace.delete({ where: { id } });
  for (const id of users.splice(0)) await db.user.delete({ where: { id } });
});
async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Synthetic page release", slug: randomUUID() } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@pages.test`, passwordHash: "synthetic" } });
  workspaces.push(workspace.id); users.push(user.id);
  const member = await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const row = await db.document.create({ data: { id: `${workspace.id}-a`, workspaceId: workspace.id, title: "Original canary", source: "UPLOAD",
    storageKey: `workspaces/${workspace.id}/uploads/fixture.txt`, textContent: "Original content" } });
  await db.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "Document", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  async function change(kind: "withdrawal" | "epoch ABA" | "head") {
    if (kind === "head") {
      const head = await db.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: workspace.id, artifactType: "Document", artifactId: row.id }, orderBy: { revision: "desc" } });
      await db.artifactInputLineage.create({ data: { workspaceId: workspace.id, artifactType: "Document", artifactId: row.id,
        revision: head.revision + 1, origin: "HUMAN_ORIGINAL", contentHash: lineageContentFingerprint("Document", row), inputsJson: [], rootsJson: [] } });
    } else {
      await db.member.update({ where: { id: member.id }, data: { isActive: false } });
      if (kind === "epoch ABA") await db.member.update({ where: { id: member.id }, data: { isActive: true } });
    }
  }
  return { actor, workspaceId: workspace.id, row, change };
}
it.each(["withdrawal", "epoch ABA", "head"] as const)("rejects original rows after a later-page %s", async kind => {
  const f = await fixture();
  await db.document.createMany({ data: Array.from({ length: 99 }, (_, index) => ({ id: `${f.workspaceId}-z-${String(index).padStart(3, "0")}`,
    workspaceId: f.workspaceId, title: "Unknown", source: "UPLOAD", storageKey: `workspaces/${f.workspaceId}/uploads/${index}.txt`, textContent: "Unproved" })) });
  let page = 0;
  const result = scanReadableArtifactPages({ actor: f.actor, workspaceId: f.workspaceId, kind: "Document", visit: () => {},
    loadPage: async (after, take) => {
      if (++page === 2) await f.change(kind);
      return db.document.findMany({ where: { workspaceId: f.workspaceId, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take });
    } });
  await expect(result).rejects.toMatchObject({ code: kind === "withdrawal" ? "NOT_A_MEMBER" : "SOURCE_CHANGED" });
});
it.each(["withdrawal", "epoch ABA", "head"] as const)("releases families together after a later-family %s", async kind => {
  const f = await fixture();
  const release = new DigestReadRelease(f.actor, f.workspaceId);
  const titles: string[] = [];
  const first = await scanReadableArtifactPages({ actor: f.actor, workspaceId: f.workspaceId, kind: "Document", release,
    loadPage: async () => [f.row], visit: row => { titles.push(row.title); } });
  expect(first).toEqual({ count: 1, complete: true, nextCursor: null });
  expect(titles).toEqual(["Original canary"]);
  const second = await scanReadableArtifactPages({ actor: f.actor, workspaceId: f.workspaceId, kind: "Meeting", release,
    loadPage: async () => { await f.change(kind); return []; }, visit: () => {} });
  await expect(release.finish({ titles, first, second })).rejects.toMatchObject({ code: kind === "withdrawal" ? "NOT_A_MEMBER" : "SOURCE_CHANGED" });
});

it("checks current membership on a final empty-page release", async () => {
  const f = await fixture();
  const result = scanReadableArtifactPages({ actor: f.actor, workspaceId: f.workspaceId, kind: "Meeting", visit: () => {},
    loadPage: async () => { await f.change("withdrawal"); return []; } });
  await expect(result).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
});
