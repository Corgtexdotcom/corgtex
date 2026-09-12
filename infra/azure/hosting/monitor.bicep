targetScope = 'resourceGroup'

param location string = resourceGroup().location
param jobName string
param environmentResourceId string
param identityResourceId string
param registryServer string
@description('64-character SHA-256 hex from the published digest receipt, verified after import into corgtex/ops-monitor. Tags are not deployment references.')
@minLength(64)
@maxLength(64)
param monitorImageSha256 string
@description('Copy the source target array without changing names or URLs: incident deduplication depends on them.')
@minLength(1)
param healthTargets array

// Preparation only: no schedule, credentials, network probes, or issue writes.
resource monitor 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityResourceId}': {} }
  }
  properties: {
    environmentId: environmentResourceId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryServer, identity: identityResourceId }]
    }
    template: {
      containers: [{
        name: 'ops-monitor'
        image: '${registryServer}/corgtex/ops-monitor@sha256:${monitorImageSha256}'
        command: ['node', '/app/scripts/ops/health-sweep.mjs']
        args: ['--dry-run']
        env: [
          { name: 'OPS_HEALTH_TARGETS_JSON', value: string(healthTargets) }
          { name: 'OPS_CREATE_GITHUB_ISSUES', value: 'false' }
        ]
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
      }]
    }
  }
}

output monitorResourceId string = monitor.id
