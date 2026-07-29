targetScope = 'resourceGroup'

@description('Azure region for the self-serve app, data, and monitoring resources.')
param location string = 'westus3'

@description('Short lowercase prefix used for Azure resource names.')
param namePrefix string = 'corgtex-ss-stg'

@description('When false, creates backing resources only. Set true after required Key Vault secrets are populated.')
param deployContainerApps bool = false

@description('Public app origin for the Azure self-serve runtime.')
param appUrl string = 'https://selfserve-staging.corgtex.com'

@description('Marketing site origin allowed by cross-app flows.')
param siteUrl string = 'https://www.corgtex.com'

@description('Control-plane origin for read-only links and later registry sync.')
param controlPlaneUrl string = 'https://ops.corgtex.com'

@description('GHCR web image tagged by immutable Git SHA.')
param webImage string

@description('GHCR worker image tagged by immutable Git SHA.')
param workerImage string

@description('Release version surfaced by /api/health.')
param releaseVersion string = 'development'

@description('Release image tag surfaced by /api/health.')
param releaseImageTag string = ''

@description('Release git SHA surfaced by /api/health.')
param releaseGitSha string = ''

@description('GitHub Container Registry server.')
param registryServer string = 'ghcr.io'

@description('GitHub Container Registry username for the PAT stored in Key Vault.')
param registryUsername string = 'corgtex-deploy'

@description('Azure OpenAI-compatible v1 base URL. For Foundry keyless auth, use https://<resource>.services.ai.azure.com/openai/v1.')
param azureOpenAiBaseUrl string

@allowed([
  'azure-openai'
  'azure-foundry'
])
@description('Model provider label for usage routing. Use azure-foundry only for Direct from Azure Foundry deployments.')
param modelProvider string = 'azure-openai'

@allowed([
  'api_key'
  'managed_identity'
])
@description('Azure OpenAI authentication mode. Production should use managed_identity.')
param azureOpenAiAuthMode string = 'managed_identity'

@description('Azure OpenAI deployment name for low-latency chat calls.')
param azureChatFastDeploymentName string = 'corgtex-chat-fast'

@description('Azure OpenAI deployment name for standard chat calls.')
param azureChatStandardDeploymentName string = 'corgtex-chat-standard'

@description('Azure OpenAI deployment name for quality chat calls.')
param azureChatQualityDeploymentName string = 'corgtex-chat-quality'

@description('Azure OpenAI deployment name for excellent chat calls.')
param azureChatExcellentDeploymentName string = 'corgtex-chat-excellent'

@description('Azure OpenAI deployment name for conversation chat calls.')
param azureChatConversationDeploymentName string = 'corgtex-chat-conversation'

@description('Azure OpenAI deployment name for embeddings.')
param azureEmbeddingDeploymentName string = 'corgtex-embedding'

@description('PostgreSQL administrator login name.')
param postgresAdminLogin string = 'corgtexadmin'

@secure()
@description('PostgreSQL administrator password. Pass at deployment time; do not store it in source control.')
param postgresAdminPassword string

@description('PostgreSQL Flexible Server version.')
param postgresVersion string = '16'

@description('PostgreSQL Flexible Server SKU.')
param postgresSkuName string = 'Standard_B1ms'

@description('PostgreSQL Flexible Server tier.')
param postgresSkuTier string = 'Burstable'

@description('PostgreSQL storage in GiB.')
param postgresStorageGb int = 32

@description('PostgreSQL backup retention in days.')
param postgresBackupRetentionDays int = 7

@description('Comma-separated PostgreSQL extensions allowed on the Flexible Server before migrations run.')
param postgresAllowedExtensions string = 'vector'

@description('Creates the Azure-services PostgreSQL firewall rule. Keep false until reviewed for the target environment.')
param allowAzureServicePostgresFirewall bool = false

@description('Additional PostgreSQL firewall rules: [{ "name": "...", "startIpAddress": "...", "endIpAddress": "..." }].')
param postgresFirewallRules array = []

