# Ops and Core backing resources

`main.bicep` is a subscription-scope deployment for new backing resources. It creates
`rg-<prefix>-hosting` and a separate `rg-<prefix>-migration-custody`. It creates no
Container Apps, app databases, app secrets, DNS cutover, ACR resources or AI services.
The existing registry is an input/output reference only; later release setup owns AcrPull.

The hosting group contains one new VNet-integrated ACA workload-profile environment
with a Consumption profile and external-ingress capability, without running apps.
Its dedicated `/27` subnet is delegated to `Microsoft.App/environments`; a separate
nondelegated `/27` subnet hosts private endpoints. Check address overlap before the
first deployment. One workspace/Application Insights pair reuses the existing module.

Each domain gets its own PG18 `Standard_D2ds_v5` General Purpose Flexible Server by
default (32 GiB, storage autogrow,
14-day backup/PITR retention, no HA), HA `Balanced_B0` Managed Redis (TLS 1.2, encrypted
port 10000, EnterpriseCluster, NoEviction), identity, runtime Key Vault and object
storage account. Both database services use private endpoints with VNet-linked DNS.
Redis public access is disabled; Redis persistence is disabled, so HA is replication,
not an archive. No `flexibleServers/databases` resource is created: full restore owns
database names and promotion. Extension allowlisting is also a restore preflight step.

## Reuse one existing PostgreSQL server

`postgresHosting` defaults to `{ mode: 'dedicated' }`, preserving two new servers.
For explicit reuse set `{ mode: 'existing-shared', resourceGroupName: '<existing-group>',
serverName: '<existing-pg18>' }`; see `existing-shared.parameters.example.json`.
The discriminated, closed parameter type requires both names and accepts no subscription
override. The reference always uses the deployment subscription.

Existing mode only reads the server. It does not create/update the server, administrator,
SKU, storage, backups, firewall rules, public access, extensions or databases. Dedicated
password parameters may be omitted; administrator login, host and public-access outputs
come from the actual server properties, not the dedicated-mode inputs. The dedicated
SKU/login/network/restore-IP inputs have no effect on the retained server. Each domain's
`temporaryRestoreFirewallName` output is null in this mode.

Hosting creates one shared PostgreSQL private endpoint and DNS zone group in its new
private-endpoint subnet. Both domain outputs bind that same endpoint/server and include
`postgresServerResourceGroupName`. Separate domain identities, runtime vaults, object
stores and migration custody remain unchanged. Select PostgreSQL shared state separately
for each domain if Redis is not wanted; server sharing does not implicitly change it.

In each retained Azure target binding, set `postgres.resourceGroupName` to the
existing server's group and bind its exact `resourceId`, `host`, `major: 18` and
hosting-owned `privateEndpointId`. Only the PostgreSQL server may use that explicit
other group; the environment, apps, Redis and endpoints remain in the hosting
group and subscription. Omitting the field preserves legacy same-group bindings
and their hashes. Reusing a server does not prove all its database writers stopped:
the inactivity guard observes only the declared domain's apps.

Before deployment/activation, independently admit the exact PG18 server, existing
public-networking/Private Link compatibility, approved endpoint, private DNS/connectivity,
restore privilege and capacity. Existing-server read access and endpoint approval authority
must already be governed; this template grants neither. The supplied names alone do not
prove any of these prerequisites. For temporary external restore access use the existing
server's serialized maintenance procedure; these templates deliberately cannot open or
close that window. The target guard must still prove public access Disabled and all
firewall rules removed before activation.

Full restore promotes separate `corgtex_ops` and `corgtex_core` databases only after
collision and OID/owner checks. Do not precreate these databases or overwrite retained
foundation databases. Use distinct domain SQL credentials and verify cross-database
isolation; separate vaults and managed identities do not grant SQL isolation automatically.
Retire or rebind rehearsal stop/firewall/cleanup authority before sharing a production
server. Per-domain release leases do not serialize server-wide maintenance, capacity,
backup recovery or stop operations. Retain capacity for all web/worker pools, the
scheduler pool plus its separate one-connection advisory lock, the scaler role
(connection limit two), deployment overlap and operator/provider reserve. Neither a
two-connection pool nor a min-zero worker proves shared-server capacity. Sharing reduces physical isolation and creates a
shared failure/maintenance scope; compilation is not live capacity or activation proof.

Incremental redeployment does not remove old dedicated servers/endpoints. This option
must not be used to imply their retirement or savings; preserve their data and recovery
obligations until separately accepted retirement.

## Demand scheduler cadence

The retained worker-demand plan defaults to a one-minute scheduler. Set
`schedulerCadenceMinutes: 5` in each domain's `workerDemand` plan only when the
five-minute latency is accepted. Plan validation accepts only `1` or `5`.
The generated job binds `*/5 * * * *` to
`WORKER_SCHEDULER_CADENCE_MINUTES=5`; the default has the existing one-minute
cron and no extra runtime setting. Activation, readback, update, pause and recovery
retain this pairing and reject cron or runtime-policy drift. Changing cadence on an
active domain requires a separately reviewed transition, not a provider-only edit.

