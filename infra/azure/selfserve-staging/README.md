# Azure self-serve staging infrastructure

This folder defines the staging Azure resource shape for the future self-serve runtime. It does not create or modify resources by itself. Run it only after the Azure subscription, startup credits, billing alerts, resource naming, and region choices are approved.

## Resource shape

- Container Apps environment with web, worker, and manual migration/seed job definitions.
- Azure Database for PostgreSQL Flexible Server and application database.
- Azure Managed Redis by default, or shared state in the existing PostgreSQL database.
- Azure Blob Storage account and private container.
- Key Vault with RBAC enabled.
- User-assigned managed identity for Container Apps.
- Log Analytics and workspace-based Application Insights.

The default deployment mode creates backing resources only:

```bash
az deployment group create \
  --resource-group <resource-group> \
  --template-file infra/azure/selfserve-staging/main.bicep \
  --parameters @infra/azure/selfserve-staging/main.parameters.example.json \
  --parameters postgresAdminPassword='<secure value>'
```

After the Key Vault exists and all required secrets are populated, redeploy with `deployContainerApps=true` to create or update the web app, worker app, and migration job.

## GitHub Actions deployment

Use the `Azure Self-Serve Staging` workflow for repeatable staging deploys. The workflow is manual-only and uses the `azure-selfserve-staging` GitHub environment so repository/environment approval rules can gate the run.

Required GitHub environment secrets:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_SELFSERVE_STAGING_POSTGRES_ADMIN_PASSWORD`
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` when building the web or migration-job image
- `AZURE_SELFSERVE_STAGING_SMOKE_EMAIL_CAPTURE_SECRET` when browser smoke is enabled

Required GitHub environment variables:

- `AZURE_SELFSERVE_STAGING_OPENAI_BASE_URL`
- `AZURE_SELFSERVE_STAGING_SMOKE_EMAIL_DOMAIN` when browser smoke is enabled

The `smoke_email_capture_allowed_domains` workflow input must include `AZURE_SELFSERVE_STAGING_SMOKE_EMAIL_DOMAIN`. The default is `selfserve-staging.corgtex.com`, which is intended only for smoke-only setup email capture and does not require public mail delivery.

The staging workflow defaults to `westus3` because the Corgtex Azure subscription returned a PostgreSQL Flexible Server offer restriction for `westus2` on June 9, 2026. Keep app, data, storage, and monitoring together in `westus3` unless Azure quota or cost review approves a different region.

The Azure identity used by GitHub OIDC needs enough permission to create the resource group resources and write role assignments for the managed identity. In practice that means `Contributor` plus `User Access Administrator` at the target scope, or `Owner` for the staging resource group/subscription scope. Key Vault uses Azure RBAC, so secret population remains a manual gate before `deployContainerApps=true`.

Suggested run order:

1. Run `operation=deploy` with `deploy_container_apps=false`, `prepare_migration_job=false`, and `shared_state_backend=redis` to create backing resources only.
2. Populate the required Key Vault secrets listed below and grant the managed identity access to the Azure OpenAI or Foundry model resource when using managed identity auth.
3. Preview the job-only deployment with `prepare_migration_job=true`, `deploy_container_apps=false`, `shared_state_backend=redis`, and `run_migration_job=false`. Then deploy with `run_migration_job=true`; this builds the immutable web image and runs the migration without updating web or worker.
4. Verify the migration and, for an existing Redis runtime, complete the writer fence described below. Preview and deploy `deploy_container_apps=true`, `prepare_migration_job=false`, `run_migration_job=false` with the explicitly accepted `shared_state_backend`. This builds the web and worker images and updates consumers after the schema is ready. Leave optional provider-secret toggles off until real staging credentials and callback URLs are registered.
5. Enable `run_health_smoke=true` and, after DNS/email/OAuth gates are ready, `run_browser_smoke=true`.

The workflow does not configure DNS or OAuth callback registrations. Keep `selfserve-staging.corgtex.com` and `selfserve.corgtex.com` as manual gates until provider credentials and DNS access are approved.

## Domain and callback readiness

Use the readiness command before enabling browser smoke, OAuth, Stripe, Resend inbound email, Slack, Intercom, or external MCP clients for the Azure self-serve runtime:

```bash
npm run smoke:azure-domain-readiness -- \
  --app-url=https://selfserve-staging.corgtex.com \
  --site-url=https://www.corgtex.com
```

For production readiness, use `--app-url=https://selfserve.corgtex.com`. Add `--strict` only after the provider credentials are populated in the target runtime; strict mode requires the OAuth, Stripe, and Resend webhook env names to be present without printing their values.

