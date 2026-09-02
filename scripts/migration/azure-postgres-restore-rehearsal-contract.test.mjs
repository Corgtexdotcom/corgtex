import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");
const expectedFoundationDatabases = ["azure_maintenance", "azure_sys", "corgtex", "postgres"];
const hasExactFoundationDatabases = (names) =>
  JSON.stringify([...names].sort()) === JSON.stringify(expectedFoundationDatabases);

describe("Azure PostgreSQL restore rehearsal workflow contract", () => {
  const workflow = read(".github/workflows/azure-migration-postgres-rehearsal.yml");
  const runner = read("scripts/migration/run-postgres-restore-rehearsal.mjs");
  const validator = read("scripts/migration/validate-postgres-restore-rehearsal.mjs");
  const readme = read("infra/azure/migration-foundation/README.md");
  const packageJson = JSON.parse(read("package.json"));

  it("is a protected main-only, single-writer manual workflow", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main' && inputs.operation == 'rehearse'");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main' && inputs.operation == 'recover'");
    expect(workflow).toContain("environment: azure-migration-foundation");
    expect(workflow).toContain("group: azure-migration-postgres-rehearsal");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("contents: write");
  });

  it("accepts only one core or ops domain and keeps source credentials step-scoped", () => {
    expect(workflow).toMatch(/options:\s*\n\s*- core\s*\n\s*- ops/u);
    expect(workflow).toContain("RAILWAY_CORE_POSTGRES_READ_ONLY_URL");
    expect(workflow).toContain("RAILWAY_OPS_POSTGRES_READ_ONLY_URL");
    expect(workflow).toContain("RAILWAY_CORE_POSTGRES_TLS_ROOT_CERT");
    expect(workflow).toContain("RAILWAY_OPS_POSTGRES_TLS_ROOT_CERT");
    expect(workflow).toContain("if: inputs.domain == 'core'");
    expect(workflow).toContain("if: inputs.domain == 'ops'");
    expect(workflow).toContain("SOURCE_DATABASE_URL: ${{ secrets.RAILWAY_CORE_POSTGRES_READ_ONLY_URL }}");
    expect(workflow).toContain("SOURCE_DATABASE_URL: ${{ secrets.RAILWAY_OPS_POSTGRES_READ_ONLY_URL }}");
    expect(workflow).toContain("SOURCE_TLS_ROOT_CERT: ${{ secrets.RAILWAY_CORE_POSTGRES_TLS_ROOT_CERT }}");
    expect(workflow).toContain("SOURCE_TLS_ROOT_CERT: ${{ secrets.RAILWAY_OPS_POSTGRES_TLS_ROOT_CERT }}");
    expect(workflow).not.toMatch(/&&\s*secrets\.|\|\|\s*secrets\./u);
    const jobEnv = workflow.slice(workflow.indexOf("    env:"), workflow.indexOf("    steps:"));
    expect(jobEnv).not.toContain("RAILWAY_CORE_POSTGRES_READ_ONLY_URL");
    expect(jobEnv).not.toContain("RAILWAY_OPS_POSTGRES_READ_ONLY_URL");
    expect(jobEnv).not.toContain("RAILWAY_CORE_POSTGRES_TLS_ROOT_CERT");
    expect(jobEnv).not.toContain("RAILWAY_OPS_POSTGRES_TLS_ROOT_CERT");
    expect(jobEnv).not.toContain("AZURE_MIGRATION_POSTGRES_ADMIN_PASSWORD");
    expect(workflow).not.toContain("--source-url");
    expect(workflow).not.toContain("--target-url");
  });

  it("uses an immutable official PostgreSQL 18.6 client and rejects local older clients", () => {
    const image = "postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";
    expect(workflow).toContain(image);
    expect(runner).toContain(image);
    expect(workflow).toContain('client_version="$(docker run --rm "$POSTGRES_CLIENT_IMAGE" pg_dump --version)"');
    expect(workflow).toContain('[[ "$client_version" == "pg_dump (PostgreSQL) 18.6 (Debian 18.6-1.pgdg13+2)" ]]');
    expect(runner).toContain("POSTGRES_18_REQUIRED");
    expect(packageJson.devDependencies.pg).toBeTruthy();
  });

  it("authenticates each Railway source with its exact temporary CA trust anchor", () => {
    expect(runner).toContain('sslmode !== "require"');
    expect(runner).toContain('sourceTlsRootCert: validateSourceTlsRootCertificate(requiredEnvironment("SOURCE_TLS_ROOT_CERT"))');
    expect(runner).toContain('ca: config.sourceTlsRootCert ?? fail("MISSING_SOURCE_TLS_ROOT_CERT")');
    expect(runner).toContain("rejectUnauthorized: true");
    expect(runner).toContain("checkServerIdentity: () => undefined");
    expect(runner).toContain('"verify-ca"');
    expect(runner).toContain('["sslrootcert=/work/source-root.crt"]');
    expect(runner).toContain('`${tempDir}/source-root.crt`');
    expect(runner).toContain("registerCleanup(serviceFile, passFile, ...(sourceRootCertFile === null ? [] : [sourceRootCertFile]))");
    expect(runner).toContain("chmodSync(sourceRootCertFile, 0o600)");
    expect(runner).toContain("target=/work/source-root.crt,readonly");
    expect(runner).not.toContain("rejectUnauthorized: false");
    expect(workflow).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(readme).toContain("CA-authenticated `verify-ca`");
  });

  it("pins the exact UAMI to one temporary RG-scoped Contributor role", () => {
    expect(workflow).toContain("--assignee-object-id \"$principal_id\"");
    expect(workflow).toContain("--include-groups");
    expect(workflow).toContain("--include-inherited");
    expect(workflow).toContain("--fill-principal-name false");
    expect(workflow).toContain("--mode=principal");
    expect(validator).toContain('status: "EXACT_REHEARSAL_PRINCIPAL"');
    expect(validator).toContain("UNEXPECTED_EFFECTIVE_ROLE_ASSIGNMENT_COUNT");
    expect(validator).not.toContain("RBAC_ADMIN_ROLE_ID");
  });

  it("reconfirms the exact non-authoritative 13-resource foundation and no runtimes", () => {
    expect(workflow).toContain('authority == "non-authoritative-restore-target"');
    expect(workflow).toContain("length == 6");
    expect(workflow).toContain('resourceCount:13');
    expect(workflow).toContain('containerApps:0');
    expect(workflow).toContain('microsoft.app/containerapps');
    expect(workflow).toContain('(.value | map(.name | split("/") | last) | sort) == ["azure_maintenance", "azure_sys", "corgtex", "postgres"]');
    expect(workflow).not.toContain('length == 1 and (map(.name | split("/") | last) == ["corgtex"])');
    expect(workflow).toContain('length == 2 and (map(.name | split("/") | last) | sort) == ["migration-restore", "objects"]');
    expect(workflow).toContain("9040099a546f60f31b3d2b797585fe022f384b26bf7e618d45d672b15208d682");
    expect(workflow).toContain('(.[0].principalId | ascii_downcase) == $principal');
    expect(workflow).toContain('length == 13 and (unique | length) == 13');
    expect(workflow).toContain('.value == "vector"');
  });

  it("accepts only the exact Azure-managed and application database baseline", () => {
    expect(hasExactFoundationDatabases(["corgtex", "postgres", "azure_maintenance", "azure_sys"])).toBe(true);
    expect(hasExactFoundationDatabases([...expectedFoundationDatabases, "corgtex_rehearsal_123_1_core"])).toBe(false);
    expect(hasExactFoundationDatabases([...expectedFoundationDatabases, "foreign"])).toBe(false);
    expect(hasExactFoundationDatabases(expectedFoundationDatabases.filter((name) => name !== "azure_sys"))).toBe(false);
    expect(hasExactFoundationDatabases([...expectedFoundationDatabases, "postgres"])).toBe(false);
    expect(hasExactFoundationDatabases(["azure_maintenance", "azure_sys", "Corgtex", "postgres"])).toBe(false);
  });

  it("binds dump and source evidence to one exported read-only snapshot", () => {
    expect(runner.indexOf("await waitForTargetConnection({ targetAdminConfig })"))
      .toBeLessThan(runner.indexOf("await sourceClient.connect()"));
    expect(runner).toContain('await client.query("SELECT 1")');
    expect(runner).toContain("TARGET_FIREWALL_PROPAGATION_TIMEOUT");
    expect(runner).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(runner).toContain("SHOW transaction_read_only");
    expect(runner).toContain("SELECT pg_export_snapshot() AS snapshot");
    expect(runner).toContain("SET LOCAL idle_in_transaction_session_timeout = '0'");
    expect(runner).toContain("current_setting('idle_in_transaction_session_timeout') AS idle_timeout");
    expect(runner).toContain("SET LOCAL statement_timeout = '0'");
    expect(runner).toContain("SET LOCAL transaction_timeout = '0'");
    expect(runner).toContain("statement_timeout=0 -c transaction_timeout=0");
    expect(runner).not.toContain("statement_timeout=15min");
    expect(runner).not.toContain("statement_timeout=30min");
    expect(runner).toContain('["pg_dump", "--format=custom", "--no-owner", "--no-acl", "--snapshot", snapshot');
    expect(runner).toContain('["pg_dump", "--schema-only", "--format=plain", "--no-owner", "--no-acl", "--snapshot", snapshot');
    expect(runner).toContain("DECLARE ${quoteIdentifier(cursorName)} NO SCROLL CURSOR");
    expect(runner).toContain("to_jsonb(t)::text AS canonical_row");
  });

  it("proves large objects through least-privilege APIs before scratch creation", () => {
    const accessPreflight = runner.indexOf("const sourceLargeObjects = await inspectLargeObjectAccess");
    const scratchCreation = runner.indexOf("await createScratchDatabase({");
    expect(accessPreflight).toBeGreaterThan(0);
    expect(scratchCreation).toBeGreaterThan(accessPreflight);
    expect(runner).toContain("FROM pg_largeobject_metadata");
    expect(runner).toContain("has_largeobject_privilege(oid, 'SELECT')");
    expect(runner).toContain("SELECT lo_get($1::oid, $2::bigint, $3::integer) AS chunk");
    expect(runner).toContain("SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING");
    expect(runner).toContain("SOURCE_LARGE_OBJECT_EVIDENCE_FAILED");
    expect(runner).toContain("DESTINATION_LARGE_OBJECT_EVIDENCE_FAILED");
    expect(runner).toContain("large-object-diagnostic.json");
    expect(runner).not.toMatch(/FROM pg_largeobject(?!_metadata)\b/u);
    expect(workflow).not.toContain("pg_read_all_data");
    expect(readme).toContain("privilege-aware `lo_get` reads");
  });

  it("proves sequence state from the immutable archive instead of a later source read", () => {
    expect(runner).toContain('`${tempDir}/snapshot.toc`');
    expect(runner).toContain('`${tempDir}/sequence-set.list`');
    expect(runner).toContain("SEQUENCE SET");
    expect(runner).toContain('"--use-list=/work/sequence-set.list"');
    expect(runner).toContain("ARCHIVE_SEQUENCE_COVERAGE_MISMATCH");
    expect(runner).toContain("ARCHIVE_SEQUENCE_REPLAY_MISMATCH");
    expect(runner).toContain("chmodSync(archiveTocFile, 0o600)");
    expect(runner).toContain("chmodSync(sequenceUseListFile, 0o600)");
    expect(runner).toContain("temporaryFiles.push(dumpFile, archiveTocFile, sequenceUseListFile");
    expect(runner).not.toMatch(/sourceEvidence\s*=\s*await collectDatabaseEvidence[\s\S]{0,300}collectSequences/u);
    expect(validator).toContain("archiveSequences");
    expect(validator).toContain('compareExact(beforeReplay, afterReplay, "ARCHIVE_SEQUENCE_REPLAY_MISMATCH")');
  });

  it("uses a unique scratch database and an exact /32 firewall with independent cleanup", () => {
    expect(workflow).toContain('scratch_database="corgtex_rehearsal_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}_${DOMAIN}"');
    expect(workflow).toContain("--start-ip-address \"$runner_ip\"");
    expect(workflow).toContain("--end-ip-address \"$runner_ip\"");
    expect(workflow).toContain('jq -e --arg name "$FIREWALL_RULE_NAME" --arg ip "$runner_ip"');
    expect(workflow).toContain("--server-name \"$NAME_PREFIX-restore-pg\"");
    expect(workflow).not.toContain("--rule-name");
    expect(workflow).not.toContain("--database-name");
    expect(workflow).toContain("Remove the exact scratch database");
    expect(workflow).toContain("Remove the exact runner firewall rule");
    expect(workflow.match(/if: \$\{\{ always\(\) \}\}/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(runner).toContain("SCRATCH_DATABASE_ALREADY_EXISTS");
    expect(runner).toContain("DROP DATABASE ${quoteIdentifier(state.scratchName)} WITH (FORCE)");
    expect(validator).toContain('fail("RECOVERY_REQUIRED")');
  });

  it("persists exact recovery intent before the first temporary mutation", () => {
    const persistIntent = workflow.indexOf("Persist recovery intent before any temporary mutation");
    const openFirewall = workflow.indexOf("Open one exact runner IPv4 firewall rule");
    expect(persistIntent).toBeGreaterThan(0);
    expect(openFirewall).toBeGreaterThan(persistIntent);
    expect(workflow).toContain("recovery-intent.json");
    expect(workflow).toContain("phase:\"ABSENCE_VERIFIED\"");
    expect(workflow).toContain("retention-days: 30");
  });

  it("consumes persisted intent in a protected exact-target recovery operation", () => {
    expect(workflow).toContain("actions/download-artifact@v5");
    expect(workflow).toContain("run-id: ${{ inputs.recovery_run_id }}");
    expect(workflow).toContain("subscriptionId:$subscription_id");
    expect(workflow).toContain("resourceId:$postgres_resource_id");
    expect(workflow).toContain("--mode=recovery-intent");
    expect(validator).toContain('status: "EXACT_RECOVERY_INTENT"');
    expect(validator).toContain("RECOVERY_SUBSCRIPTION_MISMATCH");
    expect(validator).toContain("RECOVERY_TARGET_RESOURCE_MISMATCH");
    expect(workflow).toContain("Remove the exact recovery scratch database");
    expect(workflow).toContain("Remove the exact recovery firewall rule");
    expect(workflow).toContain("az postgres flexible-server db delete");
    expect(workflow).toContain('--ids "$expected_id"');
    expect(workflow).toContain('type | ascii_downcase) == "microsoft.dbforpostgresql/flexibleservers/databases"');
    expect(workflow).toContain('status:"POSTGRES_REHEARSAL_RECOVERED"');
    const recoveryJob = workflow.slice(workflow.indexOf("  recovery:"));
    expect(recoveryJob).not.toContain("TARGET_POSTGRES_ADMIN_PASSWORD");
    expect(recoveryJob).not.toContain("--mode=cleanup");
    expect(recoveryJob).not.toContain("firewall-rule create");
    expect(recoveryJob).not.toContain("--yes --only-show-errors || true");
  });

  it("preserves and verifies the PostgreSQL 18 locale-provider contract", () => {
    expect(runner).toContain("datlocprovider::text AS locale_provider");
    expect(runner).toContain("datlocale AS provider_locale");
    expect(runner).toContain("daticurules AS icu_rules");
    expect(runner).toContain("datcollversion AS collation_version");
    expect(runner).toContain("pg_database_collation_actual_version(oid) AS actual_collation_version");
    expect(runner).toContain("LOCALE_PROVIDER");
    expect(runner).toContain("SCRATCH_DATABASE_LOCALE_MISMATCH");
    expect(runner).toContain("SOURCE_COLLATION_VERSION_STALE");
    expect(runner).toContain("TARGET_COLLATION_VERSION_STALE");
    expect(runner).not.toContain("COLLATION_VERSION ${quoteLiteral");
    expect(validator).toContain('compareExact(localeDefinition(source.locale), localeDefinition(destination.locale), "LOCALE_PARITY_MISMATCH")');
    expect(validator).toContain('collationVersionStatus: "SOURCE_AND_TARGET_CURRENT"');
    expect(validator).toContain("crossRuntimeVersionRelation");
  });

  it("keeps dump bytes and credentials temporary while uploading only private evidence", () => {
    expect(runner).toContain('`${tempDir}/snapshot.dump`');
    expect(runner).toContain("writeClientFiles(");
    expect(runner).toContain("secureDelete");
    expect(runner).toContain("source-root.crt");
    expect(runner).not.toContain("console.log");
    expect(workflow).toContain("Upload private PostgreSQL rehearsal evidence");
    expect(workflow).toContain("retention-days: 7");
    expect(workflow).not.toContain("snapshot.dump\n");
    expect(readme).toContain("Raw provider output and deployment output remain private workflow artifacts");
  });

  it("cannot mutate Railway, traffic, DNS, runtimes, or provider-cutover state", () => {
    expect(workflow).not.toMatch(/\brailway\s+(up|down|delete|deploy|service|variables|restart)/iu);
    expect(workflow).not.toMatch(/az\s+containerapp/iu);
    expect(workflow).not.toMatch(/az\s+network\s+dns/iu);
    expect(workflow).not.toContain("assessProviderCutoverTransition");
    expect(runner).not.toContain("assessProviderCutoverTransition");
    expect(runner).toContain('args.size === 5');
    expect(workflow).not.toContain(["prisma", "db", "push"].join(" "));
    expect(workflow).not.toContain("az group delete");
  });

  it("projects PostgreSQL-only verification without cutover readiness", () => {
    expect(validator).toContain('status: "POSTGRES_REHEARSAL_VERIFIED"');
    expect(validator).toContain('postgres: "VERIFIED"');
    expect(validator).toContain('redis: "UNPROVEN"');
    expect(validator).toContain('objects: "UNPROVEN"');
    expect(validator).toContain('providerCutoverStatus: "PLANNED"');
    expect(validator).toContain("cutoverReady: false");
    expect(validator).toContain('"SOURCE_QUIESCENCE_UNPROVEN"');
  });
});
