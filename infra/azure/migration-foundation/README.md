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
