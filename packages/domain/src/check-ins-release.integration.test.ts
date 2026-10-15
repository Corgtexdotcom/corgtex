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
