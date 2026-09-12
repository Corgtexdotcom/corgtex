targetScope = 'resourceGroup'

param location string = resourceGroup().location
param identityName string
param registryResourceGroup string
param registryName string

// Access preparation only. Deploy separately after explicit identity/role approval.
resource siteIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

module registryPull './registry-pull.bicep' = {
  name: '${identityName}-acr-pull'
  scope: resourceGroup(registryResourceGroup)
  params: {
    registryName: registryName
    principalId: siteIdentity.properties.principalId
  }
}

output siteIdentityResourceId string = siteIdentity.id
output sitePrincipalId string = siteIdentity.properties.principalId
output pullRoleAssignmentId string = registryPull.outputs.roleAssignmentId
