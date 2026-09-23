targetScope = 'resourceGroup'

param location string
param namePrefix string
param tags object
param containerNames array
param writerPrincipalId string
param migrationWriterPrincipalId string = ''
param allowUserDelegation bool = false

var storageName = 'ct${take(replace(namePrefix, '-', ''), 9)}${uniqueString(resourceGroup().id, namePrefix)}'
var contributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var delegatorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a')

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // Entra-authorized operator traffic and app user-delegation URLs use this endpoint.
    publicNetworkAccess: 'Enabled'
  }
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 14 }
    containerDeleteRetentionPolicy: { enabled: true, days: 14 }
  }
}
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for containerName in containerNames: {
  parent: blobService
  name: containerName
  properties: { publicAccess: 'None' }
}]
resource writers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (containerName, index) in containerNames: {
  name: guid(containers[index].id, writerPrincipalId, contributorRoleId)
  scope: containers[index]
  properties: {
    roleDefinitionId: contributorRoleId
    principalId: writerPrincipalId
    principalType: 'ServicePrincipal'
  }
}]
resource migrationWriters 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (containerName, index) in containerNames: if (!empty(migrationWriterPrincipalId)) {
  name: guid(containers[index].id, migrationWriterPrincipalId, contributorRoleId)
  scope: containers[index]
  properties: {
    roleDefinitionId: contributorRoleId
    principalId: migrationWriterPrincipalId
    principalType: 'ServicePrincipal'
  }
}]
// Existing packages/storage obtains a user delegation key for object download URLs.
// This account-scoped role grants delegation, not access to another container's data.
resource delegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (allowUserDelegation) {
  name: guid(storage.id, writerPrincipalId, delegatorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: delegatorRoleId
    principalId: writerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

var containerOutputs = [for (containerName, index) in containerNames: {
  name: containerName
  id: containers[index].id
}]

output resources object = {
  storageAccountId: storage.id
  storageAccountName: storage.name
  blobEndpoint: storage.properties.primaryEndpoints.blob
  containers: containerOutputs
}
