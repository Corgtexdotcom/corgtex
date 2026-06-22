#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const schemaName = `migration_fixture_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const admin = new PrismaClient();

function withSchema(url, schema) {
  const parsed = new URL(url);
  parsed.searchParams.set("schema", schema);
  return parsed.toString();
}

function statements(sql) {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function main() {
  const fixture = new PrismaClient({
    datasources: {
      db: {
        url: withSchema(rootDatabaseUrl, schemaName),
      },
    },
  });

  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    await fixture.$executeRawUnsafe(`
      CREATE TABLE "Workspace" (
        "id" TEXT NOT NULL PRIMARY KEY
      )
    `);
    await fixture.$executeRawUnsafe(`
      CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY
      )
    `);
    await fixture.$executeRawUnsafe(`
      CREATE TABLE "Proposal" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "version" INTEGER NOT NULL
      )
    `);
    await fixture.$executeRawUnsafe(`
      CREATE TABLE "ProposalReaction" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "proposalId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "reaction" TEXT NOT NULL,
        "bodyMd" TEXT,
        "resolvedAt" TIMESTAMP(3),
        "resolvedNote" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await fixture.$executeRawUnsafe(`
      CREATE TABLE "DeliberationEntry" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "parentType" TEXT NOT NULL,
        "parentId" TEXT NOT NULL,
        "parentVersion" INTEGER,
        "authorUserId" TEXT NOT NULL,
        "entryType" TEXT NOT NULL,
        "bodyMd" TEXT,
        "resolvedAt" TIMESTAMP(3),
        "resolvedNote" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await fixture.$executeRawUnsafe(`INSERT INTO "Workspace" ("id") VALUES ('workspace-1')`);
    await fixture.$executeRawUnsafe(`INSERT INTO "User" ("id") VALUES ('user-1')`);
    await fixture.$executeRawUnsafe(`
      INSERT INTO "Proposal" ("id", "workspaceId", "version")
      VALUES ('proposal-1', 'workspace-1', 4)
    `);
    await fixture.$executeRawUnsafe(`
      INSERT INTO "ProposalReaction" ("id", "proposalId", "userId", "reaction", "bodyMd")
      VALUES ('reaction-1', 'proposal-1', 'user-1', 'OBJECTION', '')
    `);

    const migrationSql = readFileSync("prisma/migrations/20260617120000_drop_legacy_proposal_reactions/migration.sql", "utf8");
    for (const statement of statements(migrationSql)) {
      await fixture.$executeRawUnsafe(statement);
    }

    const copied = await fixture.$queryRaw`
      SELECT "id", "workspaceId", "parentType", "parentId", "parentVersion", "authorUserId", "entryType", "bodyMd"
      FROM "DeliberationEntry"
    `;
    if (copied.length !== 1) {
      throw new Error(`Expected 1 copied deliberation entry, got ${copied.length}.`);
    }
    const [entry] = copied;
    if (
      entry.id !== "legacy-proposal-reaction-reaction-1" ||
      entry.workspaceId !== "workspace-1" ||
      entry.parentType !== "PROPOSAL" ||
      entry.parentId !== "proposal-1" ||
      entry.parentVersion !== 4 ||
      entry.authorUserId !== "user-1" ||
      entry.entryType !== "OBJECTION" ||
      entry.bodyMd !== "OBJECTION"
    ) {
      throw new Error(`Copied deliberation entry did not match expected values: ${JSON.stringify(entry)}`);
    }
    const legacyTable = await fixture.$queryRaw`SELECT to_regclass('"ProposalReaction"')::text AS table_name`;
    if (legacyTable[0]?.table_name !== null) {
      throw new Error("ProposalReaction table still exists after migration.");
    }

    console.log("OK data migration fixtures passed.");
  } finally {
    await fixture.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await admin.$disconnect().catch(() => {});
  process.exit(1);
});
