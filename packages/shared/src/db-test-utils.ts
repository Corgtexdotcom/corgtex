import { prisma } from "./db";

/**
 * Truncates all tables in the database to completely isolate integration tests.
 * This is faster than dropping and recreating the schema via push/migrate.
 * It ignores the _prisma_migrations table.
 */
export async function truncateAllTables() {
  const tableNames = await prisma.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename != '_prisma_migrations';`;

  const tables = tableNames
    .map(({ tablename }) => `"public"."${tablename}"`)
    .join(", ");

  if (tables !== "") {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} CASCADE;`);
  }
}