@description('Azure Managed Redis SKU name. Balanced_B0 is the smallest staging default.')
param managedRedisSkuName string = 'Balanced_B0'

@description('Azure Managed Redis database TLS port.')
param managedRedisPort int = 10000

@description('Include Stripe Key Vault secret refs and runtime env vars.')
param enableStripeSecrets bool = false

@description('Include Resend Key Vault secret refs and runtime env vars.')
param enableResendSecrets bool = false

@description('Include Google OAuth Key Vault secret refs and runtime env vars.')
param enableGoogleOauthSecrets bool = false

@description('Include Microsoft OAuth Key Vault secret refs and runtime env vars.')
param enableMicrosoftOauthSecrets bool = false

@description('Email sender used by self-serve signup and setup flows.')
param emailFrom string = 'Corgtex <notifications@auth.corgtex.com>'

@description('Reply-to address for operational signup emails.')
param emailReplyTo string = 'support@corgtex.com'

@description('Notification email for procurement/self-serve events.')
param procurementNotifyEmail string = 'support@corgtex.com'

@description('Worker poll interval in milliseconds.')
param workerPollIntervalMs string = '2000'

@description('Worker maximum poll interval in milliseconds.')
param workerMaxPollIntervalMs string = '30000'

@description('Worker event batch size.')
param workerEventBatchSize string = '25'

@description('Worker job batch size.')
param workerJobBatchSize string = '25'

@description('Worker health endpoint port.')
param workerHealthPort string = '9090'

@description('Worker shutdown timeout in milliseconds.')
param workerShutdownTimeoutMs string = '15000'

@description('Key Vault secret name containing the GHCR PAT.')
param ghcrPatSecretName string = 'ghcr-pat'

@description('Key Vault secret name containing DATABASE_URL.')
param databaseUrlSecretName string = 'database-url'

@description('Key Vault secret name containing REDIS_URL.')
param redisUrlSecretName string = 'redis-url'

@description('Key Vault secret name containing SESSION_COOKIE_SECRET.')
param sessionCookieSecretName string = 'session-cookie-secret'

@description('Key Vault secret name containing ENCRYPTION_KEY.')
param encryptionKeySecretName string = 'encryption-key'

@description('Key Vault secret name containing AGENT_API_KEY.')
param agentApiKeySecretName string = 'agent-api-key'

@description('Key Vault secret name containing SMOKE_EMAIL_CAPTURE_SECRET.')
param smokeEmailCaptureSecretName string = 'smoke-email-capture-secret'

@description('Comma-separated email domains allowed to use smoke-only setup email capture.')
param smokeEmailCaptureAllowedDomains string = 'selfserve-staging.corgtex.com'

@description('Key Vault secret name containing SELF_SERVE_REGISTRY_SYNC_SECRET.')
param selfServeRegistrySyncSecretName string = 'self-serve-registry-sync-secret'

@description('Key Vault secret name containing MODEL_PRICE_OVERRIDES_JSON.')
param modelPriceOverridesSecretName string = 'model-price-overrides-json'

@description('Bootstrap admin email used by the migration/seed job.')
param bootstrapAdminEmail string = 'admin+selfserve-staging@corgtex.com'

@description('Key Vault secret name containing ADMIN_PASSWORD for the migration/seed job.')
param bootstrapAdminPasswordSecretName string = 'admin-password'

@description('Key Vault secret name containing AZURE_OPENAI_API_KEY when azureOpenAiAuthMode is api_key.')
param azureOpenAiApiKeySecretName string = 'azure-openai-api-key'

@description('Key Vault secret name containing STRIPE_SECRET_KEY.')
param stripeSecretKeySecretName string = 'stripe-secret-key'

@description('Key Vault secret name containing STRIPE_WEBHOOK_SECRET.')
param stripeWebhookSecretName string = 'stripe-webhook-secret'

