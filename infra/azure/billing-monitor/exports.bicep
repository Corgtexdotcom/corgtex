targetScope = 'subscription'

param location string
param storageAccountId string
param scheduleStartUtc string

var definitions = [
  { name: 'corgtex-actualcost-mtd', timeframe: 'MonthToDate', folder: 'mtd' }
  { name: 'corgtex-actualcost-prior-month', timeframe: 'TheLastMonth', folder: 'prior-month' }
]

// No role assignments, provider registration, execution, or active schedule.
// Provider-managed identity/grant side effects need separate review before apply.
resource exports 'Microsoft.CostManagement/exports@2025-03-01' = [for definition in definitions: {
  name: definition.name
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    format: 'Csv'
    compressionMode: 'none'
    partitionData: true
    dataOverwriteBehavior: 'OverwritePreviousReport'
    definition: {
      type: 'ActualCost'
      timeframe: definition.timeframe
      dataSet: {
        granularity: 'Daily'
        configuration: { dataVersion: '2023-05-01' }
      }
    }
    deliveryInfo: {
      destination: {
        type: 'AzureBlob'
        resourceId: storageAccountId
        container: 'billing-exports'
        rootFolderPath: definition.folder
      }
    }
    schedule: {
      status: 'Inactive'
      recurrence: 'Daily'
      recurrencePeriod: { from: scheduleStartUtc }
    }
  }
}]

output principalIds array = [for (definition, index) in definitions: {
  name: definition.name
  principalId: exports[index].identity.principalId
}]
