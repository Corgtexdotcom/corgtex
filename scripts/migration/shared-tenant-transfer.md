# One-time tenant transfer

Run `node --import tsx scripts/migration/shared-tenant-transfer.ts help` for commands.
Store manifests, database archives, staging, diagnostics and receipts in a private
directory outside the repository (directory mode 0700, files 0600). Outputs are
immutable: use a new filename for each attempt. Credentials use environment
variables; never put them in command arguments or committed files.

## Prepare and rehearse

1. Inventory the exact source and target. Review every populated table and its
   workspace ownership, including separate schemas and validation workspaces.
   The tenant exporter covers the public Prisma schema; a full database archive
   also preserves other schemas, which require a separate ownership disposition.
2. `capture-copy` takes a consistent read-only native archive. `convert-copy`
   restores only into a newly owned local container and applies migrations there.
   Supply explicit `--max-bytes`, `--timeout-ms`, and `--postgres-major 16|17|18`.
   Historical migration checksums must match the supplied migration tree; resolve
   known historical SQL differences with provenance on the isolated copy, never
   by rewriting live migration history or skipping checksum validation.
3. Review the manifest's table and field policies, then `export-copy` the selected
   workspace and its reference closure. Global identities are selected by their
   actual references. Matching email alone does not authorize account linking.
   Known scalar secrets, objects and opaque references require their registered
   classification. A reviewed missing-object exception is limited to exact
   Document/BrainSource locators with preserved inline text and evidence hashes.
4. `prepare-publication --snapshot /private/source.json --options
   /private/policy.json --output /private/prepared.json` stages exact selected rows
   with their original states and records any explicitly detached references.
   Stage old credentials and executable jobs/events. Retain business history.
   Stage any source `operator_import_inactive` marker explicitly. To preserve
   newspaper click history, `disable-tracking-token` replaces only tracked-link
   token hashes with nonfunctional values while retaining their rows.
   The prepared wrapper can be passed directly to `import` and `verify-inactive`.
5. Review disabled integration, agent and schedule settings and typed identity
   mappings. `copy-objects --execute` verifies referenced files between separately
   bound private containers. Its receipt must bind the exact publication snapshot;
   even an empty file set requires verified inventory and a receipt.
   Separate stale-file removal requires a digest-verified final reconciliation
   manifest bound to the same transfer, source/target stores and exact preceding
   copy-receipt hash. An unbound list of final references cannot authorize deletion.
6. Rehearse import against an isolated target-equivalent database containing an
   existing tenant. Check transformed digests, representative content/history,
   existing credentials, isolation, disabled effects and retry behavior.

## Publish and cut over

Stop the actual source writers and reconcile in-flight work. Capture final data
and file changes/deletions after the freeze; rehearsal snapshots are not final.
Serialize shared runtime updates, database publication and client cutovers.

`import --execute` requires an exact `targetBinding` (host, port, database, user)
in its options and the final object receipt. The transaction publishes inactive
members/agents and an `operator_import_inactive` feature flag with its receipt.
The flag suppresses all-workspace scheduled jobs and approval expiry. It is not
a universal write lock: integrations, recurring series and executable pending
work need their own reviewed disabled settings or staging. Deploy these runtime
guards before publishing an inactive workspace.

Run `verify-inactive`, then verify access and actual client workflows. Activation,
fresh account setup, integration reconnection, registration and primary switching
are deliberate operator steps outside this CLI. Preserve existing target users.
Reconcile staged unfinished work before acceptance; do not replay terminal history.

For a retired application's admin-only financial history, preserve a scoped
gzip JSON archive of original text cells, schema, relationships and provenance.
Exclude credentials, sessions and unrelated tenants. The download endpoint
`/api/workspaces/{workspaceId}/finance/history-archive` requires an active human
ADMIN membership and does not index the file. Its operator-created feature flag
`operator_financial_history_archive` binds `{sha256, bytes}` to the derived private
storage key `imports/{workspaceId}/history/{sha256}.json.gz` (maximum 16 MiB).
Verify the stored bytes before enabling the flag; retain the full source archive
privately for recovery.

A failed transaction rolls back its additions. If commit acknowledgement is lost,
retry identical inputs: the persisted receipt permits verification, never replay.
After target writes begin, use current-target recovery or fix forward. Never
restore a dedicated database over shared or switch to a stale source. Source
retirement is a separate operation.

Validation: `npm run test:tenant-transfer`, `npm run test:source-copy`, focused
unit tests, and `outbox.operator-import.integration.test.ts` exercise these paths.