The five-minute worker keeps current-day newspaper eligibility and carries a
scheduled occurrence across local midnight for at most 15 minutes. Its payload
cutoff and dedupe date are the scheduled occurrence, including weekly and DST
boundaries. Approval expiry is checked in up to five batches of 25 under a
30-second loop budget; a full final batch or time cap emits a backlog warning.
Source sync checks are still based on `lastSyncAt`: a nominal five-minute source
can take roughly ten minutes between starts if a sync finishes just after a tick,
plus cold start and queue time. Use the one-minute profile where this is too slow.

Azure Cost Details reported 20 vCPU-seconds and 40 GiB-seconds for one synthetic
0.5-vCPU/1-GiB scheduler run on September 24, 2026: 40 allocated seconds. The
earlier ten-second cost assumption did not hold for that run. One run does not
prove a monthly average or the whole-estate budget. Qualify representative runs,
the pending resource retirements, shared PostgreSQL and production workload
before enabling this profile or claiming savings.

Local template checks (Bicep must already be installed):

```sh
node --test infra/azure/ops-core/infra.node-test.mjs
```

## Optional PostgreSQL shared state

`opsSharedStateBackend` and `coreSharedStateBackend` accept `redis` (the unchanged default) or `postgres`, independently. A PostgreSQL domain provisions no Redis instance or Redis private endpoint; the shared Redis DNS zone is omitted when both domains choose PostgreSQL. Each domain still has its own database, identity, secrets and object store. This choice does not resize applications or change the PostgreSQL SKU automatically.

Incremental redeployment with PostgreSQL selected does not delete previously created Redis resources. Retire any existing Redis instance, endpoint and unused DNS only after an accepted state transition and recovery check; omission alone produces no saving on those existing resources.

Pin `sharedStateBackend: "postgres"` and `redis: null` into that domain's Azure binding. Runtime custody must select the same backend, omit `REDIS_URL`, and retain the encryption key and namespace. The default URL policy remains `connection_limit=5&pool_timeout=10`. An explicit `binding.postgresConnectionLimit: 2` in the runtime projection plan permits `connection_limit=2&pool_timeout=10` for inactive-target qualification; only numeric `2` or `5` is accepted, and the supplied URL must match exactly. The operator never rewrites an existing Key Vault secret. Changing an active pool requires a separate versioned configuration rollout, not this infrastructure deployment. Activation rejects mixed backend settings and requires matching web health. Deploy the compatible additive schema to the source before taking the final migration copy.

The PostgreSQL transfer variant uses schema version 2 with `sharedState: { backend: "postgres", sourceRedis: <pinned source binding> }` instead of the legacy `redis` target/job block. It preserves source writer fences and fresh source Redis emptiness checks. Target acceptance is a read-only PostgreSQL schema/state proof, not a simulated Redis receipt. PostgreSQL public restore access still closes before activation.

Before fencing, the exact source web/worker instances must prove their actual listening processes use that Redis server, logical database and credentials. The bounded Linux `/proc` probe retains only safe identity evidence; it never retains Redis URLs, passwords or credential challenges. Private/public host aliases require matching server identity. Missing runtime proof or a changed Redis run ID blocks transfer.

Retained cache/upload ciphertext inherits database-backup retention. Pending uploads expire for application access after twenty minutes; encryption does not make old backups unrecoverable. Once the backend accepts writes, use a compatible image for rollback and preserve state continuity. See the deployment configuration documentation for backup-recovery handling. Qualify the full estate cost before provisioning; omitting Redis alone does not establish affordability or workload capacity.

## Access and custody

- Each app identity has Secrets User on its own runtime vault, Blob Data Contributor
  on its own `objects` container, and Blob Delegator on that storage account. The
  latter supports the existing storage package's user-delegation download URLs.
- The supplied GitHub OIDC migration service principal has Secrets Officer on each
  runtime vault and the custody vault, and container-scoped Blob Data Contributor
  on target objects and custody containers. It receives no broad RG/subscription role.
- Custody has its own vault for retained source recovery passwords and archive
  encryption keys, and its own account with `source-objects` and `postgres-archives`.
  No domain app identity is passed into custody or granted access to it. Keep runtime
  secrets in domain vaults and source-recovery/archive secrets in the custody vault.
- All storage disables shared-key and anonymous access, requires HTTPS/TLS 1.2, and
  enables versioning and 14-day soft deletion. Vaults use RBAC and purge protection.
  Vault/Blob HTTPS endpoints remain publicly routable for authenticated GitHub
  operators and app download URLs; this does not permit anonymous or account-key
  access. Custody receives no user-delegation role.

