targetScope = 'resourceGroup'

@sealed()
type dedicatedPostgres = {
  mode: 'dedicated'
}

@sealed()
type existingSharedPostgres = {
  mode: 'existing-shared'
  @minLength(1)
  @maxLength(90)
  resourceGroupName: string
  @minLength(3)
  @maxLength(63)
  serverName: string
}

@export()
@discriminator('mode')
type postgresHostingConfig = dedicatedPostgres | existingSharedPostgres

param postgresHosting postgresHostingConfig = { mode: 'dedicated' }
var useExistingPostgres = postgresHosting.mode == 'existing-shared'

// The scope has no subscription override: reuse is explicitly same-subscription.
resource existingPostgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' existing = if (useExistingPostgres) {
  name: postgresHosting.mode == 'existing-shared' ? postgresHosting.serverName : 'unused'
  scope: resourceGroup(postgresHosting.mode == 'existing-shared' ? postgresHosting.resourceGroupName : resourceGroup().name)
}


param location string
param namePrefix string
param tags object
param migrationOperatorPrincipalId string
param postgresAdministratorLogin string
@allowed(['Standard_D2ds_v5', 'Standard_B2s', 'Standard_B1ms'])
param opsPostgresSkuName string
@allowed(['Standard_D2ds_v5', 'Standard_B2s', 'Standard_B1ms'])
param corePostgresSkuName string
@allowed(['redis', 'postgres'])
param opsSharedStateBackend string = 'redis'
@allowed(['redis', 'postgres'])
param coreSharedStateBackend string = 'redis'

var provisionRedisDns = opsSharedStateBackend == 'redis' || coreSharedStateBackend == 'redis'
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

// One endpoint serves both distinct domain databases on the retained server.
resource sharedPostgresEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (useExistingPostgres) {
  name: 'pe-${namePrefix}-shared-pg'
  location: location
  tags: tags
  properties: {
    subnet: { id: privateEndpointsSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'postgres'
        properties: {
          privateLinkServiceId: existingPostgres!.id
          groupIds: ['postgresqlServer']
        }
      }
    ]
  }
}
resource sharedPostgresEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (useExistingPostgres) {
  parent: sharedPostgresEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'postgres', properties: { privateDnsZoneId: postgresDns.id } }
    ]
  }
}

var domainPostgres = useExistingPostgres ? {
  mode: 'existing-shared'
  resourceId: existingPostgres!.id
  resourceGroupName: postgresHosting.mode == 'existing-shared' ? postgresHosting.resourceGroupName : resourceGroup().name
  serverName: existingPostgres!.name
  host: existingPostgres!.properties.fullyQualifiedDomainName
  administratorLogin: existingPostgres!.properties.administratorLogin
  publicNetworkAccess: existingPostgres!.properties.network.publicNetworkAccess
  privateEndpointId: sharedPostgresEndpoint!.id
} : { mode: 'dedicated' }

resource redisDns 'Microsoft.Network/privateDnsZones@2020-06-01' = if (provisionRedisDns) {
  name: 'privatelink.redis.azure.net'
  location: 'global'
  tags: tags
}
resource redisDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (provisionRedisDns) {
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
    postgresBinding: domainPostgres
    postgresAdministratorLogin: postgresAdministratorLogin
    postgresAdministratorPassword: opsPostgresAdministratorPassword
    postgresSkuName: opsPostgresSkuName
    sharedStateBackend: opsSharedStateBackend
    postgresPublicNetworkAccess: opsPostgresPublicNetworkAccess
    temporaryRestoreIpv4: opsTemporaryRestoreIpv4
    privateEndpointsSubnetId: privateEndpointsSubnetId
    postgresDnsZoneId: postgresDns.id
    redisDnsZoneId: provisionRedisDns ? redisDns!.id : ''
  }
}

module coreDomain './domain.bicep' = {
  name: '${namePrefix}-core-backing'
  params: {
    location: location
    namePrefix: '${namePrefix}-core'
    tags: union(tags, { domain: 'core' })
    migrationOperatorPrincipalId: migrationOperatorPrincipalId
    postgresBinding: domainPostgres
    postgresAdministratorLogin: postgresAdministratorLogin
    postgresAdministratorPassword: corePostgresAdministratorPassword
    postgresSkuName: corePostgresSkuName
    sharedStateBackend: coreSharedStateBackend
    postgresPublicNetworkAccess: corePostgresPublicNetworkAccess
    temporaryRestoreIpv4: coreTemporaryRestoreIpv4
    privateEndpointsSubnetId: privateEndpointsSubnetId
    postgresDnsZoneId: postgresDns.id
    redisDnsZoneId: provisionRedisDns ? redisDns!.id : ''
  }
}

output platform object = {
  containerAppsEnvironmentId: containerEnvironment.id
  containerAppsEnvironmentName: containerEnvironment.name
  vnetId: vnet.id
  containerAppsSubnetId: containerAppsSubnetId
  privateEndpointsSubnetId: privateEndpointsSubnetId
  postgresPrivateDnsZoneId: postgresDns.id
  redisPrivateDnsZoneId: provisionRedisDns ? redisDns!.id : null
  logAnalyticsId: observability.outputs.logAnalyticsId
  applicationInsightsId: observability.outputs.applicationInsightsId
}
output ops object = opsDomain.outputs.resources
output core object = coreDomain.outputs.resources