@description('Key Vault secret name containing STRIPE_PRICE_AI_USAGE_ID.')
param stripePriceAiUsageSecretName string = 'stripe-price-ai-usage-id'

@description('Key Vault secret name containing RESEND_API_KEY.')
param resendApiKeySecretName string = 'resend-api-key'

@description('Key Vault secret name containing RESEND_WEBHOOK_SECRET.')
param resendWebhookSecretName string = 'resend-webhook-secret'

@description('Key Vault secret name containing GOOGLE_CLIENT_ID.')
param googleClientIdSecretName string = 'google-client-id'

@description('Key Vault secret name containing GOOGLE_CLIENT_SECRET.')
param googleClientSecretName string = 'google-client-secret'

@description('Key Vault secret name containing MICROSOFT_CLIENT_ID.')
param microsoftClientIdSecretName string = 'microsoft-client-id'

@description('Key Vault secret name containing MICROSOFT_CLIENT_SECRET.')
param microsoftClientSecretName string = 'microsoft-client-secret'

var compactPrefix = replace(namePrefix, '-', '')
var logAnalyticsWorkspaceName = 'log-${namePrefix}'
var appInsightsName = 'appi-${namePrefix}'
var managedIdentityName = 'id-${namePrefix}'
var keyVaultName = 'kv-${take(namePrefix, 16)}-${take(uniqueString(resourceGroup().id), 4)}'
var storageAccountName = take('corgtexss${uniqueString(resourceGroup().id, namePrefix)}', 24)
var storageContainerName = 'selfserve-artifacts'
var postgresServerName = '${namePrefix}-pg'
var postgresDatabaseName = 'corgtex'
var redisName = '${namePrefix}-redis'
var containerEnvironmentName = 'cae-${namePrefix}'
var webContainerAppName = 'ca-${namePrefix}-web'
var workerContainerAppName = 'ca-${namePrefix}-worker'
var migrationJobName = 'caj-${namePrefix}-migrate'
var storageBlobDataContributorRoleId = join([
  'ba92f5b4'
  '2d11'
  '453d'
  'a403'
  'e96b0029c9fe'
], '-')
var keyVaultSecretsUserRoleId = join([
  '4633458b'
  '17de'
  '408a'
  'b874'
  '0445c86b69e6'
], '-')
var keyVaultSecretUriPrefix = '${keyVault.properties.vaultUri}secrets/'

var requiredSecretRefs = [
  { name: 'database-url', keyVaultSecretName: databaseUrlSecretName }
  { name: 'redis-url', keyVaultSecretName: redisUrlSecretName }
  { name: 'session-cookie-secret', keyVaultSecretName: sessionCookieSecretName }
  { name: 'encryption-key', keyVaultSecretName: encryptionKeySecretName }
  { name: 'agent-api-key', keyVaultSecretName: agentApiKeySecretName }
  { name: 'smoke-email-capture-secret', keyVaultSecretName: smokeEmailCaptureSecretName }
  { name: 'self-serve-registry-sync-secret', keyVaultSecretName: selfServeRegistrySyncSecretName }
  { name: 'model-price-overrides-json', keyVaultSecretName: modelPriceOverridesSecretName }
]
var azureOpenAiApiKeyRef = azureOpenAiAuthMode == 'api_key' ? [
  { name: 'azure-openai-api-key', keyVaultSecretName: azureOpenAiApiKeySecretName }
] : []
var stripeSecretRefs = enableStripeSecrets ? [
  { name: 'stripe-secret-key', keyVaultSecretName: stripeSecretKeySecretName }
  { name: 'stripe-webhook-secret', keyVaultSecretName: stripeWebhookSecretName }
  { name: 'stripe-price-ai-usage-id', keyVaultSecretName: stripePriceAiUsageSecretName }
] : []
var resendSecretRefs = enableResendSecrets ? [
  { name: 'resend-api-key', keyVaultSecretName: resendApiKeySecretName }
  { name: 'resend-webhook-secret', keyVaultSecretName: resendWebhookSecretName }
] : []
var googleOauthSecretRefs = enableGoogleOauthSecrets ? [
  { name: 'google-client-id', keyVaultSecretName: googleClientIdSecretName }
  { name: 'google-client-secret', keyVaultSecretName: googleClientSecretName }
] : []
var microsoftOauthSecretRefs = enableMicrosoftOauthSecrets ? [
  { name: 'microsoft-client-id', keyVaultSecretName: microsoftClientIdSecretName }
  { name: 'microsoft-client-secret', keyVaultSecretName: microsoftClientSecretName }
] : []
var containerSecretRefs = concat([
  { name: 'ghcr-pat', keyVaultSecretName: ghcrPatSecretName }
], requiredSecretRefs, azureOpenAiApiKeyRef, stripeSecretRefs, resendSecretRefs, googleOauthSecretRefs, microsoftOauthSecretRefs)
var migrationSecretRefs = concat(containerSecretRefs, [
  { name: 'admin-password', keyVaultSecretName: bootstrapAdminPasswordSecretName }
])

