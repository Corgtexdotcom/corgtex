import { createHash } from "node:crypto";
import { fullReleaseSha, requireValidation, SELFSERVE_VALIDATION_TARGET as target } from "./selfserve-validation-target.mjs";

export const CATALOG_ALGORITHM = "SELFSERVE_PUBLIC_PG16_V1";
// V1 is the public application schema on PostgreSQL 16, not every PostgreSQL
// object or an operational configuration audit. Owners/ACLs, table contents,
// sequence positions, statistics, tablespaces and database locale are excluded.
// Views, partitions/inheritance, foreign tables, RLS/policies/rules, custom
// domains/composites/collations/operators and SECURITY DEFINER are rejected.
// Extension-owned definitions are represented by exact extension version.
const MAX_ROWS = 10000, MAX_BYTES = 16 * 1024 * 1024;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ownedByExtension = alias => `EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::pg_catalog.regclass AND d.objid=${alias}.oid AND d.deptype='e')`;
const publicRelation = `n.nspname='public' AND NOT ${ownedByExtension("c")}`;

// Only system catalogs/deparsers: never information_schema, application rows,
// statistics, sequence current values, explicit table locks, or user functions.
export const CATALOG_QUERIES = Object.freeze({
  relations: `SELECT jsonb_build_array(c.relname,c.relkind,c.relpersistence,a.amname,c.relreplident,c.reloptions) AS value
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_am a ON a.oid=c.relam WHERE ${publicRelation} AND c.relkind IN ('r','S')`,
  columns: `SELECT jsonb_build_array(c.relname,a.attname,a.attnum,pg_catalog.format_type(a.atttypid,a.atttypmod),
    a.attndims,a.attnotnull,a.attidentity,a.attgenerated,pg_catalog.pg_get_expr(d.adbin,d.adrelid,false),
    cn.nspname,co.collname,a.attstorage,a.attcompression) AS value
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
    WHERE ${publicRelation} AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`,
  enums: `SELECT jsonb_build_array(t.typname,e.enumlabel,row_number() OVER (PARTITION BY t.oid ORDER BY e.enumsortorder)) AS value
    FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid=e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'`,
  indexes: `SELECT jsonb_build_array(c.relname,ic.relname,pg_catalog.pg_get_indexdef(i.indexrelid,0,false),
    i.indisunique,i.indisprimary,i.indisexclusion,i.indimmediate,i.indisvalid,i.indisready,i.indislive,
    i.indisreplident,i.indnullsnotdistinct,ic.reloptions) AS value
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
    JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${publicRelation}`,
  constraints: `SELECT jsonb_build_array(c.relname,k.conname,k.contype,pg_catalog.pg_get_constraintdef(k.oid,false),
    k.condeferrable,k.condeferred,k.convalidated,k.connoinherit,k.conislocal,k.coninhcount) AS value
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${publicRelation}`,
  sequences: `SELECT jsonb_build_array(c.relname,pg_catalog.format_type(s.seqtypid,NULL),s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle,
    tn.nspname,t.relname,a.attname,d.deptype) AS value
    FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::pg_catalog.regclass AND d.objid=c.oid
      AND d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjsubid>0 AND d.deptype IN ('a','i')
    LEFT JOIN pg_catalog.pg_class t ON t.oid=d.refobjid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid WHERE ${publicRelation}`,
  functions: `SELECT jsonb_build_array(p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid),pg_catalog.pg_get_functiondef(p.oid)) AS value
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind IN ('f','p') AND NOT EXISTS
      (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid=p.oid AND d.deptype='e')`,
  triggers: `SELECT jsonb_build_array(c.relname,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid,false)) AS value
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${publicRelation} AND NOT t.tgisinternal`,
  extensions: `SELECT jsonb_build_array(e.extname,e.extversion,n.nspname) AS value
    FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
    WHERE n.nspname='public' OR e.extname='plpgsql'`,
});

const rowWidths = { relations: 6, columns: 13, enums: 3, indexes: 13, constraints: 10, sequences: 12, functions: 3, triggers: 4, extensions: 3 };
export const UNSUPPORTED_CATALOG_SQL = `SELECT (
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${publicRelation} AND (c.relkind NOT IN ('r','i','S') OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity))
  + (SELECT count(*) FROM pg_catalog.pg_inherits h WHERE EXISTS
    (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid IN (h.inhrelid,h.inhparent) AND ${publicRelation}))
  + (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typtype<>'e' AND t.typelem=0 AND NOT (t.typtype='c' AND t.typrelid<>0 AND EXISTS
      (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=t.typrelid AND c.relkind IN ('r','S')))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_type'::pg_catalog.regclass AND d.objid=t.oid AND d.deptype='e'))
  + (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.prokind NOT IN ('f','p') OR p.prosecdef) AND NOT EXISTS
      (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid=p.oid AND d.deptype='e'))
  + (SELECT count(*) FROM pg_catalog.pg_collation x JOIN pg_catalog.pg_namespace n ON n.oid=x.collnamespace WHERE n.nspname='public')
  + (SELECT count(*) FROM pg_catalog.pg_operator x JOIN pg_catalog.pg_namespace n ON n.oid=x.oprnamespace WHERE n.nspname='public'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_operator'::pg_catalog.regclass AND d.objid=x.oid AND d.deptype='e'))
  + (SELECT count(*) FROM pg_catalog.pg_opclass x JOIN pg_catalog.pg_namespace n ON n.oid=x.opcnamespace WHERE n.nspname='public'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_opclass'::pg_catalog.regclass AND d.objid=x.oid AND d.deptype='e'))
  + (SELECT count(*) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${publicRelation})
  + (SELECT count(*) FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${publicRelation})
)::integer AS count`;

