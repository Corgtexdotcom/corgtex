import { Prisma, type FleetHealthSnapshot } from "@prisma/client";
import { prisma } from "@corgtex/shared";

export async function loadControlPlaneSnapshots(parent: "deployment" | "account", ids: string[]) {
  const snapshotsByParent = new Map<string, FleetHealthSnapshot[]>();
  const parentIds = [...new Set(ids)];
  if (parentIds.length === 0) return snapshotsByParent;
  const parentColumn = parent === "deployment"
    ? Prisma.sql`snapshot."deploymentId"`
    : Prisma.sql`snapshot."customerAccountId"`;

  // Bound each parent's history in PostgreSQL, before transferring snapshot JSON.
  const snapshots = await prisma.$queryRaw<FleetHealthSnapshot[]>(Prisma.sql`
    SELECT snapshot.*
    FROM (SELECT unnest(ARRAY[${Prisma.join(parentIds)}]::text[]) AS id) AS parents
    CROSS JOIN LATERAL (
      SELECT snapshot.* FROM "FleetHealthSnapshot" AS snapshot
      WHERE ${parentColumn} = parents.id
      ORDER BY snapshot."createdAt" DESC
      LIMIT 6
    ) AS snapshot
    ORDER BY ${parentColumn}, snapshot."createdAt" DESC
  `);
  for (const snapshot of snapshots) {
    const id = parent === "deployment" ? snapshot.deploymentId : snapshot.customerAccountId;
    if (id === null) continue;
    const group = snapshotsByParent.get(id) ?? [];
    group.push(snapshot);
    snapshotsByParent.set(id, group);
  }
  return snapshotsByParent;
}
