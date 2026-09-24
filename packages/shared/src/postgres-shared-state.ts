import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./db";
import { decryptSecret, encryptSecret } from "./crypto";
import { sharedStateKey } from "./shared-state";
import type { RateLimitOptions, RateLimitResult } from "./rate-limiter";

// Independent clients may be supplied by integration tests. Production uses the lazy singleton.
export function createPostgresSharedState(db: PrismaClient = prisma) {
  let nextCleanupAt = 0;
  async function cleanup() {
    if (Date.now() < nextCleanupAt) return;
    nextCleanupAt = Date.now() + 60_000;
    // Small batches and SKIP LOCKED keep cleanup out of active request transactions.
    await db.$executeRaw`WITH expired AS MATERIALIZED (SELECT "id" FROM "SharedRateLimit" WHERE "expiresAt" <= clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED) DELETE FROM "SharedRateLimit" WHERE "id" IN (SELECT "id" FROM expired)`;
    await db.$executeRaw`WITH expired AS MATERIALIZED (SELECT "id" FROM "SharedCacheEntry" WHERE "expiresAt" <= clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED) DELETE FROM "SharedCacheEntry" WHERE "id" IN (SELECT "id" FROM expired)`;
  }
  async function check(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || !Number.isSafeInteger(opts.windowMs) || opts.windowMs < 1) {
      throw new Error("Invalid rate limit options");
    }
    const id = sharedStateKey("rate-limit", key);
    const result = await db.$transaction(async (tx) => {
      // Check and reset use the same transaction lock, including when no row exists.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`;
      await tx.$executeRaw`INSERT INTO "SharedRateLimit" ("id", "timestamps", "expiresAt") VALUES (${id}, ARRAY[]::bigint[], clock_timestamp()) ON CONFLICT ("id") DO UPDATE SET "id" = EXCLUDED."id"`;
      const [row] = await tx.$queryRaw<{ timestamps: bigint[] }[]>`SELECT "timestamps" FROM "SharedRateLimit" WHERE "id" = ${id} FOR UPDATE`;
      const [clock] = await tx.$queryRaw<{ now: bigint }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now`;
      const now = Number(clock.now);
      const timestamps = row.timestamps.map(Number).filter((time) => time > now - opts.windowMs);
      const resetAtMs = (timestamps[0] ?? now) + opts.windowMs;
      const allowed = timestamps.length < opts.limit;
      if (allowed) timestamps.push(now);
      await tx.sharedRateLimit.update({ where: { id }, data: { timestamps: timestamps.map(BigInt), expiresAt: new Date((timestamps.at(-1) ?? now) + opts.windowMs) } });
      return { allowed, remaining: Math.max(0, opts.limit - timestamps.length), limit: opts.limit, resetAtMs };
    });
    await cleanup().catch(() => undefined);
    return result;
  }
  async function reset(key: string) {
    const id = sharedStateKey("rate-limit", key);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`;
      await tx.sharedRateLimit.deleteMany({ where: { id } });
    });
  }
  async function getJson<T>(key: string): Promise<T | null> {
    const id = sharedStateKey("cache", key);
    const rows = await db.$queryRaw<{ encryptedPayload: string }[]>`SELECT "encryptedPayload" FROM "SharedCacheEntry" WHERE "id" = ${id} AND "expiresAt" > clock_timestamp()`;
    return rows[0] ? JSON.parse(decryptSecret(rows[0].encryptedPayload)) as T : null;
  }
  async function setJson(key: string, value: unknown, ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Invalid cache TTL");
    const id = sharedStateKey("cache", key);
    const payload = encryptSecret(JSON.stringify(value));
    await db.$executeRaw`INSERT INTO "SharedCacheEntry" ("id", "encryptedPayload", "expiresAt") VALUES (${id}, ${payload}, clock_timestamp() + ${ttlMs} * interval '1 millisecond') ON CONFLICT ("id") DO UPDATE SET "encryptedPayload" = EXCLUDED."encryptedPayload", "expiresAt" = EXCLUDED."expiresAt"`;
    await cleanup().catch(() => undefined);
  }
  async function getVersion(scope: string) {
    return (await db.sharedCacheVersion.findUnique({ where: { id: sharedStateKey("cache-version", scope) } }))?.version ?? 0;
  }
  async function incrementVersion(scope: string, transaction?: Prisma.TransactionClient) {
    const id = sharedStateKey("cache-version", scope);
    const [row] = await (transaction ?? db).$queryRaw<{ version: number }[]>`INSERT INTO "SharedCacheVersion" ("id", "version") VALUES (${id}, 1) ON CONFLICT ("id") DO UPDATE SET "version" = "SharedCacheVersion"."version" + 1 RETURNING "version"`;
    return row.version;
  }
  return { check, reset, getJson, setJson, getVersion, incrementVersion };
}

export const postgresSharedState = createPostgresSharedState();
