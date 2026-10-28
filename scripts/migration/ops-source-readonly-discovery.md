# Preliminary Ops source discovery

This isolated job uses the existing `azure-migration-foundation` environment's
`RAILWAY_OPS_POSTGRES_READ_ONLY_URL` and `RAILWAY_OPS_POSTGRES_TLS_ROOT_CERT`.
It creates no Railway CLI session, Azure identity/grant, secret, provider resource
or migration lease. The draft must pass independent review, CI and protected
merge before one separately approved dispatch on that exact main/workflow SHA.
Preparation and synthetic tests do not authorize secret use or execution.

## Bound source and useful result

The provider scope is Ops project `42d177e6-0f16-4878-9fb3-f65e6153ad2c`, production
environment `30b16f74-9443-4184-99cc-73ca595ebb3a`, PostgreSQL service
`f2498777-f21f-42b8-b836-84ebf7cbf088`, public proxy
`switchback.proxy.rlwy.net:45900` forwarding to PostgreSQL5432. Before dispatch,
the coordinator must freshly reconcile that exact provider mapping through
existing authorized provider reads and supply its actual evidence hash/time.
The job enforces a one-hour age limit but **does not authenticate provider evidence**;
the protected reviewer must verify it. Drift stops without endpoint rewriting.

The existing URL's database and role are not known from secret-name metadata.
The helper accepts only one bounded database/role name, the exact proxy and
explicit `sslmode=require` or `verify-full`; all additional URL options are rejected.
It requires a single valid PEM trust anchor and never fetches a replacement.
Only one source database connection, as the URL's existing role, is permitted.
No target or alternative credential reference is accessed.

Success provides PG18 identity/read-only checks, current database OID, catalog
counts, and digests of the connection binding and bounded catalogs. It does not
select an authoritative application database/reader, establish full privileges,
or read the cluster system identifier. Powerful direct role flags are rejected;
that does not prove the credential has no existing table-write or role-switch
capability. The fixed session remains read-only and never switches roles.

## TLS boundary

The historical `run-postgres-restore-rehearsal.mjs` source adapter combines
`sslmode=require` with a supplied CA but overrides `checkServerIdentity`; its
Docker source profile uses `verify-ca`. **This observer does not import or reuse
that adapter or its hostname exception.**

First it sends PostgreSQL's SSLRequest and validates the source certificate chain
against only the supplied CA with TLS>=1.2 and `check_hostname=True` for
`switchback.proxy.rlwy.net`. It sends no PostgreSQL StartupMessage, user or password
on that preliminary connection. A hostname mismatch, expired/untrusted certificate,
missing TLS, bad URL or failed connection stops before database authentication.