No secrets are created, returned, or embedded in examples. In dedicated mode, supply
valid separate PostgreSQL admin passwords through protected deployment inputs. Empty
defaults only allow existing-shared mode to omit these creation-only secrets; they are
not usable dedicated-server passwords. The example uses references to
an existing bootstrap vault, which must support ARM secret references; it cannot
reference the vaults being created in the same initial deployment. These templates
do not grant ARM access to that existing vault. Do not store populated parameter files.

## Temporary PostgreSQL restore access

Defaults are public access `Disabled` and no firewall rule. Servers use public-access
networking mode plus Private Link, with no delegated PostgreSQL subnet. For the
bounded external Node/Docker restore window, set only the selected domain's
`*PostgresPublicNetworkAccess` to `Enabled` and `*TemporaryRestoreIpv4` to the actual
runner outbound IPv4. The rule has identical start/end addresses; `0.0.0.0` is
explicitly excluded because Azure interprets it as Azure-wide access.

Use the server's normal FQDN with TLS `verify-full`. Complete all external database
work, then explicitly delete the owned `temporary-migration-operator` firewall rule
and set public access back to `Disabled`. **Incremental ARM deployment does not delete
a previously created conditional rule just because the parameter is now empty.**
Require Ready state, public access Disabled, endpoint Approved, successful private
ACA connectivity and failed new external connectivity before activation. Creating
backing resources or compiling this template proves none of those live conditions.

## Local validation and handoff

```sh
az bicep build --file infra/azure/ops-core/main.bicep --stdout > /dev/null
```

The checked-in example is intentionally not deployable until its identity/resource
references are resolved. Deployment requires an independently authorized identity
with resource creation and scoped role-assignment permissions. Outputs identify the
environment, VNet/subnets/DNS, each domain's identity/vault/storage/PG/Redis endpoints,
and the separate custody resources. They contain no passwords or Redis keys.

Official schemas checked for this topology:

- [PG18 and network properties, stable 2025-08-01](https://learn.microsoft.com/en-us/azure/templates/microsoft.dbforpostgresql/2025-08-01/flexibleservers)
- [PostgreSQL public access with private endpoints](https://learn.microsoft.com/en-us/azure/postgresql/network/how-to-networking-servers-deployed-public-access-enable-public-access)
- [Managed Redis HA/public access, stable 2025-07-01](https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/2025-07-01/redisenterprise)
- [Redis database TLS/clustering/eviction](https://learn.microsoft.com/en-us/azure/templates/microsoft.cache/2025-07-01/redisenterprise/databases)
- [Redis Private Link and DNS](https://learn.microsoft.com/en-us/azure/redis/private-link)
- [Private endpoint resource schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.network/2024-05-01/privateendpoints)
- [ACA workload-profile networking](https://learn.microsoft.com/en-us/azure/container-apps/custom-virtual-networks)

The `opsPostgresSkuName` and `corePostgresSkuName` parameters select each database
independently. Both default to `Standard_D2ds_v5`; the template derives the matching
`GeneralPurpose` tier. The explicit `Standard_B1ms` (1 vCore / 2 GiB) and `Standard_B2s` (2 vCore / 4 GiB)
alternatives derive `Burstable`
and requires an accepted production support/CPU-credit tradeoff plus measured
restore/runtime capacity before use. Choosing a SKU in this template does not
establish that approval or capacity evidence.

Refresh PG18/SKU and Redis availability, quota and prices in the actual subscription
and region before provisioning. General Purpose increases the estimate relative to
the earlier B2s scenario; price the selected configuration, existing retained
resources and transition overlap together. No monthly-cost fit is implied. Measure
restore/runtime demand and recovery with the selected tier and 32-GiB storage before
production acceptance. Deployment/provisioning,
private DNS/connectivity, restore, secret transfer and runtime activation remain separate.


## Low-load qualification

For small workloads, qualify the smaller Burstable options before adding General
Purpose capacity. Retain separate Core and Ops databases and credentials. Compare
measured CPU, memory, connections, storage and restore behavior, including bursts
and permitted queued work; low web request volume alone does not size a database.
Use explicit per-process `connection_limit` values in application database URLs,
accounting for all web replicas, workers, rollout overlap and operator connections.
Reserve provider/admin headroom instead of inheriting the host CPU-based Prisma
pool size. Connection limits and extension availability must be verified on the
chosen target. B1ms has less memory, I/O and connection capacity than B2s.

Keep workers available for durable scheduling and callbacks. Deduplicated periodic
and daily schedules count only newly inserted jobs, allowing the existing idle
polling backoff to operate. Measure queue latency and CPU/network after rollout;
fewer scheduler scans are not automatically equivalent to lower billed compute.

Model app active time and idle time separately using the Azure billing conditions.
Scale-to-zero web candidates require cold-start and callback qualification. Choose
CPU/memory independently for each role in the frozen activation plan; do not impose
one allocation on every process. Historical memory peaks, startup, accepted job
concurrency and representative requests all constrain a smaller allocation.

A small SKU is a qualification option, not a production capacity guarantee or a
purchase instruction. Existing backup, recovery, private-access and independent
release requirements remain in force.