var stripeRuntimeEnv = enableStripeSecrets ? [
  { name: 'STRIPE_SECRET_KEY', secretRef: 'stripe-secret-key' }
  { name: 'STRIPE_WEBHOOK_SECRET', secretRef: 'stripe-webhook-secret' }
  { name: 'STRIPE_PRICE_AI_USAGE_ID', secretRef: 'stripe-price-ai-usage-id' }
] : []
var resendRuntimeEnv = enableResendSecrets ? [
  { name: 'RESEND_API_KEY', secretRef: 'resend-api-key' }
  { name: 'RESEND_WEBHOOK_SECRET', secretRef: 'resend-webhook-secret' }
] : []
var googleOauthRuntimeEnv = enableGoogleOauthSecrets ? [
  { name: 'GOOGLE_CLIENT_ID', secretRef: 'google-client-id' }
  { name: 'GOOGLE_CLIENT_SECRET', secretRef: 'google-client-secret' }
] : []
var microsoftOauthRuntimeEnv = enableMicrosoftOauthSecrets ? [
  { name: 'MICROSOFT_CLIENT_ID', secretRef: 'microsoft-client-id' }
  { name: 'MICROSOFT_CLIENT_SECRET', secretRef: 'microsoft-client-secret' }
] : []

var commonRuntimeEnv = concat([
  { name: 'NODE_ENV', value: 'production' }
  { name: 'NEXT_TELEMETRY_DISABLED', value: '1' }
  { name: 'APP_URL', value: appUrl }
  { name: 'NEXT_PUBLIC_APP_URL', value: appUrl }
  { name: 'NEXT_PUBLIC_SITE_URL', value: siteUrl }
  { name: 'CONTROL_PLANE_URL', value: controlPlaneUrl }
  { name: 'MCP_PUBLIC_URL', value: '${appUrl}/mcp' }
  { name: 'MEETING_RECORDER_PUBLIC_BASE_URL', value: appUrl }
  { name: 'CORGTEX_RELEASE_VERSION', value: releaseVersion }
  { name: 'CORGTEX_RELEASE_IMAGE_TAG', value: releaseImageTag }
  { name: 'CORGTEX_RELEASE_GIT_SHA', value: releaseGitSha }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'REDIS_URL', secretRef: 'redis-url' }
  { name: 'REDIS_KEY_PREFIX', value: compactPrefix }
  { name: 'SESSION_COOKIE_SECRET', secretRef: 'session-cookie-secret' }
  { name: 'ENCRYPTION_KEY', secretRef: 'encryption-key' }
  { name: 'AGENT_API_KEY', secretRef: 'agent-api-key' }
  { name: 'SMOKE_EMAIL_CAPTURE_SECRET', secretRef: 'smoke-email-capture-secret' }
  { name: 'SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS', value: smokeEmailCaptureAllowedDomains }
  { name: 'SELF_SERVE_REGISTRY_SYNC_SECRET', secretRef: 'self-serve-registry-sync-secret' }
  { name: 'STORAGE_PROVIDER', value: 'azure_blob' }
  { name: 'AZURE_STORAGE_AUTH_MODE', value: 'managed_identity' }
  { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storage.name }
  { name: 'AZURE_STORAGE_CONTAINER_NAME', value: storageContainerName }
  { name: 'AZURE_STORAGE_BLOB_ENDPOINT', value: storage.properties.primaryEndpoints.blob }
  { name: 'AZURE_CLIENT_ID', value: managedIdentity.properties.clientId }
  { name: 'AZURE_STORAGE_CLIENT_ID', value: managedIdentity.properties.clientId }
  { name: 'MODEL_PROVIDER', value: modelProvider }
  { name: 'MODEL_BASE_URL', value: azureOpenAiBaseUrl }
  { name: 'AZURE_OPENAI_AUTH_MODE', value: azureOpenAiAuthMode }
  { name: 'AZURE_OPENAI_SCOPE', value: modelProvider == 'azure-foundry' ? 'https://ai.azure.com/.default' : 'https://cognitiveservices.azure.com/.default' }
  { name: 'MODEL_CHAT_DEFAULT', value: azureChatStandardDeploymentName }
  { name: 'MODEL_CHAT_FAST', value: azureChatFastDeploymentName }
  { name: 'MODEL_CHAT_STANDARD', value: azureChatStandardDeploymentName }
  { name: 'MODEL_CHAT_QUALITY', value: azureChatQualityDeploymentName }
  { name: 'MODEL_CHAT_EXCELLENT', value: azureChatExcellentDeploymentName }
  { name: 'MODEL_CHAT_CONVERSATION', value: azureChatConversationDeploymentName }
  { name: 'MODEL_EMBEDDING_DEFAULT', value: azureEmbeddingDeploymentName }
  { name: 'MODEL_PRICE_OVERRIDES_JSON', secretRef: 'model-price-overrides-json' }
  { name: 'EMAIL_FROM', value: emailFrom }
  { name: 'EMAIL_REPLY_TO', value: emailReplyTo }
  { name: 'PROCUREMENT_NOTIFY_EMAIL', value: procurementNotifyEmail }
  { name: 'WORKER_POLL_INTERVAL_MS', value: workerPollIntervalMs }
  { name: 'WORKER_MAX_POLL_INTERVAL_MS', value: workerMaxPollIntervalMs }
  { name: 'WORKER_EVENT_BATCH_SIZE', value: workerEventBatchSize }
  { name: 'WORKER_JOB_BATCH_SIZE', value: workerJobBatchSize }
  { name: 'WORKER_HEALTH_PORT', value: workerHealthPort }
  { name: 'WORKER_SHUTDOWN_TIMEOUT_MS', value: workerShutdownTimeoutMs }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: applicationInsights.properties.ConnectionString }
], azureOpenAiAuthMode == 'api_key' ? [
  { name: 'AZURE_OPENAI_API_KEY', secretRef: 'azure-openai-api-key' }
] : [], stripeRuntimeEnv, resendRuntimeEnv, googleOauthRuntimeEnv, microsoftOauthRuntimeEnv)

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: managedIdentityName
  location: location
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    sku: {
      family: 'A'
      name: 'standard'
    }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource storageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: storageContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: postgresServerName
  location: location
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    version: postgresVersion
    storage: {
      storageSizeGB: postgresStorageGb
    }
    backup: {
      backupRetentionDays: postgresBackupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    authConfig: {
      passwordAuth: 'Enabled'
      activeDirectoryAuth: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgres
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource postgresAllowedExtensionsConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: postgresAllowedExtensions
    source: 'user-override'
  }
}

