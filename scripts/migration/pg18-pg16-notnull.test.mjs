import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashCanonical, hashFrames } from "./shared-tenant-export.ts";
import { importTenantSnapshot } from "./shared-tenant-import.ts";
import { comparePg18ToPg16NotNull, PG18_TO_PG16_NOT_NULL_RULE, verifyPg18ToPg16NotNullComparison } from "./pg18-pg16-notnull.ts";

function rehash(evidence) {
  evidence.rawSchemaSha256 = createHash("sha256").update(JSON.stringify(evidence.rawCatalog)).digest("hex");
  const { sha256: _old, ...body } = evidence;
  evidence.sha256 = hashCanonical(body);
  return evidence;
}
function evidence(major) {
  const columns = ["id", "slug", "name"].map((name) => ({ table: "Workspace", name, type: "text", notNull: true, identity: "", generated: "", default: null }));
  const primary = { table: "Workspace", name: "Workspace_pkey", type: "p", definition: "PRIMARY KEY (id)", deferrable: false, deferred: false,
    referencedSchema: null, referencedTable: null, columns: ["id"], referencedColumns: [] };
  const constraints = [primary, ...(major === 18 ? columns.map((column) => ({ ...primary, name: `${column.name}_not_null`, type: "n", definition: `NOT NULL ${column.name}`, columns: [column.name] })) : [])];
  return rehash({ rule: PG18_TO_PG16_NOT_NULL_RULE, serverVersionNum: `${major}0006`, serverVersion: `${major}.6`, database: `fixture${major}`, sourceSnapshot: "10:20:",
    rawCatalog: { columns, constraints, indexes: [], triggers: [] }, rawSchemaSha256: "",
    relations: [{ table: "Workspace", kind: "r", partition: false, inheritance: false }],
    attributes: columns.map((column, index) => ({ table: column.table, name: column.name, number: index + 1, notNull: true, local: true, ancestors: 0, typeKind: "b", domain: false, collatable: true })),
    constraints: constraints.map((row) => ({ table: row.table, name: row.name, type: row.type, validated: true, enforced: true, local: true,
      ancestors: 0, noInherit: false, parent: false, domain: false, deferrable: false, deferred: false, columns: row.columns })),
    enums: [{ name: "State", label: "PENDING", position: 1 }],
    collations: columns.map((column) => ({ table: column.table, name: column.name, namespace: "pg_catalog", collation: "default", provider: "d", deterministic: true, encoding: -1, locale: null, ctype: null, version: null, actual: null })),
    databaseLocale: [{ encoding: "UTF8", locale: "C", ctype: "C", provider: "c", version: null, actual: null }],
    extensions: [{ name: "vector", version: "0.8.2", namespace: "public" }], sha256: "" });
}
function snapshot(source = evidence(18)) {
  const manifest = { formatVersion: 1, transferId: "fixture", workspaceId: "w", workspaceSlug: "w", schemaSha256: source.rawSchemaSha256,
    tables: { Workspace: { disposition: "copy", reason: "Synthetic" } } };
  const rows = [["w", "w", "Fixture"]];
  const body = { formatVersion: 1, manifest, manifestSha256: hashCanonical(manifest), sourceSnapshot: source.sourceSnapshot, sourceDatabase: source.database,
    schemaSha256: source.rawSchemaSha256, pg18ToPg16NotNullEvidence: source,
    tables: [{ name: "Workspace", columns: source.rawCatalog.columns.map((c) => ({ name: c.name, type: c.type, nullable: !c.notNull })),
      primaryKey: ["id"], foreignKeys: [], rows, sha256: hashFrames(rows) }], dispositions: [] };
  return { ...body, sha256: hashCanonical(body) };
}
function importOptions(value, comparison) {
  const body = { formatVersion: 1, transferId: value.manifest.transferId, sourceSnapshotSha256: value.sha256, sourceStoreId: "source", targetStoreId: "target", entries: [] };
  return { identityLinks: [], objectReceipt: { ...body, sha256: hashCanonical(body) }, objectStorageBinding: { sourceStoreId: "source", targetStoreId: "target" },
    ...(comparison === undefined ? {} : { pg18ToPg16NotNull: comparison }) };
}
function clientFor(target) {
  const statements = [];
  return { statements, query: async (sql) => {
    statements.push(sql);
    if (sql.includes("AS description")) return { rows: [{ version: target.serverVersionNum, description: target.serverVersion, database: target.database, snapshot: "30:40:", isolation: "serializable" }] };
    if (sql.includes("format_type")) return { rows: target.rawCatalog.columns };
    if (sql.includes("pg_get_constraintdef")) return { rows: target.rawCatalog.constraints };
    if (sql.includes("FROM pg_indexes")) return { rows: target.rawCatalog.indexes };
    if (sql.includes("pg_get_triggerdef")) return { rows: target.rawCatalog.triggers };
    if (sql.includes("EXISTS(SELECT 1 FROM pg_inherits")) return { rows: target.relations };
    if (sql.includes("a.attnum AS number")) return { rows: target.attributes };
    if (sql.includes("k.convalidated")) return { rows: target.constraints };
    if (sql.includes("t.typtype='d'")) return { rows: [] };
    if (sql.includes("FROM pg_enum")) return { rows: target.enums };
    if (sql.includes("co.collname AS collation")) return { rows: target.collations };
    if (sql.includes("datcollate AS locale")) return { rows: target.databaseLocale };
    if (sql.includes("FROM pg_extension")) return { rows: target.extensions };
    if (/^(INSERT|UPDATE|DELETE)/.test(sql)) throw new Error("Unexpected write");
    return { rows: [] };
  } };
}

