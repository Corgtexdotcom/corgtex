import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const requireThat = (ok, code) => { if (!ok) throw new Error(`CORE_BASELINE_${code}`); };
// Explicit historical disposition, not an input-controlled checksum allowlist.
export const CORE_HISTORICAL_LEDGER = Object.freeze({
  sourceSha: "d0a3896ef917b50f2fec2d797908f29aa026a058",
  manifestSha256: "a5d5fa95e7569cf05113b57d8917135fff171633e144ea453924202771b00fed",
  datamodelSha256: "af7ad71cad045dcb2c41358fbf5e13160e2e77b220208b70420fadbd7e21ac03",
  migration: "20260617120000_drop_legacy_proposal_reactions",
  sourceChecksum: "614cdf040b15f381255592683128686d90904182721ca117ba43975dd1927e26",
  appliedChecksum: "570ac368fa8994eb9c6ff751eb40172bfb03aeabc511d7d063de0fe93925caa1",
  historicalRowCorrectnessCertified: false,
});
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const identityHash = (value) => sha256(canonical(value));
export function migrationManifest(sourceDir) {
  const git = (args) => execFileSync("git", args, { cwd: sourceDir, maxBuffer: 8_000_000 });
  const paths = git(["ls-tree", "-r", "--name-only", "HEAD", "--", "prisma/migrations"]).toString().trim().split("\n")
    .filter((path) => /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(path)).sort();
  requireThat(paths.length > 0 && paths.length <= 10000, "SOURCE_MIGRATIONS_INVALID");
  const migrations = paths.map((path) => ({ name: path.split("/")[2], checksum: sha256(git(["show", `HEAD:${path}`])) }));
  return { migrations, manifestSha256: identityHash(migrations), datamodelSha256: sha256(git(["show", "HEAD:prisma/schema.prisma"])) };
}

export function historicalSource(manifest, sourceSha) {
  return sourceSha === CORE_HISTORICAL_LEDGER.sourceSha
    && manifest.manifestSha256 === CORE_HISTORICAL_LEDGER.manifestSha256
    && manifest.datamodelSha256 === CORE_HISTORICAL_LEDGER.datamodelSha256;
}

export function verifyLedger(manifest, rows, sourceSha) {
  requireThat(Array.isArray(rows) && rows.length <= 10000, "LEDGER_UNBOUNDED");
  const applied = rows.filter((row) => row.finished_at != null && row.rolled_back_at == null);
  requireThat(rows.every((row) => row.finished_at != null || row.rolled_back_at != null)
    && applied.length === manifest.migrations.length && new Set(applied.map((row) => row.migration_name)).size === applied.length,
  "LEDGER_NOT_EXACT");
  const checksums = new Map(applied.map((row) => [row.migration_name, row.checksum]));
  const mismatches = manifest.migrations.filter((item) => checksums.get(item.name) !== item.checksum);
  if (mismatches.length === 0) return { exactLedgerMatch: true };
  const exception = CORE_HISTORICAL_LEDGER;
  requireThat(historicalSource(manifest, sourceSha) && identityHash(manifest.migrations) === exception.manifestSha256
    && rows.length === applied.length && mismatches.length === 1
    && mismatches[0].name === exception.migration && mismatches[0].checksum === exception.sourceChecksum
    && checksums.get(exception.migration) === exception.appliedChecksum, "LEDGER_NOT_EXACT");
  return { exactLedgerMatch: false, historicalLedgerException: { ...exception } };
}

export function databaseIdentity(url) {
  const parsed = new URL(url);
  requireThat(["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.pathname.length > 1, "DATABASE_URL_INVALID");
  requireThat((parsed.searchParams.get("schema") || "public") === "public", "DATABASE_SCHEMA_UNSUPPORTED");
  return identityHash({ host: parsed.hostname, port: parsed.port || "5432", database: parsed.pathname.slice(1), schema: "public" });
}

