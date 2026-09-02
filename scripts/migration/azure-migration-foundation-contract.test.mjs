import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Azure migration foundation static contract", () => {
  const workflow = read(".github/workflows/azure-migration-foundation.yml");
  const readme = read("infra/azure/migration-foundation/README.md");
  const entrypoint = read("infra/azure/migration-foundation/main.bicep");
  const postgres = read("infra/azure/modules/postgresql.bicep");
  const storage = read("infra/azure/modules/blob-storage.bicep");
  const whatIfValidator = read("scripts/migration/validate-azure-what-if.mjs");
  const readbackValidator = read("scripts/migration/validate-azure-foundation-readback.mjs");
  const principalValidator = read("scripts/migration/validate-azure-migration-principal.mjs");

  it("keeps the workflow manual, preview-first, OIDC-authenticated, and guarded", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("default: what-if");
    expect(workflow).toContain("id-token: write");
    expect(workflow.match(/if: github\.ref == 'refs\/heads\/main'/g)).toHaveLength(1);
    expect(workflow).toContain("environment: azure-migration-foundation");
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}");
    expect(workflow).toContain("AZURE_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}");
    expect(workflow).toContain("AZURE_SUBSCRIPTION_ID: ${{ vars.AZURE_SUBSCRIPTION_ID }}");
    expect(workflow).toContain("client-id: ${{ vars.AZURE_CLIENT_ID }}");
    expect(workflow).toContain("tenant-id: ${{ vars.AZURE_TENANT_ID }}");
    expect(workflow).toContain("subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}");
    expect(workflow).toContain("az deployment group what-if");
    expect(workflow).toContain("az deployment group create");
    expect(workflow).toContain("--result-format FullResourcePayloads");
    expect(workflow).toContain("validate-azure-what-if.mjs");
    expect(workflow).toContain("validate-azure-foundation-readback.mjs");
    expect(workflow).toContain("validate-azure-migration-principal.mjs");
    expect(workflow).toContain("principal-role-assignments.json");
    expect(workflow).toContain('--assignee-object-id "$principal_id"');
    expect(workflow).toContain("--include-groups");
    expect(workflow).toContain("--include-inherited");
    expect(workflow).toContain("--fill-principal-name false");
    expect(workflow).toContain("az group show");
    expect(workflow).toContain("az resource list");
    expect(workflow).toContain("resource-group-inventory.json");
    expect(workflow).toContain("Unexpected resource appeared in the migration resource group during deployment.");
    expect(workflow.match(/map\(ascii_downcase\) \| sort/g)).toHaveLength(3);
    expect(workflow).toContain("non-authoritative-restore-target");
    expect(workflow).toContain("SAFE_EXACT_CREATE");
    expect(workflow).toContain("deployment-binding.json");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).toContain("if: ${{ inputs.operation == 'deploy' }}");
    expect(workflow).not.toContain("az group delete");
    expect(workflow).not.toContain("railway ");
    expect(workflow).not.toContain("az containerapp");
    expect(workflow).not.toContain("managed-azure-release-production");
    expect(workflow).not.toContain("az deployment sub");
    expect(workflow).not.toContain("secrets.AZURE_CLIENT_ID");
    expect(workflow).not.toContain("secrets.AZURE_TENANT_ID");
    expect(workflow).not.toContain("secrets.AZURE_SUBSCRIPTION_ID");
  });

  it("binds preview to deploy, keeps the database secret out of argv/artifacts, and reads back exact identities", () => {
    expect(workflow).toContain("--template-digest=");
    expect(workflow).toContain("--parameters-digest=");
    expect(workflow).toContain("--target-digest=");
    expect(workflow).toContain("${RUNNER_TEMP}/azure-migration-foundation-");
    expect(workflow).toContain("trap 'shred -u -- \"$secure_parameters\"' EXIT");
    expect(workflow).toContain("az rest");
    expect(workflow).not.toContain('postgresAdministratorPassword="$POSTGRES_ADMIN_PASSWORD"');
    expect(workflow).not.toContain("POSTGRES_ADMIN_PASSWORD: ${{ secrets.AZURE_MIGRATION_POSTGRES_ADMIN_PASSWORD }}\n\n    steps:");
    expect(whatIfValidator).toContain('status: "SAFE_EXACT_CREATE"');
    expect(whatIfValidator).toContain('if (document.changes.length !== EXPECTED_CHANGE_COUNT)');
    expect(readbackValidator).toContain('status: "EXACT_CREATE_READ_BACK"');
    expect(principalValidator).toContain('status: "EXACT_MIGRATION_PRINCIPAL"');
    expect(principalValidator).toContain("707be00bd89b2c0cf1ebdf8c0d389ff24b5f69d9f2ba35a113cddf8f073296bf");
    expect(principalValidator).toContain("roleAssignments/write");
    expect(principalValidator).toContain("roleAssignments/delete");
    expect(principalValidator).toContain("document.assignments.length !== 2");
  });

  it("documents the exact protected environment variable and secret contract", () => {
    expect(readme).toContain("protected `azure-migration-foundation` environment");
    expect(readme).toContain("dedicated passwordless user-assigned");
    expect(readme).toContain("Before either `what-if` or `deploy`, configure these environment variables:");
    expect(readme).toContain("- `AZURE_CLIENT_ID`");
    expect(readme).toContain("- `AZURE_TENANT_ID`");
    expect(readme).toContain("- `AZURE_SUBSCRIPTION_ID`");
    expect(readme).toContain("Configure only the database credential as an environment secret:");
    expect(readme).toContain("- `AZURE_MIGRATION_POSTGRES_ADMIN_PASSWORD`");
    expect(readme).not.toContain("protected `managed-azure-release-production` environment");
  });

  it("creates only backing modules inside the precreated resource-group boundary", () => {
    expect(entrypoint).toContain("targetScope = 'resourceGroup'");
    expect(entrypoint).not.toContain("Microsoft.Resources/resourceGroups@2024-03-01");
    expect(entrypoint).toContain("../modules/observability.bicep");
    expect(entrypoint).toContain("../modules/identity-key-vault.bicep");
    expect(entrypoint).toContain("../modules/blob-storage.bicep");
    expect(entrypoint).toContain("../modules/postgresql.bicep");
    expect(entrypoint).not.toContain("Microsoft.App/");
    expect(entrypoint).not.toContain("existing");
  });

  it("requires PostgreSQL 18 with backups and an isolated restore database", () => {
    expect(postgres).toMatch(/@allowed\(\[\s*'18'\s*\]\)/);
    expect(postgres).toContain("createMode: 'Default'");
    expect(postgres).toContain("backupRetentionDays");
    expect(postgres).toContain("geoRedundantBackup: 'Disabled'");
    expect(postgres).toContain("${namePrefix}-restore-pg");
    expect(postgres).toContain("name: 'azure.extensions'");
    expect(entrypoint).toContain("output postgresBackupRetentionDays int = postgres.outputs.backupRetentionDays");
  });

  it("keeps object and restore containers private with recovery retention", () => {
    expect(storage).toContain("allowBlobPublicAccess: false");
    expect(storage).toContain("allowSharedKeyAccess: false");
    expect(storage).toContain("isVersioningEnabled: true");
    expect(storage).toContain("containerDeleteRetentionPolicy");
    expect(storage).toContain("restoreContainerName string = 'migration-restore'");
    expect(storage.match(/publicAccess: 'None'/g)).toHaveLength(2);
  });
});
