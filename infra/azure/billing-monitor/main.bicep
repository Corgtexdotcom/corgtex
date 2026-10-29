targetScope = 'subscription'

@description('Preparation only. Dedicated billing image digest after independent image review; no tag or default.')
@minLength(64)
@maxLength(64)
param monitorImageSha256 string

@description('Explicit UTC start for the inactive export definition; does not activate or execute exports.')
param exportScheduleStartUtc string

var approvedSubscriptionId = '227eb707-bc46-415e-a09b-7d2b69fb14b2'
var productionResourceGroup = 'rg-corgtex-selfserve-production-wus3'
var storageAccountName = 'corgtexssyfi4c2fhwqzh2'
var storageAccountId = '/subscriptions/${approvedSubscriptionId}/resourceGroups/${productionResourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}'

// Subscription is explicitly bound, including when invoked from another context.
module resources 'resources.bicep' = {
  name: 'billing-monitor-preparation'
  scope: resourceGroup(approvedSubscriptionId, productionResourceGroup)
  params: {
    location: 'westus3'
    storageAccountName: storageAccountName
    environmentName: 'cae-corgtex-ss-prod'
    workspaceName: 'log-corgtex-ss-prod'
    registryServer: 'acrcorgtexssstgwus3.azurecr.io'
    monitorImageSha256: monitorImageSha256
  }
}

module exports 'exports.bicep' = {
  name: 'billing-exports-inactive-preparation'
  scope: subscription(approvedSubscriptionId)
  params: {
    location: 'westus3'
    storageAccountId: storageAccountId
    scheduleStartUtc: exportScheduleStartUtc
  }
  dependsOn: [resources]
}

output monitorIdentityResourceId string = resources.outputs.identityResourceId
// Principal IDs must be obtained and verified after any separately approved creation.
output monitorPrincipalId string = resources.outputs.principalId
output exportPrincipalIds array = exports.outputs.principalIds
output deploymentState string = 'preparation-only-no-runtime-or-grants'
