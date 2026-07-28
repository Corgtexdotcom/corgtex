#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

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

async function applyMigration(fixture, migrationPath) {
  const migrationSql = readFileSync(migrationPath, "utf8");
  for (const statement of statements(migrationSql)) {
    await fixture.$executeRawUnsafe(statement);
  }
}

async function withIsolatedSchema(run) {
  const schemaName = `migration_fixture_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const fixture = new PrismaClient({
    datasources: {
      db: {
        url: withSchema(rootDatabaseUrl, schemaName),
      },
    },
  });

  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    await run(fixture);
  } finally {
    await fixture.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  }
}

async function runProposalReactionFixture() {
  await withIsolatedSchema(async (fixture) => {
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

    await applyMigration(fixture, "prisma/migrations/20260617120000_drop_legacy_proposal_reactions/migration.sql");

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
  });
}

async function tableCount(fixture, tableName, whereClause = "TRUE") {
  const rows = await fixture.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "${tableName}" WHERE ${whereClause}`);
  return Number(rows[0]?.count ?? 0);
}

async function createTable(fixture, tableName, columnsSql) {
  await fixture.$executeRawUnsafe(`CREATE TABLE "${tableName}" (${columnsSql})`);
}

async function runLegacyFinanceFixture() {
  await withIsolatedSchema(async (fixture) => {
    await createTable(fixture, "WorkspaceFeatureFlag", `"id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "flag" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true`);
    await createTable(fixture, "WorkspaceModuleAccessRequest", `"id" TEXT PRIMARY KEY, "moduleKey" TEXT NOT NULL`);
    await createTable(fixture, "WorkspaceModuleGrant", `"id" TEXT PRIMARY KEY, "moduleKey" TEXT NOT NULL`);
    await createTable(fixture, "GoalLink", `"id" TEXT PRIMARY KEY, "source" TEXT NOT NULL, "entityType" TEXT NOT NULL`);
    await createTable(fixture, "CommunicationEntityLink", `"id" TEXT PRIMARY KEY, "entityType" TEXT NOT NULL`);
    await createTable(fixture, "WorkItemEvidence", `"id" TEXT PRIMARY KEY, "entityType" TEXT NOT NULL`);
    await createTable(fixture, "WorkspaceExternalResourceAttachment", `"id" TEXT PRIMARY KEY, "entityType" TEXT NOT NULL`);
    await createTable(fixture, "AuditLog", `"id" TEXT PRIMARY KEY, "entityType" TEXT NOT NULL`);
    await createTable(fixture, "WorkItemVersion", `"id" TEXT PRIMARY KEY, "entityType" TEXT NOT NULL`);
    await createTable(fixture, "WorkspaceArchiveRecord", `"id" TEXT PRIMARY KEY, "entityType" TEXT NOT NULL`);
    await createTable(fixture, "WorkspacePermalink", `"id" TEXT PRIMARY KEY, "entityType" TEXT NOT NULL`);
    await createTable(fixture, "AppDefinition", `"id" TEXT PRIMARY KEY, "appKey" TEXT NOT NULL`);
    await createTable(fixture, "CatalogItem", `"id" TEXT PRIMARY KEY, "sourceId" TEXT, "slug" TEXT, "title" TEXT NOT NULL`);

    const practiceTypes = [
      "PracticeEntryReviewStatus",
      "PracticeEntryReviewTarget",
      "PracticeSourceDocumentStatus",
      "PracticeSourceDocumentType",
      "PracticeEntryStatus",
      "PracticeProjectLineKind",
      "PracticeClientStatus",
      "PracticeContributionCashStatus",
      "PracticeContributionPaymentChoice",
      "PracticeContributionType",
      "PracticeProjectStatus",
    ];
    for (const typeName of practiceTypes) {
      await fixture.$executeRawUnsafe(`CREATE TYPE "${typeName}" AS ENUM ('FIXTURE')`);
    }

    const practiceTables = [
      "PracticeContributionEntry",
      "PracticeEntryReview",
      "PracticeExpense",
      "PracticeTimeEntry",
      "PracticePaymentBatch",
      "PracticeSourceDocument",
      "PracticeProjectAssignment",
      "PracticePurchaseOrder",
      "PracticeProjectLine",
      "PracticeProject",
      "PracticeConsultant",
      "PracticeBillingCode",
      "PracticeClient",
    ];
    for (const tableName of practiceTables) {
      await createTable(fixture, tableName, `"id" TEXT PRIMARY KEY`);
      await fixture.$executeRawUnsafe(`INSERT INTO "${tableName}" ("id") VALUES ('${tableName}-1')`);
    }

    await fixture.$executeRawUnsafe(`
      INSERT INTO "WorkspaceFeatureFlag" ("id", "workspaceId", "flag", "enabled")
      VALUES
        ('flag-finance', 'workspace-1', 'FINANCE', true),
        ('flag-brain', 'workspace-1', 'BRAIN', true),
        ('flag-finance-projects', 'workspace-1', 'FINANCE_PROJECTS', true),
        ('flag-finance-slicing-pie', 'workspace-1', 'FINANCE_SLICING_PIE', true),
        ('flag-practice-projects', 'workspace-1', 'PRACTICE_PROJECTS', true),
        ('flag-slicing-pie', 'workspace-1', 'SLICING_PIE', true)
    `);
    await fixture.$executeRawUnsafe(`
      INSERT INTO "WorkspaceModuleAccessRequest" ("id", "moduleKey")
      VALUES ('request-practice', 'practice-ledger'), ('request-brain', 'brain')
    `);
    await fixture.$executeRawUnsafe(`
      INSERT INTO "WorkspaceModuleGrant" ("id", "moduleKey")
      VALUES ('grant-practice', 'practice-ledger'), ('grant-brain', 'brain')
    `);
    await fixture.$executeRawUnsafe(`
      INSERT INTO "GoalLink" ("id", "source", "entityType")
      VALUES
        ('goal-link-source', 'practice-finance', 'Goal'),
        ('goal-link-entity', 'manual', 'PracticeProject'),
        ('goal-link-keep', 'manual', 'Goal')
    `);
    for (const tableName of [
      "CommunicationEntityLink",
      "WorkItemEvidence",
      "WorkspaceExternalResourceAttachment",
      "AuditLog",
      "WorkItemVersion",
      "WorkspaceArchiveRecord",
      "WorkspacePermalink",
    ]) {
      await fixture.$executeRawUnsafe(`
        INSERT INTO "${tableName}" ("id", "entityType")
        VALUES ('${tableName}-practice', 'PracticeProject'), ('${tableName}-keep', 'Goal')
      `);
    }
    await fixture.$executeRawUnsafe(`
      INSERT INTO "AppDefinition" ("id", "appKey")
      VALUES ('app-practice', 'practice-ledger'), ('app-brain', 'brain')
    `);
    await fixture.$executeRawUnsafe(`
      INSERT INTO "CatalogItem" ("id", "sourceId", "slug", "title")
      VALUES
        ('catalog-source', 'practice-ledger', 'finance-source', 'Finance'),
        ('catalog-slug', 'finance', 'practice-ledger', 'Finance'),
        ('catalog-title', 'finance', 'finance', 'Practice Ledger'),
        ('catalog-keep', 'brain', 'brain', 'Brain')
    `);

    await applyMigration(fixture, "prisma/migrations/20260728070000_drop_legacy_finance/migration.sql");

    const financeFlags = await tableCount(fixture, "WorkspaceFeatureFlag", `"flag" = 'FINANCE'`);
    const oldFinanceFlags = await tableCount(fixture, "WorkspaceFeatureFlag", `"flag" IN ('FINANCE_PROJECTS', 'FINANCE_SLICING_PIE', 'PRACTICE_PROJECTS', 'SLICING_PIE')`);
    const unrelatedFlags = await tableCount(fixture, "WorkspaceFeatureFlag", `"flag" = 'BRAIN'`);
    if (financeFlags !== 1 || oldFinanceFlags !== 0 || unrelatedFlags !== 1) {
      throw new Error(`Unexpected Finance flag cleanup counts: ${JSON.stringify({ financeFlags, oldFinanceFlags, unrelatedFlags })}`);
    }

    const removedPracticeAppRows = await tableCount(fixture, "AppDefinition", `"appKey" = 'practice-ledger'`);
    const keptAppRows = await tableCount(fixture, "AppDefinition", `"appKey" = 'brain'`);
    const removedCatalogRows = await tableCount(fixture, "CatalogItem", `"sourceId" = 'practice-ledger' OR "slug" = 'practice-ledger' OR "title" = 'Practice Ledger'`);
    const keptCatalogRows = await tableCount(fixture, "CatalogItem", `"slug" = 'brain'`);
    if (removedPracticeAppRows !== 0 || keptAppRows !== 1 || removedCatalogRows !== 0 || keptCatalogRows !== 1) {
      throw new Error(`Unexpected app/catalog cleanup counts: ${JSON.stringify({ removedPracticeAppRows, keptAppRows, removedCatalogRows, keptCatalogRows })}`);
    }

    const removedGoalLinks = await tableCount(fixture, "GoalLink", `"source" IN ('practice-finance', 'practice-ledger') OR "entityType" ILIKE 'Practice%'`);
    const keptGoalLinks = await tableCount(fixture, "GoalLink", `"entityType" = 'Goal'`);
    if (removedGoalLinks !== 0 || keptGoalLinks !== 1) {
      throw new Error(`Unexpected GoalLink cleanup counts: ${JSON.stringify({ removedGoalLinks, keptGoalLinks })}`);
    }

    for (const tableName of [
      "WorkspaceModuleAccessRequest",
      "WorkspaceModuleGrant",
      "CommunicationEntityLink",
      "WorkItemEvidence",
      "WorkspaceExternalResourceAttachment",
      "AuditLog",
      "WorkItemVersion",
      "WorkspaceArchiveRecord",
      "WorkspacePermalink",
    ]) {
      const oldRows = tableName.includes("WorkspaceModule")
        ? await tableCount(fixture, tableName, `"moduleKey" = 'practice-ledger'`)
        : await tableCount(fixture, tableName, `"entityType" ILIKE 'Practice%'`);
      const keptRows = tableName.includes("WorkspaceModule")
        ? await tableCount(fixture, tableName, `"moduleKey" = 'brain'`)
        : await tableCount(fixture, tableName, `"entityType" = 'Goal'`);
      if (oldRows !== 0 || keptRows !== 1) {
        throw new Error(`Unexpected cleanup counts for ${tableName}: ${JSON.stringify({ oldRows, keptRows })}`);
      }
    }

    const remainingPracticeTables = await fixture.$queryRawUnsafe(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name LIKE 'Practice%'
      ORDER BY table_name
    `);
    if (remainingPracticeTables.length !== 0) {
      throw new Error(`Practice tables still exist after migration: ${JSON.stringify(remainingPracticeTables)}`);
    }

    const remainingPracticeTypes = await fixture.$queryRawUnsafe(`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema()
        AND t.typname LIKE 'Practice%'
      ORDER BY t.typname
    `);
    if (remainingPracticeTypes.length !== 0) {
      throw new Error(`Practice enum types still exist after migration: ${JSON.stringify(remainingPracticeTypes)}`);
    }
  });
}

async function main() {
  try {
    await runProposalReactionFixture();
    await runLegacyFinanceFixture();
    console.log("OK data migration fixtures passed.");
  } finally {
    await admin.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await admin.$disconnect().catch(() => {});
  process.exit(1);
});
