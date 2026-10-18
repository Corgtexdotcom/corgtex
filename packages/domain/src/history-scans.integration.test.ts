import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { getPrismaClient } from "../../shared/src/db";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import type { CheckIn, Prisma } from "@prisma/client";
import { createDailyCompanyUnderstandingQuestions } from "./check-ins";
import { listConstitutionVersionPage } from "./constitutions";
import { DigestReadRelease } from "./digest-lineage";
import { recordArtifactInputLineage } from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic bounded history", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  return { workspaceId: workspace.id, actor, member };
}

it("creates daily questions beyond 5001 denied quota rows with bounded pages and readable template deduplication", async () => {
  const f = await fixture();
  const template = "What document, customer note, or working file would give CORGTEX the most useful company context today?";
  await prisma.checkIn.createMany({ data: Array.from({ length: 5001 }, (_, index) => ({
    id: `denied-${String(index).padStart(5, "0")}`, workspaceId: f.workspaceId, memberId: f.member.id,
    questionText: template, questionSource: "AI", questionType: "COMPANY_UNDERSTANDING", createdAt: new Date("2026-01-01"),
  })) });
  const old = await prisma.checkIn.create({ data: { id: "tail-readable", workspaceId: f.workspaceId, memberId: f.member.id,
    questionText: template, questionSource: "USER", questionType: "COMPANY_UNDERSTANDING", createdAt: new Date("2026-01-01") } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "CheckIn", id: old.id }, content: old, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const client = getPrismaClient();
  const transaction = client.$transaction.bind(client);
  const pages: number[] = [];
  const observe = async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number }) => transaction(async tx => {
    const query = tx.checkIn.findMany.bind(tx.checkIn);
    vi.spyOn(tx.checkIn, "findMany").mockImplementation((async args => {
      const rows = await query(args) as CheckIn[];
      pages.push(rows.length);
      expect(args?.take).toBe(100);
      expect(rows.length).toBeLessThanOrEqual(100);
      return rows;
    }) as typeof tx.checkIn.findMany);
    return work(tx);
  }, options);
  vi.spyOn(client, "$transaction").mockImplementation(observe as typeof client.$transaction);
  const started = performance.now();
  const result = await createDailyCompanyUnderstandingQuestions(f.actor, { workspaceId: f.workspaceId, memberId: f.member.id });
  console.info("daily quota bounded history", { elapsedMs: Math.round(performance.now() - started), pages: pages.length, hydrated: pages.reduce((a, b) => a + b, 0), maxPage: Math.max(...pages) });
  expect(result.created).toBe(2);
  expect(pages).toEqual([...Array<number>(50).fill(100), 2]);
  expect(await prisma.checkIn.count({ where: { workspaceId: f.workspaceId } })).toBe(5004);
  expect(result.lineageRoots.some(root => root.id === old.id)).toBe(true);
}, 180_000);

it("serializes concurrent daily creation under the same recipient quota lock", async () => {
  const f = await fixture();
  const results = await Promise.all([1, 2].map(() => createDailyCompanyUnderstandingQuestions(f.actor, { workspaceId: f.workspaceId, memberId: f.member.id })));
  expect(results.map(row => row.created).sort()).toEqual([0, 3]);
  expect(await prisma.checkIn.count({ where: { workspaceId: f.workspaceId, memberId: f.member.id } })).toBe(3);
}, 60_000);

it.each(["positive", "off-page-head", "caller-restore"] as const)("keeps bounded constitution history and its original count proof through %s", async mode => {
  const f = await fixture();
  await prisma.constitution.createMany({ data: Array.from({ length: 201 }, (_, index) => ({
    id: `version-${String(index + 1).padStart(4, "0")}`, workspaceId: f.workspaceId, version: index + 1,
    bodyMd: `Synthetic ${index + 1}`, modelUsed: "synthetic",
  })) });
  const readable = await prisma.constitution.findMany({ where: { workspaceId: f.workspaceId, version: { in: [201, 200, 1] } }, orderBy: { version: "desc" } });
  for (const row of readable) await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "Constitution", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const query = vi.spyOn(prisma.constitution, "findMany");
  const finish = DigestReadRelease.prototype.finish;
  let changed = false;
  vi.spyOn(DigestReadRelease.prototype, "finish").mockImplementation(async function<T>(this: DigestReadRelease, value: T) {
    if (!changed) {
      if (mode === "off-page-head") {
        const offPage = readable[1]!;
        await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
          artifact: {kind: "Constitution", id: offPage.id}, content: offPage, origin: "HUMAN_ORIGINAL", inputs: []}));
      }
      if (mode === "caller-restore") {
        await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
        await prisma.member.update({where: {id: f.member.id}, data: {isActive: true}});
      }
      changed = true;
    }
    return finish.call(this, value) as Promise<T>;
  });
  const read = listConstitutionVersionPage(f.actor, f.workspaceId, {take: 1});
  if (mode === "positive") await expect(read).resolves.toMatchObject({items: [{id: readable[0]!.id}], complete: false, hasMore: true});
  else await expect(read).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]?.take).toBe(200);

}, 60_000);
