targetScope = 'subscription'

@description('Exact new resource group for the isolated migration foundation.')
@minLength(10)
@maxLength(90)
param resourceGroupName string

@allowed([
  'westus3'
])
param location string = 'westus3'

@description('Short lowercase prefix used for resource names.')
@minLength(6)
@maxLength(20)
param namePrefix string

@description('PostgreSQL administrator login for the isolated restore target.')
param postgresAdministratorLogin string

@secure()
@description('PostgreSQL administrator password supplied from the protected environment.')
param postgresAdministratorPassword string

@allowed([
  '18'
])
@description('Observed Railway source major version. PostgreSQL 18 is available in westus3.')
param postgresVersion string

@description('PostgreSQL Flexible Server compute SKU name.')
param postgresSkuName string

@description('PostgreSQL Flexible Server compute tier.')
param postgresSkuTier string

@description('PostgreSQL restore-target storage in GiB.')
@minValue(64)
@maxValue(1024)
param postgresStorageGb int

@description('Comma-separated PostgreSQL extensions allowed before restore.')
param postgresAllowedExtensions string = 'vector'

@description('Explicit temporary restore-runner firewall rules. Empty by default.')
param postgresFirewallRules array = []

@description('Tags applied to migration foundation resources.')
param tags object = {
  purpose: 'railway-to-azure-migration-foundation'
  authority: 'non-authoritative-restore-target'
  managedBy: 'github-oidc'
}

resource foundationResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module observability '../modules/observability.bicep' = {
  name: 'observability'
  scope: foundationResourceGroup
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
  }
}

module identity '../modules/identity-key-vault.bicep' = {
  name: 'identity-key-vault'
  scope: foundationResourceGroup
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
  }
}

module storage '../modules/blob-storage.bicep' = {
  name: 'blob-storage'
  scope: foundationResourceGroup
  params: {
    location: location
    namePrefix: namePrefix
    managedIdentityPrincipalId: identity.outputs.managedIdentityPrincipalId
    tags: tags
  }
}

module postgres '../modules/postgresql.bicep' = {
  name: 'postgresql-restore-target'
  scope: foundationResourceGroup
  params: {
    location: location
    namePrefix: namePrefix
    administratorLogin: postgresAdministratorLogin
    administratorPassword: postgresAdministratorPassword
    postgresVersion: postgresVersion
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    storageSizeGb: postgresStorageGb
    allowedExtensions: postgresAllowedExtensions
    firewallRules: postgresFirewallRules
    tags: tags
  }
}

output foundationResourceGroupId string = foundationResourceGroup.id
output logAnalyticsId string = observability.outputs.logAnalyticsId
output applicationInsightsId string = observability.outputs.applicationInsightsId
output managedIdentityId string = identity.outputs.managedIdentityId
output keyVaultId string = identity.outputs.keyVaultId
output storageAccountId string = storage.outputs.storageAccountId
output objectContainerName string = storage.outputs.objectContainerName
output restoreContainerName string = storage.outputs.restoreContainerName
output postgresServerId string = postgres.outputs.postgresServerId
output postgresDatabaseName string = postgres.outputs.postgresDatabaseName
output postgresVersion string = postgres.outputs.postgresVersion
output postgresBackupRetentionDays int = postgres.outputs.backupRetentionDays
