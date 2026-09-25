targetScope = 'resourceGroup'

@allowed(['westus3'])
param location string = 'westus3'

@minLength(3)
@maxLength(63)
param serverName string

@allowed(['Standard_D2ds_v5', 'Standard_B2s'])
param skuName string = 'Standard_D2ds_v5'

param administratorLogin string = 'corgtexadmin'

@secure()
param administratorPassword string

param tags object = {
  application: 'corgtex'
  purpose: 'ops-core-shared-postgres-target'
  managedBy: 'migration-operator'
}

// This creates one inactive migration target. The Ops/Core backing template
// attaches one private endpoint through its existing-shared mode.
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuName == 'Standard_D2ds_v5' ? 'GeneralPurpose' : 'Burstable'
  }
  properties: {
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    version: '18'
    createMode: 'Default'
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
    network: { publicNetworkAccess: 'Disabled' }
  }
}

output target object = {
  resourceId: postgres.id
  resourceGroupName: resourceGroup().name
  serverName: postgres.name
  host: postgres.properties.fullyQualifiedDomainName
  skuName: skuName
  storageGiB: 32
  publicNetworkAccess: postgres.properties.network.publicNetworkAccess
}
