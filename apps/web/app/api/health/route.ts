import { NextResponse } from "next/server";
import { prisma } from "@corgtex/shared";

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
    const failedMigrationsRaw = await prisma.$queryRaw`
      SELECT COUNT(*) as count FROM _prisma_migrations 
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
    `;
    const count = Number((failedMigrationsRaw as any[])[0]?.count || 0);
    return count === 0;
  } catch (e) {
    // If table doesn't exist yet, it's not healthy
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
      loginPath: "/login",
      apiLoginPath: "/api/auth/login",
    });
  } catch (error) {
    console.error("Healthcheck failed.", error);

    return NextResponse.json(
      {
        status: "degraded",
        service: "web",
        database: "down",
        schema: "unknown",
        app: "corgtex",
        auth: "password-session",
      },
      { status: 503 },
    );
  }
}
