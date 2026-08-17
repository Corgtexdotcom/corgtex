#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const prismaBin = path.join(rootDir, "node_modules", ".bin", "prisma");
const canonicalMigrationPath = "prisma/migrations/20260817000000_canonical_workspace_system_actor/migration.sql";

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

function applyExactMigration(databaseUrl, migrationPath) {
  execFileSync(prismaBin, ["db", "execute", "--file", migrationPath, "--url", databaseUrl], {
    cwd: rootDir,
    env: process.env,
    stdio: "pipe",
  });
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
    await run(fixture, withSchema(rootDatabaseUrl, schemaName));
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

async function createCanonicalWorkspaceTables(fixture) {
  await fixture.$executeRawUnsafe(`CREATE TYPE "GlobalRole" AS ENUM ('USER', 'OPERATOR')`);
  await fixture.$executeRawUnsafe(`CREATE TYPE "MemberRole" AS ENUM ('CONTRIBUTOR', 'FACILITATOR', 'FINANCE_STEWARD', 'ADMIN')`);
  await fixture.$executeRawUnsafe(`CREATE TYPE "MemberKind" AS ENUM ('HUMAN', 'SYSTEM')`);
  await fixture.$executeRawUnsafe(`CREATE TYPE "ApprovalMode" AS ENUM ('CONSENT', 'MAJORITY')`);
  await fixture.$executeRawUnsafe(`
    CREATE TABLE "Workspace" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "slug" TEXT NOT NULL UNIQUE,
      "name" TEXT NOT NULL
    )
  `);
  await fixture.$executeRawUnsafe(`
    CREATE TABLE "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "email" TEXT NOT NULL UNIQUE,
      "displayName" TEXT,
      "passwordHash" TEXT NOT NULL,
      "globalRole" "GlobalRole" NOT NULL DEFAULT 'USER',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL
    )
  `);
  await fixture.$executeRawUnsafe(`
    CREATE TABLE "UserSsoIdentity" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL
    )
  `);
  await fixture.$executeRawUnsafe(`CREATE TABLE "OAuthConnection" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL)`);
  await fixture.$executeRawUnsafe(`CREATE TABLE "ExternalMcpConnection" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL)`);
  await fixture.$executeRawUnsafe(`CREATE TABLE "Session" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL)`);
  await fixture.$executeRawUnsafe(`CREATE TABLE "PasswordResetToken" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "usedAt" TIMESTAMP(3))`);
  await fixture.$executeRawUnsafe(`CREATE TABLE "OAuthAuthorizationCode" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "usedAt" TIMESTAMP(3))`);
  await fixture.$executeRawUnsafe(`CREATE TABLE "OAuthAccessToken" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "revokedAt" TIMESTAMP(3))`);
  await fixture.$executeRawUnsafe(`CREATE TABLE "McpOAuthAuthorizationCode" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "usedAt" TIMESTAMP(3))`);
  await fixture.$executeRawUnsafe(`CREATE TABLE "McpOAuthAccessToken" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "revokedAt" TIMESTAMP(3))`);
  await fixture.$executeRawUnsafe(`CREATE TABLE "AppSession" ("id" TEXT NOT NULL PRIMARY KEY, "actorUserId" TEXT, "revokedAt" TIMESTAMP(3))`);
  await fixture.$executeRawUnsafe(`
    CREATE TABLE "Member" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspaceId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "role" "MemberRole" NOT NULL DEFAULT 'CONTRIBUTOR',
      "kind" "MemberKind" NOT NULL DEFAULT 'HUMAN',
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "mergedIntoMemberId" TEXT,
      "mergedAt" TIMESTAMP(3),
      "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Member_workspaceId_userId_key" UNIQUE ("workspaceId", "userId")
    )
  `);
  await fixture.$executeRawUnsafe(`
    CREATE TABLE "ApprovalPolicy" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspaceId" TEXT NOT NULL,
      "subjectType" TEXT NOT NULL,
      "mode" "ApprovalMode" NOT NULL,
      "quorumPercent" INTEGER NOT NULL DEFAULT 0,
      "minApproverCount" INTEGER NOT NULL DEFAULT 1,
      "decisionWindowHours" INTEGER NOT NULL DEFAULT 72,
      "requireProposalLink" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "ApprovalPolicy_workspaceId_subjectType_key" UNIQUE ("workspaceId", "subjectType")
    )
  `);
}

async function insertFixtureWorkspace(fixture, id, slug, name = slug) {
  await fixture.$executeRawUnsafe(
    `INSERT INTO "Workspace" ("id", "slug", "name") VALUES ($1, $2, $3)`,
    id,
    slug,
    name,
  );
}

async function insertFixtureUser(fixture, params) {
  await fixture.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "displayName", "passwordHash", "globalRole", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::"GlobalRole", CURRENT_TIMESTAMP)`,
    params.id,
    params.email,
    params.displayName ?? null,
    params.passwordHash ?? "existing-password-hash",
    params.globalRole ?? "USER",
  );
}

async function insertFixtureMember(fixture, params) {
  await fixture.$executeRawUnsafe(
    `INSERT INTO "Member" (
       "id", "workspaceId", "userId", "role", "kind", "isActive", "mergedAt", "mergedIntoMemberId"
     ) VALUES ($1, $2, $3, $4::"MemberRole", $5::"MemberKind", $6, $7, $8)`,
    params.id,
    params.workspaceId,
    params.userId,
    params.role ?? "ADMIN",
    params.kind ?? "SYSTEM",
    params.isActive ?? true,
    params.mergedAt ?? null,
    params.mergedIntoMemberId ?? null,
  );
}

async function insertFixtureSsoIdentity(fixture, id, userId) {
  await fixture.$executeRawUnsafe(
    `INSERT INTO "UserSsoIdentity" ("id", "userId") VALUES ($1, $2)`,
    id,
    userId,
  );
}

async function insertCanonicalInboundCredentials(fixture, userId, prefix = userId) {
  await fixture.$executeRawUnsafe(`INSERT INTO "Session" ("id", "userId") VALUES ($1, $2)`, `${prefix}-session`, userId);
  await fixture.$executeRawUnsafe(`INSERT INTO "PasswordResetToken" ("id", "userId") VALUES ($1, $2)`, `${prefix}-reset`, userId);
  await fixture.$executeRawUnsafe(`INSERT INTO "OAuthAuthorizationCode" ("id", "userId") VALUES ($1, $2)`, `${prefix}-oauth-code`, userId);
  await fixture.$executeRawUnsafe(`INSERT INTO "OAuthAccessToken" ("id", "userId") VALUES ($1, $2)`, `${prefix}-oauth-token`, userId);
  await fixture.$executeRawUnsafe(`INSERT INTO "McpOAuthAuthorizationCode" ("id", "userId") VALUES ($1, $2)`, `${prefix}-mcp-code`, userId);
  await fixture.$executeRawUnsafe(`INSERT INTO "McpOAuthAccessToken" ("id", "userId") VALUES ($1, $2)`, `${prefix}-mcp-token`, userId);
  await fixture.$executeRawUnsafe(`INSERT INTO "AppSession" ("id", "actorUserId") VALUES ($1, $2)`, `${prefix}-app-session`, userId);
}

async function assertCanonicalInboundCredentialsRevoked(fixture, userId) {
  if (await tableCount(fixture, "Session", `"userId" = '${userId}'`) !== 0) {
    throw new Error("Canonical migration retained an interactive Session.");
  }
  for (const [table, timestamp] of [
    ["PasswordResetToken", "usedAt"],
    ["OAuthAuthorizationCode", "usedAt"],
    ["OAuthAccessToken", "revokedAt"],
    ["McpOAuthAuthorizationCode", "usedAt"],
    ["McpOAuthAccessToken", "revokedAt"],
  ]) {
    if (await tableCount(fixture, table, `"userId" = '${userId}' AND "${timestamp}" IS NULL`) !== 0) {
      throw new Error(`Canonical migration retained active ${table} credentials.`);
    }
  }
  if (await tableCount(fixture, "AppSession", `"actorUserId" = '${userId}' AND "revokedAt" IS NULL`) !== 0) {
    throw new Error("Canonical migration retained an active delegated AppSession.");
  }
}

async function runCanonicalWorkspaceHappyFixture() {
  await withIsolatedSchema(async (fixture, databaseUrl) => {
    await createCanonicalWorkspaceTables(fixture);
    await insertFixtureWorkspace(fixture, "workspace-new", "workspace-new", "New Workspace");
    await insertFixtureWorkspace(fixture, "workspace-repair", "workspace-repair", "Repair Workspace");
    await insertFixtureWorkspace(fixture, "workspace-custom", "workspace-custom", "Custom Workspace");

    await insertFixtureUser(fixture, {
      id: "system-repair",
      email: "system+workspace-repair@corgtex.local",
      displayName: "Preserved Repair Name",
      passwordHash: "preserved-repair-password",
    });
    await insertFixtureMember(fixture, {
      id: "member-repair",
      workspaceId: "workspace-repair",
      userId: "system-repair",
      role: "CONTRIBUTOR",
      isActive: false,
    });
    await insertCanonicalInboundCredentials(fixture, "system-repair");

    await insertFixtureUser(fixture, {
      id: "system-custom",
      email: "system+workspace-custom@corgtex.local",
      displayName: "Preserved Custom Name",
      passwordHash: "preserved-custom-password",
    });
    await insertFixtureMember(fixture, {
      id: "member-custom",
      workspaceId: "workspace-custom",
      userId: "system-custom",
    });
    await insertFixtureUser(fixture, {
      id: "legacy-support",
      email: "support+workspace-custom@corgtex.local",
      displayName: "Legacy Support",
    });
    await insertFixtureMember(fixture, {
      id: "legacy-support-member",
      workspaceId: "workspace-custom",
      userId: "legacy-support",
      role: "CONTRIBUTOR",
      kind: "SYSTEM",
    });
    await fixture.$executeRawUnsafe(`
      INSERT INTO "ApprovalPolicy" (
        "id", "workspaceId", "subjectType", "mode", "quorumPercent",
        "minApproverCount", "decisionWindowHours", "requireProposalLink", "updatedAt"
      ) VALUES (
        'custom-policy', 'workspace-custom', 'PROPOSAL', 'MAJORITY', 67, 4, 240, true, CURRENT_TIMESTAMP
      )
    `);
    const [customPolicyBefore] = await fixture.$queryRawUnsafe(`
      SELECT "id", "mode"::text, "quorumPercent", "minApproverCount", "decisionWindowHours", "requireProposalLink"
      FROM "ApprovalPolicy" WHERE "id" = 'custom-policy'
    `);

    applyExactMigration(databaseUrl, canonicalMigrationPath);
    const [firstCanonicalHash] = await fixture.$queryRawUnsafe(`
      SELECT "passwordHash" FROM "User" WHERE "id" = 'system-repair'
    `);
    applyExactMigration(databaseUrl, canonicalMigrationPath);

    const systemRows = await fixture.$queryRawUnsafe(`
      SELECT
        workspace."slug",
        canonical_user."displayName",
        canonical_user."passwordHash",
        membership."role"::text,
        membership."kind"::text,
        membership."isActive"
      FROM "Workspace" AS workspace
      JOIN "User" AS canonical_user
        ON canonical_user."email" = 'system+' || workspace."slug" || '@corgtex.local'
      JOIN "Member" AS membership
        ON membership."workspaceId" = workspace."id" AND membership."userId" = canonical_user."id"
      ORDER BY workspace."slug"
    `);
    if (systemRows.length !== 3 || systemRows.some((row) => row.role !== "ADMIN" || row.kind !== "SYSTEM" || !row.isActive)) {
      throw new Error(`Canonical system members were not established: ${JSON.stringify(systemRows)}`);
    }
    const created = systemRows.find((row) => row.slug === "workspace-new");
    if (created?.passwordHash !== "disabled$canonical-workspace-system-actor-v1") {
      throw new Error("New canonical system user does not have the stable disabled password marker.");
    }
    const repaired = systemRows.find((row) => row.slug === "workspace-repair");
    if (repaired?.displayName !== "Preserved Repair Name"
      || repaired?.passwordHash !== "disabled$canonical-workspace-system-actor-v1"
      || firstCanonicalHash?.passwordHash !== repaired.passwordHash) {
      throw new Error("Migration did not stably disable an existing proven-safe canonical User.");
    }
    await assertCanonicalInboundCredentialsRevoked(fixture, "system-repair");

    const [customPolicyAfter] = await fixture.$queryRawUnsafe(`
      SELECT "id", "mode"::text, "quorumPercent", "minApproverCount", "decisionWindowHours", "requireProposalLink"
      FROM "ApprovalPolicy" WHERE "id" = 'custom-policy'
    `);
    if (JSON.stringify(customPolicyAfter) !== JSON.stringify(customPolicyBefore)) {
      throw new Error("Migration overwrote a customized proposal policy.");
    }
    if (await tableCount(fixture, "ApprovalPolicy") !== 3) {
      throw new Error("Canonical migration was not idempotent for proposal policies.");
    }
    if (await tableCount(fixture, "User", `"id" = 'legacy-support'`) !== 1
      || await tableCount(fixture, "Member", `"id" = 'legacy-support-member'`) !== 1) {
      throw new Error("Canonical migration changed a legacy support identity.");
    }
  });
}

async function runCanonicalCollisionFixture(label, seedCollision) {
  await withIsolatedSchema(async (fixture, databaseUrl) => {
    await createCanonicalWorkspaceTables(fixture);
    await insertFixtureWorkspace(fixture, "workspace-clean", "workspace-clean", "Clean Workspace");
    await insertFixtureWorkspace(fixture, "workspace-collision", "workspace-collision", "Collision Workspace");
    await seedCollision(fixture);

    let failed = false;
    try {
      applyExactMigration(databaseUrl, canonicalMigrationPath);
    } catch (error) {
      failed = true;
      const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
      if (!output.includes("CANONICAL_SYSTEM_ACTOR_COLLISION")) {
        throw new Error(`${label} failed without the sanitized collision code.`);
      }
    }
    if (!failed) throw new Error(`${label} unexpectedly passed canonical collision preflight.`);

    const cleanUsers = await tableCount(fixture, "User", `"email" = 'system+workspace-clean@corgtex.local'`);
    const cleanPolicies = await tableCount(fixture, "ApprovalPolicy", `"workspaceId" = 'workspace-clean'`);
    if (cleanUsers !== 0 || cleanPolicies !== 0) {
      throw new Error(`${label} partially mutated a clean workspace before collision failure.`);
    }
  });
}

async function runCanonicalCollisionFixtures() {
  await runCanonicalCollisionFixture("case-insensitive alias", async (fixture) => {
    await insertFixtureUser(fixture, {
      id: "alias-user",
      email: "System+workspace-collision@corgtex.local",
    });
  });
  await runCanonicalCollisionFixture("orphaned exact user", async (fixture) => {
    await insertFixtureUser(fixture, {
      id: "orphan-user",
      email: "system+workspace-collision@corgtex.local",
    });
  });
  await runCanonicalCollisionFixture("human canonical member", async (fixture) => {
    await insertFixtureUser(fixture, {
      id: "human-user",
      email: "system+workspace-collision@corgtex.local",
    });
    await insertFixtureMember(fixture, {
      id: "human-member",
      workspaceId: "workspace-collision",
      userId: "human-user",
      kind: "HUMAN",
    });
  });
  await runCanonicalCollisionFixture("foreign canonical member", async (fixture) => {
    await insertFixtureWorkspace(fixture, "workspace-foreign", "workspace-foreign", "Foreign Workspace");
    await insertFixtureUser(fixture, {
      id: "foreign-user",
      email: "system+workspace-collision@corgtex.local",
    });
    await insertFixtureMember(fixture, {
      id: "foreign-member",
      workspaceId: "workspace-foreign",
      userId: "foreign-user",
    });
  });
  await runCanonicalCollisionFixture("merged canonical member", async (fixture) => {
    await insertFixtureUser(fixture, {
      id: "merged-user",
      email: "system+workspace-collision@corgtex.local",
    });
    await insertFixtureMember(fixture, {
      id: "merged-member",
      workspaceId: "workspace-collision",
      userId: "merged-user",
      mergedAt: new Date("2026-08-01T00:00:00.000Z"),
      mergedIntoMemberId: "replacement-member",
    });
  });
  await runCanonicalCollisionFixture("operator canonical user", async (fixture) => {
    await insertFixtureUser(fixture, {
      id: "operator-user",
      email: "system+workspace-collision@corgtex.local",
      globalRole: "OPERATOR",
    });
    await insertFixtureMember(fixture, {
      id: "operator-member",
      workspaceId: "workspace-collision",
      userId: "operator-user",
    });
  });
  await runCanonicalCollisionFixture("SSO-linked canonical user", async (fixture) => {
    await insertFixtureUser(fixture, {
      id: "sso-user",
      email: "system+workspace-collision@corgtex.local",
    });
    await insertFixtureMember(fixture, {
      id: "sso-member",
      workspaceId: "workspace-collision",
      userId: "sso-user",
    });
    await insertFixtureSsoIdentity(fixture, "sso-identity", "sso-user");
  });
  await runCanonicalCollisionFixture("OAuth-connected canonical user", async (fixture) => {
    await insertFixtureUser(fixture, {
      id: "oauth-user",
      email: "system+workspace-collision@corgtex.local",
    });
    await insertFixtureMember(fixture, {
      id: "oauth-member",
      workspaceId: "workspace-collision",
      userId: "oauth-user",
    });
    await fixture.$executeRawUnsafe(`INSERT INTO "OAuthConnection" ("id", "userId") VALUES ('oauth-connection', 'oauth-user')`);
  });
  await runCanonicalCollisionFixture("outbound MCP-connected canonical user", async (fixture) => {
    await insertFixtureUser(fixture, {
      id: "external-mcp-user",
      email: "system+workspace-collision@corgtex.local",
    });
    await insertFixtureMember(fixture, {
      id: "external-mcp-member",
      workspaceId: "workspace-collision",
      userId: "external-mcp-user",
    });
    await fixture.$executeRawUnsafe(`INSERT INTO "ExternalMcpConnection" ("id", "userId") VALUES ('external-mcp-connection', 'external-mcp-user')`);
  });
}

async function runCanonicalInvalidSlugFixture(label, invalidSlug) {
  await withIsolatedSchema(async (fixture, databaseUrl) => {
    await createCanonicalWorkspaceTables(fixture);
    await insertFixtureWorkspace(fixture, "workspace-clean", "workspace-clean", "Clean Workspace");
    await insertFixtureWorkspace(fixture, "workspace-invalid", invalidSlug, "Invalid Workspace");

    let failed = false;
    try {
      applyExactMigration(databaseUrl, canonicalMigrationPath);
    } catch (error) {
      failed = true;
      const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
      if (!output.includes("CANONICAL_WORKSPACE_SLUG_INVALID")) {
        throw new Error(`${label} failed without the sanitized precondition code.`);
      }
    }
    if (!failed) throw new Error(`${label} unexpectedly passed migration preflight.`);
    if (await tableCount(fixture, "User") !== 0 || await tableCount(fixture, "ApprovalPolicy") !== 0) {
      throw new Error(`${label} caused partial canonical migration writes.`);
    }
  });
}

async function runCanonicalLateFailureFixture() {
  await withIsolatedSchema(async (fixture, databaseUrl) => {
    await createCanonicalWorkspaceTables(fixture);
    await insertFixtureWorkspace(fixture, "workspace-late", "workspace-late", "Late Failure Workspace");
    await insertFixtureUser(fixture, {
      id: "system-late",
      email: "system+workspace-late@corgtex.local",
      passwordHash: "legacy-known-password-hash",
    });
    await insertFixtureMember(fixture, {
      id: "member-late",
      workspaceId: "workspace-late",
      userId: "system-late",
      role: "CONTRIBUTOR",
      isActive: false,
    });
    await insertCanonicalInboundCredentials(fixture, "system-late");
    await fixture.$executeRawUnsafe(`
      CREATE FUNCTION reject_canonical_member_fixture() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'LATE_MEMBER_FIXTURE_FAILURE';
      END;
      $$ LANGUAGE plpgsql
    `);
    await fixture.$executeRawUnsafe(`
      CREATE TRIGGER reject_canonical_member_fixture
      BEFORE INSERT OR UPDATE ON "Member"
      FOR EACH ROW EXECUTE FUNCTION reject_canonical_member_fixture()
    `);

    let failed = false;
    try {
      applyExactMigration(databaseUrl, canonicalMigrationPath);
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("Late Member failure fixture unexpectedly passed.");
    const [rolledBackUser] = await fixture.$queryRawUnsafe(`SELECT "passwordHash" FROM "User" WHERE "id" = 'system-late'`);
    const activeInboundCredentialCounts = await Promise.all([
      tableCount(fixture, "PasswordResetToken", `"userId" = 'system-late' AND "usedAt" IS NULL`),
      tableCount(fixture, "OAuthAuthorizationCode", `"userId" = 'system-late' AND "usedAt" IS NULL`),
      tableCount(fixture, "OAuthAccessToken", `"userId" = 'system-late' AND "revokedAt" IS NULL`),
      tableCount(fixture, "McpOAuthAuthorizationCode", `"userId" = 'system-late' AND "usedAt" IS NULL`),
      tableCount(fixture, "McpOAuthAccessToken", `"userId" = 'system-late' AND "revokedAt" IS NULL`),
      tableCount(fixture, "AppSession", `"actorUserId" = 'system-late' AND "revokedAt" IS NULL`),
    ]);
    if (rolledBackUser?.passwordHash !== "legacy-known-password-hash"
      || await tableCount(fixture, "Session", `"userId" = 'system-late'`) !== 1
      || activeInboundCredentialCounts.some((count) => count !== 1)
      || await tableCount(fixture, "ApprovalPolicy") !== 0) {
      throw new Error("Explicit migration transaction did not roll back writes after a late Member failure.");
    }
  });
}

async function main() {
  try {
    await runProposalReactionFixture();
    await runLegacyFinanceFixture();
    await runCanonicalWorkspaceHappyFixture();
    await runCanonicalCollisionFixtures();
    await runCanonicalInvalidSlugFixture("Non-normalized workspace slug", " Invalid Slug ");
    await runCanonicalInvalidSlugFixture("Empty workspace slug", "");
    await runCanonicalLateFailureFixture();
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
