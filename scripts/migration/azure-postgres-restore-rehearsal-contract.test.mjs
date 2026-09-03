import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");
const expectedFoundationDatabases = ["azure_maintenance", "azure_sys", "corgtex", "postgres"];
const hasExactFoundationDatabases = (names) =>
  JSON.stringify([...names].sort()) === JSON.stringify(expectedFoundationDatabases);

describe("Azure PostgreSQL restore rehearsal workflow contract", () => {
  const workflow = read(".github/workflows/azure-migration-postgres-rehearsal.yml");
  const runner = read("scripts/migration/run-postgres-restore-rehearsal.mjs");
  const smoke = read("scripts/migration/postgres-restore-rehearsal-smoke.mjs");
  const validator = read("scripts/migration/validate-postgres-restore-rehearsal.mjs");
  const readme = read("infra/azure/migration-foundation/README.md");
  const targetRootBundle = read("infra/azure/migration-foundation/azure-postgres-root-ca.pem");
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

  it("pins only the documented Azure PostgreSQL roots for explicit target verification", () => {
    expect(createHash("sha256").update(targetRootBundle).digest("hex"))
      .toBe("00aa10fc3c32eb0d024cd4262dac3d4466dd44aed87fa24d9f2d3fb49977601c");
    expect(targetRootBundle.match(/-----BEGIN CERTIFICATE-----/gu)).toHaveLength(2);
    expect(runner).toContain("CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F");
    expect(runner).toContain("C7:41:F7:0F:4B:2A:8D:88:BF:2E:71:C1:41:22:EF:53:EF:10:EB:A0:CF:A5:E6:4C:FA:20:F4:18:85:30:73:E0");
    expect(runner).toContain('targetServiceSslMode = target.sslmode === "disable" ? "disable" : "verify-full"');
    expect(runner).toContain("sslrootcert=/work/target-root.crt");
    expect(runner).not.toContain("sslrootcert=system");
    expect(readme).toContain("DigiCert Global Root G2");
    expect(readme).toContain("Microsoft RSA Root Certificate Authority 2017");
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
    expect(runner).toContain("...(sourceRootCertFile === null ? [] : [sourceRootCertFile])");
    expect(runner).toContain("chmodSync(sourceRootCertFile, 0o600)");
    expect(runner).toContain("target=/work/source-root.crt,readonly");
    expect(runner).not.toContain("rejectUnauthorized: false");
    expect(workflow).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(readme).toContain("CA-authenticated `verify-ca`");
  });

  it("pins the exact UAMI to temporary subscription Reader and RG Contributor roles", () => {
    expect(workflow).toContain("--assignee-object-id \"$principal_id\"");
    expect(workflow).toContain("--include-groups");
    expect(workflow).toContain("--include-inherited");
    expect(workflow).toContain("--fill-principal-name false");
    expect(workflow).toContain("--mode=principal");
    expect(validator).toContain('status: "EXACT_REHEARSAL_PRINCIPAL"');
    expect(validator).toContain("UNEXPECTED_EFFECTIVE_ROLE_ASSIGNMENT_COUNT");
    expect(validator).toContain('const READER_ROLE_ID = "acdd72a7-3385-48ef-bd42-f606fba81ae7"');
    expect(validator).toContain("document.assignments.length !== 2");
    expect(validator).toContain('kind: "reader", scope: subscriptionScope');
    expect(validator).toContain('kind: "contributor", scope: expectedScope');
    expect(validator).toContain('effectiveRoleAssignmentCount: 2');
    expect(validator).not.toContain("RBAC_ADMIN_ROLE_ID");
  });

  it("separates tenant login from bounded exact-subscription selection", () => {
    const rehearsalLogin = workflow.slice(
      workflow.indexOf("Log in to the exact Azure tenant\n"),
      workflow.indexOf("Select and verify the exact Azure subscription\n"),
    );
    const recoveryLogin = workflow.slice(
      workflow.indexOf("Log in to the exact Azure tenant for recovery\n"),
      workflow.indexOf("Select and verify the exact Azure subscription for recovery\n"),
    );
    expect(rehearsalLogin).toContain("allow-no-subscriptions: true");
    expect(recoveryLogin).toContain("allow-no-subscriptions: true");
    expect(rehearsalLogin).not.toContain("subscription-id:");
    expect(recoveryLogin).not.toContain("subscription-id:");
    expect(workflow.match(/for attempt in 1 2 3 4;/gu)).toHaveLength(2);
    expect(workflow.match(/az account list \\\n\s+--refresh --output json --only-show-errors/gu)).toHaveLength(2);
    expect(workflow.match(/sleep 25/gu)).toHaveLength(2);
    expect(workflow.match(/if \[\[ "\$match_count" == "1" \]\]/gu)).toHaveLength(2);
    expect(workflow.match(/\(\( match_count > 1 \)\)/gu)).toHaveLength(2);
    expect(workflow.match(/and \.state == "Enabled"/gu)).toHaveLength(2);
    expect(workflow.match(/az account set \\/gu)).toHaveLength(2);
    expect(workflow.match(/\$\{actual_subscription,,\}" == "\$\{AZURE_SUBSCRIPTION_ID,,\}/gu)).toHaveLength(2);
    expect(workflow.match(/\$\{actual_tenant,,\}" == "\$\{AZURE_TENANT_ID,,\}/gu)).toHaveLength(2);
    expect(workflow.match(/"\$actual_state" == "Enabled"/gu)).toHaveLength(2);
    expect(workflow.match(/Exact enabled Azure subscription selected\./gu)).toHaveLength(2);

    const rehearsalSelection = workflow.indexOf("Select and verify the exact Azure subscription\n");
    const authorityValidation = workflow.indexOf("Verify exact temporary rehearsal authority and foundation inventory");
    const persistRecoveryIntent = workflow.indexOf("Persist recovery intent before any temporary mutation");
    const recoverySelection = workflow.indexOf("Select and verify the exact Azure subscription for recovery\n");
    const recoveryValidation = workflow.indexOf("Validate recovery authority and exact cleanup target");
    const recoveryScratchDelete = workflow.indexOf("Remove the exact recovery scratch database");
    expect(rehearsalSelection).toBeGreaterThan(0);
    expect(rehearsalSelection).toBeLessThan(authorityValidation);
    expect(authorityValidation).toBeLessThan(persistRecoveryIntent);
    expect(recoverySelection).toBeGreaterThan(0);
    expect(recoverySelection).toBeLessThan(recoveryValidation);
    expect(recoveryValidation).toBeLessThan(recoveryScratchDelete);

    const subscriptionScopedCommands = /\baz (?:account get-access-token|role assignment list|group show|resource list|postgres flexible-server|identity show|rest)\b/u;
    const lines = workflow.split("\n");
    const commands = lines.flatMap((line, index) => {
      if (!subscriptionScopedCommands.test(line)) return [];
      const command = [line];
      for (let offset = 1; command.at(-1)?.trimEnd().endsWith("\\"); offset += 1) {
        command.push(lines[index + offset] ?? "");
      }
      return [command.join("\n")];
    });
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.includes('--subscription "$AZURE_SUBSCRIPTION_ID"'))).toBe(true);
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
    expect(runner.match(/`--restrict-key=\$\{SCHEMA_RESTRICT_KEY\}`/gu)).toHaveLength(2);
    expect(runner).toContain('export const SCHEMA_RESTRICT_KEY = "CorgtexSchemaParityV1"');
    expect(runner).toContain('export const SCHEMA_TOKEN_ALGORITHM = "PG_DUMP_SQL_TOKENS_V1"');
    expect(runner).toContain('classification: "EXECUTABLE_SCHEMA_DIFFERENCE"');
    expect(runner).toContain('classification: "NON_EXECUTABLE_DUMP_TEXT_ONLY"');
    expect(runner).toContain('`${artifactDir}/schema-diagnostic.json`');
    expect(runner.match(/SET LOCAL search_path = pg_catalog/gu)).toHaveLength(3);
    expect(runner.indexOf('await sourceClient.query("COMMIT");'))
      .toBeLessThan(runner.indexOf("await restoreArchiveSections({"));
    expect(runner).toContain("constraintCatalogIdentityQuery");
    expect(runner).toContain("LIMIT 2");
    expect(runner).toContain('"SOURCE_REBIND_DRIFT"');
    expect(runner).toContain("FROM pg_catalog.pg_constraint AS constraint_row");
    expect(runner).toContain("pg_catalog.pg_get_constraintdef(constraint_row.oid, false)");
    expect(runner).toContain("pg_catalog.pg_get_triggerdef(constraint_trigger.oid, false)");
    expect(runner).toContain("pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false)");
    expect(runner).toContain("constraintSemantics: buildConstraintSemanticDiagnostic");
    expect(runner).toContain("checkExpressionDifference");
    expect(runner).toContain("buildUniqueCheckTokenEdit");
    expect(runner).toContain("pg_catalog.pg_identify_object");
    expect(runner).toContain('status: "AMBIGUOUS"');
    expect(smoke).not.toContain("CONSTRAINT_CHECK_DIAGNOSTIC_CLASSIFICATION_FAILED");
    expect(smoke).toContain("CONSTRAINT_CHECK_DIAGNOSTIC_COLLECTION_STATUS");
    expect(smoke).toContain("CONSTRAINT_CHECK_DIAGNOSTIC_DEPENDENCY_IDENTITY");
    expect(smoke).toContain("CONSTRAINT_CHECK_DIAGNOSTIC_SOURCE_NODE_COUNTS");
    expect(readme).toContain("fixed token-category counts");
    expect(readme).toContain("never\nrelax schema parity");
    expect(readme).toContain("no catalog value is serialized");
    expect(validator).toContain('value.schema.algorithm !== SCHEMA_TOKEN_ALGORITHM');
    expect(readme).toContain("`PG_DUMP_SQL_TOKENS_V1`");
    expect(runner).toContain("DECLARE ${quoteIdentifier(cursorName)} NO SCROLL CURSOR");
    expect(runner).toContain("to_jsonb(t)::text AS canonical_row");
  });

  it("pins UTC and the existing timeouts for every containerized libpq session", () => {
    const pgOptions = [...runner.matchAll(/"PGOPTIONS=([^"]+)"/gu)].map((match) => match[1]);
    expect(pgOptions).toHaveLength(2);
    for (const options of pgOptions) {
      expect(options.match(/-c timezone=UTC/gu)).toHaveLength(1);
      expect(options).toContain("-c lock_timeout=5s");
      expect(options).toContain("-c statement_timeout=0");
      expect(options).toContain("-c transaction_timeout=0");
      expect(options).toContain("-c idle_in_transaction_session_timeout=20min");
    }
    expect(pgOptions.filter((options) => options.includes("-c default_transaction_read_only=on")))
      .toHaveLength(1);
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
    expect(runner).toContain("target-root.crt");
    expect(runner).not.toContain("console.log");
    expect(workflow).toContain("Upload private PostgreSQL rehearsal evidence");
    expect(workflow).toContain("retention-days: 7");
    expect(workflow).not.toContain("snapshot.dump\n");
    expect(readme).toContain("Raw provider output and deployment output remain private workflow artifacts");
  });

  it("reduces destination restore failures to a private enum-only diagnostic", () => {
    expect(runner).toContain("MAX_RESTORE_DIAGNOSTIC_LINE_BYTES = 4 * 1024");
    expect(runner).toContain("MAX_RESTORE_STATUS_LINE_BYTES = 128");
    expect(runner).toContain('LC_ALL: "C", LANG: "C"');
    expect(runner).toContain('`${artifactDir}/restore-diagnostic.json`');
    expect(runner).toContain('`${artifactDir}/connection-probe-diagnostic.json`');
    expect(runner).toContain('phase: "TARGET_CLIENT_CONNECTION_PROBE"');
    expect(runner).toContain('phase: "DESTINATION_RESTORE"');
    expect(runner).toContain('const RESTORE_SECTIONS = ["pre-data", "data", "post-data"]');
    expect(runner).toContain('pg_restore --section="$1" --no-owner --no-acl --file=- /work/snapshot.dump 2>/dev/null');
    expect(runner).toContain("psql -X --quiet --set=ON_ERROR_STOP=1 --set=VERBOSITY=sqlstate --set=SHOW_CONTEXT=never --set=ECHO=none");
    expect(runner).toContain('"--command=SELECT 1"');
    expect(runner.indexOf("await probeTargetClientConnection({"))
      .toBeLessThan(runner.indexOf('["pg_dump", "--format=custom"'));
    expect(runner).toContain("CORGTEX_RESTORE_STATUS:%s:%s");
    expect(runner).toContain("PIPESTATUS");
    expect(runner).toContain("options.stderrClassifier?.consume(chunk)");
    expect(runner).toContain("options.stdoutClassifier.consume(chunk)");
    expect(runner).toContain("if (options.stderrClassifier === undefined && stderrBytes > MAX_COMMAND_STDERR_BYTES)");
    for (const category of [
      "INSUFFICIENT_PRIVILEGE",
      "DUPLICATE_OBJECT",
      "MISSING_DEPENDENCY",
      "DATA_CONSTRAINT",
      "RESOURCE_EXHAUSTED",
      "CONNECTION",
      "AUTHENTICATION",
      "UNSUPPORTED_FEATURE",
      "SYNTAX_OR_ACCESS_RULE",
      "INTERNAL_ERROR",
      "UNKNOWN",
    ]) expect(runner).toContain(`"${category}"`);
    for (const processClass of ["OK", "ARCHIVE_RENDER_FAILED", "SCRIPT_ERROR", "CONNECTION_ERROR", "PROCESS_ERROR"]) {
      expect(runner).toContain(`"${processClass}"`);
    }
    expect(runner).toContain('rejectPromise(new RehearsalError(options.code ?? "COMMAND_FAILED"))');
    expect(runner).not.toContain("writeFileSync(stderr");
    expect(runner).not.toContain("process.stderr.write");
    expect(runner).not.toContain("stderrTail");
    expect(runner).not.toContain('"--verbose"');
    expect(runner).not.toContain("archiveToc:");
    expect(readme).toContain("restore-diagnostic.json");
    expect(readme).toContain("generated SQL is never materialized");
    expect(readme).toContain("SQLSTATE-only verbosity");
    expect(readme).toContain("never authorizes automatic remediation");
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
