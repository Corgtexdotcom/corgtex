# Azure self-serve staging infrastructure

This folder defines the staging Azure resource shape for the future self-serve runtime. It does not create or modify resources by itself. Run it only after the Azure subscription, startup credits, billing alerts, resource naming, and region choices are approved.

## Resource shape

- Container Apps environment with web, worker, and manual migration/seed job definitions.
- Azure Database for PostgreSQL Flexible Server and application database.
- Azure Cache for Redis.
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
- `AZURE_SELFSERVE_STAGING_SMOKE_EMAIL_CAPTURE_SECRET` when browser smoke is enabled

Required GitHub environment variables:

- `AZURE_SELFSERVE_STAGING_OPENAI_BASE_URL`
- `AZURE_SELFSERVE_STAGING_SMOKE_EMAIL_DOMAIN` when browser smoke is enabled

The Azure identity used by GitHub OIDC needs enough permission to create the resource group resources and write role assignments for the managed identity. In practice that means `Contributor` plus `User Access Administrator` at the target scope, or `Owner` for the staging resource group/subscription scope. Key Vault uses Azure RBAC, so secret population remains a manual gate before `deployContainerApps=true`.

Suggested run order:

1. Run `operation=deploy` with `deployContainerApps=false` to create backing resources only.
2. Populate the Key Vault secrets listed below and grant the managed identity access to the Azure OpenAI or Foundry model resource when using managed identity auth.
3. Run `operation=deploy` with `deployContainerApps=true` to build and push GHCR images tagged `sha-<git-sha>`, then create or update the web app, worker, and migration job.
4. Enable `run_migration_job=true` for the first app deploy of a new image.
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
- Confirm Azure OpenAI or Foundry model availability. The app/data default is `westus2`; model deployments can be in another approved region if the base URL and deployment names are documented.
- Populate Key Vault secrets before setting `deployContainerApps=true`.
- Grant the managed identity access to the Azure OpenAI or Foundry model resource when using managed identity auth.
- Confirm GHCR image access. The Key Vault secret named `ghcr-pat` must contain a package-read token for `ghcr.io/corgtexdotcom/corgtex`.
- Confirm the PostgreSQL firewall decision. `allowAzureServicePostgresFirewall` defaults to `false`; enable it only after review or replace it with approved explicit firewall rules.
- Keep DNS manual until the `selfserve-staging.corgtex.com` or `selfserve.corgtex.com` record is approved and configured through the DNS provider.
- Confirm the Container Apps custom domain has issued TLS before provider callback tests are run.
- Confirm `APP_URL`, `NEXT_PUBLIC_APP_URL`, `MCP_PUBLIC_URL`, and `MEETING_RECORDER_PUBLIC_BASE_URL` all describe the Azure runtime, not the Railway production app.

## Key Vault secrets

The template references these Key Vault secret names by default:

- `ghcr-pat`
- `database-url`
- `redis-url`
- `session-cookie-secret`
- `encryption-key`
- `agent-api-key`
- `smoke-email-capture-secret`
- `self-serve-registry-sync-secret`
- `model-price-overrides-json`
- `stripe-secret-key`
- `stripe-webhook-secret`
- `stripe-price-ai-usage-id`
- `resend-api-key`
- `google-client-id`
- `google-client-secret`
- `microsoft-client-id`
- `microsoft-client-secret`

If `azureOpenAiAuthMode=api_key`, also create `azure-openai-api-key`. Production should prefer `managed_identity`.

## Startup contract

- The web Container App sets `CORGTEX_STARTUP_MODE=web`, so it does not mutate the database at normal startup.
- The migration job sets `CORGTEX_STARTUP_MODE=migrate-and-seed` and should be run before smoke testing a new image.
- The worker runs from the existing worker image and exposes `/health` on `WORKER_HEALTH_PORT`.

## Validation

```bash
az bicep build --file infra/azure/selfserve-staging/main.bicep
npm run smoke:azure-domain-readiness -- --app-url=https://selfserve-staging.corgtex.com --site-url=https://www.corgtex.com
```
