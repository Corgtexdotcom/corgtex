#!/usr/bin/env python3
"""Build a non-migrating execution template for the existing staging job."""

import json
import re
import sys
from pathlib import Path


EXPECTED_REFS = {
    "DATABASE_URL": "database-url",
    "REDIS_URL": "redis-url",
    "SESSION_COOKIE_SECRET": "session-cookie-secret",
    "ENCRYPTION_KEY": "encryption-key",
    "AGENT_API_KEY": "agent-api-key",
    "SMOKE_EMAIL_CAPTURE_SECRET": "smoke-email-capture-secret",
    "SELF_SERVE_REGISTRY_SYNC_SECRET": "self-serve-registry-sync-secret",
    "MODEL_PRICE_OVERRIDES_JSON": "model-price-overrides-json",
    "ADMIN_PASSWORD": "admin-password",
}
REQUIRED_NONEMPTY = ("DATABASE_URL", "REDIS_URL", "SESSION_COOKIE_SECRET", "ENCRYPTION_KEY", "ADMIN_PASSWORD")
PROVIDER_EXECUTION_REF = "cappjob-caj-corgtex-ss-stg-migrate"
SCHEMA_PROBE_SCRIPT = r"""
const allowedHost = 'corgtex-ss-stg-pg.postgres.database.azure.com';
const migration = '20260923120000_postgres_shared_state';
const rawUrl = process.env.DATABASE_URL;
let url;
try { url = new URL(rawUrl); } catch { throw new Error('TARGET_URL_INVALID'); }
const queryKeys = [...url.searchParams.keys()].sort().join(',');
const configuredStrict = url.searchParams.has('sslaccept');
if (url.protocol !== 'postgresql:' || url.hostname !== allowedHost || url.pathname !== '/corgtex'
  || (url.port !== '' && url.port !== '5432') || rawUrl.includes('#')
  || !['schema,sslmode', 'schema,sslaccept,sslmode'].includes(queryKeys)
  || url.searchParams.get('schema') !== 'public' || url.searchParams.get('sslmode') !== 'require'
  || (configuredStrict && url.searchParams.get('sslaccept') !== 'strict')) {
  throw new Error('TARGET_MISMATCH');
}
// This execution alone gets strict certificate validation. The saved shared secret
// and the migration job template are not changed by the read-only probe.
if (!configuredStrict) {
  url.searchParams.set('sslaccept', 'strict');
  process.env.DATABASE_URL = url.toString();
}
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  try {
    const state = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const [tables] = await tx.$queryRawUnsafe(`SELECT
        to_regclass('public."_prisma_migrations"') IS NOT NULL AS "ledger",
        to_regclass('public."SharedRateLimit"') IS NOT NULL AS "rateLimit",
        to_regclass('public."SharedCacheEntry"') IS NOT NULL AS "cacheEntry",
        to_regclass('public."SharedCacheVersion"') IS NOT NULL AS "cacheVersion",
        to_regclass('public."PendingTranscriptUpload"') IS NOT NULL AS "pendingUpload"`);
      let ledger = { total: 0, finished: 0 };
      if (tables.ledger) {
        [ledger] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS "total",
          count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS "finished"
          FROM public."_prisma_migrations" WHERE migration_name = $1`, migration);
      }
      return { tables, ledger };
    }, { timeout: 20000 });
    const { tables, ledger } = state;
    const flags = [tables.rateLimit, tables.cacheEntry, tables.cacheVersion, tables.pendingUpload];
    const unapplied = ledger.total === 0 && flags.every((flag) => flag === false);
    const applied = ledger.total === 1 && ledger.finished === 1 && flags.every((flag) => flag === true);
    if (!unapplied && !applied) throw new Error('INCONSISTENT_SCHEMA');
    console.log('SCHEMA_PROBE_PASS state=' + (applied ? 'APPLIED' : 'NOT_APPLIED')
      + ' tls=' + (configuredStrict ? 'CONFIGURED_STRICT' : 'PROBE_ONLY_STRICT'));
  } finally {
    await prisma.$disconnect();
  }
}
run().catch((error) => {
  const known = ['TARGET_URL_INVALID', 'TARGET_MISMATCH', 'INCONSISTENT_SCHEMA'];
  console.error('SCHEMA_PROBE_FAILED code=' + (known.includes(error.message) ? error.message : 'QUERY_FAILED'));
  process.exitCode = 1;
});
""".strip()