resource postgresAzureServicesFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = if (allowAzureServicePostgresFirewall) {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource postgresFirewallRuleResources 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = [for rule in postgresFirewallRules: {
  parent: postgres
  name: rule.name
  properties: {
    startIpAddress: rule.startIpAddress
    endIpAddress: rule.endIpAddress
  }
}]

resource redis 'Microsoft.Cache/redisEnterprise@2026-02-01-preview' = {
  name: redisName
  location: location
  sku: {
    name: managedRedisSkuName
  }
  identity: {
    type: 'None'
  }
  properties: {
    minimumTlsVersion: '1.2'
    highAvailability: 'Disabled'
    publicNetworkAccess: 'Enabled'
  }
}

resource redisDatabase 'Microsoft.Cache/redisEnterprise/databases@2026-02-01-preview' = {
  parent: redis
  name: 'default'
  properties: {
    accessKeysAuthentication: 'Enabled'
    clientProtocol: 'Encrypted'
    clusteringPolicy: 'OSSCluster'
    evictionPolicy: 'VolatileLRU'
    modules: []
    persistence: {
      aofEnabled: false
      rdbEnabled: false
    }
    port: managedRedisPort
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, managedIdentity.id, storageBlobDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource keyVaultSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, managedIdentity.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource webApp 'Microsoft.App/containerApps@2024-03-01' = if (deployContainerApps) {
  name: webContainerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'ghcr-pat'
        }
      ]
      secrets: [for secretRef in containerSecretRefs: {
        name: secretRef.name
        keyVaultUrl: '${keyVaultSecretUriPrefix}${secretRef.keyVaultSecretName}'
        identity: managedIdentity.id
      }]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          env: concat(commonRuntimeEnv, [
            { name: 'PORT', value: '3000' }
            { name: 'CORGTEX_STARTUP_MODE', value: 'web' }
          ])
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 60
              periodSeconds: 30
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    keyVaultSecretsRole
    storageBlobRole
  ]
}

