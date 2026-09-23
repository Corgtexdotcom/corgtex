targetScope = 'resourceGroup'

param location string
param namePrefix string
param tags object
param migrationOperatorPrincipalId string
param postgresAdministratorLogin string
@allowed(['Standard_D2ds_v5', 'Standard_B2s'])
param postgresSkuName string
@secure()
param postgresAdministratorPassword string
@allowed(['Disabled', 'Enabled'])
param postgresPublicNetworkAccess string = 'Disabled'
@maxLength(15)
param temporaryRestoreIpv4 string = ''
param privateEndpointsSubnetId string
param postgresDnsZoneId string
param redisDnsZoneId string

module identity '../modules/identity-key-vault.bicep' = {
  name: '${namePrefix}-identity'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
  }
}

module objects './blob-store.bicep' = {
  name: '${namePrefix}-objects'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    containerNames: ['objects']
    writerPrincipalId: identity.outputs.managedIdentityPrincipalId
    migrationWriterPrincipalId: migrationOperatorPrincipalId
    allowUserDelegation: true
  }
}

module runtimeSecretsWriter './vault-writer.bicep' = {
  name: '${namePrefix}-runtime-secrets-writer'
  params: {
    vaultName: last(split(identity.outputs.keyVaultId, '/'))
    writerPrincipalId: migrationOperatorPrincipalId
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: '${namePrefix}-pg'
  location: location
  tags: tags
  sku: {
    name: postgresSkuName
    tier: postgresSkuName == 'Standard_B2s' ? 'Burstable' : 'GeneralPurpose'
  }
  properties: {
    administratorLogin: postgresAdministratorLogin
    administratorLoginPassword: postgresAdministratorPassword
    version: '18'
    createMode: 'Default'
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
    // No delegatedSubnetResourceId: Private Link permits an exact-IP restore window.
    network: { publicNetworkAccess: postgresPublicNetworkAccess }
  }
}

// 0.0.0.0 is Azure-wide access, not a single-client rule. Never create it.
resource restoreFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = if (postgresPublicNetworkAccess == 'Enabled' && !empty(temporaryRestoreIpv4) && temporaryRestoreIpv4 != '0.0.0.0') {
  parent: postgres
  name: 'temporary-migration-operator'
  properties: {
    startIpAddress: temporaryRestoreIpv4
    endIpAddress: temporaryRestoreIpv4
  }
}

resource postgresEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${namePrefix}-pg'
  location: location
  tags: tags
  properties: {
    subnet: { id: privateEndpointsSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'postgres'
        properties: {
          privateLinkServiceId: postgres.id
          groupIds: ['postgresqlServer']
        }
      }
    ]
  }
}
resource postgresEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: postgresEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'postgres', properties: { privateDnsZoneId: postgresDnsZoneId } }
    ]
  }
}

resource redis 'Microsoft.Cache/redisEnterprise@2025-07-01' = {
  name: '${namePrefix}-redis'
  location: location
  tags: tags
  sku: { name: 'Balanced_B0' }
  properties: {
    minimumTlsVersion: '1.2'
    highAvailability: 'Enabled'
    publicNetworkAccess: 'Disabled'
  }
}
resource redisDatabase 'Microsoft.Cache/redisEnterprise/databases@2025-07-01' = {
  parent: redis
  name: 'default'
  properties: {
    accessKeysAuthentication: 'Enabled'
    clientProtocol: 'Encrypted'
    clusteringPolicy: 'EnterpriseCluster'
    evictionPolicy: 'NoEviction'
    modules: []
    persistence: { aofEnabled: false, rdbEnabled: false }
    port: 10000
  }
}
resource redisEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${namePrefix}-redis'
  location: location
  tags: tags
  properties: {
    subnet: { id: privateEndpointsSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'redis'
        properties: {
          privateLinkServiceId: redis.id
          groupIds: ['redisEnterprise']
        }
      }
    ]
  }
  dependsOn: [redisDatabase]
}
resource redisEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: redisEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'redis', properties: { privateDnsZoneId: redisDnsZoneId } }
    ]
  }
}

output resources object = {
  managedIdentityId: identity.outputs.managedIdentityId
  managedIdentityClientId: identity.outputs.managedIdentityClientId
  managedIdentityPrincipalId: identity.outputs.managedIdentityPrincipalId
  runtimeKeyVaultId: identity.outputs.keyVaultId
  runtimeKeyVaultUri: identity.outputs.keyVaultUri
  objectStorage: objects.outputs.resources
  postgresServerId: postgres.id
  postgresServerName: postgres.name
  postgresHost: postgres.properties.fullyQualifiedDomainName
  postgresPort: 5432
  postgresAdministratorLogin: postgresAdministratorLogin
  postgresPrivateEndpointId: postgresEndpoint.id
  postgresPublicNetworkAccess: postgresPublicNetworkAccess
  temporaryRestoreFirewallName: 'temporary-migration-operator'
  redisId: redis.id
  redisDatabaseId: redisDatabase.id
  redisHost: redis.properties.hostName
  redisPort: redisDatabase.properties.port
  redisPrivateEndpointId: redisEndpoint.id
}
