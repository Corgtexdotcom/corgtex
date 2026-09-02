targetScope = 'resourceGroup'

param location string
param namePrefix string
param administratorLogin string
@secure()
param administratorPassword string

@allowed([
  '18'
])
param postgresVersion string

param databaseName string = 'corgtex'
param skuName string
param skuTier string
@minValue(64)
@maxValue(1024)
param storageSizeGb int
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7
param allowedExtensions string = 'vector'
param firewallRules array = []
param tags object = {}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${namePrefix}-restore-pg'
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    version: postgresVersion
    createMode: 'Default'
    storage: {
      storageSizeGB: storageSizeGb
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgres
  name: databaseName
  properties: {}
}

resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    source: 'user-override'
    value: allowedExtensions
  }
}

resource firewallRuleResources 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = [for rule in firewallRules: {
  parent: postgres
  name: rule.name
  properties: {
    startIpAddress: rule.startIpAddress
    endIpAddress: rule.endIpAddress
  }
}]

output postgresServerId string = postgres.id
output postgresServerName string = postgres.name
output postgresServerFqdn string = postgres.properties.fullyQualifiedDomainName
output postgresDatabaseName string = database.name
output postgresVersion string = postgres.properties.version
output backupRetentionDays int = postgres.properties.backup.backupRetentionDays
