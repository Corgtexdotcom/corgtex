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

## Required manual gates

- Confirm the Azure account is the Corgtex work account and the target subscription has approved credits, budget alert permissions, and enough quota in the selected region.
- Confirm Azure OpenAI or Foundry model availability. The app/data default is `westus2`; model deployments can be in another approved region if the base URL and deployment names are documented.
- Populate Key Vault secrets before setting `deployContainerApps=true`.
- Grant the managed identity access to the Azure OpenAI or Foundry model resource when using managed identity auth.
- Confirm GHCR image access. The Key Vault secret named `ghcr-pat` must contain a package-read token for `ghcr.io/corgtexdotcom/corgtex`.
- Confirm the PostgreSQL firewall decision. `allowAzureServicePostgresFirewall` defaults to `false`; enable it only after review or replace it with approved explicit firewall rules.
- Keep DNS manual until the `selfserve-staging.corgtex.com` or `selfserve.corgtex.com` record is approved and configured through the DNS provider.

## Key Vault secrets

The template references these Key Vault secret names by default:

- `ghcr-pat`
- `database-url`
- `redis-url`
- `session-cookie-secret`
- `encryption-key`
- `agent-api-key`
- `smoke-email-capture-secret`
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
```
