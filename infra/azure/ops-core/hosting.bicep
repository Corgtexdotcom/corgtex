targetScope = 'resourceGroup'

param location string
param namePrefix string
param tags object
param migrationOperatorPrincipalId string
param postgresAdministratorLogin string
@allowed(['Standard_D2ds_v5', 'Standard_B2s'])
param opsPostgresSkuName string
@allowed(['Standard_D2ds_v5', 'Standard_B2s'])
param corePostgresSkuName string
@secure()
param opsPostgresAdministratorPassword string
@secure()
param corePostgresAdministratorPassword string
@allowed(['Disabled', 'Enabled'])
param opsPostgresPublicNetworkAccess string
@allowed(['Disabled', 'Enabled'])
param corePostgresPublicNetworkAccess string
param opsTemporaryRestoreIpv4 string
param coreTemporaryRestoreIpv4 string
param vnetAddressPrefix string
param containerAppsSubnetPrefix string
param privateEndpointsSubnetPrefix string

module observability '../modules/observability.bicep' = {
  name: '${namePrefix}-observability'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: 'log-${namePrefix}'
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-${namePrefix}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          delegations: [
            {
              name: 'container-apps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: privateEndpointsSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

var containerAppsSubnetId = '${vnet.id}/subnets/container-apps'
var privateEndpointsSubnetId = '${vnet.id}/subnets/private-endpoints'

resource postgresDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.postgres.database.azure.com'
  location: 'global'
  tags: tags
}
resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: postgresDns
  name: namePrefix
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

resource redisDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.redis.azure.net'
  location: 'global'
  tags: tags
}
resource redisDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: redisDns
  name: namePrefix
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${namePrefix}'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: containerAppsSubnetId
      internal: false
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
  dependsOn: [observability]
}

module opsDomain './domain.bicep' = {
  name: '${namePrefix}-ops-backing'
  params: {
    location: location
    namePrefix: '${namePrefix}-ops'
    tags: union(tags, { domain: 'ops' })
    migrationOperatorPrincipalId: migrationOperatorPrincipalId
    postgresAdministratorLogin: postgresAdministratorLogin
    postgresAdministratorPassword: opsPostgresAdministratorPassword
    postgresSkuName: opsPostgresSkuName
    postgresPublicNetworkAccess: opsPostgresPublicNetworkAccess
    temporaryRestoreIpv4: opsTemporaryRestoreIpv4
    privateEndpointsSubnetId: privateEndpointsSubnetId
    postgresDnsZoneId: postgresDns.id
    redisDnsZoneId: redisDns.id
  }
}

module coreDomain './domain.bicep' = {
  name: '${namePrefix}-core-backing'
  params: {
    location: location
    namePrefix: '${namePrefix}-core'
    tags: union(tags, { domain: 'core' })
    migrationOperatorPrincipalId: migrationOperatorPrincipalId
    postgresAdministratorLogin: postgresAdministratorLogin
    postgresAdministratorPassword: corePostgresAdministratorPassword
    postgresSkuName: corePostgresSkuName
    postgresPublicNetworkAccess: corePostgresPublicNetworkAccess
    temporaryRestoreIpv4: coreTemporaryRestoreIpv4
    privateEndpointsSubnetId: privateEndpointsSubnetId
    postgresDnsZoneId: postgresDns.id
    redisDnsZoneId: redisDns.id
  }
}

output platform object = {
  containerAppsEnvironmentId: containerEnvironment.id
  containerAppsEnvironmentName: containerEnvironment.name
  vnetId: vnet.id
  containerAppsSubnetId: containerAppsSubnetId
  privateEndpointsSubnetId: privateEndpointsSubnetId
  postgresPrivateDnsZoneId: postgresDns.id
  redisPrivateDnsZoneId: redisDns.id
  logAnalyticsId: observability.outputs.logAnalyticsId
  applicationInsightsId: observability.outputs.applicationInsightsId
}
output ops object = opsDomain.outputs.resources
output core object = coreDomain.outputs.resources
