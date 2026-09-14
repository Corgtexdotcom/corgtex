import { PrismaClient, Prisma, type FleetHealthSnapshot } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { tx: null as Prisma.TransactionClient | null, queries: [] as Prisma.Sql[] } }));
vi.mock("@corgtex/shared", () => ({ prisma: {
  $queryRaw: (query: Prisma.Sql) => {
    state.queries.push(query);
    if (!state.tx) throw new Error("Missing synthetic test transaction");
    return state.tx.$queryRaw(query);
  },
} }));
import { loadControlPlaneSnapshots } from "./control-plane-snapshots";

const client = new PrismaClient();
afterAll(async () => { await client.$disconnect(); });

describe("bounded snapshot SQL in PostgreSQL", () => {
  it("matches latest-six histories across kinds for both parent types, with one query and a database limit per parent", async () => {
    await client.$transaction(async tx => {
      state.tx = tx;
      // Connection-local shadow fixture: no real application tables or migrations.
      await tx.$executeRaw`CREATE TYPE pg_temp."SnapshotKindFixture" AS ENUM ('HEALTH', 'SUPPORT_READY')`;
      await tx.$executeRaw`CREATE TEMP TABLE "FleetHealthSnapshot" (
        id text PRIMARY KEY, "customerAccountId" text NOT NULL, "deploymentId" text,
        "snapshotKind" pg_temp."SnapshotKindFixture" NOT NULL, status text NOT NULL, summary jsonb, error text,
        "observedAt" timestamp(3) NOT NULL, "createdAt" timestamp(3) NOT NULL
      ) ON COMMIT DROP`;
      await tx.$executeRaw`INSERT INTO "FleetHealthSnapshot"
        SELECT 's-' || p || '-' || n, 'account-' || p,
          CASE WHEN p = 3 THEN NULL ELSE 'deployment-' || p END,
          (CASE WHEN n % 3 = 0 THEN 'HEALTH' ELSE 'SUPPORT_READY' END)::pg_temp."SnapshotKindFixture",
          'unknown', jsonb_build_object('nested', jsonb_build_object('large', repeat('x', 4000)), 'ordinal', n),
          CASE WHEN n % 2 = 0 THEN 'synthetic error' ELSE NULL END,
          timestamp '2026-01-01' + n * interval '1 second',
          timestamp '2026-01-02' + n * interval '1 second'
        FROM generate_series(1, 3) p CROSS JOIN generate_series(1, 40) n`;
      for (const parent of ["deployment", "account"] as const) {
        const ids = parent === "deployment" ? ["deployment-1", "deployment-2", "missing"] : ["account-1", "account-2", "account-3", "missing"];
        state.queries = [];
        const actual = await loadControlPlaneSnapshots(parent, [...ids, ids[0]]);
        expect(state.queries).toHaveLength(1);
        for (const id of ids) {
          const column = parent === "deployment" ? Prisma.sql`"deploymentId"` : Prisma.sql`"customerAccountId"`;
          const expected = await tx.$queryRaw<FleetHealthSnapshot[]>(Prisma.sql`
            SELECT * FROM "FleetHealthSnapshot" WHERE ${column} = ${id} ORDER BY "createdAt" DESC LIMIT 6
          `);
          expect(actual.get(id) ?? []).toEqual(expected);
        }
        expect([...actual.values()].every(rows => rows.length === 6)).toBe(true);
        expect([...actual.values()].flat().length).toBe(6 * (ids.length - 1));
        const [explained] = await tx.$queryRaw<Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>>(
          Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${state.queries[0]}`,
        );
        const limits: Record<string, unknown>[] = [];
        const visit = (node: Record<string, unknown>) => {
          if (node["Node Type"] === "Limit") limits.push(node);
          for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
        };
        visit(explained["QUERY PLAN"][0].Plan);
        expect(limits).toHaveLength(1);
        expect(limits[0]["Actual Loops"]).toBe(ids.length);
        expect(Number(limits[0]["Actual Rows"])).toBeLessThanOrEqual(6);
      }
      // Duplicate timestamps retain descending order without a new tie-break contract.
      await tx.$executeRaw`UPDATE "FleetHealthSnapshot" SET "createdAt" = timestamp '2026-02-01' WHERE "customerAccountId" = 'account-1'`;
      const tied = (await loadControlPlaneSnapshots("account", ["account-1"])).get("account-1") as FleetHealthSnapshot[];
      expect(tied).toHaveLength(6);
      expect(new Set(tied.map(row => row.id)).size).toBe(6);
      expect(tied.every(row => row.createdAt.toISOString() === "2026-02-01T00:00:00.000Z")).toBe(true);
      state.tx = null;
    }, { timeout: 30000 });
  });
});
