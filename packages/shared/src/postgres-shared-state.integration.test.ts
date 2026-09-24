import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkRateLimit } from "./rate-limiter";
import { postgresSharedState } from "./postgres-shared-state";
import { createPostgresSharedState } from "./postgres-shared-state";
import { sharedStateKey } from "./shared-state";

const first = new PrismaClient();
const second = new PrismaClient();
const a = createPostgresSharedState(first);
const b = createPostgresSharedState(second);
const prefix = randomUUID();
const rateKeys: string[] = [];
const cacheKeys: string[] = [];
const versionKeys: string[] = [];
const key = (kind: string, keys: string[]) => { const value = `${prefix}:${kind}`; keys.push(value); return value; };
beforeAll(() => { vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex")); });
afterAll(async () => {
  await first.sharedRateLimit.deleteMany({ where: { id: { in: rateKeys.map((k) => sharedStateKey("rate-limit", k)) } } });
  await first.sharedCacheEntry.deleteMany({ where: { id: { in: cacheKeys.map((k) => sharedStateKey("cache", k)) } } });
  await first.sharedCacheVersion.deleteMany({ where: { id: { in: versionKeys.map((k) => sharedStateKey("cache-version", k)) } } });
  await Promise.all([first.$disconnect(), second.$disconnect()]);
  vi.unstubAllEnvs();
});

describe("PostgreSQL shared state across independent clients", () => {
  it("works with an ordinary DML-only runtime role while DDL is denied", async () => {
    const role = `shared_state_test_${randomBytes(8).toString("hex")}`;
    const password = randomBytes(24).toString("hex");
    const runtimeUrl = new URL(process.env.DATABASE_URL!);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    const runtime = new PrismaClient({ datasources: { db: { url: runtimeUrl.toString() } } });
    // Identifiers and password contain only generated hexadecimal plus a fixed prefix.
    await first.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    try {
      await first.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await first.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SharedRateLimit", "SharedCacheEntry", "SharedCacheVersion" TO "${role}"`);
      const state = createPostgresSharedState(runtime);
      const limitKey = key("ordinary-role-limit", rateKeys);
      const cacheKey = key("ordinary-role-cache", cacheKeys);
      const scope = key("ordinary-role-version", versionKeys);
      expect((await state.check(limitKey, { limit: 1, windowMs: 60_000 })).allowed).toBe(true);
      expect((await state.check(limitKey, { limit: 1, windowMs: 60_000 })).allowed).toBe(false);
      await state.reset(limitKey);
      expect((await state.check(limitKey, { limit: 1, windowMs: 60_000 })).allowed).toBe(true);
      await state.setJson(cacheKey, { allowed: "DML" }, 60_000);
      expect(await state.getJson(cacheKey)).toEqual({ allowed: "DML" });
      expect(await state.incrementVersion(scope)).toBe(1);
      expect(await state.getVersion(scope)).toBe(1);
      await expect(runtime.$executeRawUnsafe(`CREATE TABLE public."${role}" (id INTEGER)`)).rejects.toMatchObject({ code: "P2010", meta: { code: "42501" } });
    } finally {
      await runtime.$disconnect();
      await first.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await first.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  });
  it("admits exactly the shared limit under concurrent requests", async () => {
    const k = key("concurrency", rateKeys);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).check(k, { limit: 7, windowMs: 60_000 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(7);
    expect(results.filter((r) => r.allowed).map((r) => r.remaining).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(results.map((r) => r.resetAtMs)).size).toBe(1);
  });
  it("serializes reset with an in-flight check, then expires windows", async () => {
    const k = key("reset", rateKeys);
    await a.check(k, { limit: 1, windowMs: 60_000 });
    await Promise.all([a.check(k, { limit: 1, windowMs: 60_000 }), b.reset(k)]);
    // The check was denied before reset, or admitted after reset. At most one token survives.
    const row = await first.sharedRateLimit.findUnique({ where: { id: sharedStateKey("rate-limit", k) } });
    expect(row?.timestamps.length ?? 0).toBeLessThanOrEqual(1);
    await b.reset(k);
    expect((await a.check(k, { limit: 1, windowMs: 60_000 })).remaining).toBe(0);
    await first.sharedRateLimit.update({ where: { id: sharedStateKey("rate-limit", k) }, data: { timestamps: [BigInt(Date.now() - 120_000)], expiresAt: new Date(Date.now() - 60_000) } });
    const result = await b.check(k, { limit: 1, windowMs: 60_000 });
    expect(result.allowed).toBe(true);
    expect(result.resetAtMs).toBeGreaterThan(Date.now() + 50_000);
  });
  it("bounds expiry cleanup and preserves live buckets", async () => {
    const expired = Array.from({ length: 105 }, (_, i) => key(`cleanup-${i}`, rateKeys));
    const ids = expired.map((k) => sharedStateKey("rate-limit", k));
    await first.sharedRateLimit.createMany({ data: ids.map((id) => ({ id, timestamps: [], expiresAt: new Date(0) })) });
    const live = key("cleanup-live", rateKeys);
    await createPostgresSharedState(first).check(live, { limit: 1, windowMs: 60_000 });
    const left = await first.sharedRateLimit.count({ where: { id: { in: ids } } });
    expect(left).toBe(5);
    expect((await b.check(live, { limit: 1, windowMs: 60_000 })).allowed).toBe(false);
  });
  it("skips an expired bucket while another transaction renews it", async () => {
    const renewing = key("renewing", rateKeys);
    const id = sharedStateKey("rate-limit", renewing);
    await first.sharedRateLimit.create({ data: { id, timestamps: [], expiresAt: new Date(0) } });
    await first.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "SharedRateLimit" WHERE "id" = ${id} FOR UPDATE`;
      await createPostgresSharedState(second).check(key("cleanup-during-renewal", rateKeys), { limit: 1, windowMs: 60_000 });
      await tx.sharedRateLimit.update({ where: { id }, data: { timestamps: [BigInt(Date.now())], expiresAt: new Date(Date.now() + 60_000) } });
    });
    expect((await b.check(renewing, { limit: 1, windowMs: 60_000 })).allowed).toBe(false);
  });
  it("denies authentication when a real database connection is unavailable", async () => {
    const unavailableUrl = new URL(process.env.DATABASE_URL!);
    unavailableUrl.hostname = "127.0.0.1";
    unavailableUrl.port = "1";
    unavailableUrl.searchParams.set("connect_timeout", "1");
    const unavailable = new PrismaClient({ datasources: { db: { url: unavailableUrl.toString() } } });
    vi.stubEnv("SHARED_STATE_BACKEND", "postgres");
    const spy = vi.spyOn(postgresSharedState, "check").mockImplementation(createPostgresSharedState(unavailable).check);
    try {
      expect((await checkRateLimit("unavailable-auth", { limit: 3, windowMs: 60_000, failClosed: true })).allowed).toBe(false);
    } finally {
      spy.mockRestore();
      vi.stubEnv("SHARED_STATE_BACKEND", "redis");
      await unavailable.$disconnect();
    }
  });
  it("keeps invalidation in the caller transaction", async () => {
    const scope = key("transaction", versionKeys);
    await expect(first.$transaction(async (tx) => {
      await a.incrementVersion(scope, tx);
      throw new Error("rollback mutation");
    })).rejects.toThrow("rollback mutation");
    expect(await b.getVersion(scope)).toBe(0);
    await first.$transaction(async (tx) => { await a.incrementVersion(scope, tx); });
    expect(await b.getVersion(scope)).toBe(1);
  });
  it("stores encrypted JSON with TTL and atomically invalidates across clients", async () => {
    const scope = key("scope", versionKeys);
    const k = key("document:0", cacheKeys);
    await a.setJson(k, { private: "confidential content" }, 60_000);
    expect(await b.getJson(k)).toEqual({ private: "confidential content" });
    const stored = await first.sharedCacheEntry.findUniqueOrThrow({ where: { id: sharedStateKey("cache", k) } });
    expect(stored.encryptedPayload).not.toContain("confidential content");
    expect(stored.encryptedPayload).toMatch(/^aes-256-gcm:/);
    const versions = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).incrementVersion(scope)));
    expect(new Set(versions).size).toBe(12);
    expect(await a.getVersion(scope)).toBe(12);
    expect(await b.getJson(`${prefix}:document:${await b.getVersion(scope)}`)).toBeNull();
    await first.sharedCacheEntry.update({ where: { id: stored.id }, data: { expiresAt: new Date(0) } });
    expect(await b.getJson(k)).toBeNull();
  });
});
