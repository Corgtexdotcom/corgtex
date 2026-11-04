targetScope = 'resourceGroup'

param location string
param storageAccountName string
param environmentName string
param workspaceName string
param registryServer string
@minLength(64)
@maxLength(64)
param monitorImageSha256 string

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccountName }
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: account
  name: 'default'
}
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for name in ['billing-exports', 'billing-ledger']: {
  parent: blobs
  name: name
  properties: { publicAccess: 'None' }
}]
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = { name: workspaceName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-corgtex-billing-monitor-prod'
  location: location
}
resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-corgtex-billing-monitor-prod'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryServer, identity: identity.id }]
    }
    template: {
      containers: [{
        name: 'billing-monitor'
        image: '${registryServer}/corgtex/billing-monitor@sha256:${monitorImageSha256}'
        // This deliberately exits. An approved future wrapper must replace it.
        // No export IO, ledger writes, dispatch, health-sweep or credential loading.
        command: ['python3', '-c']
        args: ['raise SystemExit("Billing monitor runtime is not activated")']
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
      }]
    }
  }
}

var summaryQuery = '''
ContainerAppConsoleLogs_CL
| where ContainerJobName_s == "caj-corgtex-billing-monitor-prod"
| extend event = parse_json(Log_s)
| where event.event == "corgtex.billing.summary" and toint(event.schemaVersion) == 1
| extend committed = todatetime(event.committedAt), commitSequence = tolong(event.commitSequence)
| where isnotnull(committed) and committed <= now() and commitSequence > 0
'''
var heartbeatQuery = concat('let lastCommit = toscalar(\n', summaryQuery, '''
| summarize arg_max(commitSequence, *)
| project committed);
let latestFailure = toscalar(ContainerAppSystemLogs_CL
| where JobName_s == "caj-corgtex-billing-monitor-prod"
| where Reason_s in ("JobExecutionFailed", "BackoffLimitExceeded", "DeadlineExceeded")
| where isnull(lastCommit) or TimeGenerated > lastCommit
| summarize max(TimeGenerated));
print alert = iff(isnull(lastCommit) or lastCommit < ago(36h) or isnotnull(latestFailure), 1, 0)
| where alert == 1
''')
var staleQuery = concat(summaryQuery, '''
| summarize arg_max(commitSequence, *)
| where committed >= ago(36h)
| where tostring(event.dataStatus) != "ready_for_provisional_evaluation" or toint(event.unknownCount) > 0
''')
var policyQuery = concat(summaryQuery, '''
| summarize arg_max(commitSequence, *)
| where committed >= ago(36h) and toint(event.belowThresholdCount) > 0
''')
var rules = [
  { name: 'corgtex-billing-monitor-heartbeat-missing', query: heartbeatQuery }
  { name: 'corgtex-billing-monitor-data-stale', query: staleQuery }
  { name: 'corgtex-billing-monitor-policy-alert', query: policyQuery }
]
resource alerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [for rule in rules: {
  name: rule.name
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: rule.name
    description: 'Preparation only; summary/KQL and destination acceptance required before enabling.'
    enabled: false
    severity: 2
    evaluationFrequency: 'PT15M'
    windowSize: 'P2D'
    scopes: [workspace.id]
    skipQueryValidation: false
    autoMitigate: true
    criteria: {
      allOf: [{
        query: rule.query
        timeAggregation: 'Count'
        operator: 'GreaterThan'
        threshold: 0
        failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
      }]
    }
    actions: { actionGroups: [] }
  }
}]
output identityResourceId string = identity.id
output principalId string = identity.properties.principalId
output jobResourceId string = job.id
