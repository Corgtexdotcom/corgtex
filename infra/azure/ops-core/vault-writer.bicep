targetScope = 'resourceGroup'

param vaultName string
param writerPrincipalId string

var secretsOfficerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}
resource writer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, writerPrincipalId, secretsOfficerRoleId)
  scope: vault
  properties: {
    roleDefinitionId: secretsOfficerRoleId
    principalId: writerPrincipalId
    principalType: 'ServicePrincipal'
  }
}
