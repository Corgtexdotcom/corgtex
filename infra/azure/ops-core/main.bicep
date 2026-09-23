targetScope = 'subscription'

@allowed(['westus3'])
param location string = 'westus3'

@minLength(6)
@maxLength(16)
@description('New lowercase deployment prefix; do not reuse a selfserve or rehearsal prefix.')
param namePrefix string

@description('Existing ACR resource ID. This template does not change the registry or assign registry roles.')
param existingAcrResourceId string

@description('Object ID of the GitHub OIDC migration service principal, never a domain app identity.')
param migrationOperatorPrincipalId string

param postgresAdministratorLogin string = 'corgtexadmin'
@allowed(['Standard_D2ds_v5', 'Standard_B2s', 'Standard_B1ms'])
@description('General Purpose by default. B1ms/B2s require an explicitly accepted Burstable production exception and measured capacity.')
param opsPostgresSkuName string = 'Standard_D2ds_v5'
@allowed(['Standard_D2ds_v5', 'Standard_B2s', 'Standard_B1ms'])
@description('General Purpose by default. B1ms/B2s require an explicitly accepted Burstable production exception and measured capacity.')
param corePostgresSkuName string = 'Standard_D2ds_v5'
@secure()
param opsPostgresAdministratorPassword string
@secure()
param corePostgresAdministratorPassword string

@allowed(['Disabled', 'Enabled'])
param opsPostgresPublicNetworkAccess string = 'Disabled'
@allowed(['Disabled', 'Enabled'])
param corePostgresPublicNetworkAccess string = 'Disabled'

@description('Temporary operator outbound IPv4 only. Empty creates no rule; 0.0.0.0 is never allowed.')
@maxLength(15)
param opsTemporaryRestoreIpv4 string = ''
@description('Temporary operator outbound IPv4 only. Empty creates no rule; 0.0.0.0 is never allowed.')
@maxLength(15)
param coreTemporaryRestoreIpv4 string = ''

@description('Select a new nonoverlapping private range before the first deployment.')
param vnetAddressPrefix string = '10.84.0.0/24'
param containerAppsSubnetPrefix string = '10.84.0.0/27'
param privateEndpointsSubnetPrefix string = '10.84.0.32/27'

param tags object = {
  application: 'corgtex'
  managedBy: 'github-oidc'
  purpose: 'ops-core-backing-resources'
}

resource hostingGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${namePrefix}-hosting'
  location: location
  tags: tags
}

resource custodyGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${namePrefix}-migration-custody'
  location: location
  tags: union(tags, { purpose: 'migration-custody' })
}

module hosting './hosting.bicep' = {
  name: '${namePrefix}-backing-resources'
  scope: hostingGroup
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    migrationOperatorPrincipalId: migrationOperatorPrincipalId
    postgresAdministratorLogin: postgresAdministratorLogin
    opsPostgresSkuName: opsPostgresSkuName
    corePostgresSkuName: corePostgresSkuName
    opsPostgresAdministratorPassword: opsPostgresAdministratorPassword
    corePostgresAdministratorPassword: corePostgresAdministratorPassword
    opsPostgresPublicNetworkAccess: opsPostgresPublicNetworkAccess
    corePostgresPublicNetworkAccess: corePostgresPublicNetworkAccess
    opsTemporaryRestoreIpv4: opsTemporaryRestoreIpv4
    coreTemporaryRestoreIpv4: coreTemporaryRestoreIpv4
    vnetAddressPrefix: vnetAddressPrefix
    containerAppsSubnetPrefix: containerAppsSubnetPrefix
    privateEndpointsSubnetPrefix: privateEndpointsSubnetPrefix
  }
}

module custody './custody.bicep' = {
  name: '${namePrefix}-migration-custody'
  scope: custodyGroup
  params: {
    location: location
    namePrefix: namePrefix
    migrationOperatorPrincipalId: migrationOperatorPrincipalId
    tags: union(tags, { purpose: 'migration-custody' })
  }
}

output hostingResourceGroupId string = hostingGroup.id
output custodyResourceGroupId string = custodyGroup.id
output existingAcrId string = existingAcrResourceId
output platform object = hosting.outputs.platform
output ops object = hosting.outputs.ops
output core object = hosting.outputs.core
output migrationCustody object = custody.outputs.resources