describe("bounded PG18 to PG16 NOT NULL evidence", () => {
  it("binds exact raw catalogs and versions without mutating them", () => {
    const value = snapshot(), target = evidence(16), before = structuredClone([value, target]);
    const comparison = comparePg18ToPg16NotNull(value, target);
    expect(comparison).toMatchObject({ rule: PG18_TO_PG16_NOT_NULL_RULE, sourceRawSchemaSha256: value.schemaSha256, targetRawSchemaSha256: target.rawSchemaSha256, sourceVersion: "180006", targetVersion: "160006" });
    expect(value.schemaSha256).not.toBe(target.rawSchemaSha256);
    expect([value, target]).toEqual(before);
    const recaptured = rehash({ ...target, sourceSnapshot: "20:30:" });
    expect(verifyPg18ToPg16NotNullComparison(value, recaptured, comparison)).toEqual(comparison);
  });

  it.each([
    ["unvalidated even without rows", (s) => { s.constraints[1].validated = false; }],
    ["unenforced", (s) => { s.constraints[1].enforced = false; }],
    ["NO INHERIT", (s) => { s.constraints[1].noInherit = true; }],
    ["inherited", (s) => { s.relations[0].inheritance = true; }],
    ["partitioned", (s) => { s.relations[0].kind = "p"; }],
    ["partition", (s) => { s.relations[0].partition = true; }],
    ["domain", (s) => { s.attributes[0].typeKind = "d"; }],
    ["array of domain", (s) => { s.attributes[0].domain = true; }],
    ["inherited column", (s) => { s.attributes[0].ancestors = 1; }],
    ["inherited constraint", (s) => { s.constraints[1].ancestors = 1; }],
    ["nonlocal constraint", (s) => { s.constraints[1].local = false; }],
    ["partition constraint", (s) => { s.constraints[1].parent = true; }],
    ["missing attribute", (s) => { s.attributes.pop(); }],
    ["missing semantics", (s) => { s.constraints.pop(); }],
    ["missing NOT NULL", (s) => { s.constraints.pop(); s.rawCatalog.constraints.pop(); }],
    ["ambiguous column", (s) => { s.attributes.push(s.attributes[0]); }],
    ["ambiguous constraints", (s) => { s.constraints.push(s.constraints[1]); s.rawCatalog.constraints.push(s.rawCatalog.constraints[1]); }],
    ["missing collation", (s) => { s.collations.pop(); }],
    ["unknown enforcement", (s) => { delete s.constraints[1].enforced; }],
  ])("rejects source %s even with recomputed digests", (_name, change) => {
    const source = evidence(18); change(source);
    expect(() => comparePg18ToPg16NotNull(snapshot(rehash(source)), evidence(16))).toThrow(/TRANSFER_PG18_PG16_NOTNULL_/);
  });

  it.each([
    ["nullable target", (t) => { t.rawCatalog.columns[2].notNull = false; t.attributes[2].notNull = false; }],
    ["type", (t) => { t.rawCatalog.columns[2].type = "varchar(10)"; }],
    ["default", (t) => { t.rawCatalog.columns[2].default = "'changed'::text"; }],
    ["CHECK", (t) => { t.rawCatalog.constraints[0].definition = "CHECK (id IS NOT NULL)"; }],
    ["constraint enforcement", (t) => { t.constraints[0].enforced = false; }],
    ["constraint validation", (t) => { t.constraints[0].validated = false; }],
    ["enum", (t) => { t.enums[0].label = "COMPLETED"; }],
    ["collation", (t) => { t.collations[0].collation = "C"; }],
    ["locale", (t) => { t.databaseLocale[0].locale = "en_US.utf8"; }],
    ["extension", (t) => { t.extensions[0].version = "0.8.6"; }],
    ["index", (t) => { t.rawCatalog.indexes.push({ table: "Workspace", name: "new_index", definition: "CREATE INDEX new_index ON Workspace(id)" }); }],
  ])("rejects unrelated %s drift", (_name, change) => {
    const target = evidence(16); change(target);
    expect(() => comparePg18ToPg16NotNull(snapshot(), rehash(target))).toThrow(/TRANSFER_PG18_PG16_NOTNULL_/);
  });

  it("rejects stale source snapshot identity and tampered evidence", () => {
    const source = evidence(18), value = snapshot(source);
    source.sourceSnapshot = "99:100:"; rehash(source);
    const { sha256: _old, ...body } = value; value.sha256 = hashCanonical(body);
    expect(() => comparePg18ToPg16NotNull(value, evidence(16))).toThrow("SOURCE_BINDING_MISMATCH");
    const changed = snapshot(); changed.pg18ToPg16NotNullEvidence.serverVersion = "changed";
    const { sha256: _ignored, ...changedBody } = changed; changed.sha256 = hashCanonical(changedBody);
    expect(() => comparePg18ToPg16NotNull(changed, evidence(16))).toThrow("EVIDENCE_DIGEST_MISMATCH");
  });

  it.each(["c", "f"])("rejects unrelated %s constraint enforcement with otherwise matching catalogs", (type) => {
    const source = evidence(18), target = evidence(16);
    for (const value of [source, target]) {
      const constraint = { ...value.rawCatalog.constraints[0], name: "unrelated_constraint", type,
        definition: type === "c" ? "CHECK (id <> '')" : "FOREIGN KEY (id) REFERENCES Workspace(id)",
        referencedSchema: type === "f" ? "public" : null, referencedTable: type === "f" ? "Workspace" : null,
        referencedColumns: type === "f" ? ["id"] : [] };
      value.rawCatalog.constraints.push(constraint);
      value.constraints.push({ ...value.constraints[0], name: constraint.name, type });
      rehash(value);
    }
    expect(() => comparePg18ToPg16NotNull(snapshot(source), target)).not.toThrow();
    source.constraints.at(-1).enforced = false; rehash(source);
    expect(() => comparePg18ToPg16NotNull(snapshot(source), target)).toThrow("CONSTRAINT_UNSUPPORTED");
  });

  it.each([
    ["null", () => null],
    ["missing fields", () => ({})],
    ["unknown rule", (c) => ({ ...c, rule: "ignore-notnull" })],
    ["changed target hash", (c) => ({ ...c, targetRawSchemaSha256: "a".repeat(64) })],
    ["changed source version", (c) => ({ ...c, sourceVersion: "180007" })],
    ["changed digest", (c) => ({ ...c, sha256: "a".repeat(64) })],
  ])("rejects %s comparison inside importer before writes", async (_name, change) => {
    const value = snapshot(), target = evidence(16), comparison = comparePg18ToPg16NotNull(value, target);
    const client = clientFor(target);
    await expect(importTenantSnapshot(client, value, importOptions(value, change(comparison)))).rejects.toThrow("COMPARISON_MISMATCH");
    expect(client.statements.at(-1)).toBe("ROLLBACK");
    expect(client.statements.some((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });

  it("recaptures target inside import transaction and rolls back a stale comparison before writes", async () => {
    const value = snapshot(), target = evidence(16), comparison = comparePg18ToPg16NotNull(value, target);
    target.serverVersionNum = "160007"; target.serverVersion = "16.7"; rehash(target);
    const client = clientFor(target);
    await expect(importTenantSnapshot(client, value, importOptions(value, comparison))).rejects.toThrow("COMPARISON_MISMATCH");
    expect(client.statements[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(client.statements.at(-1)).toBe("ROLLBACK");
    expect(client.statements.some((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });

  it("requires explicit source evidence and forbids combining fingerprint override", async () => {
    const value = snapshot(), comparison = comparePg18ToPg16NotNull(value, evidence(16));
    const client = clientFor(evidence(16));
    await expect(importTenantSnapshot(client, value, { ...importOptions(value, comparison), targetSchemaSha256: "a".repeat(64) })).rejects.toThrow("OVERRIDE_FORBIDDEN");
    await expect(importTenantSnapshot(client, value, { ...importOptions(value), targetSchemaSha256: "a".repeat(64) })).rejects.toThrow("OVERRIDE_FORBIDDEN");
    delete value.pg18ToPg16NotNullEvidence;
    const { sha256: _old, ...body } = value; value.sha256 = hashCanonical(body);
    await expect(importTenantSnapshot(client, value, importOptions(value, comparison))).rejects.toThrow("SOURCE_EVIDENCE_REQUIRED");
    expect(client.statements).toEqual([]);
    await expect(importTenantSnapshot(client, value, importOptions(value))).rejects.toThrow("TRANSFER_TARGET_SCHEMA_MISMATCH");
    expect(client.statements.at(-1)).toBe("ROLLBACK");
  });
});
