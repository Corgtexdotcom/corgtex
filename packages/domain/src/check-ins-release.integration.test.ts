import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createCompanyUnderstandingQuestion, listCompanyUnderstandingQuestions, listDailyCompanyUnderstandingQuestions } from "./check-ins";
import { lineageContentFingerprint } from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic check-ins", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const otherMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: other.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Reader" } };
  const questions = [];
  for (let i = 0; i < 4; i++) questions.push(await createCompanyUnderstandingQuestion(actor, {
    workspaceId: workspace.id, memberId: member.id, questionText: `Synthetic question ${i}`, priority: 10 - i,
  }));
  return { workspaceId: workspace.id, actor, member, otherMember, questions };
}
for (const [name, list] of [["company", listCompanyUnderstandingQuestions], ["daily", listDailyCompanyUnderstandingQuestions]] as const) {
  describe(`${name} question release`, () => {
    it("preserves readable ordering, limits, counts and member isolation", async () => {
      const f = await setup();
      const denied = await createCompanyUnderstandingQuestion(f.actor, { workspaceId: f.workspaceId,
        memberId: f.otherMember.id, questionText: "Other recipient private question", priority: 100 });
      const unknown = await prisma.checkIn.create({ data: { workspaceId: f.workspaceId, memberId: f.member.id,
        questionText: "Unknown lineage question", questionSource: "AI", questionType: "COMPANY_UNDERSTANDING", priority: 99 } });
      const rows = await list(f.actor, { workspaceId: f.workspaceId, take: 2 });
      expect(rows.map(row => row.id)).toEqual(f.questions.slice(0, 2).map(row => row.id));
      expect(rows.some(row => row.id === denied.id || row.id === unknown.id)).toBe(false);
      const full = await list(f.actor, { workspaceId: f.workspaceId, take: 100 });
      expect(full).toHaveLength(name === "daily" ? 3 : 4);
      expect(await prisma.checkIn.count({ where: { workspaceId: f.workspaceId, status: "OPEN" } })).toBe(6);
      expect(await prisma.checkIn.count({ where: { workspaceId: f.workspaceId, status: "ANSWERED" } })).toBe(0);
      const foreign = await prisma.workspace.create({ data: { name: "Other tenant", slug: randomUUID() } });
      await expect(list(f.actor, { workspaceId: foreign.id })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    });
    it("reports unavailable after 200 of more than 5000 denied questions", async () => {
      const f = await setup();
      const date = new Date("2026-01-01T00:00:00Z");
      await prisma.checkIn.createMany({ data: Array.from({ length: 5501 }, (_, index) => ({
        workspaceId: f.workspaceId, memberId: f.member.id, questionText: "Synthetic unknown history",
        questionSource: "AI", questionType: "COMPANY_UNDERSTANDING", priority: index < 5001 ? 99 : 0, createdAt: date,
      })) });
      const original = prisma.checkIn.findMany.bind(prisma.checkIn);
      const pages: Array<{ size: number; ids: string[] }> = [];
      const query = vi.spyOn(prisma.checkIn, "findMany").mockImplementation((async args => {
        const rows = await original(args);
        pages.push({ size: rows.length, ids: rows.map(row => (row as { id: string }).id) });
        // Assert at the actual hydration boundary, before a baseline full-history
        // admission scan could hide its unbounded query behind the final slice.
        expect(args?.take).toBe(100);
        expect(rows.length).toBeLessThanOrEqual(100);
        return rows;
      }) as typeof prisma.checkIn.findMany);
      await expect(list(f.actor, { workspaceId: f.workspaceId, take: 3 })).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
      expect(pages).toHaveLength(2);
      expect(pages.every(page => page.size === 100)).toBe(true);
      expect(new Set(pages.flatMap(page => page.ids)).size).toBe(200);
      expect(query.mock.calls.every(([args]) => JSON.stringify(args?.orderBy) ===
        JSON.stringify([{ priority: "desc" }, { createdAt: "desc" }, { id: "desc" }]))).toBe(true);
      const deniedPrefix = pages.slice(0, 50).flatMap(page => page.ids);
      expect(deniedPrefix).toEqual([...deniedPrefix].sort().reverse());
    }, 180_000);
    it.each(["membership-restore", "head-replacement"] as const)(
      "withholds the first page's original question after %s while loading the next page", async change => {
        const f = await setup();
        await prisma.checkIn.createMany({ data: Array.from({ length: 100 }, () => ({
          workspaceId: f.workspaceId, memberId: f.member.id, questionText: "Synthetic denied page gap",
          questionSource: "AI", questionType: "COMPANY_UNDERSTANDING", priority: 10,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        })) });
        const original = prisma.checkIn.findMany.bind(prisma.checkIn);
        let pages = 0;
        vi.spyOn(prisma.checkIn, "findMany").mockImplementation((async args => {
          if (++pages === 2) {
            if (change === "membership-restore") {
              await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
              await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
            } else {
              const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspaceId,
                artifactType: "CheckIn", artifactId: f.questions[0].id }, orderBy: { revision: "desc" } });
              await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" ("id", "workspaceId", "artifactType", "artifactId", "revision", "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson") SELECT ${randomUUID()}, "workspaceId", "artifactType", "artifactId", "revision" + 1, "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson" FROM "ArtifactInputLineage" WHERE "id" = ${head.id}`;
            }
          }
          return original(args);
        }) as typeof prisma.checkIn.findMany);
        await expect(list(f.actor, { workspaceId: f.workspaceId, take: 2 })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
        expect(pages).toBe(2);
      });
    it.each(["membership-restore", "recipient-restore", "head-replacement"] as const)(
      "withholds original selected question after %s during a later candidate read", async change => {
        const f = await setup();
        const first = f.questions[0], later = f.questions[1];
        const original = prisma.checkIn.findFirst.bind(prisma.checkIn);
        let changed = false;
        vi.spyOn(prisma.checkIn, "findFirst").mockImplementation((async args => {
          if (!changed && args?.where?.id === later.id) {
            changed = true;
            if (change === "membership-restore") {
              await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
              await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
            } else if (change === "recipient-restore") {
              await prisma.checkIn.update({ where: { id: first.id }, data: { memberId: f.otherMember.id } });
              const restored = await prisma.checkIn.update({ where: { id: first.id }, data: { memberId: f.member.id } });
              expect(lineageContentFingerprint("CheckIn", restored)).toBe(lineageContentFingerprint("CheckIn", first));
            } else {
              const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspaceId,
                artifactType: "CheckIn", artifactId: first.id }, orderBy: { revision: "desc" } });
              await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" ("id", "workspaceId", "artifactType", "artifactId", "revision", "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson") SELECT ${randomUUID()}, "workspaceId", "artifactType", "artifactId", "revision" + 1, "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson" FROM "ArtifactInputLineage" WHERE "id" = ${head.id}`;
            }
          }
          return original(args);
        }) as typeof prisma.checkIn.findFirst);
        await expect(list(f.actor, { workspaceId: f.workspaceId, take: 1 })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
        expect(changed).toBe(true);
      });
  });
}
