import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import { sha256 as hash, identityHash, CORE_HISTORICAL_LEDGER, migrationManifest, verifyLedger, databaseIdentity } from "./core-baseline-common.mjs";
import { readSharedTenantSchema } from "./migration/shared-tenant-inventory.mjs";

const check = (ok, code) => { if (!ok) throw new Error(`CORE_RECOVERY_${code}`); };
const same = (a, b) => identityHash(a) === identityHash(b);

export function recoveryTls(request) {
  const binding = request.sourceTls;
  check(binding?.certificateName === "localhost" && /^[a-f0-9]{64}$/.test(binding.leafSha256)
    && /^[a-f0-9]{64}$/.test(binding.caSha256) && typeof binding.caCertificate === "string"
    && binding.caCertificate.length < 10000 && !binding.caCertificate.includes("PRIVATE KEY"), "TLS_BINDING");
  const certificate = new X509Certificate(binding.caCertificate);
  check(certificate.ca && hash(certificate.raw) === binding.caSha256, "CA_BINDING");
  return { rejectUnauthorized: true, ca: binding.caCertificate, checkServerIdentity: (_host, cert) => {
    if (!cert.raw || hash(cert.raw) !== binding.leafSha256) return new Error("CORE_RECOVERY_LEAF_BINDING");
    return checkServerIdentity(binding.certificateName, cert);
  } };
}

export async function verifyRecoveryDatabase(evidence, expectedSchema, request, { env, sourceDir, Client, requireSourceEnums = false, expectedEnumSha256 }) {
  check(databaseIdentity(env.DATABASE_URL) === evidence.target.databaseIdentitySha256, "DATABASE_IDENTITY");
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8", stdio: "pipe" }).trim();
  check(actual === evidence.sourceSha && execFileSync("git", ["diff", "--name-only", "HEAD"],
    { cwd: sourceDir, encoding: "utf8", stdio: "pipe" }).trim() === "", "ACCEPTED_SOURCE_CHECKOUT");
  const manifest = migrationManifest(sourceDir);
  check(manifest.manifestSha256 === expectedSchema.manifestSha256
    && manifest.datamodelSha256 === expectedSchema.datamodelSha256, "ACCEPTED_SOURCE_SCHEMA");
  const url = new URL(env.DATABASE_URL);
  // URL SSL parameters can silently replace pg's explicit TLS options.
  for (const key of [...url.searchParams.keys()]) if (key.startsWith("ssl") || key === "uselibpqcompat" || key === "options") url.searchParams.delete(key);
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 10000,
    options: "-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=1000", ssl: recoveryTls(request) });
  try {
    await client.connect();
    check(client.connection?.stream?.authorized === true && client.connection.stream.encrypted === true, "AUTHORIZED_TLS_REQUIRED");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [binding] } = await client.query(`SELECT current_database() AS database,
      current_setting('server_version') AS version, current_setting('transaction_read_only') AS read_only,
      current_setting('default_transaction_read_only') AS default_read_only`);
    check(binding.database === decodeURIComponent(url.pathname.slice(1)) && binding.version.startsWith(`${request.sourceVersion} `)
      && binding.read_only === "on" && binding.default_read_only === "on", "DATABASE_READ_BINDING");
    const { schemaSha256 } = await readSharedTenantSchema(client);
    check(schemaSha256 === request.sourceSchemaSha256, "SOURCE_CATALOG_CHANGED");
    if (requireSourceEnums) {
      const datamodel = execFileSync("git", ["show", "HEAD:prisma/schema.prisma"], { cwd: sourceDir, encoding: "utf8", stdio: "pipe" });
      const enums = await client.query(`SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
        FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
        WHERE n.nspname='public' GROUP BY t.typname ORDER BY t.typname COLLATE "C"`);
      const sql = manifest.migrations.map(item => execFileSync("git", ["show", `HEAD:prisma/migrations/${item.name}/migration.sql`],
        { cwd: sourceDir, encoding: "utf8", stdio: "pipe", maxBuffer: 8_000_000 }));
      const enumSha256 = verifySourceEnums(datamodel, enums.rows, sql);
      check(!expectedEnumSha256 || enumSha256 === expectedEnumSha256, "INHERITANCE_ENUM_BINDING");
    }
    const rows = await client.query("SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name LIMIT 10001");
    const ledger = verifyLedger(manifest, rows.rows, evidence.sourceSha);
    const result = { manifestSha256: manifest.manifestSha256, datamodelSha256: manifest.datamodelSha256, ...ledger, supportedSchemaMatch: true };
    check(same(result, expectedSchema), "ACCEPTED_LEDGER_CHANGED");
    return result;
  } finally { await client.query("ROLLBACK").catch(() => {}); await client.end().catch(() => {}); }
}


