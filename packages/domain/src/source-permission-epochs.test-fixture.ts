import { vi } from "vitest";

/** In-memory SQL adapter for unit fixtures; trigger/locking behavior has separate PostgreSQL tests. */
export function installSourcePermissionEpochFixture(db: any) {
  const epochs = new Map<string, bigint>();
  const key = (workspaceId: string, kind: string, id: string) => JSON.stringify([workspaceId, kind, id]);
  const previousExecute = db.$executeRaw.getMockImplementation();
  const previousQuery = db.$queryRaw.getMockImplementation();
  const sql = (args: any[]) => typeof args[0]?.sql === "string" ? args[0].sql
    : Array.isArray(args[0]) ? args[0].join("?") : "";
  const values = (args: any[]) => Array.isArray(args[0]?.values) ? args[0].values : args.slice(1);
  db.$executeRaw.mockImplementation(async (...args: any[]) => {
    if (!sql(args).includes('INSERT INTO "SourcePermissionEpoch"')) return previousExecute?.(...args) ?? 1;
    const bound = values(args);
    for (let i = 0; i < bound.length; i += 4) {
      const identity = key(bound[i + 1], bound[i + 2], bound[i + 3]);
      if (!epochs.has(identity)) epochs.set(identity, 0n);
    }
    return bound.length / 4;
  });
  db.$queryRaw.mockImplementation(async (...args: any[]) => {
    if (!sql(args).includes('FROM "SourcePermissionEpoch"')) return previousQuery?.(...args) ?? [];
    const [workspaceId, ...bound] = values(args);
    const rows = [];
    for (let i = 0; i < bound.length; i += 2) {
      const epoch = epochs.get(key(workspaceId, bound[i], bound[i + 1]));
      if (epoch !== undefined) rows.push({sourceKind: bound[i], sourceId: bound[i + 1], epoch});
    }
    return rows;
  });
  const findMany = vi.fn(async ({where}: any) => {
    const epoch = epochs.get(key(where.workspaceId, where.sourceKind, where.sourceId));
    return epoch === undefined ? [] : [{epoch}];
  });
  db.sourcePermissionEpoch = { findMany, findUnique: vi.fn(async ({where}: any) => {
    const rows = await findMany({where: where.workspaceId_sourceKind_sourceId});
    return rows[0] ?? null;
  }) };
  return { bump(workspaceId: string, kind: string, id: string) {
    const identity = key(workspaceId, kind, id);
    epochs.set(identity, (epochs.get(identity) ?? 0n) + 1n);
  }};
}