def build_request(job, expected_image):
    if not re.fullmatch(r"[^\s]+/corgtex/web@sha256:[a-f0-9]{64}", expected_image):
        raise ValueError("Expected an immutable ACR web image digest")
    containers = job["template"]["containers"]
    if len(containers) != 1 or containers[0].get("name") != "migrate":
        raise ValueError("Expected exactly one named migration container")
    if job["template"].get("initContainers"):
        raise ValueError("Unexpected migration job init container")
    container = containers[0]
    resources = dict(container.get("resources") or {})
    # Azure may add an empty ephemeralStorage to the saved job as well as execution GET.
    if resources.get("ephemeralStorage") == "":
        del resources["ephemeralStorage"]
    if container.get("image") != expected_image or resources != {"cpu": 0.5, "memory": "1Gi"}:
        raise ValueError("Migration image or resources changed")
    if container.get("command") or container.get("args"):
        raise ValueError("Migration job already overrides its image command")

    registry = job["registries"]
    server = expected_image.split("/corgtex/web@", 1)[0]
    if len(registry) != 1 or registry[0].get("server") != server or registry[0].get("passwordSecretRef") != "ghcr-pat":
        raise ValueError("Staging ACR binding changed")

    entries = container["env"]
    if len({entry["name"] for entry in entries}) != len(entries):
        raise ValueError("Duplicate migration environment name")
    by_name = {entry["name"]: entry for entry in entries}
    probe_env = []
    for name, secret_ref in EXPECTED_REFS.items():
        entry = by_name.get(name, {})
        if entry.get("secretRef") != secret_ref or entry.get("value") not in (None, ""):
            raise ValueError(f"Migration secret reference changed: {name}")
        # Preserve the live API representation, including the CLI-added empty value.
        probe_env.append({key: entry[key] for key in ("name", "secretRef", "value") if key in entry})

    names = list(REQUIRED_NONEMPTY)
    script = (
        f"const names={json.dumps(names)};"
        "const missing=names.filter(name=>!process.env[name]);"
        "if(missing.length){console.error('SECRET_REF_PROBE_FAILED names='+missing.join(','));process.exit(1)}"
        "console.log('SECRET_REF_PROBE_PASS count='+names.length)"
    )
    # An invalid startup mode also fails closed if the image entrypoint runs.
    probe_env.append({"name": "CORGTEX_STARTUP_MODE", "value": "secret-probe-no-migration"})
    return {"containers": [{
        "name": "migrate",
        "image": expected_image,
        "resources": resources,
        "env": probe_env,
        "command": ["node"],
        "args": ["-e", script],
    }]}


def build_schema_request(job, expected_image):
    request = build_request(job, expected_image)
    request["containers"][0]["args"] = ["-e", SCHEMA_PROBE_SCRIPT]
    return request


def verify_execution(execution, request):
    containers = execution["template"]["containers"]
    if len(containers) != 1:
        raise ValueError("Secret probe execution has an unexpected container count")
    actual = containers[0]
    expected = request["containers"][0]
    for key in ("name", "image", "command", "args"):
        if actual.get(key) != expected[key]:
            raise ValueError(f"Secret probe execution changed {key}")
    resources = dict(actual.get("resources") or {})
    # Azure execution GET can also add an empty ephemeralStorage to this request.
    if resources.get("ephemeralStorage") == "":
        del resources["ephemeralStorage"]
    if resources != expected["resources"]:
        raise ValueError("Secret probe execution changed resources")
    if execution["template"].get("initContainers"):
        raise ValueError("Secret probe execution has an init container")
    actual_env = actual.get("env", [])
    if len(actual_env) != len(expected["env"]) or len({entry["name"] for entry in actual_env}) != len(actual_env):
        raise ValueError("Secret probe execution environment changed")
    by_name = {entry["name"]: entry for entry in actual_env}
    requested_refs = [entry["secretRef"] for entry in expected["env"] if "secretRef" in entry]
    returned_refs = [by_name.get(entry["name"], {}).get("secretRef") for entry in expected["env"] if "secretRef" in entry]
    # The observed execution GET replaces every named job secret with this one opaque
    # provider reference. The saved job and POST still require the exact named refs;
    # execution success requires the five values to resolve inside the container.
    if returned_refs not in (requested_refs, [PROVIDER_EXECUTION_REF] * len(requested_refs)):
        raise ValueError("Secret probe execution references changed")
    for entry in expected["env"]:
        found = by_name.get(entry["name"], {})
        if "secretRef" in entry:
            if found.get("value") not in (None, ""):
                raise ValueError(f"Secret probe execution reference changed: {entry['name']}")
        elif found != entry:
            raise ValueError(f"Secret probe execution environment changed: {entry['name']}")


def main():
    usage = "usage: build-staging-secret-probe.py build|build-schema JOB_JSON EXPECTED_IMAGE REQUEST_JSON | verify EXECUTION_JSON REQUEST_JSON"
    if len(sys.argv) < 2:
        raise SystemExit(usage)
    try:
        if sys.argv[1] == "verify" and len(sys.argv) == 4:
            execution = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
            request = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
            verify_execution(execution, request)
            print("Secret probe execution command and provider reference shape verified")
            return
        if sys.argv[1] in ("build", "build-schema") and len(sys.argv) == 5:
            job = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
            request = build_schema_request(job, sys.argv[3]) if sys.argv[1] == "build-schema" else build_request(job, sys.argv[3])
            Path(sys.argv[4]).write_text(json.dumps(request, separators=(",", ":")), encoding="utf-8")
            print("Staging read-only probe template prepared for the pinned image")
            return
        raise ValueError(usage)
    except (KeyError, TypeError, ValueError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
