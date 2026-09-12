targetScope = 'resourceGroup'

param location string = resourceGroup().location
param siteName string
param environmentResourceId string
@description('Dedicated site identity with only AcrPull at the source registry. Never use the production push/import identity. Created separately after access approval.')
param identityResourceId string
param registryServer string
@description('64-character SHA-256 hex from the published digest receipt, verified after import into corgtex/site. Tags are not deployment references.')
@minLength(64)
@maxLength(64)
param siteImageSha256 string
@description('Runtime settings, including existing PostHog configuration. Public browser settings must also be supplied when building the image.')
param environmentVariables array = []
@description('Supply through a secure deployment parameter from the protected delivery environment, never a committed parameter file.')
@secure()
param posthogProjectToken string = ''

resource site 'Microsoft.App/containerApps@2024-03-01' = {
  name: siteName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentResourceId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [{ server: registryServer, identity: identityResourceId }]
      secrets: empty(posthogProjectToken) ? [] : [{ name: 'posthog-project-token', value: posthogProjectToken }]
    }
    template: {
      containers: [{
        name: 'site'
        image: '${registryServer}/corgtex/site@sha256:${siteImageSha256}'
        env: concat(environmentVariables, [{ name: 'PORT', value: '3000' }], empty(posthogProjectToken) ? [] : [
          { name: 'POSTHOG_PROJECT_TOKEN', secretRef: 'posthog-project-token' }
        ])
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        probes: [for probeType in ['Liveness', 'Readiness']: {
          type: probeType
          httpGet: { path: '/api/health', port: 3000, scheme: 'HTTP' }
          initialDelaySeconds: 30
          periodSeconds: 10
        }]
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }]
      }
    }
  }
}

output siteResourceId string = site.id
output candidateOrigin string = 'https://${site.properties.configuration.ingress.fqdn}'