resource workerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployContainerApps) {
  name: workerContainerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: int(workerHealthPort)
        transport: 'auto'
      }
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'ghcr-pat'
        }
      ]
      secrets: [for secretRef in containerSecretRefs: {
        name: secretRef.name
        keyVaultUrl: '${keyVaultSecretUriPrefix}${secretRef.keyVaultSecretName}'
        identity: managedIdentity.id
      }]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: workerImage
          env: commonRuntimeEnv
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: int(workerHealthPort)
                scheme: 'HTTP'
              }
              initialDelaySeconds: 60
              periodSeconds: 30
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    keyVaultSecretsRole
    storageBlobRole
  ]
}

resource migrationJob 'Microsoft.App/jobs@2024-03-01' = if (deployContainerApps) {
  name: migrationJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'ghcr-pat'
        }
      ]
      secrets: [for secretRef in migrationSecretRefs: {
        name: secretRef.name
        keyVaultUrl: '${keyVaultSecretUriPrefix}${secretRef.keyVaultSecretName}'
        identity: managedIdentity.id
      }]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: webImage
          env: concat(commonRuntimeEnv, [
            { name: 'CORGTEX_STARTUP_MODE', value: 'migrate-and-seed' }
            { name: 'ADMIN_EMAIL', value: bootstrapAdminEmail }
            { name: 'ADMIN_PASSWORD', secretRef: 'admin-password' }
          ])
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    keyVaultSecretsRole
    postgresAllowedExtensionsConfig
    storageBlobRole
  ]
}

output keyVaultUri string = keyVault.properties.vaultUri
output managedIdentityClientId string = managedIdentity.properties.clientId
output storageAccount string = storage.name
output storageContainer string = storageContainer.name
output postgresServerFqdn string = postgres.properties.fullyQualifiedDomainName
output redisHostName string = redis.properties.hostName
output redisPort int = managedRedisPort
output containerAppsEnvironment string = containerEnvironment.name
output webAppName string = deployContainerApps ? webApp.name : ''
output workerAppName string = deployContainerApps ? workerApp.name : ''
output migrationJobNameOut string = deployContainerApps ? migrationJob.name : ''
