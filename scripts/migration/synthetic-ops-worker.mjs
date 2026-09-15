import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runPostgresRestoreRehearsal, cleanupScratchDatabase, nodeClientConfig, buildCreateDatabaseSql, writeClientFiles, probeTargetClientConnection } from "./run-postgres-restore-rehearsal.mjs";
import { SOURCE_PINS, pinnedBytes, readSourceBaseline, hash, check, ATTEST_SQL, assertRuntime, collectCorpus, compareCorpus } from "./synthetic-ops-source.mjs";
import { bootstrapSource, save, withDatabase, LOCAL_CLIENT_HOST } from "./bootstrap-synthetic-ops.mjs";
import { SyntheticSubprocesses } from "./synthetic-subprocess.mjs";
import { HOST } from "./probe-ops-azure-target.mjs";

export const sourceSettings = { encoding: "UTF8", provider: "libc", collation: "en_US.utf8", ctype: "en_US.utf8", providerLocale: null, icuRules: null };
export async function work(mode, config, supervisor = new SyntheticSubprocesses()) {
  if (mode === "source") return bootstrapSource({ ...config, supervisor });
  if (mode === "transport") {
    const t = config.targetAdminConfig, s = config.sourceConfig, o = config.owned;
    check(/^[a-f0-9-]{36}$/u.test(o?.id) && o.network === `syn-ops-${o.id}` && o.container === `syn-source-${o.id}`
      && t?.host === LOCAL_CLIENT_HOST && t.dockerHost === LOCAL_CLIENT_HOST && t.database === "source"
      && t.user === "fixture_reader" && t.sslmode === "verify-full" && t.password === "synthetic-local-only"
      && Number.isInteger(t.port) && t.port > 0 && t.port <= 65535
      && s?.dockerHost === o.container && s.database === "source" && s.user === "fixture_reader" && s.sslmode === "require",
    "LOCAL_CLIENT_CONFIG_MISMATCH");
    const clientFiles = writeClientFiles(config.tempDir, s, t, () => {});
    await probeTargetClientConnection({ tempDir: config.tempDir, clientFiles, network: o.network, artifactDir: config.artifactDir });
    return { status: "LOCAL_CLIENT_QUERY_CLOSED", providerEffects: 0 };
  }
  check(config.targetAdminConfig?.host === HOST && config.targetAdminConfig.database === "postgres"
    && config.targetAdminConfig.sslmode === "verify-full", "SYNTHETIC_TARGET_CONFIG_MISMATCH");
  check(/^corgtex_rehearsal_syn_[1-9][0-9]*_[1-9][0-9]*_(1|2|corpus)$/u.test(config.scratchName), "SYNTHETIC_SCRATCH_NAME_INVALID");
  mkdirSync(config.artifactDir, { recursive: true, mode: 0o700 });
  if (mode === "cleanup") return cleanupScratchDatabase({ ...config, expectedScratchName: config.scratchName });
  if (mode === "restore") {
    check(config.sourceConfig?.database === "source" && config.sourceConfig.host === "127.0.0.1"
      && config.sourceConfig.user === "fixture_reader" && config.sourceConfig.sslmode === "require", "NON_SYNTHETIC_SOURCE_REJECTED");
    pinnedBytes(config.bundle, "synthetic.dump");
    const result = await runPostgresRestoreRehearsal({ ...config, domain: "ops", afterArchive: async () => {
      pinnedBytes(config.bundle, "synthetic.dump");
      const dump = `${config.tempDir}/snapshot.dump`;
      copyFileSync(`${config.bundle}/synthetic.dump`, dump); chmodSync(dump, 0o600);
      check(hash(readFileSync(dump)) === SOURCE_PINS["synthetic.dump"], "RESTORE_INPUT_NOT_PINNED");
      save(`${config.artifactDir}/pinned-input.json`, { sha256: SOURCE_PINS["synthetic.dump"], syntheticOnly: true });
      // pg_dump does not pin CREATE EXTENSION's default version. Select the
      // already allowlisted version only in the runner-created owned scratch DB.
      await withDatabase(nodeClientConfig({ ...config.targetAdminConfig, database: config.scratchName }, "synthetic_vector_pin", 5000, 5000),
        c => c.query("CREATE EXTENSION vector VERSION '0.8.2'"));
    } });
    await withDatabase(nodeClientConfig({ ...config.targetAdminConfig, database: config.scratchName }, "synthetic_restore_attest", 5000, 5000), async c => {
      assertRuntime((await c.query(ATTEST_SQL)).rows[0], "2.38");
    });
    return { status: "SYNTHETIC_RESTORE_CAPTURED", targetRef: result.targetRef, validation: "PENDING_ACTUAL_CLEANUP" };
  }
  check(mode === "corpus", "SYNTHETIC_WORKER_MODE_INVALID");
  const state = { schemaVersion: "1.0.0", scratchName: config.scratchName,
    targetRef: `sha256:${hash(`${HOST}\0${config.scratchName}`).slice(0, 16)}`, phase: "INTENT" };
  save(config.stateFile, state);
  await withDatabase(nodeClientConfig(config.targetAdminConfig, "synthetic_corpus_create", 5000, 5000), async c => {
    check((await c.query("SELECT 1 FROM pg_database WHERE datname=$1", [config.scratchName])).rowCount === 0, "SCRATCH_DATABASE_ALREADY_EXISTS");
    state.phase = "ABSENCE_VERIFIED"; writeFileSync(config.stateFile, JSON.stringify(state), { mode: 0o600 });
    await c.query(buildCreateDatabaseSql(config.scratchName, sourceSettings));
    state.phase = "CREATED"; writeFileSync(config.stateFile, JSON.stringify(state), { mode: 0o600 });
  });
  const captured = await withDatabase(nodeClientConfig({ ...config.targetAdminConfig, database: config.scratchName }, "synthetic_corpus_capture", 5000, 10000), async c => {
    await c.query(pinnedBytes(config.bundle, "corpus.sql").toString());
    assertRuntime((await c.query(ATTEST_SQL)).rows[0], "2.38");
    return collectCorpus(c);
  });
  const comparison = compareCorpus(captured, readSourceBaseline(config.bundle));
  save(`${config.artifactDir}/corpus.json`, { captured, comparison });
  check(comparison.observationsEqual && comparison.indexesValid, "SYNTHETIC_CORPUS_DIVERGENCE");
  return { status: "SYNTHETIC_CORPUS_MATCHED", productionAccepted: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const supervisor = new SyntheticSubprocesses();
  process.on("SIGTERM", () => { supervisor.stop(true); process.exit(1); });
  work(process.argv[2], JSON.parse(readFileSync(process.argv[3], "utf8")), supervisor).then(result => {
    console.log(JSON.stringify(result));
  }).catch(e => { console.log(JSON.stringify({ status: "SYNTHETIC_WORKER_FAILED", code: /^[A-Z][A-Z0-9_]+$/u.test(e.code ?? "") ? e.code : "SYNTHETIC_WORK_FAILED" })); process.exitCode = 1; });
}
