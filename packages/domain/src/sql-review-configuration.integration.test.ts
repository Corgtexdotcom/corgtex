import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { connectReadOnly, listTables } from "../../connectors-sql/src/postgres";
import { decrypt, encrypt } from "../../connectors-sql/src/encryption";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createExternalDataSource, enqueueExternalDataSourceSync, getExternalDataSource, updateExternalDataSource } from "./integrations";

async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "SQL configuration", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  return {workspace, actor};
}

beforeEach(truncateAllTables);

describe("SQL selection and policy migration boundaries", () => {
  it("keeps empty saved connections inactive for discovery and requires explicit valid activation", async () => {
    const {workspace, actor} = await fixture();
    const source = await createExternalDataSource(actor, {workspaceId: workspace.id, label: "Discovery connection",
      driverType: "postgres", connectionStringEnc: encrypt(process.env.DATABASE_URL!), selectedTables: [], pullCadenceMinutes: 60, cursorColumn: "updated_at"});
    expect(source.isActive).toBe(false);
    // Configuration stays inspectable; the saved-source test route separately loads the stored connection.
    expect(await getExternalDataSource(actor, {workspaceId: workspace.id, sourceId: source.id})).toMatchObject({selectedTables: [], isActive: false});
    const saved = await prisma.externalDataSource.findUniqueOrThrow({where: {id: source.id}});
    const connection = await connectReadOnly(decrypt(saved.connectionStringEnc));
    try {expect(Array.isArray(await listTables(connection))).toBe(true);} finally {await connection.end();}
    const target = {workspaceId: workspace.id, sourceId: source.id};
    await expect(updateExternalDataSource(actor, {...target, isActive: true})).rejects.toMatchObject({code: "SQL_TABLE_SELECTION_REQUIRED"});
    await expect(updateExternalDataSource(actor, {...target, selectedTables: []})).rejects.toMatchObject({code: "SQL_TABLE_SELECTION_REQUIRED"});
    await expect(enqueueExternalDataSourceSync(actor, target)).rejects.toMatchObject({code: "SQL_TABLE_SELECTION_REQUIRED"});
    expect(await prisma.workflowJob.count()).toBe(0);
    expect((await updateExternalDataSource(actor, {...target, selectedTables: ["public.records"]})).isActive).toBe(false);
    expect((await updateExternalDataSource(actor, {...target, isActive: true})).isActive).toBe(true);
    expect((await updateExternalDataSource(actor, {...target, isActive: false})).isActive).toBe(false);
    expect((await prisma.externalDataSource.findUniqueOrThrow({where: {id: source.id}})).selectedTables).toEqual(["public.records"]);
    expect(await prisma.externalDataSyncLog.count()).toBe(0);
    expect(await prisma.sqlIngestionAttempt.count()).toBe(0);
  });

  it("enforces all four NOT NULL policy arrays and preserves invalid legacy bytes when forward migration refuses", async () => {
    const {workspace, actor} = await fixture();
    const source = await createExternalDataSource(actor, {workspaceId: workspace.id, label: "Restricted source", driverType: "postgres",
      connectionStringEnc: "synthetic", selectedTables: ["public.records"], pullCadenceMinutes: 60, cursorColumn: "updated_at"});
    const policy = await prisma.informationCategoryPolicy.create({data: {workspaceId: workspace.id, category: "SQL_RESTRICTED", isRestricted: true}});
    const columns = await prisma.$queryRaw<Array<{table_name: string; column_name: string; is_nullable: string}>>`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('ExternalDataSource','InformationCategoryPolicy')
        AND column_name IN ('allowedRoleIds','allowedCircleIds')`;
    expect(columns).toHaveLength(4);
    expect(columns.every(column => column.is_nullable === "NO")).toBe(true);
    const client = new Client({connectionString: process.env.DATABASE_URL});
    await client.connect();
    try {
      for (const table of ["ExternalDataSource", "InformationCategoryPolicy"]) for (const column of ["allowedRoleIds", "allowedCircleIds"]) {
        await expect(client.query(`UPDATE "${table}" SET "${column}"=NULL WHERE id=$1`, [table === "ExternalDataSource" ? source.id : policy.id])).rejects.toMatchObject({code: "23502"});
      }
      // A rollback-only legacy state exercises the exact forward migration, not a NULL-to-empty repair.
      await client.query("BEGIN");
      for (const table of ["ExternalDataSource", "InformationCategoryPolicy"]) {
        await client.query(`ALTER TABLE "${table}" ALTER COLUMN "allowedRoleIds" DROP NOT NULL, ALTER COLUMN "allowedCircleIds" DROP NOT NULL`);
        await client.query(`UPDATE "${table}" SET "allowedRoleIds"=NULL, "allowedCircleIds"=NULL WHERE id=$1`, [table === "ExternalDataSource" ? source.id : policy.id]);
      }
      const originals = await client.query(`SELECT to_jsonb(s) body FROM "ExternalDataSource" s WHERE id=$1 UNION ALL SELECT to_jsonb(p) FROM "InformationCategoryPolicy" p WHERE id=$2`, [source.id, policy.id]);
      await client.query("SAVEPOINT policy_enforcement");
      const migration = await readFile(new URL("../../../prisma/migrations/20261014100000_sql_policy_array_constraints/migration.sql", import.meta.url), "utf8");
      await expect(client.query(migration.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, ""))).rejects.toThrow("SQL_POLICY_ARRAY_REPAIR_REQUIRED");
      await client.query("ROLLBACK TO SAVEPOINT policy_enforcement");
      expect((await client.query(`SELECT to_jsonb(s) body FROM "ExternalDataSource" s WHERE id=$1 UNION ALL SELECT to_jsonb(p) FROM "InformationCategoryPolicy" p WHERE id=$2`, [source.id, policy.id])).rows).toEqual(originals.rows);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
    expect((await prisma.informationCategoryPolicy.findUniqueOrThrow({where: {id: policy.id}})).isRestricted).toBe(true);
  });
});