export function validateCatalog(catalog) {
  requireValidation(catalog?.algorithm === CATALOG_ALGORITHM && catalog.serverMajor === 16, "CATALOG_VERSION_UNSUPPORTED");
  requireValidation(JSON.stringify(catalog).length <= MAX_BYTES && catalog.categories
    && Object.keys(catalog.categories).sort().join() === Object.keys(CATALOG_QUERIES).sort().join(), "CATALOG_SHAPE_INVALID");
  for (const [category, width] of Object.entries(rowWidths)) {
    const rows = catalog.categories[category];
    requireValidation(Array.isArray(rows) && rows.length <= MAX_ROWS && rows.every(row => Array.isArray(row)
      && row.length === width && JSON.stringify(row).length <= 256 * 1024), "CATALOG_SHAPE_INVALID");
    requireValidation(new Set(rows.map(JSON.stringify)).size === rows.length, "CATALOG_DUPLICATE_ROW");
  }
  requireValidation(catalog.categories.extensions.every(([name]) => ["vector", "plpgsql"].includes(name)), "CATALOG_EXTENSION_UNSUPPORTED");
  return catalog;
}

export async function collectSchemaCatalog(client) {
  const context = (await client.query("SELECT current_setting('server_version_num')::integer AS version,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation")).rows[0];
  requireValidation(Math.floor(context.version / 10000) === 16, "CATALOG_VERSION_UNSUPPORTED");
  requireValidation(context.read_only === "on" && context.isolation === "repeatable read", "CATALOG_SNAPSHOT_REQUIRED");
  await client.query("SET LOCAL search_path = pg_catalog");
  requireValidation((await client.query(UNSUPPORTED_CATALOG_SQL)).rows[0].count === 0, "CATALOG_OBJECT_UNSUPPORTED");
  const categories = {};
  for (const [category, sql] of Object.entries(CATALOG_QUERIES)) {
    const rows = (await client.query(`${sql} LIMIT ${MAX_ROWS + 1}`)).rows.map(row => row.value);
    categories[category] = rows.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  }
  return validateCatalog({ algorithm: CATALOG_ALGORITHM, serverMajor: 16, categories });
}

export function catalogBinding({ expectedSha, manifest, runId, runAttempt }) {
  fullReleaseSha(expectedSha);
  requireValidation(/^[1-9][0-9]*$/.test(String(runId)) && /^[1-9][0-9]*$/.test(String(runAttempt))
    && /^[a-f0-9]{64}$/.test(manifest?.manifestSha256 || "") && /^[a-f0-9]{64}$/.test(manifest?.datamodelSha256 || ""), "CATALOG_BINDING_INVALID");
  return { target: target.name, origin: target.origin, workspaceId: target.workspaceId, ownerUserId: target.ownerUserId,
    gitSha: expectedSha, manifestSha256: manifest.manifestSha256, datamodelSha256: manifest.datamodelSha256,
    runId: String(runId), runAttempt: String(runAttempt) };
}

export function expectedCatalogArtifact(catalog, binding) {
  validateCatalog(catalog);
  return { schemaVersion: 1, ...catalogBinding(binding), scope: "isolated-synthetic", status: "passed", cleanup: "pending",
    datamodelMatch: true, catalog, catalogSha256: digest(catalog) };
}

export function assertExpectedCatalog(artifact, binding) {
  const expected = catalogBinding(binding);
  requireValidation(artifact?.schemaVersion === 1 && artifact.scope === "isolated-synthetic" && artifact.status === "passed"
    && artifact.cleanup === "completed" && artifact.datamodelMatch === true
    && Object.entries(expected).every(([key, value]) => artifact[key] === value), "CATALOG_ARTIFACT_MISBOUND");
  validateCatalog(artifact.catalog);
  requireValidation(artifact.catalogSha256 === digest(artifact.catalog), "CATALOG_ARTIFACT_DIGEST_MISMATCH");
  return artifact.catalog;
}

export function compareSchemaCatalog(expected, actual) {
  validateCatalog(expected); validateCatalog(actual);
  const differences = Object.keys(CATALOG_QUERIES).flatMap(category => {
    const a = expected.categories[category], b = actual.categories[category];
    const expectedHash = digest(a), actualHash = digest(b);
    return expectedHash === actualHash ? [] : [{ category, expectedCount: a.length, actualCount: b.length, expectedHash, actualHash }];
  });
  return { supportedSchemaMatch: differences.length === 0, algorithm: CATALOG_ALGORITHM,
    expectedCatalogSha256: digest(expected), actualCatalogSha256: digest(actual), differences };
}