// This inheritance policy is deliberately limited to the reviewed incident and
// accepted source. Caller input cannot choose a catalog, certificate or ledger.
export const RECOVERY_INCIDENT_SHA256 = "9c27df416d8ac4598f8e0bd114b6bebdf4046cda6efac99494a8fd4e6dcb844a";
export const RECOVERY_RECEIPT_SHA256 = "2538c074e0305f594268977b8cebe7cf1b6353313f81988af1f2ff4e3eb2cc5c";
export function recoveryDatabaseWitness(evidence) {
  const bytes = readFileSync(new URL("../.github/core-recovery-incident.json", import.meta.url));
  check(hash(bytes) === RECOVERY_INCIDENT_SHA256, "INHERITANCE_INCIDENT_CHANGED");
  const request = JSON.parse(bytes);
  check(evidence.sourceSha === CORE_HISTORICAL_LEDGER.sourceSha, "INHERITANCE_SOURCE");
  return { kind: "incident-bound-core-schema-inheritance", incidentSha256: RECOVERY_INCIDENT_SHA256,
    originalReceiptSha256: request.acceptedReceiptSha256, recoveryReceiptSha256: RECOVERY_RECEIPT_SHA256,
    sourceSha: evidence.sourceSha, databaseIdentitySha256: evidence.target.databaseIdentitySha256,
    sourceSchemaSha256: request.sourceSchemaSha256, sourceVersion: request.sourceVersion, sourceTls: request.sourceTls,
    schema: { manifestSha256: CORE_HISTORICAL_LEDGER.manifestSha256, datamodelSha256: CORE_HISTORICAL_LEDGER.datamodelSha256,
      exactLedgerMatch: false, historicalLedgerException: { ...CORE_HISTORICAL_LEDGER }, supportedSchemaMatch: true },
    enumSha256: "f0a777e922cf80d8902fb7f9a10e6c996d246e60557848cd4ebaa443cf066fc0",
    enumRule: "accepted-source-label-sets-and-migration-ordered-labels" };
}
export function validateRecoveryDatabaseWitness(witness, evidence) {
  check(same(witness, recoveryDatabaseWitness(evidence)), "INHERITANCE_WITNESS_CHANGED");
  return witness;
}
export async function verifyInheritedRecoveryDatabase(evidence, witness, options) {
  validateRecoveryDatabaseWitness(witness, evidence);
  return verifyRecoveryDatabase(evidence, witness.schema, witness, { ...options, requireSourceEnums: true, expectedEnumSha256: witness.enumSha256 });
}
export function sourceEnums(datamodel) {
  const clean = datamodel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const result = [];
  for (const [, name, body] of clean.matchAll(/^\s*enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    let databaseName = name;
    const labels = [];
    for (const line of body.split("\n").map(value => value.trim()).filter(Boolean)) {
      const map = line.match(/^@@map\("([^"\n]+)"\)$/);
      if (map) { databaseName = map[1]; continue; }
      const label = line.match(/^(\w+)(?:\s+@map\("([^"\n]+)"\))?$/);
      check(label, "ENUM_DATAMODEL_UNSUPPORTED");
      labels.push(label[2] ?? label[1]);
    }
    check(labels.length > 0, "ENUM_DATAMODEL_EMPTY");
    result.push({ name: databaseName, labels });
  }
  check(result.length > 0 && new Set(result.map(item => item.name)).size === result.length, "ENUM_DATAMODEL_INVALID");
  return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export function migrationEnums(sqlFiles) {
  const enums = new Map();
  const unquote = value => value.slice(1, -1).replaceAll('""', '"');
  const literal = value => value.slice(1, -1).replaceAll("''", "'");
  for (const sql of sqlFiles) {
    const clean = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
    const statements = [...clean.matchAll(/\b(?:CREATE|ALTER|DROP)\s+TYPE\b[^;]*;/gi)];
    check(statements.length === [...clean.matchAll(/\b(?:CREATE|ALTER|DROP)\s+TYPE\b/gi)].length, "ENUM_SQL_UNCONSUMED");
    for (const [statement] of statements) {
      let match;
      if ((match = statement.match(/^CREATE\s+TYPE\s+("(?:[^"]|"")+")\s+AS\s+ENUM\s*\(([\s\S]*?)\)\s*;$/i))) {
        const name = unquote(match[1]);
        const labels = [...match[2].matchAll(/'(?:[^']|'')*'/g)].map(([value]) => literal(value));
        check(labels.length > 0 && new Set(labels).size === labels.length && !enums.has(name)
          && match[2].replace(/'(?:[^']|'')*'/g, "").replace(/[\s,]/g, "") === "", "ENUM_SQL_CREATE");
        enums.set(name, labels);
      } else if ((match = statement.match(/^ALTER\s+TYPE\s+("(?:[^"]|"")+")\s+ADD\s+VALUE\s+('(?:[^']|'')*')\s*;$/i))) {
        const name = unquote(match[1]), value = literal(match[2]);
        check(enums.has(name) && !enums.get(name).includes(value), "ENUM_SQL_ADD");
        enums.get(name).push(value);
      } else if ((match = statement.match(/^ALTER\s+TYPE\s+("(?:[^"]|"")+")\s+RENAME\s+TO\s+("(?:[^"]|"")+")\s*;$/i))) {
        const name = unquote(match[1]), next = unquote(match[2]);
        check(enums.has(name) && !enums.has(next), "ENUM_SQL_RENAME");
        enums.set(next, enums.get(name)); enums.delete(name);
      } else if ((match = statement.match(/^DROP\s+TYPE\s+(IF\s+EXISTS\s+)?("(?:[^"]|"")+")\s*;$/i))) {
        const name = unquote(match[2]);
        check(match[1] || enums.has(name), "ENUM_SQL_DROP"); enums.delete(name);
      } else check(false, "ENUM_SQL_UNSUPPORTED");
    }
  }
  return [...enums].map(([name, labels]) => ({ name, labels })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export function verifySourceEnums(datamodel, rows, sqlFiles) {
  check(Array.isArray(rows) && rows.length <= 1000
    && rows.every(row => typeof row.name === "string" && Array.isArray(row.labels) && row.labels.every(label => typeof label === "string")), "ENUM_CATALOG_INVALID");
  const actual = rows.map(({ name, labels }) => ({ name, labels })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const labelSets = items => items.map(item => ({ name: item.name, labels: [...item.labels].sort() }));
  const migrated = migrationEnums(sqlFiles);
  check(same(labelSets(sourceEnums(datamodel)), labelSets(migrated)), "ENUM_DATAMODEL_MIGRATIONS_CHANGED");
  check(same(migrated, actual), "SOURCE_ENUMS_CHANGED");
  return identityHash(migrated);
}
