import { randomUUID } from "node:crypto";
import { Prisma, type Constitution } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getCurrentConstitution, listConstitutionVersions } from "./constitutions";
import { DigestReadRelease } from "./digest-lineage";
import { recordArtifactInputLineage } from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture(count = 1, readableVersion = count) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic current constitution", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  await prisma.constitution.createMany({ data: Array.from({ length: count }, (_, index) => ({
    id: `constitution-${String(index + 1).padStart(5, "0")}`, workspaceId: workspace.id,
    version: index + 1, bodyMd: `Synthetic version ${index + 1}: ${"history ".repeat(128)}`, modelUsed: "synthetic",
  })) });
  const row = await prisma.constitution.findUniqueOrThrow({ where: { workspaceId_version: { workspaceId: workspace.id, version: readableVersion } } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "Constitution", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  return { workspaceId: workspace.id, actor, member, row };
}

it("loads a bounded current page with constant work as older history grows", async () => {
  const f = await fixture(1201);
  const delegate = prisma.constitution as unknown as { findMany: (args?: Prisma.ConstitutionFindManyArgs) => Promise<Constitution[]> };
  const query = delegate.findMany.bind(delegate);
  const pageSizes: number[] = [];
  const calls = vi.spyOn(delegate, "findMany").mockImplementation(async args => {
    const rows = await query(args);
    pageSizes.push(rows.length);
    return rows;
  });
  const started = performance.now();
  expect(await getCurrentConstitution(f.actor, f.workspaceId)).toMatchObject({ id: f.row.id });
  console.info("constitution current scale", { history: 1201, pageSizes, milliseconds: Math.round(performance.now() - started) });
  expect(pageSizes).toEqual([100]);
  expect(calls).toHaveBeenCalledWith({ where: { workspaceId: f.workspaceId }, orderBy: [{ version: "desc" }, { id: "desc" }], take: 100 });
});

it("reports current constitution unavailable after 200 of more than 5000 denied versions", async () => {
  const f = await fixture(5002, 1);
  const calls = vi.spyOn(prisma.constitution, "findMany");
  await expect(getCurrentConstitution(f.actor, f.workspaceId)).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
  expect(calls).toHaveBeenCalledTimes(2);
  expect(calls.mock.calls.every(([args]) => args?.take === 100)).toBe(true);
}, 120_000);

it("preserves the history endpoint's exact readable total and offset contract", async () => {
  const f = await fixture(103, 1);
  const newer = await prisma.constitution.findUniqueOrThrow({ where: { workspaceId_version: { workspaceId: f.workspaceId, version: 101 } } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "Constitution", id: newer.id }, content: newer, origin: "HUMAN_ORIGINAL", inputs: [] }));
  expect(await listConstitutionVersions(f.actor, f.workspaceId, { take: 1, skip: 1 }))
    .toMatchObject({ items: [{ id: f.row.id }], total: 2, take: 1, skip: 1 });
  expect(await getCurrentConstitution(f.actor, f.workspaceId)).toMatchObject({ id: newer.id });
});

it("skips a proved newer version when its source is private to another member", async () => {
  const f = await fixture(2, 1);
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: f.workspaceId, userId: user.id, role: "CONTRIBUTOR" } });
  const author: AppActor = { kind: "user", user };
  const source = await prisma.action.create({ data: { workspaceId: f.workspaceId, authorUserId: user.id,
    title: "Private source", bodyMd: "Private source canary", status: "DRAFT", isPrivate: true } });
  const newer = await prisma.constitution.findUniqueOrThrow({ where: { workspaceId_version: { workspaceId: f.workspaceId, version: 2 } } });
  await prisma.$transaction(async tx => {
    await recordArtifactInputLineage({ tx, actor: author, workspaceId: f.workspaceId,
      artifact: { kind: "Action", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx, actor: author, workspaceId: f.workspaceId,
      artifact: { kind: "Constitution", id: newer.id }, content: newer, origin: "DERIVED", inputs: [{ kind: "Action", id: source.id }] });
  });
  expect(await getCurrentConstitution(author, f.workspaceId)).toMatchObject({ id: newer.id });
  expect(await getCurrentConstitution(f.actor, f.workspaceId)).toMatchObject({ id: f.row.id });
});

it.each(["body", "head", "epoch"] as const)("rejects a selected original whose %s changes before final release", async mode => {
  const f = await fixture();
  const finish = DigestReadRelease.prototype.finish;
  let changed = false;
  vi.spyOn(DigestReadRelease.prototype, "finish").mockImplementation(async function <T>(this: DigestReadRelease, value: T) {
    changed = true;
    if (mode === "body") await prisma.constitution.update({ where: { id: f.row.id }, data: { bodyMd: "Changed after admission" } });
    if (mode === "head") await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind: "Constitution", id: f.row.id }, content: f.row, origin: "HUMAN_ORIGINAL", inputs: [] }));
    if (mode === "epoch") {
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    }
    return finish.call(this, value);
  });
  await expect(getCurrentConstitution(f.actor, f.workspaceId)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(changed).toBe(true);
});

it("rechecks current membership before releasing an empty current result", async () => {
  const f = await fixture();
  await prisma.constitution.deleteMany({ where: { workspaceId: f.workspaceId } });
  const delegate = prisma.constitution as unknown as { findMany: (args?: Prisma.ConstitutionFindManyArgs) => Promise<Constitution[]> };
  const query = delegate.findMany.bind(delegate);
  vi.spyOn(delegate, "findMany").mockImplementation(async args => {
    const rows = await query(args);
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    return rows;
  });
  await expect(getCurrentConstitution(f.actor, f.workspaceId)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
});
