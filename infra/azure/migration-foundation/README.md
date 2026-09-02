# Azure migration foundation

This resource-group-scope template creates only the backing resources needed to
rehearse a Railway-to-Azure restore inside one precreated, isolated resource group:

- PostgreSQL Flexible Server 18 and one restore database;
- private Blob containers for objects and restore evidence;
- a user-assigned identity, RBAC Key Vault, and data-plane role assignments; and
- Log Analytics and Application Insights.

It deliberately creates no Container Apps, workers, jobs, DNS, callbacks, or
Railway changes. The target is non-authoritative until a later cutover gate.

## Guarded preview

Use the manual `Azure Migration Foundation` workflow. It defaults to `what-if`,
uses a dedicated Azure OIDC identity, validates the exact subscription and
precreated resource-group boundary, and runs
`scripts/migration/validate-azure-what-if.mjs` against the full JSON result. The
resource group must exist in `westus3`, carry the reviewed purpose, authority, and
manager tags, and contain no workload resources. The validator permits only the
exact reviewed 13-resource `Create` manifest within that group. Delete, modify,
no-change/adoption, deploy/replace, ignore, unsupported, foreign, duplicate, empty, partial,
diagnostic, potential-change, malformed, or incomplete results fail closed.
The group boundary rejects extra tags before preview and deploy, and post-deploy
inventory rejects any resource outside the exact previewed identity set.

Raw provider output and deployment output remain private workflow artifacts. Logs
and public receipts contain only counts, hashes, metadata, and opaque references.
The workflow binds the compiled template, public parameters, and exact target to
the preview, recomputes those bindings immediately before create, keeps the
database password in step-scoped protected environment state and a mode-0600
runner-temporary parameter file, and reads back every exact previewed resource.

## Required provider gate

Before `deploy`, freeze the exact subscription, precreated empty resource-group
name, location, name prefix, SKU/capacity, PostgreSQL 18 source compatibility,
rollback, and owner. The workflow requires the protected `azure-migration-foundation` environment.
It is restricted to `main` and backed by a dedicated passwordless user-assigned
managed identity in a separate bootstrap resource group. That identity must have only
temporary `Contributor` and conditioned `Role Based Access Control Administrator`
assignments at the exact resource-group scope. The RBAC condition may delegate
only Key Vault Secrets User and Storage Blob Data Contributor to service principals.
At runtime, the workflow pins the dedicated identity by an opaque client-ID digest,
enumerates direct, inherited-scope, and transitive group assignments, and requires
exactly the reviewed Contributor plus conditioned RBAC Administrator roles before
preview or deploy.
Before either `what-if` or `deploy`, configure these environment variables:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

Configure only the database credential as an environment secret:

- `AZURE_MIGRATION_POSTGRES_ADMIN_PASSWORD`

The example parameter password is a placeholder and must never be used or copied
into a real parameter file. The workflow injects the protected secret only into a
shredded runner-temporary parameter file; it is never passed in command arguments
or uploaded as evidence. Raw provider output remains in private workflow artifacts.

## Local validation

```text
az bicep build --file infra/azure/migration-foundation/main.bicep
npx vitest run scripts/migration/validate-azure-migration-principal.test.mjs scripts/migration/validate-azure-what-if.test.mjs scripts/migration/validate-azure-foundation-readback.test.mjs scripts/migration/azure-migration-foundation-contract.test.mjs
```

Provider rollback may remove only the exact newly created empty rehearsal resources
after zero-data readback. Once restore data exists, preserve it until separately
authorized cleanup.

## PostgreSQL restore rehearsal

The manual `Azure Migration PostgreSQL Restore Rehearsal` workflow restores exactly
one `core` or `ops` snapshot per run. It is a PostgreSQL-only proof and does not
authorize a cutover. The workflow runs only from exact `main`, uses the existing
protected `azure-migration-foundation` environment, and serializes both data domains
because they share one non-authoritative Azure server.

Before a run, temporarily grant the dedicated migration UAMI only `Contributor` at
the exact rehearsal resource-group scope. Its effective direct, inherited, and group
assignment set must contain exactly that one role. Do not grant RBAC Administrator or
data-plane storage roles for this phase. Revoke Contributor again after the run and
its cleanup evidence have been verified.