Only after that succeeds does the pinned PostgreSQL client authenticate on a
second connection, **independently** enforcing `sslmode=verify-full`, TLS>=1.2, the same CA
and the exact hostname. GSS encryption and client-certificate selection are disabled;
there is no ambient authentication/certificate fallback. An original URL option `require` is promoted to the stronger
client policy; it never selects encryption-only behavior. No `verify-ca`, disabled
hostname callback, insecure fallback, certificate replacement or source-network
change is included. The retained certificate's SAN/current validity is unknown
until an approved check. If it cannot validate the proxy hostname, this route is
blocked; retain the failure and return a separate supported transport decision.
See the PostgreSQL18 [TLS modes](https://www.postgresql.org/docs/18/libpq-ssl.html)
and [client environment settings](https://www.postgresql.org/docs/18/libpq-envars.html).

## SQL, limits and custody boundary

The frozen SQL starts repeatable-read/read-only with `search_path=pg_catalog`.
Startup also sets default read-only mode. Require PG18 primary, exact URL database
and role/current login, current session TLS, and absence of superuser/CREATEDB/
CREATEROLE/replication/BYPASSRLS direct flags before the catalog query. Stop if
those conditions fail; do not grant privileges or substitute an admin password.

Read only `pg_database`, allowlisted noncredential `pg_roles` fields and
`pg_auth_members`, plus current-session identity/read-only settings and own
`pg_stat_ssl` flag. No user tables, customer rows, password/verifier catalogs,
query history, function bodies, files, environment dumps or source state changes.
The transaction ends with ROLLBACK.

Limits: 128 databases,256 roles,1024 memberships (sentinel overflow rejects),
64KiB client output, source URL8KiB, CA16KiB, password4KiB, 5s statement/1s lock/
10s idle/20s transaction timeouts, one client execution40s and five-minute job.
Transport reads have five-second socket deadlines. No automatic retries.

Catalogs alone do not establish source service/image/volume provenance, startup
file hashes, complete capture policy, writer inventory/fence, Redis emptiness,
objects, archive/recovery or migration acceptance. `custodyReady` and
`migrationAuthorized` always remain false. Source capture/vendor hashes remain
separate later requirements and do not block this preliminary catalog observation.
All retained target Core rehearsals and unknown historical effects are untouched.

## Credentials, logs, costs and cleanup

Only the final source step receives the two existing secrets as normal Actions
environment variables. The URL/password is never passed in command arguments,
Docker environment/labels, logs or artifacts. The helper sends a bounded passfile,
CA and static SQL over stdin into a read-only, capability-dropped, no-swap-limited
client container using private tmpfs files. PostgreSQL startup files are disabled.
Docker logging is disabled. The runner and Docker daemon remain trusted receivers;
compromise of either could expose the credential. Normal GitHub/provider audit and
secret-injection mechanisms remain; no promise is made to erase provider history.

The client image is the existing reviewed PostgreSQL digest:
`docker.io/library/postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280`.
It is pulled before the secret-bearing step; runtime never pulls another image or
installs dependencies. The container is force-removed on completion/failure; failed
cleanup stops rather than reporting success. Read-only sessions have finite deadlines.
If execution becomes uncertain, reconcile the exact run before any retry.

This repository is public. No raw catalog, database/role names, URL, certificate,
credential-bearing blob or environment artifact is uploaded. The public job log
contains only fixed status codes, nonsecret scope IDs, verification flags, counts,
current database OID and SHA256 hashes. Raw names/catalogs are transient in runner
memory and disappear with the client/runner; they are not a retained private full
inventory. Do not claim their absence from every provider/internal process trace.

No service, plan, purchase or capacity change. One ordinary hosted-runner job
<=5minutes plus one public client pull/two short source connections uses existing
Actions/provider billing. No customer object/archive transfer or model/API requests.
No source/target writes, writer fence, migration status/preflight/init, Redis/S3/
vault/archive access, role/grant changes, networking, DNS, deletion or deployment.

## Execution gates and proposed one-time approval

1. Publish the exact draft, pass hosted checks and independent protected review,
   then merge through normal protection. This draft is not dispatchable yet.
2. Reconcile fresh source provider/proxy evidence, exact reviewed SHA and normal
   `azure-migration-foundation` reviewer gate. Preserve its existing prevention of
   self-review and protected-branch restriction; no bypass or setting changes.
3. Obtain specific authorization to use the two existing secret values in this
   ephemeral job, disclose the runner/client exposure and the public sanitized
   receipt fields, and dispatch at most once with run_attempt1.
4. Stop on drift, missing/invalid secrets, wrong/expired CA, hostname mismatch,
   denied authentication/catalog permissions, excessive role power, bounds or
   unconfirmed cleanup. Do not weaken transport, read another secret or retry.

Proposed approval after code delivery: “May I run the reviewed Ops read-only
discovery job once using the existing protected URL and CA secrets, only against
`switchback.proxy.rlwy.net:45900`? It will require certificate and hostname
verification before one bounded read-only catalog session, then discard the client.
The ephemeral Actions runner can briefly access the credential; only nonsecret
counts/OID/hashes and status will remain in this public repository's run log.
Any mismatch stops without fallback. This creates no Railway login, grant, source
change, migration or deployment.”

Synthetic verification: run the standalone Python test file in an isolated scratch
directory with only the observer/test files. Fixtures generate a temporary dummy
localhost certificate; no real secrets, source connection, Docker or provider access.
