import { describe, expectTypeOf, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { createPostgresSharedState } from "./postgres-shared-state";

type StateClient = NonNullable<Parameters<typeof createPostgresSharedState>[0]>;
type DatasourceClient = PrismaClient<{ datasources: { db: { url: string } } }>;

describe("PostgreSQL shared state database typing boundary", () => {
  it("accepts default and custom-datasource clients with exact generated capabilities", () => {
    expectTypeOf<PrismaClient>().toExtend<StateClient>();
    expectTypeOf<DatasourceClient>().toExtend<StateClient>();
    expectTypeOf<StateClient>().toEqualTypeOf<Pick<PrismaClient,
      "$queryRaw" | "$executeRaw" | "$transaction" | "sharedCacheVersion">>();
  });

  it("requires every adapter capability and a transaction-capable client", () => {
    expectTypeOf<Omit<StateClient, "$queryRaw">>().not.toExtend<StateClient>();
    expectTypeOf<Omit<StateClient, "$executeRaw">>().not.toExtend<StateClient>();
    expectTypeOf<Omit<StateClient, "$transaction">>().not.toExtend<StateClient>();
    expectTypeOf<Omit<StateClient, "sharedCacheVersion">>().not.toExtend<StateClient>();
    expectTypeOf<Prisma.TransactionClient>().not.toExtend<StateClient>();
  });

  it("preserves complete transaction overloads and caller-owned invalidation transactions", () => {
    expectTypeOf<StateClient["$transaction"]>().toEqualTypeOf<PrismaClient["$transaction"]>();
    expectTypeOf<Parameters<ReturnType<typeof createPostgresSharedState>["incrementVersion"]>[1]>()
      .toEqualTypeOf<Prisma.TransactionClient | undefined>();
  });
});
