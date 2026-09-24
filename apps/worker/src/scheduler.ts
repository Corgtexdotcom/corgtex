import { PrismaClient } from "@prisma/client";

export interface SchedulerLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  disconnect(): Promise<void>;
}

/** One additional connection, held for this execution only. Never use the application pool
 * for a session advisory lock: unlock must run on the same connection that acquired it.
 * PostgreSQL advisory locks are scoped to the database, so independent databases do not block.
 */
export function createSchedulerLock(databaseUrl: string): SchedulerLock {
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", "1");
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
  return {
    async acquire() {
      const [row] = await client.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended('corgtex:worker:scheduler-once:v1', 0)) AS acquired`;
      return row.acquired;
    },
    async release() {
      const [row] = await client.$queryRaw<{ released: boolean }[]>`SELECT pg_advisory_unlock(hashtextextended('corgtex:worker:scheduler-once:v1', 0)) AS released`;
      if (!row.released) throw new Error("Scheduler lock ownership lost");
    },
    disconnect: () => client.$disconnect(),
  };
}

export async function withSchedulerLock<T>(lock: SchedulerLock, execute: () => Promise<T>) {
  let acquired = false;
  try {
    acquired = await lock.acquire();
    if (!acquired) return { skipped: true as const };
    return { skipped: false as const, result: await execute() };
  } finally {
    try {
      if (acquired) await lock.release();
    } finally {
      await lock.disconnect();
    }
  }
}