The callback/webhook URLs that must be registered with external providers are:

| Provider | Staging URL | Production URL |
| --- | --- | --- |
| Google OAuth | `https://selfserve-staging.corgtex.com/api/integrations/google/callback` | `https://selfserve.corgtex.com/api/integrations/google/callback` |
| Microsoft OAuth | `https://selfserve-staging.corgtex.com/api/integrations/microsoft/callback` | `https://selfserve.corgtex.com/api/integrations/microsoft/callback` |
| Workspace SSO | `https://selfserve-staging.corgtex.com/api/auth/sso/callback` | `https://selfserve.corgtex.com/api/auth/sso/callback` |
| Slack OAuth | `https://selfserve-staging.corgtex.com/api/integrations/slack/callback` | `https://selfserve.corgtex.com/api/integrations/slack/callback` |
| Stripe webhook | `https://selfserve-staging.corgtex.com/api/webhooks/stripe` | `https://selfserve.corgtex.com/api/webhooks/stripe` |
| Resend inbound webhook | `https://selfserve-staging.corgtex.com/api/webhooks/resend-inbound` | `https://selfserve.corgtex.com/api/webhooks/resend-inbound` |
| MCP connector | `https://selfserve-staging.corgtex.com/mcp` | `https://selfserve.corgtex.com/mcp` |

Do not remove or replace existing provider callbacks for `app.corgtex.com` during this phase. Add the Azure self-serve URLs beside the existing Railway URLs until public signup routing and rollback have both been verified.

## Required manual gates

- Confirm the Azure account is the Corgtex work account and the target subscription has approved credits, budget alert permissions, and enough quota in the selected region.
- Confirm Azure OpenAI or Foundry model availability. The app/data default is `westus3`; model deployments can be in another approved region if the base URL and deployment names are documented.
- Populate required Key Vault secrets before setting `deployContainerApps=true` or `deployMigrationJob=true`.
- Grant the managed identity access to the Azure OpenAI or Foundry model resource when using managed identity auth.
- The staging workflow resolves the single registry in the staging resource group and pushes immutable images there. Its OIDC identity reads the existing ACR admin credential through resource-group-scoped management access. The Container Apps secret remains named `ghcr-pat` for compatibility, but its Key Vault value must authenticate to the resolved ACR with the registry name as username. Verify that pull before applying a job or app image change.
- Confirm the PostgreSQL firewall decision. `allowAzureServicePostgresFirewall` defaults to `false`; enable it only after review or replace it with approved explicit firewall rules.
- Keep `postgresAllowedExtensions` set to include `vector`; the migration set uses pgvector and Azure Flexible Server rejects extension creation unless the server-level `azure.extensions` parameter allows it first.
- Keep DNS manual until the `selfserve-staging.corgtex.com` or `selfserve.corgtex.com` record is approved and configured through the DNS provider.
- Confirm the Container Apps custom domain has issued TLS before provider callback tests are run.
- Confirm `APP_URL`, `NEXT_PUBLIC_APP_URL`, `MCP_PUBLIC_URL`, and `MEETING_RECORDER_PUBLIC_BASE_URL` all describe the Azure runtime, not the Railway production app.
- Confirm `SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS` contains the staging smoke email domain before enabling browser smoke.

## Key Vault secrets

The template references these Key Vault secret names by default when `deployContainerApps=true` or `deployMigrationJob=true`:

- `ghcr-pat`
- `database-url`
- `redis-url` only when `sharedStateBackend=redis`
- `session-cookie-secret`
- `encryption-key`
- `smoke-email-capture-secret`
- `self-serve-registry-sync-secret`
- `model-price-overrides-json`
- `admin-password`

Shared self-serve staging intentionally does not receive a global `AGENT_API_KEY`.
Agents must use a per-workspace credential or OAuth so a newly created workspace
cannot inherit bootstrap access to another tenant.

These provider secrets are optional and are referenced only when their corresponding workflow input or Bicep parameter is enabled:

- `stripe-secret-key`
- `stripe-webhook-secret`
- `stripe-price-ai-usage-id`
- `resend-api-key`
- `resend-webhook-secret`
- `google-client-id`
- `google-client-secret`
- `microsoft-client-id`
- `microsoft-client-secret`

If `azureOpenAiAuthMode=api_key`, also create these model API-key secrets:

- `azure-openai-api-key`
- `azure-foundry-api-key` when `modelProvider=azure-foundry` and Azure Foundry API-key auth is selected.

