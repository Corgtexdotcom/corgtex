import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";

const prisma = getPrismaClient();

async function stillWaiting(promise: Promise<unknown>) {
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
  ]);
}

it("serializes Action duplicate resolution against linked-work creation in both orders", async () => {
  await truncateAllTables();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const memberId = randomUUID();
  const canonicalId = randomUUID();
  const writerFirstId = randomUUID();
  const resolverFirstId = randomUUID();
  await prisma.user.create({ data: { id: userId, email: `action-guard-${userId}@example.test`, passwordHash: "synthetic" } });
  await prisma.workspace.create({ data: { id: workspaceId, slug: `action-guard-${workspaceId}`, name: "Action guard test" } });
  await prisma.member.create({ data: { id: memberId, workspaceId, userId, role: "ADMIN" } });
  for (const id of [canonicalId, writerFirstId, resolverFirstId]) {
    await prisma.action.create({ data: { id, workspaceId, authorUserId: userId, title: "Follow up", status: "OPEN", isPrivate: false } });
  }

  const writer = new Client({ connectionString: process.env.DATABASE_URL });
  const resolver = new Client({ connectionString: process.env.DATABASE_URL });
  await Promise.all([writer.connect(), resolver.connect()]);
  try {
    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout = '5s'");
    await writer.query(`INSERT INTO "AdviceProcess" ("id", "workspaceId", "authorMemberId", "subjectType", "subjectId", "updatedAt")
      VALUES ($1, $2, $3, 'ACTION', $4, now())`, [randomUUID(), workspaceId, memberId, writerFirstId]);
    await resolver.query("BEGIN");
    await resolver.query("SET LOCAL lock_timeout = '5s'");
    const waitingResolver = resolver.query(`SELECT "id" FROM "Action" WHERE "id" = $1 FOR UPDATE`, [writerFirstId]);
    expect(await stillWaiting(waitingResolver)).toBe(true);
    await writer.query("COMMIT");
    await waitingResolver;
    const count = await resolver.query(`SELECT COUNT(*)::int AS count FROM "AdviceProcess" WHERE "subjectType" = 'ACTION' AND "subjectId" = $1`, [writerFirstId]);
    expect(count.rows[0].count).toBe(1);
    await resolver.query("ROLLBACK");

    await resolver.query("BEGIN");
    await resolver.query("SET LOCAL lock_timeout = '5s'");
    await resolver.query(`SELECT "id" FROM "Action" WHERE "id" = $1 FOR UPDATE`, [resolverFirstId]);
    await resolver.query(`UPDATE "Action" SET "duplicateOfActionId" = $1 WHERE "id" = $2`, [canonicalId, resolverFirstId]);
    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout = '5s'");
    const waitingWriter = writer.query(`INSERT INTO "AdviceProcess" ("id", "workspaceId", "authorMemberId", "subjectType", "subjectId", "updatedAt")
      VALUES ($1, $2, $3, 'ACTION', $4, now())`, [randomUUID(), workspaceId, memberId, resolverFirstId]);
    expect(await stillWaiting(waitingWriter)).toBe(true);
    await resolver.query("COMMIT");
    await expect(waitingWriter).rejects.toMatchObject({ code: "23503", constraint: "Action_link_unresolved_check" });
    await writer.query("ROLLBACK");
    await expect(writer.query(`INSERT INTO "ActionChecklistItem" ("id", "workspaceId", "actionId", "title", "updatedAt")
      VALUES ($1, $2, $3, 'Late checklist', now())`, [randomUUID(), workspaceId, resolverFirstId]))
      .rejects.toMatchObject({ code: "23503", constraint: "Action_link_unresolved_check" });
    await expect(writer.query(`INSERT INTO "ActionCreationSource" ("id", "workspaceId", "actionId", "sourceType", "sourceId")
      VALUES ($1, $2, $3, 'WEB_REQUEST', $4)`, [randomUUID(), workspaceId, resolverFirstId, randomUUID()]))
      .rejects.toMatchObject({ code: "23503", constraint: "Action_link_unresolved_check" });
  } finally {
    await Promise.allSettled([writer.query("ROLLBACK"), resolver.query("ROLLBACK")]);
    await Promise.all([writer.end(), resolver.end()]);
    await truncateAllTables();
  }
});
