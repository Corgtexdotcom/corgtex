targetScope = 'resourceGroup'

param location string
param namePrefix string
param managedIdentityPrincipalId string
param objectContainerName string = 'objects'
param restoreContainerName string = 'migration-restore'
@minValue(1)
@maxValue(365)
param retentionDays int = 7
param tags object = {}

var compactPrefix = replace(namePrefix, '-', '')
var storageAccountName = take('ct${compactPrefix}${uniqueString(resourceGroup().id, namePrefix)}', 24)
var storageBlobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: retentionDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: retentionDays
    }
  }
}

resource objectContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: objectContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource restoreContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: restoreContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, namePrefix, storageBlobDataContributorRoleId)
  scope: storage
  properties: {
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

output storageAccountId string = storage.id
output storageAccountName string = storage.name
output objectContainerName string = objectContainer.name
output restoreContainerName string = restoreContainer.name