Production should prefer `managed_identity`.

Keep `enable_resend_secrets=false` for smoke-only signup testing unless a real Resend staging key and inbound webhook signing secret are available. With Resend unset, the app records the smoke setup URL through `SMOKE_EMAIL_CAPTURE_SECRET` without attempting external mail delivery.

## PostgreSQL shared state

`sharedStateBackend=postgres` omits Redis provisioning and Redis secret references
for web, worker and the migration job, and sets `SHARED_STATE_BACKEND=postgres`
consistently. The template default remains `redis`. The staging workflow requires
an explicit `shared_state_backend` input of `redis` or `postgres` on every preview
and deploy; it does not infer the accepted backend from a default or repository
variable. Direct template deployments must pass the accepted backend explicitly.
Review the what-if output before applying.

This is a deployment option, not an online state-transfer mechanism. Before
switching an existing staging runtime:

1. Qualify the PostgreSQL backend and additive `20260923120000_postgres_shared_state`
   migration on staging's PostgreSQL version, including distributed auth limits,
   invalidation and transcript retries. Use bounded connection pools and retain
   the existing encryption key and `REDIS_KEY_PREFIX` namespace.
2. Fence every Redis writer, including web, worker, manual jobs and old revisions.
   Preserve/drain pending uploads and live counters; prove the exact source cache
   empty. Do not independently switch consumers while either backend has writers.
3. Preview with `prepare_migration_job=true`, `deploy_container_apps=false`,
   `shared_state_backend=redis`, and `run_migration_job=false`. Deploy the same
   settings with `run_migration_job=true` to run the prepared job. This
   updates the job before web or worker and applies the additive schema without
   switching consumers. Verify the migration, then preview and deploy
   `deploy_container_apps=true`, `prepare_migration_job=false`, and
   `shared_state_backend=postgres` under the writer fence. Verify exact image/backend identity,
   cold-wake health, shared-state behavior and the absence of Redis references.
   Keep a PostgreSQL-capable rollback image; switching back to old Redis state
   after new writes is not an acceptable rollback.
4. Only after independent acceptance, retire the exact unused Redis resource and
   verify its billing removal separately. Incremental ARM deployment does **not**
   delete an existing Redis merely because the new template omits it. Do not use
   complete-mode deployment for this retirement or discard retained recovery data.

The readiness command accepts PostgreSQL without `REDIS_URL`, rejects unknown or
mixed backend settings, and still requires database and encryption configuration.
Readiness checks configuration names; they do not prove schema, source-state
custody, database capacity or runtime acceptance. No Redis retirement or live
backend switch is performed by this source change.

## Startup contract

- The web Container App sets `CORGTEX_STARTUP_MODE=web`, so it does not mutate the database at normal startup but requires all bundled migrations to be present.
- The migration job sets `CORGTEX_STARTUP_MODE=migrate-and-seed` and should be run before smoke testing a new image.
- The migration job also receives `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `bootstrapAdminEmail` and the `admin-password` Key Vault secret so the production bootstrap seed can complete.
- The worker runs from the existing worker image and exposes `/health` on `WORKER_HEALTH_PORT`.

### Routine fleet releases

The separate `scripts/release/fleet-release-runner.mjs` Azure update path sets web
startup to `migrate-and-web`. It imports both release-tagged images, updates web,
waits for the exact new web revision/image to be ready, and then polls the public
`/api/health` for `status=ok`, `database=up`, `schema=ready` and the intended Git SHA
and image tag. Web startup applies and verifies all bundled migrations before
starting Next.js; health also checks the bundled migration ledger. Provider Ready
alone, an old healthy web release, or a stale schema cannot admit the worker update.
Only after this proof may worker secrets/image be updated and its exact revision
awaited. Normal post-deployment health, OAuth and release recording still follow.

On web failure the existing worker is untouched. This is not worker quiescence:
the old worker continues during migrations and can overlap new web traffic. Review
schema, job payload and authorization compatibility for each release; withhold new
support grants/work until all consuming workers enforce the new policy. Incompatible
changes require a separately coordinated writer fence, not an automatic scale-to-zero.
Retain previous images and use the existing serialized fleet release workflow.
No automatic rollback, revision deactivation, scale or traffic change is added;
image rollback does not reverse migrations or restore revoked credentials.

## Validation

```bash
az bicep build --file infra/azure/selfserve-staging/main.bicep
npm run smoke:azure-domain-readiness -- --app-url=https://selfserve-staging.corgtex.com --site-url=https://www.corgtex.com
```
