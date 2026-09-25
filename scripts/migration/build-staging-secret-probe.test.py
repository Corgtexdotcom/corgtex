import copy
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("build-staging-secret-probe.py")
SPEC = importlib.util.spec_from_file_location("build_staging_secret_probe", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
IMAGE = "acr.example.azurecr.io/corgtex/web@sha256:" + "a" * 64


class BuildStagingSecretProbeTests(unittest.TestCase):
    def setUp(self):
        env = [
            {"name": name, "secretRef": secret_ref, "value": ""}
            for name, secret_ref in MODULE.EXPECTED_REFS.items()
        ]
        env.append({"name": "CORGTEX_STARTUP_MODE", "value": "migrate-and-seed"})
        self.job = {
            "registries": [{"server": "acr.example.azurecr.io", "passwordSecretRef": "ghcr-pat"}],
            "template": {"containers": [{"name": "migrate", "image": IMAGE,
                                         "resources": {"cpu": 0.5, "memory": "1Gi"}, "env": env}]},
        }

    def test_overrides_command_and_fails_closed_on_entrypoint(self):
        request = MODULE.build_request(self.job, IMAGE)
        container = request["containers"][0]
        self.assertEqual(container["command"], ["node"])
        self.assertEqual(container["args"][0], "-e")
        self.assertEqual(container["env"][-1], {"name": "CORGTEX_STARTUP_MODE", "value": "secret-probe-no-migration"})
        self.assertEqual(len(container["env"]), len(MODULE.EXPECTED_REFS) + 1)
        self.assertEqual(container["env"][0]["value"], "")
        self.assertNotIn("migrate-and-seed", str(request))
        self.assertNotIn("AGENT_API_KEY", container["args"][1])

    def test_rejects_changed_secret_reference(self):
        self.job["template"]["containers"][0]["env"][0]["secretRef"] = "other"
        with self.assertRaisesRegex(ValueError, "DATABASE_URL"):
            MODULE.build_request(self.job, IMAGE)

    def test_rejects_literal_secret_value(self):
        self.job["template"]["containers"][0]["env"][0]["value"] = "unexpected"
        with self.assertRaisesRegex(ValueError, "DATABASE_URL"):
            MODULE.build_request(self.job, IMAGE)

    def test_rejects_image_drift_and_init_container(self):
        changed = copy.deepcopy(self.job)
        changed["template"]["containers"][0]["image"] = "other"
        with self.assertRaisesRegex(ValueError, "image or resources"):
            MODULE.build_request(changed, IMAGE)
        self.job["template"]["initContainers"] = [{"name": "unexpected"}]
        with self.assertRaisesRegex(ValueError, "init container"):
            MODULE.build_request(self.job, IMAGE)

    def test_accepts_omitted_empty_value_but_keeps_reference(self):
        self.job["template"]["containers"][0]["env"][0].pop("value")
        request = MODULE.build_request(self.job, IMAGE)
        self.assertEqual(request["containers"][0]["env"][0], {"name": "DATABASE_URL", "secretRef": "database-url"})

    def test_accepts_empty_saved_job_ephemeral_storage_without_propagating_it(self):
        resources = self.job["template"]["containers"][0]["resources"]
        resources["ephemeralStorage"] = ""
        request = MODULE.build_schema_request(self.job, IMAGE)
        self.assertEqual(request["containers"][0]["resources"], {"cpu": 0.5, "memory": "1Gi"})
        self.assertEqual(resources["ephemeralStorage"], "")

    def test_rejects_nonempty_saved_job_ephemeral_storage(self):
        self.job["template"]["containers"][0]["resources"]["ephemeralStorage"] = "1Gi"
        with self.assertRaisesRegex(ValueError, "image or resources"):
            MODULE.build_schema_request(self.job, IMAGE)

    def test_verifies_execution_command_and_references(self):
        request = MODULE.build_request(self.job, IMAGE)
        execution = {"template": copy.deepcopy(request)}
        MODULE.verify_execution(execution, request)
        execution["template"]["containers"][0]["command"] = ["sh"]
        with self.assertRaisesRegex(ValueError, "command"):
            MODULE.verify_execution(execution, request)

    def test_rejects_execution_entrypoint_or_secret_drift(self):
        request = MODULE.build_request(self.job, IMAGE)
        execution = {"template": copy.deepcopy(request)}
        execution["template"]["containers"][0]["env"][-1]["value"] = "migrate-and-seed"
        with self.assertRaisesRegex(ValueError, "CORGTEX_STARTUP_MODE"):
            MODULE.verify_execution(execution, request)
        execution = {"template": copy.deepcopy(request)}
        execution["template"]["containers"][0]["env"][0]["secretRef"] = "other"
        with self.assertRaisesRegex(ValueError, "references changed"):
            MODULE.verify_execution(execution, request)

    def test_accepts_observed_azure_execution_readback(self):
        request = MODULE.build_request(self.job, IMAGE)
        execution = {"template": copy.deepcopy(request)}
        container = execution["template"]["containers"][0]
        container["resources"]["ephemeralStorage"] = ""
        for entry in container["env"]:
            if "secretRef" in entry:
                entry["secretRef"] = MODULE.PROVIDER_EXECUTION_REF
        MODULE.verify_execution(execution, request)

    def test_rejects_mixed_or_changed_provider_readback(self):
        request = MODULE.build_request(self.job, IMAGE)
        execution = {"template": copy.deepcopy(request)}
        container = execution["template"]["containers"][0]
        container["env"][0]["secretRef"] = MODULE.PROVIDER_EXECUTION_REF
        with self.assertRaisesRegex(ValueError, "references changed"):
            MODULE.verify_execution(execution, request)
        for entry in container["env"]:
            if "secretRef" in entry:
                entry["secretRef"] = MODULE.PROVIDER_EXECUTION_REF
        container["resources"]["ephemeralStorage"] = "1Gi"
        with self.assertRaisesRegex(ValueError, "resources"):
            MODULE.verify_execution(execution, request)

    def test_builds_read_only_schema_probe_for_exact_staging_database(self):
        request = MODULE.build_schema_request(self.job, IMAGE)
        container = request["containers"][0]
        script = container["args"][1]
        self.assertEqual(container["command"], ["node"])
        self.assertIn("SET TRANSACTION READ ONLY", script)
        self.assertIn("corgtex-ss-stg-pg.postgres.database.azure.com", script)
        self.assertIn("20260923120000_postgres_shared_state", script)
        self.assertIn("SCHEMA_PROBE_PASS", script)
        self.assertEqual(container["env"][-1], {"name": "CORGTEX_STARTUP_MODE", "value": "secret-probe-no-migration"})
        self.assertNotIn("migrate-and-seed", str(request))
        self.assertNotIn("CREATE TABLE", script)

    def test_schema_probe_retains_execution_readback_guards(self):
        request = MODULE.build_schema_request(self.job, IMAGE)
        execution = {"template": copy.deepcopy(request)}
        container = execution["template"]["containers"][0]
        container["resources"]["ephemeralStorage"] = ""
        for entry in container["env"]:
            if "secretRef" in entry:
                entry["secretRef"] = MODULE.PROVIDER_EXECUTION_REF
        MODULE.verify_execution(execution, request)
        container["args"][1] = "console.log('no database query')"
        with self.assertRaisesRegex(ValueError, "args"):
            MODULE.verify_execution(execution, request)

    def test_schema_script_uses_read_only_transaction_and_rejects_partial_state(self):
        fake_client = r"""
let readOnly = false;
module.exports.PrismaClient = class {
  constructor() {
    const url = new URL(process.env.DATABASE_URL);
    if ([...url.searchParams.keys()].sort().join(',') !== 'schema,sslaccept,sslmode'
      || url.searchParams.get('sslaccept') !== 'strict') throw new Error('Prisma saw a weak URL');
    if (process.env.EXPECT_ENCODED_PASSWORD && url.password !== process.env.EXPECT_ENCODED_PASSWORD)
      throw new Error('Prisma saw a changed password');
  }
  async $transaction(work) {
    return work({
      $executeRawUnsafe: async (sql) => {
        if (sql !== 'SET TRANSACTION READ ONLY') throw new Error('not read only');
        readOnly = true;
      },
      $queryRawUnsafe: async (sql) => {
        if (!readOnly || !sql.trim().startsWith('SELECT')) throw new Error('unsafe query');
        const state = process.env.FAKE_SCHEMA_STATE;
        if (sql.includes('to_regclass')) return [{ ledger: state !== 'unapplied',
          rateLimit: state !== 'unapplied', cacheEntry: state !== 'unapplied',
          cacheVersion: state !== 'unapplied', pendingUpload: state === 'applied' }];
        return [{ total: 1, finished: 1 }];
      },
    });
  }
  async $disconnect() {}
};
"""
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory, "@prisma", "client")
            package.mkdir(parents=True)
            (package / "index.js").write_text(fake_client, encoding="utf-8")
            for state, suffix, code, marker in (
                ("unapplied", "&sslaccept=strict", 0, "SCHEMA_PROBE_PASS state=NOT_APPLIED tls=CONFIGURED_STRICT"),
                ("applied", "&sslaccept=strict", 0, "SCHEMA_PROBE_PASS state=APPLIED tls=CONFIGURED_STRICT"),
                ("applied", "", 0, "SCHEMA_PROBE_PASS state=APPLIED tls=PROBE_ONLY_STRICT"),
                ("partial", "", 1, "SCHEMA_PROBE_FAILED code=INCONSISTENT_SCHEMA"),
            ):
                with self.subTest(state=state, suffix=suffix):
                    env = {**os.environ, "NODE_PATH": directory, "FAKE_SCHEMA_STATE": state,
                           "DATABASE_URL": "postgresql://probe:local-only@corgtex-ss-stg-pg.postgres.database.azure.com/corgtex?schema=public&sslmode=require" + suffix}
                    result = subprocess.run(["node", "-e", MODULE.SCHEMA_PROBE_SCRIPT],
                                            cwd=directory, env=env, text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, code)
                    self.assertIn(marker, result.stdout + result.stderr)
            escaped = {**os.environ, "NODE_PATH": directory, "FAKE_SCHEMA_STATE": "applied",
                       "EXPECT_ENCODED_PASSWORD": "local%23only",
                       "DATABASE_URL": "postgresql://probe:local%23only@corgtex-ss-stg-pg.postgres.database.azure.com/corgtex?schema=public&sslmode=require"}
            escaped_result = subprocess.run(["node", "-e", MODULE.SCHEMA_PROBE_SCRIPT],
                                            cwd=directory, env=escaped, text=True, capture_output=True, timeout=10)
            self.assertEqual(escaped_result.returncode, 0)
            self.assertIn("SCHEMA_PROBE_PASS state=APPLIED tls=PROBE_ONLY_STRICT", escaped_result.stdout)
            base = "postgresql://probe:local-only@corgtex-ss-stg-pg.postgres.database.azure.com"
            for target in (
                base + ":5433/corgtex?schema=public&sslmode=require&sslaccept=strict",
                base + "/corgtex?schema=foreign&sslmode=require&sslaccept=strict",
                base + "/corgtex?schema=public&sslmode=disable&sslaccept=strict",
                base + "/corgtex?schema=public&sslmode=require&sslaccept=accept_invalid_certs",
                base + "/corgtex?schema=public&sslmode=require&sslaccept=strict&host=/tmp/foreign-db",
                base + "/corgtex?schema=public&sslmode=require&sslaccept=strict#ignored",
                base + "/corgtex?schema=public&sslmode=require#",
                base + "/corgtex?schema=public&sslmode=require&schema=public",
            ):
                with self.subTest(target=target.split("?")[-1]):
                    env = {**os.environ, "NODE_PATH": directory, "FAKE_SCHEMA_STATE": "applied",
                           "DATABASE_URL": target}
                    result = subprocess.run(["node", "-e", MODULE.SCHEMA_PROBE_SCRIPT],
                                            cwd=directory, env=env, text=True, capture_output=True, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("TARGET_MISMATCH", result.stderr)


if __name__ == "__main__":
    unittest.main()