Configure one transactionally read-only Railway credential per data domain as
protected environment secrets:

- `RAILWAY_CORE_POSTGRES_READ_ONLY_URL`
- `RAILWAY_OPS_POSTGRES_READ_ONLY_URL`
- `RAILWAY_CORE_POSTGRES_TLS_ROOT_CERT`
- `RAILWAY_OPS_POSTGRES_TLS_ROOT_CERT`

The existing `AZURE_MIGRATION_POSTGRES_ADMIN_PASSWORD` secret is used only to create,
restore, read, and remove the unique scratch database. URLs and passwords remain in
step-scoped environment state and mode-0600 runner-temporary service/pass files; they
are never command arguments, logs, or uploaded artifacts.

Each Railway trust-anchor secret contains exactly the matching source service's
current `root.crt`, retrieved through authenticated Railway access and validated
against that service's live TLS chain before storage. The runner requires the source
URL's `sslmode=require` contract but strengthens both Node and PostgreSQL client
connections to CA-authenticated `verify-ca`; Azure remains system-root
`verify-full`. Trust anchors are domain-scoped, written only to a mode-0600
runner-temporary file, shredded with the other connection material, and never
logged or uploaded. Railway CA rotation fails closed until the matching protected
secret is refreshed.

Each run reconfirms the exact 13-resource foundation, non-authoritative tags,
PostgreSQL 18 posture, empty firewall set, absence of Container Apps, storage
containers, and data-plane role assignments. It then opens one run-named `/32`
firewall rule, exports one repeatable-read read-only source snapshot, and binds both
the immutable PostgreSQL 18.6 `pg_dump` and source evidence to that snapshot. The
restore always targets a new run-derived database, never the Bicep-managed `corgtex`
database. The workflow preserves the source PostgreSQL 18 locale provider, provider
locale, ICU rules, encoding, collation, and character classification, and requires
the target-computed collation version to match before reporting parity. The exported
snapshot holder disables its statement, transaction, and idle-in-transaction
timeouts, while dump, restore, and evidence clients disable statement and transaction
timeouts. Before opening a source snapshot or creating the scratch database, the
runner polls an authenticated, harmless target query for up to five minutes so the
exact Azure firewall rule has reached the data plane; each connection attempt is
bounded by the remaining deadline. The workflow's bounded 180-minute job timeout
remains the outer limit.
Because sequence values are not MVCC-protected, sequence parity is derived from the
immutable custom archive: only exact `SEQUENCE SET` entries are replayed against the
isolated scratch database, and their replay must be a no-op with complete sequence
coverage.

Private evidence contains schema/table identities, counts, digests, and the exact
before/after archive-sequence replay proof—never table row values or dump bytes. The
public receipt is limited to opaque source, target, and domain references; aggregate
counts; the evidence digest; and fixed readiness states. Success is
`POSTGRES_REHEARSAL_VERIFIED` with Redis, objects, destination runtime, and source
quiescence still unproven, `ProviderCutover` still `PLANNED`, and `cutoverReady:
false`.

Scratch-database and firewall cleanup run independently under `always()`. A success
receipt requires absence readback for both plus shredded runner-temporary connection
material. Before either temporary resource can be created, the workflow uploads a
30-day private recovery-intent artifact containing the exact run-derived database and
firewall identities plus their absence-verified target. If the runner is terminated
before `always()` cleanup, dispatch the same protected workflow with operation
`recover`, the original domain, run ID, and run attempt. It downloads and validates
that exact artifact, deletes the exact database child through the Azure management
plane without a PostgreSQL password or recovery-runner firewall, independently
removes the run-derived firewall rule, and proves both absent. The intent never
authorizes removal of the Bicep-managed `corgtex` database or another firewall rule.
Any missing or failed cleanup is `RECOVERY_REQUIRED`.

Local validation:

```text
npx vitest run --project unit scripts/migration/run-postgres-restore-rehearsal.test.mjs scripts/migration/validate-postgres-restore-rehearsal.test.mjs scripts/migration/azure-postgres-restore-rehearsal-contract.test.mjs
npm run test:migration:postgres-smoke
```
