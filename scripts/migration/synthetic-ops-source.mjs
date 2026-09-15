import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProbeError } from "./probe-ops-azure-target.mjs";

export const SOURCE_IMAGE = "sha256:dcb131869da366a7f5a9f38f12e4d57fa19d99e786959d048be67d26470c3b36";
// The same pinned archive's ARM64 manifest (63ef36b0...) links this config.
// Classic Docker addresses the config; containerd can address the OCI index.
export const SOURCE_CONFIG_IMAGE = "sha256:2c90b56d40e03c0f17096231024cdf66897ae0c2b9251dfbf6ce69c43e3917b4";
export const SOURCE_PINS = {
  "source-image.tar": "b9d445db75b43d2e8d3ee9640572b98d9e0b7024f247866ea19084ec213fae05",
  "synthetic.dump": "a95a642469e99139d36b755585339299af4e9a511356550c3dd230e3b93ca57e",
  "corpus.sql": "062f093f5c2959cdd2ee569063f1ff37995e26a1398e011f9a964a9d945fca71",
  "source-baseline.json": "307c6d2543a29e29c39df4c5cd843b82c38f8b794c1c4f3b595a8635f4200905",
};
export const check = (value, code) => { if (!value) throw new ProbeError(code); };
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const SOURCE_BASELINE_RUNTIME = { version: "180006", locale: "en_US.utf8", provider: "c", recorded: "2.41", actual: "2.41", vector: "0.8.2", tls: true };
export function validateSourceBaseline(value) {
  check(value?.schemaVersion === 1 && Object.keys(value).sort().join() === "corpusSha256,observations,schemaVersion,sourceRuntime"
    && JSON.stringify(value.sourceRuntime) === JSON.stringify(SOURCE_BASELINE_RUNTIME)
    && value.corpusSha256 === SOURCE_PINS["corpus.sql"] && value.observations && typeof value.observations === "object", "SOURCE_BASELINE_BINDING_MISMATCH");
  return value;
}
// Explicit projection for parent audit. The original run receipt stays private;
// copying observations preserves their values and ordering without recomputation.
export function projectSourceBaseline(receipt) {
  const db = receipt.probe.database;
  return validateSourceBaseline({ schemaVersion: 1,
    sourceRuntime: { version: db.version, locale: db.locale, provider: db.provider, recorded: db.recorded, actual: db.actual, vector: db.installed_vector, tls: db.tls },
    corpusSha256: receipt.probe.baseline.corpusSha256, observations: receipt.probe.baseline.observations });
}
export const readSourceBaseline = directory => validateSourceBaseline(JSON.parse(pinnedBytes(directory, "source-baseline.json")));
export function pinnedBytes(directory, name) {
  check(Object.hasOwn(SOURCE_PINS, name), "UNKNOWN_SYNTHETIC_INPUT");
  const fd = openSync(resolve(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.size > 0 && stat.size <= (name === "source-image.tar" ? 256 * 1024 * 1024 : 1048576), "SYNTHETIC_INPUT_LIMIT");
    const bytes = readFileSync(fd);
    check(hash(bytes) === SOURCE_PINS[name], "SYNTHETIC_INPUT_PIN_MISMATCH");
    return bytes;
  } finally { closeSync(fd); }
}
export function verifyBundle(directory) {
  for (const name of Object.keys(SOURCE_PINS)) pinnedBytes(directory, name);
  return { pins: SOURCE_PINS, image: SOURCE_IMAGE, productionAccepted: false };
}

export const ATTEST_SQL = `SELECT current_setting('server_version_num')::int AS version,
  pg_encoding_to_char(encoding) AS encoding, datcollate AS locale, datctype AS ctype,
  datlocprovider::text AS provider, datcollversion AS recorded,
  pg_database_collation_actual_version(oid) AS actual,
  (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector,
  (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls
  FROM pg_database WHERE datname=current_database()`;
export function assertRuntime(row, version) {
  check(row?.version === 180006 && row.encoding === "UTF8" && row.locale === "en_US.utf8"
    && row.ctype === "en_US.utf8" && row.provider === "c" && row.recorded === version
    && row.actual === version && row.vector === "0.8.2" && row.tls === true, "SYNTHETIC_RUNTIME_MISMATCH");
}

// Index readiness and same-runtime scan agreement remain separate from the
// cross-runtime ordering/range/expression baseline. Neither waives schema guards.
export async function collectCorpus(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const observations = {};
    observations.orderedIds = (await client.query("SELECT id FROM fixture_corpus ORDER BY value, id")).rows.map(r => r.id);
    observations.ranges = [];
    for (const [lo, hi] of [["A", "Z"], ["a", "z"], ["1", "2"]]) observations.ranges.push({ lo, hi,
      ids: (await client.query("SELECT id FROM fixture_corpus WHERE value >= $1 AND value < $2 ORDER BY id", [lo, hi])).rows.map(r => r.id) });
    observations.expressions = (await client.query("SELECT id, encode(convert_to(lower(value),'UTF8'),'hex') AS lower, encode(convert_to(upper(value),'UTF8'),'hex') AS upper, encode(convert_to(initcap(value),'UTF8'),'hex') AS initcap FROM fixture_corpus ORDER BY id")).rows;
    observations.lowerRange = (await client.query("SELECT id FROM fixture_corpus WHERE lower(value)>='a' AND lower(value)<'z' ORDER BY id")).rows.map(r => r.id);
    const indexes = (await client.query("SELECT c.relname AS name,i.indisvalid AS valid,i.indisready AS ready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='fixture_corpus'::regclass ORDER BY c.relname COLLATE \"C\"")).rows;
    const planChecks = [];
    for (const query of ["SELECT id FROM fixture_corpus ORDER BY value,id", "SELECT id FROM fixture_corpus WHERE value>='a' AND value<'z' ORDER BY id", "SELECT id FROM fixture_corpus WHERE lower(value)>='a' AND lower(value)<'z' ORDER BY id"]) {
      await client.query("SET LOCAL enable_seqscan=on; SET LOCAL enable_indexscan=off; SET LOCAL enable_indexonlyscan=off; SET LOCAL enable_bitmapscan=off");
      const sequential = (await client.query(query)).rows;
      const sequentialPlan = (await client.query("EXPLAIN (FORMAT JSON) " + query)).rows;
      await client.query("SET LOCAL enable_seqscan=off; SET LOCAL enable_indexscan=on; SET LOCAL enable_indexonlyscan=on; SET LOCAL enable_bitmapscan=on");
      const indexed = (await client.query(query)).rows;
      const indexPlan = (await client.query("EXPLAIN (FORMAT JSON) " + query)).rows;
      planChecks.push({ query, sequentialPlan, indexPlan, resultsEqual: JSON.stringify(sequential) === JSON.stringify(indexed),
        plansVerified: JSON.stringify(sequentialPlan).includes("Seq Scan") && /Index (Only )?Scan|Bitmap Index Scan/u.test(JSON.stringify(indexPlan)) });
    }
    return { observations, indexEvidence: { indexes, planChecks },
      indexesValid: indexes.length === 4 && indexes.every(i => i.valid && i.ready) && planChecks.every(p => p.resultsEqual && p.plansVerified) };
  } finally { await client.query("ROLLBACK"); }
}
export function compareCorpus(captured, baseline) {
  return { scope: "48 pinned synthetic strings and declared queries only", zeroDivergenceRequired: true,
    observationsEqual: JSON.stringify(captured.observations) === JSON.stringify(baseline.observations),
    indexesValid: captured.indexesValid, productionAccepted: false, schemaGuardWaived: false };
}
