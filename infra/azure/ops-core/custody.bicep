targetScope = 'resourceGroup'

param location string
param namePrefix string
param migrationOperatorPrincipalId string
param tags object

module archiveStore './blob-store.bicep' = {
  name: '${namePrefix}-custody-storage'
  params: {
    location: location
    namePrefix: '${namePrefix}-custody'
    tags: tags
    containerNames: ['source-objects', 'postgres-archives']
    writerPrincipalId: migrationOperatorPrincipalId
    allowUserDelegation: false
  }
}

var vaultName = 'kv-${take(replace(namePrefix, '-', ''), 9)}-cust-${take(uniqueString(resourceGroup().id), 5)}'
var secretsOfficerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}
resource custodySecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, migrationOperatorPrincipalId, secretsOfficerRoleId)
  scope: vault
  properties: {
    roleDefinitionId: secretsOfficerRoleId
    principalId: migrationOperatorPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output resources object = {
  keyVaultId: vault.id
  keyVaultUri: vault.properties.vaultUri
  storage: archiveStore.outputs.resources
  migrationOperatorPrincipalId: migrationOperatorPrincipalId
}
