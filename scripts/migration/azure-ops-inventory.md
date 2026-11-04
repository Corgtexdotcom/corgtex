# Read-only Azure Ops inventory

This route closes the ARM discovery gap **before** a frozen migration plan exists.
It does not need the Ops API, a frozen inventory UUID, Railway credentials,
PostgreSQL credentials, Key Vault secret access or a running PostgreSQL server.
It neither replaces `ops-core-preflight.mjs` nor calls target qualification.
Qualification can start/stop servers, open networking, restore and write; this
collector cannot. Core is retired into selfserve: do not activate another Core.

## Run and retain evidence

After normal review and merge, an authorized operator can manually dispatch
**Azure Ops Read-only Inventory** from protected `main`. The workflow reuses the
existing `azure-migration-foundation` environment and its `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` variables for OIDC. It has no PR,
push or schedule trigger, no arbitrary target inputs, and no credential secrets.
It creates no identity, federation, grant or secret. Existing read permission
must already cover the intended resources; a 401/403 is an evidence blocker,
not permission to add access or rerun the mutating qualification workflow.

For an already authorized, authenticated cloud operator, the same command is:

```sh
node scripts/migration/ops-core-azure-inventory.mjs       # offline intended targets only
node scripts/migration/ops-core-azure-inventory.mjs --execute
```

Execution also requires `AZURE_SUBSCRIPTION_ID` to equal the shared intended
subscription. No values are sourced from a `.env` file. The read-only transport
uses the current Azure CLI identity to acquire an ARM token, then bounded HTTPS
GET requests; it never invokes resource-changing CLI commands. Use a fresh
working directory for each execution: the receipt is created exclusively and an
existing receipt is not overwritten. Never commit generated proof.

The only retained file is `.artifacts/azure-ops-inventory/summary.json`, uploaded
as `azure-ops-inventory-<run-id>-<attempt>` for seven days. Keep the artifact private
and use its workflow run/SHA as provenance. It contains intended IDs separately
from observed IDs/presence, bounded configuration metadata, image references from
app templates and revisions, PASS/FAIL/UNKNOWN checks and unperformed evidence
gates. A successful capture exits zero even when checks fail: **green means
inventory captured, never migration accepted**. An incomplete/denied/invalid ARM
read, or any required metadata check that remains UNKNOWN, exits nonzero and
retains the partial sanitized receipt. Positively observed absence or policy
mismatches are complete evidence of a gap, not read failures. A login failure
cannot produce ARM proof. No automatic retry, access repair or mutation follows.

## Scope and interpretation

Targets follow the existing runtime-preparation contract: the Ops/core hosting
group, PG18 server, ACA environment, shared PostgreSQL private endpoint, Ops
web/worker, Ops managed identity, runtime vault, object storage account, default
blob-service protection policy and `objects` container. Shared subscription,
group, server and environment constants are used by both preparation and this
collector. These are **intended targets**, not claims that they exist today.
The intended Ops state backend is PostgreSQL; this does not prove the live app
uses it or that Railway Redis can be removed.

Only exact successful GET identities are `PRESENT`. Only a 404 with
`ResourceNotFound` is `ABSENT`; authorization errors, malformed responses,
unsupported response shapes and other 404 codes remain `UNKNOWN`. An exact
resource identity can remain `PRESENT` while its required metadata check is
`UNKNOWN`; that still makes `inventoryComplete` false. Known unsafe values
produce `FAIL`, not an inferred unknown or a pass. Paginated
firewall/revision lists are bounded, reject cycles and cannot change origin,
resource or API version. An absent app is a preparation gap, not proof that a
service should be created. A stopped target remains stopped.

The receipt does not contain tags, environment values, arbitrary environment
names, secrets or secret references, registry passwords, log workspace keys,
command arguments, provider error bodies, firewall IPs, object metadata or
customer data. ARM may return sensitive fields in its response; those stay in
process memory and are discarded by an explicit allowlist before retention.
No raw response is written to disk or stdout. Image references are validated
registry/repository tag or digest strings; a mutable tag is not a digest pin.
Tokens stay inside the existing transport and are not retained.

`armChecksPassed` covers only the named metadata predicates. In particular:

- The target's General Purpose SKU, 32 GiB storage and 14-day backup settings are
  checked against runtime preparation. This does not qualify capacity or restore.
- Endpoint approval and no PostgreSQL public access/firewall rules do not prove
  private DNS, effective network connectivity, database credentials or isolation.
- Image references and active revision declarations do not prove process health,
  release SHA, immutable promotion provenance, route traffic or a writer fence.
- Identity/vault presence and storage protection do not prove effective grants,
  retained secret continuity, object parity or archive/custody readiness.
- Settings-presence counts never inspect values. Use the existing reviewed
  runtime-projection/Azure-only config gates separately; do not dump settings.

The report always records `productionAccepted: false` and
`railwayRetirementAccepted: false`. It lists remaining SQL, source ownership,
parity, job state, health, image provenance, PITR, capacity/cost, scheduler/probe,
custody/archive and cutover evidence. It is not an atomic snapshot or frozen
fleet inventory. Keep Railway Ops serving and preserve existing recovery
material until those independent gates are satisfied. No networking, restart,
provisioning, restore, database write, deployment, flag change or retirement is
performed by this route.

## Offline validation

```sh
node --test scripts/migration/ops-core-azure-inventory.node-test.mjs \
  scripts/migration/ops-core-azure-target.node-test.mjs \
  scripts/migration/ops-core-runtime-preparation.node-test.mjs
node scripts/check-public-docs.mjs
node scripts/check-private-boundary.mjs
```

The existing `test:migration:ops-core` CI glob includes these tests. Fixtures
exercise sanitization, exact targets, missing-versus-denied resources, policy
drift, safe pagination/bounds, cancellation, the existing GET-only transport,
offline CLI behavior and the manual protected-workflow boundary. Fixture passes
are not live Azure evidence. Use the existing stable ARM schemas for
[storage](https://learn.microsoft.com/en-us/azure/templates/microsoft.storage/2023-05-01/storageaccounts),
[vaults](https://learn.microsoft.com/en-us/azure/templates/microsoft.keyvault/2023-07-01/vaults)
and [identities](https://learn.microsoft.com/en-us/azure/templates/microsoft.managedidentity/2023-01-31/userassignedidentities);
the PostgreSQL/ACA/network API versions match the existing target transport.
