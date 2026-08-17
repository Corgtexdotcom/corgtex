import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma, resolveReleaseMetadata } from "@corgtex/shared";
import {
  resolveAzureBlobStorageRuntimeConfig,
  resolveStorageProviderName,
  resolveStorageRuntimeConfig,
} from "@corgtex/storage";

const migrationsDir = path.resolve(process.cwd(), "..", "..", "prisma", "migrations");

function handleRouteError(error: unknown) {
  console.error("Healthcheck failed.", error);

  return NextResponse.json(
    {
      status: "degraded",
      service: "web",
      database: "down",
      schema: "unknown",
      app: "corgtex",
      auth: "password-session",
      release: releaseFingerprint(),
      runtime: runtimeFingerprint(),
    },
    { status: 503 },
  );
}

function releaseFingerprint() {
  return resolveReleaseMetadata(process.env, { service: "web" });
}

function runtimeFingerprint() {
  const storageConfigured = resolveStorageProviderName() === "azure_blob"
    ? resolveAzureBlobStorageRuntimeConfig().configured
    : resolveStorageRuntimeConfig().configured;

  return {
    redis: process.env.REDIS_URL ? "configured" : "missing",
    storage: storageConfigured ? "configured" : "missing",
    workspaceScopeSlug: process.env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG ?? null,
  };
}

async function hasRequiredBrainTables() {
  const [result] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
    SELECT bool_and(to_regclass(required.name) IS NOT NULL) AS "ready"
    FROM (
      VALUES
        ('public."BrainArticle"'),
        ('public."BrainArticleVersion"'),
        ('public."BrainSource"'),
        ('public."BrainBacklink"'),
        ('public."BrainDiscussionThread"'),
        ('public."BrainDiscussionComment"')
    ) AS required(name)
  `;

  return result?.ready === true;
}

async function hasBrainKnowledgeSourceType() {
  const [result] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_enum enum
      JOIN pg_type type ON type.oid = enum.enumtypid
      WHERE type.typname = 'KnowledgeSourceType'
        AND enum.enumlabel = 'BRAIN_ARTICLE'
    ) AS "ready"
  `;

  return result?.ready === true;
}

async function hasHealthyMigrations() {
  try {
    const bundledMigrations = existsSync(migrationsDir)
      ? readdirSync(migrationsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "migration_lock.toml")
        .map((entry) => entry.name)
      : [];
    const migrationRows = await prisma.$queryRaw<Array<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM _prisma_migrations
    `;
    const failedMigration = migrationRows.some((row) => row.finished_at === null && row.rolled_back_at === null);
    if (failedMigration) return false;

    const appliedMigrations = new Set(
      migrationRows
        .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
        .map((row) => row.migration_name),
    );
    return bundledMigrations.every((migration) => appliedMigrations.has(migration));
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [brainTablesReady, knowledgeSourceTypeReady, migrationsHealthy] = await Promise.all([
      hasRequiredBrainTables(),
      hasBrainKnowledgeSourceType(),
      hasHealthyMigrations(),
    ]);

    if (!brainTablesReady || !knowledgeSourceTypeReady || !migrationsHealthy) {
      return NextResponse.json(
        {
          status: "degraded",
          service: "web",
          database: "up",
          schema: "stale",
          app: "corgtex",
          auth: "password-session",
          release: releaseFingerprint(),
          runtime: runtimeFingerprint(),
          missing: {
            brainTables: !brainTablesReady,
            knowledgeSourceType: !knowledgeSourceTypeReady,
            migrations: !migrationsHealthy,
          },
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      status: "ok",
      service: "web",
      database: "up",
      schema: "ready",
      app: "corgtex",
      auth: "password-session",
      release: releaseFingerprint(),
      runtime: runtimeFingerprint(),
      loginPath: "/login",
      apiLoginPath: "/api/auth/login",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
