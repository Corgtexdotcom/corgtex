import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  approveReviewGatedProcurementTrial,
  configureControlPlaneMeetingRecorderIntegration,
  createControlPlaneClient,
  createControlPlaneCustomerMember,
  createSelfServeSupportSession,
  deployLatestControlPlaneRelease,
  enqueueControlPlaneFleetSnapshots,
  enqueueControlPlaneDeployLatestRollout,
  executeControlPlaneClientMigration,
  finalizeControlPlaneClientMigration,
  fetchCustomerSupportSnapshot,
  freezeControlPlaneManagedReleaseInventory,
  reconcileControlPlaneManagedAzureTarget,
  enqueueControlPlaneAgendaPreparation,
  getControlPlaneClientMigrationStatus,
  getControlPlaneDeployLatestPreflight,
  getControlPlaneAiGovernanceStatus,
  getControlPlaneContextHealth,
  getControlPlaneDeployment,
  getControlPlaneIntegrationStatus,
  getControlPlaneMeetingOperationsReadiness,
  getControlPlaneManagedReleaseBootstrapTarget,
  getControlPlaneManagedReleaseInventory,
  getControlPlaneSlackSetupTarget,
  getControlPlaneProviderStatus,
  getControlPlaneReleaseStatus,
  listControlPlaneCustomerSummaries,
  listControlPlaneCustomerMembers,
  listControlPlaneFeatureFlags,
  listControlPlaneReleaseRolloutJobs,
  listSelfServeCustomerRegistry,
  probeControlPlaneDeploymentHealth,
  recordCustomerSupportAudit,
  recordVerifiedControlPlaneRelease,
  rejectReviewGatedProcurementTrial,
  requireControlPlaneAccess,
  requireControlPlaneScope,
  refreshControlPlaneFleetSnapshots,
  rollbackControlPlaneClientMigration,
  revokeControlPlaneAgentCredential,
  resendControlPlaneCustomerMemberAccessLink,
  runControlPlaneClientMigrationDryRun,
  runControlPlaneContextOperation,
  runControlPlaneMeetingRecorderOperation,
  runControlPlaneManagedReleaseLeaseOperation,
  runControlPlanePostDeployProbe,
  runControlPlaneReleaseOperation,
  runCustomerSupportOperation,
  readControlPlaneManagedReleaseAuth,
  planControlPlaneClientMigration,
  setControlPlaneFeatureFlag,
  validateControlPlaneRailwayReleaseExecutor,
  upsertSelfServeSmokeRun,
  updateControlPlaneAgentCredentialScopes,
  updateControlPlaneAgentPolicy,
  updateControlPlaneCustomerMemberStatus,
  updateControlPlaneModelBudget,
} from "@corgtex/domain";
import type { SupportAction } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { env } from "@corgtex/shared";

export const dynamic = "force-dynamic";

const tools = [
  {
    name: "list_customers",
    description: "List customer deployments registered in the Corgtex control plane.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        health: { type: "string" },
        support: { type: "string" },
        limit: { type: "number" },
        includeAllDeployments: { type: "boolean" },
        uncapped: { type: "boolean" },
      },
    },
  },
  {
    name: "list_self_serve_customers",
    description: "List Corgtex Cloud self-serve trials, billing state, onboarding state, latest smoke result, setup-email capture status, and support-session status.",
    inputSchema: {
      type: "object",
      properties: {
        take: { type: "number" },
        status: { type: "string" },
      },
    },
  },
  {
    name: "record_self_serve_smoke_run",
    description: "Record browser/API self-serve smoke evidence for a trial, workspace, or customer deployment.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        runKind: { type: "string" },
        status: { type: "string" },
        deploymentId: { type: "string" },
        workspaceId: { type: "string" },
        procurementTrialId: { type: "string" },
        baseUrl: { type: "string" },
        siteUrl: { type: "string" },
        summary: { type: "object" },
        artifacts: { type: "object" },
        error: { type: "string" },
        startedAt: { type: "string" },
        completedAt: { type: "string" },
      },
      required: ["runId", "status"],
    },
  },
  {
    name: "create_self_serve_support_session",
    description: "Create an audited one-time support login for a shared-cloud self-serve workspace.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        workspaceId: { type: "string" },
        targetMemberId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
  {
    name: "approve_self_serve_trial_request",
    description: "Approve a review-gated self-serve signup request and provision the shared-cloud trial workspace.",
    inputSchema: {
      type: "object",
      properties: {
        trialId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["trialId", "reason"],
    },
  },
  {
    name: "reject_self_serve_trial_request",
    description: "Reject a review-gated self-serve signup request by marking it suspended with a reason.",
    inputSchema: {
      type: "object",
      properties: {
        trialId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["trialId", "reason"],
    },
  },
  {
    name: "create_client",
    description: "Create a new managed client as a shared workspace or hosted dedicated Railway deployment. Hosted dedicated deployments always start non-primary until verified readiness or migration cutover.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string" },
        label: { type: "string" },
        customerSlug: { type: "string" },
        reason: { type: "string" },
        supportOwnerEmail: { type: "string" },
        description: { type: "string" },
        featurePosture: { type: "string" },
        primary: { type: "boolean", description: "Shared workspace only. Hosted dedicated client creation rejects primary=true." },
        initialAdmins: { type: "array", items: { type: "object" } },
        region: { type: "string" },
        dataResidency: { type: "string" },
        customDomain: { type: "string" },
        releaseVersion: { type: "string" },
        releaseImageTag: { type: "string" },
        webImage: { type: "string" },
        workerImage: { type: "string" },
        webSource: { type: "object" },
        workerSource: { type: "object" },
        storageBucketName: { type: "string" },
        bootstrapBundleUri: { type: "string" },
        bootstrapBundleChecksum: { type: "string" },
        bootstrapBundleSchemaVersion: { type: "string" },
      },
      required: ["mode", "label", "customerSlug", "reason"],
    },
  },
  {
    name: "plan_client_migration",
    description: "Create a dry-run migration plan between shared workspace and hosted dedicated lanes.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDeploymentId: { type: "string" },
        targetMode: { type: "string" },
        destinationDeploymentId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["sourceDeploymentId", "targetMode", "reason"],
    },
  },
  {
    name: "run_client_migration_dry_run",
    description: "Validate migration inventory, feature parity, secret prerequisites, active-write safety, and ID maps.",
    inputSchema: {
      type: "object",
      properties: {
        migrationRunId: { type: "string" },
        sourceDeploymentId: { type: "string" },
        targetMode: { type: "string" },
        destinationDeploymentId: { type: "string" },
        writesQuiesced: { type: "boolean" },
        acceptRequiresReauth: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
  {
    name: "execute_client_migration",
    description: "Mark an approved migration executed after stored control-plane migration-worker verification exists.",
    inputSchema: {
      type: "object",
      properties: {
        migrationRunId: { type: "string" },
        destinationDeploymentId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["migrationRunId", "reason"],
    },
  },
  {
    name: "get_client_migration_status",
    description: "Return sanitized migration progress, verification results, and ID-map count.",
    inputSchema: { type: "object", properties: { migrationRunId: { type: "string" } }, required: ["migrationRunId"] },
  },
  {
    name: "finalize_client_migration",
    description: "Mark the destination primary and source archived after final verification.",
    inputSchema: {
      type: "object",
      properties: { migrationRunId: { type: "string" }, reason: { type: "string" } },
      required: ["migrationRunId", "reason"],
    },
  },
  {
    name: "rollback_client_migration",
    description: "Restore primary routing to the retained source before a migration is finalized.",
    inputSchema: {
      type: "object",
      properties: { migrationRunId: { type: "string" }, reason: { type: "string" } },
      required: ["migrationRunId", "reason"],
    },
  },
  {
    name: "get_customer_deployment_status",
    description: "Get one customer deployment, recent support operations, and customer-deployment events.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "get_azure_provider_status",
    description: "Get the read-only Azure deployment adapter status: health, release, logs link, latest smoke, registry sync, and cost summary.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "refresh_customer_deployment_snapshot",
    description: "Fetch a live support snapshot from the customer deployment through the support connector.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "list_customer_integrations",
    description: "Get customer integration entitlement and readiness status.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "get_customer_integration_setup_link",
    description: "Generate a human OAuth setup link for a customer integration. Does not complete browser OAuth. V1 supports slack.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        integrationKey: { type: "string" },
      },
      required: ["deploymentId", "integrationKey"],
    },
  },
  {
    name: "get_context_health",
    description: "Get governed context and brain health for a customer deployment.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "get_ai_governance_status",
    description: "Get agent, model usage, approval, and failed-job governance status.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "update_customer_agent_credential_scopes",
    description: "Update scopes for a customer agent credential through the audited Control Plane path.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        credentialId: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
      },
      required: ["deploymentId", "credentialId", "scopes", "reason"],
    },
  },
  {
    name: "revoke_customer_agent_credential",
    description: "Revoke a customer agent credential through the audited Control Plane path.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        credentialId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "credentialId", "reason"],
    },
  },
  {
    name: "update_customer_model_budget",
    description: "Update the customer workspace model budget through the audited Control Plane path.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        monthlyCostCapUsd: { type: "number" },
        alertThresholdPct: { type: "number" },
        periodStartDay: { type: "number" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "monthlyCostCapUsd", "reason"],
    },
  },
  {
    name: "update_customer_agent_policy",
    description: "Update an agent governance policy or model override through the audited Control Plane path.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        agentKey: { type: "string" },
        governancePolicy: { type: "string" },
        modelOverride: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "agentKey", "reason"],
    },
  },
  {
    name: "get_release_status",
    description: "Get release, provisioning, health, and rollback-readiness status.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "get_deploy_latest_preflight",
    description: "Check whether one customer can deploy the configured latest release target.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "validate_railway_release_executor",
    description: "Read-only check that the configured Railway executor can access the recorded project, environment, web service, and worker service.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "list_customer_members",
    description: "List all active and inactive members for a customer deployment.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "create_customer_member",
    description: "Create a customer member and email a setup link. Does not expose or set raw passwords.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        email: { type: "string" },
        displayName: { type: "string" },
        role: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "email", "role", "reason"],
    },
  },
  {
    name: "resend_customer_member_access_link",
    description: "Email a fresh setup/reset access link for a customer member.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        memberId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "memberId", "reason"],
    },
  },
  {
    name: "update_customer_member_status",
    description: "Deactivate or reactivate a customer member.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        memberId: { type: "string" },
        isActive: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "memberId", "isActive", "reason"],
    },
  },
  {
    name: "list_customer_feature_flags",
    description: "List customer workspace feature flags, defaults, sources, and audit context.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "set_customer_feature_flag",
    description: "Enable or disable a customer workspace feature flag. Finance config writes require an exact-state identity.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        flag: { type: "string" },
        enabled: { type: "boolean" },
        config: { type: "object" },
        reportImportsEnabled: { type: "boolean" },
        expectedConfigIdentity: { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] },
        reason: { type: "string" },
      },
      required: ["deploymentId", "flag", "reason"],
    },
  },
  {
    name: "configure_customer_integration",
    description: "Configure an audited customer integration entitlement. V1 supports meeting_recorders.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        integrationKey: { type: "string" },
        reason: { type: "string" },
        entitlementEnabled: { type: "boolean" },
        enabled: { type: "boolean" },
        autoRecordEnabled: { type: "boolean" },
        defaultProvider: { type: "string" },
        fallbackProvider: { type: "string" },
        monthlyMinuteCap: { type: "number" },
        botName: { type: "string" },
        entryMessage: { type: "string" },
      },
      required: ["deploymentId", "integrationKey", "reason", "entitlementEnabled", "enabled", "autoRecordEnabled"],
    },
  },
  {
    name: "run_meeting_recorder_operation",
    description: "Run an audited meeting recorder rollout operation: enqueue calendar sync, dry-run scan, live smoke, or enable auto-recording after a completed smoke.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        operation: { type: "string" },
        reason: { type: "string" },
        meetingUrl: { type: "string" },
        joinAt: { type: "string" },
        provider: { type: "string" },
      },
      required: ["deploymentId", "operation", "reason"],
    },
  },
  {
    name: "check_meeting_operations_readiness",
    description: "Read agenda and recorder readiness for a managed customer without exposing raw meeting content or credentials.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
      },
      required: ["deploymentId"],
    },
  },
  {
    name: "enqueue_agenda_preparation",
    description: "Queue the deterministic regular-call agenda scan for a managed customer/date window.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        targetDateISO: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "reason"],
    },
  },
  {
    name: "run_context_sync",
    description: "Queue an audited context sync for all active sources or one source.",
    inputSchema: {
      type: "object",
      properties: { deploymentId: { type: "string" }, sourceId: { type: "string" }, reason: { type: "string" } },
      required: ["deploymentId", "reason"],
    },
  },
  {
    name: "probe_customer_deployment_health",
    description: "Probe customer runtime health and record central release/health evidence.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" }, reason: { type: "string" } }, required: ["deploymentId", "reason"] },
  },
  {
    name: "record_verified_release",
    description: "Reconcile control-plane release metadata after probing a verified live customer release.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        releaseImageTag: { type: "string" },
        releaseVersion: { type: "string" },
        reason: { type: "string" },
        managedAzureTarget: { type: "object" },
      },
      required: ["deploymentId", "releaseImageTag", "reason"],
    },
  },
  {
    name: "refresh_fleet_snapshots",
    description: "Refresh cached fleet snapshots for one customer deployment without relying on list-page fanout.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        snapshotKinds: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
      },
      required: ["deploymentId", "reason"],
    },
  },
  {
    name: "run_post_deploy_probe",
    description: "Run sanitized customer-read and recorder-readiness probes after a release health check.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        releaseImageTag: { type: "string" },
        releaseVersion: { type: "string" },
        reason: { type: "string" },
        requireRemoteSupportAudit: { type: "boolean" },
      },
      required: ["deploymentId", "reason"],
    },
  },
  {
    name: "enqueue_fleet_snapshot_jobs",
    description: "Queue bounded background fleet snapshot jobs for one deployment or the next due batch.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        snapshotKinds: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
  {
    name: "reconcile_managed_azure_target",
    description: "Inspect or reconcile existing deployment metadata against protected provider evidence. Preserves stable identity, credentials, lifecycle status and release selection.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { deploymentId: { type: "string" }, execute: { type: "boolean" }, reason: { type: "string" },
        expectedMetadataDigest: { type: "string" }, expectedTargetDigest: { type: "string" } },
      required: ["deploymentId", "execute", "reason"],
    },
  },
  {
    name: "read_managed_release_auth",
    description: "Read authenticated client release readiness or one exact diagnostic receipt without creating an Ops operation.",
    inputSchema: { type: "object", additionalProperties: false, properties: { deploymentId: { type: "string" }, mode: { type: "string" },
      operationId: { type: "string" }, expectedGitSha: { type: "string" } }, required: ["deploymentId", "mode"] },
  },
  {
    name: "dispatch_managed_release_diagnostic",
    description: "Dispatch one idempotent authenticated web and worker release diagnostic under release authority.",
    inputSchema: { type: "object", additionalProperties: false, properties: { deploymentId: { type: "string" },
      operationId: { type: "string" }, expectedGitSha: { type: "string" }, reason: { type: "string" },
      retryAttempt: { type: "number", enum: [1] } },
      required: ["deploymentId", "operationId", "expectedGitSha", "reason"] },
  },
  {
    name: "freeze_managed_release_inventory",
    description: "Create one private immutable managed-Azure exact-target inventory asset for a deployment and workload class.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        workloadClass: { type: "string" },
        acrName: { type: "string" },
        acrServer: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "workloadClass", "acrName", "acrServer", "reason"],
    },
  },
  {
    name: "get_managed_release_bootstrap_target",
    description: "Resolve the trusted managed-Azure target for baseline bootstrap without requiring existing release metadata.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        workloadClass: { type: "string" },
        acrName: { type: "string" },
        acrServer: { type: "string" },
      },
      required: ["deploymentId", "workloadClass", "acrName", "acrServer"],
    },
  },
  {
    name: "get_managed_release_inventory",
    description: "Load one private immutable P0-05 inventory artifact and bind its selected workload-class target to one deployment.",
    inputSchema: {
      type: "object",
      properties: {
        inventoryRef: { type: "string" },
        expectedSha256: { type: "string" },
        deploymentId: { type: "string" },
        workloadClass: { type: "string" },
        acrName: { type: "string" },
        acrServer: { type: "string" },
      },
      required: ["inventoryRef", "expectedSha256", "deploymentId", "workloadClass", "acrName", "acrServer"],
    },
  },
  {
    name: "managed_release_lease",
    description: "Run one exact fenced managed-Azure release lease transition.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string" },
        deploymentId: { type: "string" },
        workloadClass: { type: "string" },
        leaseId: { type: "string" },
        capability: { type: "string" },
        fence: { type: "number" },
        expectedLeaseId: { type: "string" },
        expectedFence: { type: "number" },
        expectedImageTag: { type: "string" },
        expectedTargetDigest: { type: "string" },
        incomingImageTag: { type: "string" },
        incomingVersion: { type: "string" },
        owner: { type: "string" },
        acrName: { type: "string" },
        acrServer: { type: "string" },
        rollback: { type: "object" },
        stage: { type: "string" },
        code: { type: "string" },
        reason: { type: "string" },
      },
      required: ["operation"],
    },
  },
  {
    name: "prepare_release_upgrade",
    description: "Record audited target release readiness evidence without deploying.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        targetReleaseImageTag: { type: "string" },
        targetReleaseVersion: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "targetReleaseImageTag", "reason"],
    },
  },
  {
    name: "deploy_latest_release",
    description: "Deploy the configured latest release to one customer after preflight checks.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        reason: { type: "string" },
        force: { type: "boolean" },
      },
      required: ["deploymentId", "reason"],
    },
  },
  {
    name: "deploy_latest_release_bulk",
    description: "Queue deploy-latest rollout jobs for selected or eligible customer deployments.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentIds: { type: "array", items: { type: "string" } },
        allEligible: { type: "boolean" },
        includeUnhealthy: { type: "boolean" },
        reason: { type: "string" },
        limit: { type: "number" },
      },
      required: ["reason"],
    },
  },
  {
    name: "get_rollout_status",
    description: "List recent deploy-latest rollout jobs and statuses.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        take: { type: "number" },
      },
    },
  },
  {
    name: "run_customer_support_operation",
    description: "Run an audited support action against a customer deployment.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        action: { type: "string" },
        reason: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["deploymentId", "action"],
    },
  },
  {
    name: "record_customer_support_audit",
    description: "Record a standalone sanitized customer support closeout audit through the configured support connector.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        action: { type: "string" },
        reason: { type: "string" },
        summary: { type: "string" },
        outcome: { type: "string" },
        evidence: { type: "object" },
        remoteWorkspaceId: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: ["deploymentId", "action", "reason", "summary"],
    },
  },
];

const toolScopes: Record<string, string> = {
  list_customers: "control-plane:read",
  list_self_serve_customers: "control-plane:read",
  record_self_serve_smoke_run: "control-plane:support:write",
  create_self_serve_support_session: "control-plane:support:write",
  approve_self_serve_trial_request: "control-plane:clients:write",
  reject_self_serve_trial_request: "control-plane:clients:write",
  create_client: "control-plane:clients:write",
  plan_client_migration: "control-plane:migrations:write",
  run_client_migration_dry_run: "control-plane:migrations:write",
  execute_client_migration: "control-plane:migrations:write",
  get_client_migration_status: "control-plane:read",
  finalize_client_migration: "control-plane:migrations:write",
  rollback_client_migration: "control-plane:migrations:write",
  get_customer_deployment_status: "control-plane:read",
  get_azure_provider_status: "control-plane:read",
  list_customer_integrations: "control-plane:read",
  get_customer_integration_setup_link: "control-plane:integrations:write",
  get_context_health: "control-plane:read",
  get_ai_governance_status: "control-plane:read",
  update_customer_agent_credential_scopes: "control-plane:ai-governance:write",
  revoke_customer_agent_credential: "control-plane:ai-governance:write",
  update_customer_model_budget: "control-plane:ai-governance:write",
  update_customer_agent_policy: "control-plane:ai-governance:write",
  get_release_status: "control-plane:read",
  get_deploy_latest_preflight: "control-plane:read",
  validate_railway_release_executor: "control-plane:read",
  list_customer_members: "control-plane:read",
  create_customer_member: "control-plane:access:write",
  resend_customer_member_access_link: "control-plane:access:write",
  update_customer_member_status: "control-plane:access:write",
  list_customer_feature_flags: "control-plane:read",
  set_customer_feature_flag: "control-plane:features:write",
  refresh_customer_deployment_snapshot: "control-plane:support:write",
  configure_customer_integration: "control-plane:integrations:write",
  run_meeting_recorder_operation: "control-plane:integrations:write",
  check_meeting_operations_readiness: "control-plane:read",
  enqueue_agenda_preparation: "control-plane:integrations:write",
  run_context_sync: "control-plane:context:write",
  probe_customer_deployment_health: "control-plane:releases:write",
  record_verified_release: "control-plane:releases:write",
  refresh_fleet_snapshots: "control-plane:fleet:write",
  enqueue_fleet_snapshot_jobs: "control-plane:fleet:write",
  prepare_release_upgrade: "control-plane:releases:write",
  freeze_managed_release_inventory: "control-plane:releases:write",
  read_managed_release_auth: "control-plane:releases:write",
  dispatch_managed_release_diagnostic: "control-plane:releases:write",
  reconcile_managed_azure_target: "control-plane:releases:write",
  get_managed_release_bootstrap_target: "control-plane:releases:write",
  get_managed_release_inventory: "control-plane:releases:write",
  managed_release_lease: "control-plane:releases:write",
  deploy_latest_release: "control-plane:releases:write",
  deploy_latest_release_bulk: "control-plane:releases:write",
  get_rollout_status: "control-plane:read",
  run_customer_support_operation: "control-plane:support:write",
  record_customer_support_audit: "control-plane:support:write",
};

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status: code < 0 ? 200 : code });
}

function textContent(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function objectArgs(args: unknown) {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function argString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function inputError(message: string) {
  const error = new Error(message) as Error & { status: number; code: string };
  error.status = 400;
  error.code = "INVALID_INPUT";
  return error;
}

function argOptionalString(args: Record<string, unknown>, key: string) {
  if (!Object.prototype.hasOwnProperty.call(args, key) || args[key] == null) return null;
  if (typeof args[key] !== "string") {
    throw inputError(`${key} must be a string.`);
  }
  const value = args[key].trim();
  return value.length > 0 ? value : null;
}

function argBoolean(args: Record<string, unknown>, key: string, fallback: boolean) {
  return typeof args[key] === "boolean" ? args[key] as boolean : fallback;
}

function argNumber(args: Record<string, unknown>, key: string, fallback: number) {
  return typeof args[key] === "number" && Number.isFinite(args[key]) ? args[key] as number : fallback;
}

function argStringArray(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function argObject(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredStringArray(args: Record<string, unknown>, key: string) {
  const value = argStringArray(args, key);
  return value ?? [];
}

function parseTimezoneAwareJoinAt(value: string | null) {
  if (!value) return { ok: true as const, date: null };
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([zZ]|[+-]\d{2}:\d{2})$/);
  if (!match) {
    return { ok: false as const, message: "joinAt must include an explicit timezone offset or Z." };
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || !timezoneAwareTimestampMatchesInput(date, match)) {
    return { ok: false as const, message: "joinAt must be a valid timestamp." };
  }
  return { ok: true as const, date };
}

function timezoneAwareTimestampMatchesInput(parsed: Date, match: RegExpMatchArray) {
  const [, year, month, day, hour, minute, second = "0", fraction = "0", zone] = match;
  const offsetMinutes = zone.toUpperCase() === "Z"
    ? 0
    : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * (zone.startsWith("-") ? -1 : 1);
  const local = new Date(parsed.getTime() + offsetMinutes * 60_000);
  return local.getUTCFullYear() === Number(year)
    && local.getUTCMonth() + 1 === Number(month)
    && local.getUTCDate() === Number(day)
    && local.getUTCHours() === Number(hour)
    && local.getUTCMinutes() === Number(minute)
    && local.getUTCSeconds() === Number(second)
    && local.getUTCMilliseconds() === Number(fraction.slice(0, 3).padEnd(3, "0"));
}

export async function GET() {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  return NextResponse.json({
    name: "corgtex-control-plane-mcp",
    version: "1.0.0",
    description: "Corgtex control-plane MCP endpoint for platform support operations.",
    capabilities: { tools: true },
  });
}

export async function POST(request: NextRequest) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    await requireControlPlaneAccess(actor);
    const body = await request.json();
    const id = body?.id ?? null;

    if (body?.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "corgtex-control-plane", version: "1.0.0" },
        capabilities: { tools: {} },
      });
    }

    if (body?.method === "tools/list") {
      return rpcResult(id, { tools });
    }

    if (body?.method !== "tools/call") {
      return rpcError(id, -32601, "Unsupported MCP method.");
    }

    const name = String(body.params?.name ?? "");
    const args = objectArgs(body.params?.arguments);
    if (toolScopes[name]) {
      requireControlPlaneScope(actor, toolScopes[name]);
    }

    if (name === "list_customers") {
      return rpcResult(id, textContent(await listControlPlaneCustomerSummaries(actor, {
        query: argOptionalString(args, "query"),
        health: argOptionalString(args, "health"),
        support: argOptionalString(args, "support"),
        limit: argNumber(args, "limit", 500),
        includeAllDeployments: argBoolean(args, "includeAllDeployments", false),
        uncapped: argBoolean(args, "uncapped", false),
      })));
    }
    if (name === "list_self_serve_customers") {
      return rpcResult(id, textContent(await listSelfServeCustomerRegistry(actor, {
        take: argNumber(args, "take", 100),
        status: argOptionalString(args, "status"),
      })));
    }
    if (name === "record_self_serve_smoke_run") {
      return rpcResult(id, textContent(await upsertSelfServeSmokeRun({
        actor,
        runId: argString(args, "runId"),
        runKind: argString(args, "runKind") || "browser",
        status: argString(args, "status"),
        deploymentId: argOptionalString(args, "deploymentId"),
        workspaceId: argOptionalString(args, "workspaceId"),
        procurementTrialId: argOptionalString(args, "procurementTrialId"),
        baseUrl: argOptionalString(args, "baseUrl"),
        siteUrl: argOptionalString(args, "siteUrl"),
        summary: Object.prototype.hasOwnProperty.call(args, "summary") ? args.summary : undefined,
        artifacts: Object.prototype.hasOwnProperty.call(args, "artifacts") ? args.artifacts : undefined,
        error: argOptionalString(args, "error"),
        startedAt: argOptionalString(args, "startedAt"),
        completedAt: argOptionalString(args, "completedAt"),
      })));
    }
    if (name === "create_self_serve_support_session") {
      return rpcResult(id, textContent(await createSelfServeSupportSession(actor, {
        deploymentId: argOptionalString(args, "deploymentId"),
        workspaceId: argOptionalString(args, "workspaceId"),
        targetMemberId: argOptionalString(args, "targetMemberId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "approve_self_serve_trial_request") {
      return rpcResult(id, textContent(await approveReviewGatedProcurementTrial(actor, {
        trialId: argString(args, "trialId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "reject_self_serve_trial_request") {
      return rpcResult(id, textContent(await rejectReviewGatedProcurementTrial(actor, {
        trialId: argString(args, "trialId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "create_client") {
      return rpcResult(id, textContent(await createControlPlaneClient(actor, {
        mode: argString(args, "mode") || argString(args, "clientMode"),
        label: argString(args, "label"),
        customerSlug: argString(args, "customerSlug"),
        reason: argString(args, "reason"),
        supportOwnerEmail: argOptionalString(args, "supportOwnerEmail"),
        description: argOptionalString(args, "description"),
        featurePosture: argOptionalString(args, "featurePosture"),
        primary: argBoolean(args, "primary", false),
        initialAdmins: Array.isArray(args.initialAdmins) ? args.initialAdmins : [],
        region: argOptionalString(args, "region"),
        dataResidency: argOptionalString(args, "dataResidency"),
        customDomain: argOptionalString(args, "customDomain"),
        releaseVersion: argOptionalString(args, "releaseVersion"),
        releaseImageTag: argOptionalString(args, "releaseImageTag"),
        webImage: argOptionalString(args, "webImage"),
        workerImage: argOptionalString(args, "workerImage"),
        webSource: argObject(args, "webSource") as never,
        workerSource: argObject(args, "workerSource") as never,
        storageBucketName: argOptionalString(args, "storageBucketName"),
        bootstrapBundleUri: argOptionalString(args, "bootstrapBundleUri"),
        bootstrapBundleChecksum: argOptionalString(args, "bootstrapBundleChecksum"),
        bootstrapBundleSchemaVersion: argOptionalString(args, "bootstrapBundleSchemaVersion"),
      })));
    }
    if (name === "plan_client_migration") {
      return rpcResult(id, textContent(await planControlPlaneClientMigration(actor, {
        sourceDeploymentId: argString(args, "sourceDeploymentId"),
        targetMode: argString(args, "targetMode"),
        destinationDeploymentId: argOptionalString(args, "destinationDeploymentId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "run_client_migration_dry_run") {
      return rpcResult(id, textContent(await runControlPlaneClientMigrationDryRun(actor, {
        migrationRunId: argOptionalString(args, "migrationRunId"),
        sourceDeploymentId: argOptionalString(args, "sourceDeploymentId"),
        targetMode: argOptionalString(args, "targetMode"),
        destinationDeploymentId: argOptionalString(args, "destinationDeploymentId"),
        writesQuiesced: argBoolean(args, "writesQuiesced", false),
        acceptRequiresReauth: argBoolean(args, "acceptRequiresReauth", false),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "execute_client_migration") {
      return rpcResult(id, textContent(await executeControlPlaneClientMigration(actor, {
        migrationRunId: argString(args, "migrationRunId"),
        destinationDeploymentId: argOptionalString(args, "destinationDeploymentId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "get_client_migration_status") {
      return rpcResult(id, textContent(await getControlPlaneClientMigrationStatus(actor, argString(args, "migrationRunId"))));
    }
    if (name === "finalize_client_migration") {
      return rpcResult(id, textContent(await finalizeControlPlaneClientMigration(actor, {
        migrationRunId: argString(args, "migrationRunId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "rollback_client_migration") {
      return rpcResult(id, textContent(await rollbackControlPlaneClientMigration(actor, {
        migrationRunId: argString(args, "migrationRunId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "get_customer_deployment_status") {
      return rpcResult(id, textContent(await getControlPlaneDeployment(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "get_azure_provider_status") {
      return rpcResult(id, textContent(await getControlPlaneProviderStatus(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "refresh_customer_deployment_snapshot") {
      return rpcResult(id, textContent(await fetchCustomerSupportSnapshot(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "list_customer_integrations") {
      return rpcResult(id, textContent(await getControlPlaneIntegrationStatus(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "get_customer_integration_setup_link") {
      const integrationKey = argString(args, "integrationKey").toLowerCase();
      if (integrationKey !== "slack") {
        return rpcError(id, -32602, "Unsupported integration key.");
      }
      const deploymentId = argString(args, "deploymentId");
      const target = await getControlPlaneSlackSetupTarget(actor, deploymentId);
      const setupPath = `/api/control-plane/deployments/${deploymentId}/integrations/slack/install`;
      const appOrigin = env.APP_URL?.replace(/\/$/, "");
      return rpcResult(id, textContent({
        deploymentId,
        integrationKey,
        managedWorkspaceId: target.managedWorkspaceId,
        setupUrl: appOrigin ? `${appOrigin}${setupPath}` : setupPath,
        completesOAuth: false,
        instruction: "Open setupUrl in a browser as a human account with Slack installation permissions.",
      }));
    }
    if (name === "get_context_health") {
      return rpcResult(id, textContent(await getControlPlaneContextHealth(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "get_ai_governance_status") {
      return rpcResult(id, textContent(await getControlPlaneAiGovernanceStatus(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "update_customer_agent_credential_scopes") {
      if (!Array.isArray(args.scopes) || !args.scopes.every((scope) => typeof scope === "string")) {
        return rpcError(id, -32602, "scopes must be an array of strings.");
      }
      return rpcResult(id, textContent(await updateControlPlaneAgentCredentialScopes(actor, {
        deploymentId: argString(args, "deploymentId"),
        credentialId: argString(args, "credentialId"),
        scopes: requiredStringArray(args, "scopes"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "revoke_customer_agent_credential") {
      return rpcResult(id, textContent(await revokeControlPlaneAgentCredential(actor, {
        deploymentId: argString(args, "deploymentId"),
        credentialId: argString(args, "credentialId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "update_customer_model_budget") {
      if (typeof args.monthlyCostCapUsd !== "number" || !Number.isFinite(args.monthlyCostCapUsd)) {
        return rpcError(id, -32602, "monthlyCostCapUsd must be a finite number.");
      }
      return rpcResult(id, textContent(await updateControlPlaneModelBudget(actor, {
        deploymentId: argString(args, "deploymentId"),
        monthlyCostCapUsd: args.monthlyCostCapUsd,
        alertThresholdPct: typeof args.alertThresholdPct === "number" ? args.alertThresholdPct : null,
        periodStartDay: typeof args.periodStartDay === "number" ? args.periodStartDay : null,
        reason: argString(args, "reason"),
      })));
    }
    if (name === "update_customer_agent_policy") {
      return rpcResult(id, textContent(await updateControlPlaneAgentPolicy(actor, {
        deploymentId: argString(args, "deploymentId"),
        agentKey: argString(args, "agentKey"),
        governancePolicy: argOptionalString(args, "governancePolicy"),
        modelOverride: argOptionalString(args, "modelOverride"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "get_release_status") {
      return rpcResult(id, textContent(await getControlPlaneReleaseStatus(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "get_deploy_latest_preflight") {
      return rpcResult(id, textContent(await getControlPlaneDeployLatestPreflight(actor, argString(args, "deploymentId"))));
    }
    if (name === "validate_railway_release_executor") {
      return rpcResult(id, textContent(await validateControlPlaneRailwayReleaseExecutor(actor, argString(args, "deploymentId"))));
    }
    if (name === "list_customer_members") {
      return rpcResult(id, textContent(await listControlPlaneCustomerMembers(actor, argString(args, "deploymentId"))));
    }
    if (name === "create_customer_member") {
      const role = argString(args, "role").trim();
      if (!role) {
        return rpcError(id, -32602, "role must be a non-empty string.");
      }
      return rpcResult(id, textContent(await createControlPlaneCustomerMember(actor, {
        deploymentId: argString(args, "deploymentId"),
        email: argString(args, "email"),
        displayName: argOptionalString(args, "displayName"),
        role,
        reason: argString(args, "reason"),
      })));
    }
    if (name === "resend_customer_member_access_link") {
      return rpcResult(id, textContent(await resendControlPlaneCustomerMemberAccessLink(actor, {
        deploymentId: argString(args, "deploymentId"),
        memberId: argString(args, "memberId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "update_customer_member_status") {
      if (typeof args.isActive !== "boolean") {
        return rpcError(id, -32602, "isActive must be a boolean.");
      }
      return rpcResult(id, textContent(await updateControlPlaneCustomerMemberStatus(actor, {
        deploymentId: argString(args, "deploymentId"),
        memberId: argString(args, "memberId"),
        isActive: args.isActive,
        reason: argString(args, "reason"),
      })));
    }
    if (name === "list_customer_feature_flags") {
      return rpcResult(id, textContent(await listControlPlaneFeatureFlags(actor, argString(args, "deploymentId"))));
    }
    if (name === "set_customer_feature_flag") {
      const flag = argString(args, "flag");
      const hasEnabled = Object.prototype.hasOwnProperty.call(args, "enabled");
      const hasConfig = Object.prototype.hasOwnProperty.call(args, "config");
      const hasReportImports = Object.prototype.hasOwnProperty.call(args, "reportImportsEnabled");
      const hasExpectedIdentity = Object.prototype.hasOwnProperty.call(args, "expectedConfigIdentity");
      if (hasReportImports && typeof args.reportImportsEnabled !== "boolean") {
        return rpcError(id, -32602, "reportImportsEnabled must be a boolean.");
      }
      if ((!hasReportImports && typeof args.enabled !== "boolean") || (hasReportImports && (hasEnabled || hasConfig || flag !== "FINANCE"))) {
        return rpcError(id, -32602, "enabled must be a boolean.");
      }
      const financeConfigMutation = flag === "FINANCE" && (hasConfig || hasReportImports);
      if ((financeConfigMutation && !hasExpectedIdentity) || (hasExpectedIdentity && !financeConfigMutation)) {
        return rpcError(id, -32602, "Finance config writes require expectedConfigIdentity.");
      }
      if (args.expectedConfigIdentity != null && (typeof args.expectedConfigIdentity !== "string" || !/^[0-9a-f]{64}$/.test(args.expectedConfigIdentity))) {
        return rpcError(id, -32602, "expectedConfigIdentity must be a SHA-256 hex digest or null.");
      }
      return rpcResult(id, textContent(await setControlPlaneFeatureFlag(actor, {
        deploymentId: argString(args, "deploymentId"),
        flag,
        ...(hasEnabled ? { enabled: args.enabled as boolean } : {}),
        ...(Object.prototype.hasOwnProperty.call(args, "config") ? { config: args.config } : {}),
        ...(hasReportImports ? { reportImportsEnabled: args.reportImportsEnabled as boolean } : {}),
        ...(hasExpectedIdentity ? { expectedConfigIdentity: args.expectedConfigIdentity as string | null } : {}),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "configure_customer_integration") {
      if (argString(args, "integrationKey") !== "meeting_recorders") {
        return rpcError(id, -32602, "Unsupported integration key.");
      }
      if (typeof args.entitlementEnabled !== "boolean") {
        return rpcError(id, -32602, "entitlementEnabled must be a boolean.");
      }
      if (typeof args.enabled !== "boolean") {
        return rpcError(id, -32602, "enabled must be a boolean.");
      }
      if (typeof args.autoRecordEnabled !== "boolean") {
        return rpcError(id, -32602, "autoRecordEnabled must be a boolean.");
      }
      return rpcResult(id, textContent(await configureControlPlaneMeetingRecorderIntegration(actor, {
        deploymentId: argString(args, "deploymentId"),
        entitlementEnabled: args.entitlementEnabled,
        enabled: args.enabled,
        autoRecordEnabled: args.autoRecordEnabled,
        defaultProvider: argString(args, "defaultProvider") || "RECALL_AI",
        fallbackProvider: argOptionalString(args, "fallbackProvider"),
        monthlyMinuteCap: argNumber(args, "monthlyMinuteCap", 6_000),
        botName: argOptionalString(args, "botName"),
        entryMessage: argOptionalString(args, "entryMessage"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "run_meeting_recorder_operation") {
      const joinAt = argOptionalString(args, "joinAt");
      const parsedJoinAt = parseTimezoneAwareJoinAt(joinAt);
      if (!parsedJoinAt.ok) {
        return rpcError(id, -32602, parsedJoinAt.message);
      }
      return rpcResult(id, textContent(await runControlPlaneMeetingRecorderOperation(actor, {
        deploymentId: argString(args, "deploymentId"),
        operation: argString(args, "operation") as "enqueue_calendar_sync" | "dry_run_scan" | "live_smoke" | "enable_auto_recording_after_smoke",
        meetingUrl: argOptionalString(args, "meetingUrl"),
        joinAt: parsedJoinAt.date,
        provider: argOptionalString(args, "provider"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "check_meeting_operations_readiness") {
      return rpcResult(id, textContent(await getControlPlaneMeetingOperationsReadiness(actor, argString(args, "deploymentId"))));
    }
    if (name === "enqueue_agenda_preparation") {
      return rpcResult(id, textContent(await enqueueControlPlaneAgendaPreparation(actor, {
        deploymentId: argString(args, "deploymentId"),
        targetDateISO: argOptionalString(args, "targetDateISO"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "run_context_sync") {
      const sourceId = argOptionalString(args, "sourceId");
      return rpcResult(id, textContent(await runControlPlaneContextOperation(actor, {
        deploymentId: argString(args, "deploymentId"),
        operation: sourceId ? "sync_source" : "sync_all",
        sourceId,
        reason: argString(args, "reason"),
      })));
    }
    if (name === "probe_customer_deployment_health") {
      return rpcResult(id, textContent(await probeControlPlaneDeploymentHealth(actor, {
        deploymentId: argString(args, "deploymentId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "record_verified_release") {
      return rpcResult(id, textContent(await recordVerifiedControlPlaneRelease(actor, {
        deploymentId: argString(args, "deploymentId"),
        releaseImageTag: argString(args, "releaseImageTag"),
        releaseVersion: argOptionalString(args, "releaseVersion"),
        managedAzureTarget: typeof args.managedAzureTarget === "object" && args.managedAzureTarget !== null && !Array.isArray(args.managedAzureTarget) ? args.managedAzureTarget as never : undefined,
        reason: argString(args, "reason"),
      })));
    }
    if (name === "refresh_fleet_snapshots") {
      return rpcResult(id, textContent(await refreshControlPlaneFleetSnapshots(actor, {
        deploymentId: argString(args, "deploymentId"),
        snapshotKinds: argStringArray(args, "snapshotKinds"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "run_post_deploy_probe") {
      return rpcResult(id, textContent(await runControlPlanePostDeployProbe(actor, {
        deploymentId: argString(args, "deploymentId"),
        releaseImageTag: argOptionalString(args, "releaseImageTag"),
        releaseVersion: argOptionalString(args, "releaseVersion"),
        reason: argString(args, "reason"),
        requireRemoteSupportAudit: argBoolean(args, "requireRemoteSupportAudit", false),
      })));
    }
    if (name === "get_managed_release_inventory") {
      return rpcResult(id, textContent(await getControlPlaneManagedReleaseInventory(actor, {
        inventoryRef: argString(args, "inventoryRef"),
        expectedSha256: argString(args, "expectedSha256"),
        deploymentId: argString(args, "deploymentId"),
        workloadClass: argString(args, "workloadClass") as never,
        acrName: argString(args, "acrName"),
        acrServer: argString(args, "acrServer"),
      })));
    }
    if (name === "reconcile_managed_azure_target") {
      return rpcResult(id, textContent(await reconcileControlPlaneManagedAzureTarget(actor, args)));
    }
    if (name === "read_managed_release_auth") {
      return rpcResult(id, textContent(await readControlPlaneManagedReleaseAuth(actor, {
        deploymentId: argString(args, "deploymentId"), mode: argString(args, "mode") as "preflight" | "status",
        operationId: argOptionalString(args, "operationId") ?? undefined, expectedGitSha: argOptionalString(args, "expectedGitSha") ?? undefined,
      })));
    }
    if (name === "dispatch_managed_release_diagnostic") {
      const operationId = argString(args, "operationId");
      const retryAttempt = argNumber(args, "retryAttempt", 0);
      if (Object.prototype.hasOwnProperty.call(args, "retryAttempt") && retryAttempt !== 1) {
        throw inputError("retryAttempt must be 1.");
      }
      return rpcResult(id, textContent(await runCustomerSupportOperation(actor, {
        deploymentId: argString(args, "deploymentId"), action: "runtime.release_diagnostic",
        reason: argString(args, "reason"), arguments: { operationId, expectedGitSha: argString(args, "expectedGitSha"),
          ...(retryAttempt === 1 ? { retryAttempt: 1 } : {}) },
        idempotencyKey: retryAttempt === 1 ? `release-diagnostic-retry:${operationId}:1` : `release-diagnostic-start:${operationId}`,
        scopeOverride: "control-plane:releases:write",
      })));
    }
    if (name === "freeze_managed_release_inventory") {
      return rpcResult(id, textContent(await freezeControlPlaneManagedReleaseInventory(actor, {
        deploymentId: argString(args, "deploymentId"),
        workloadClass: argString(args, "workloadClass") as never,
        acrName: argString(args, "acrName"),
        acrServer: argString(args, "acrServer"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "get_managed_release_bootstrap_target") {
      return rpcResult(id, textContent(await getControlPlaneManagedReleaseBootstrapTarget(actor, {
        deploymentId: argString(args, "deploymentId"),
        workloadClass: argString(args, "workloadClass") as never,
        acrName: argString(args, "acrName"),
        acrServer: argString(args, "acrServer"),
      })));
    }
    if (name === "managed_release_lease") {
      return rpcResult(id, textContent(await runControlPlaneManagedReleaseLeaseOperation(actor, {
        ...args,
        operation: argString(args, "operation"),
      })));
    }
    if (name === "enqueue_fleet_snapshot_jobs") {
      return rpcResult(id, textContent(await enqueueControlPlaneFleetSnapshots(actor, {
        deploymentId: argOptionalString(args, "deploymentId"),
        snapshotKinds: argStringArray(args, "snapshotKinds"),
        limit: argNumber(args, "limit", 100),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "prepare_release_upgrade") {
      return rpcResult(id, textContent(await runControlPlaneReleaseOperation(actor, {
        deploymentId: argString(args, "deploymentId"),
        operation: "prepare_upgrade",
        targetReleaseImageTag: argString(args, "targetReleaseImageTag"),
        targetReleaseVersion: argOptionalString(args, "targetReleaseVersion"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "deploy_latest_release") {
      return rpcResult(id, textContent(await deployLatestControlPlaneRelease(actor, {
        deploymentId: argString(args, "deploymentId"),
        reason: argString(args, "reason"),
        force: argBoolean(args, "force", false),
      })));
    }
    if (name === "deploy_latest_release_bulk") {
      return rpcResult(id, textContent(await enqueueControlPlaneDeployLatestRollout(actor, {
        deploymentIds: argStringArray(args, "deploymentIds"),
        allEligible: argBoolean(args, "allEligible", false),
        includeUnhealthy: argBoolean(args, "includeUnhealthy", false),
        limit: argNumber(args, "limit", 100),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "get_rollout_status") {
      return rpcResult(id, textContent(await listControlPlaneReleaseRolloutJobs(actor, {
        deploymentId: argOptionalString(args, "deploymentId"),
        take: argNumber(args, "take", 50),
      })));
    }
    if (name === "run_customer_support_operation") {
      const operation = await runCustomerSupportOperation(actor, {
        deploymentId: argString(args, "deploymentId"),
        action: argString(args, "action") as SupportAction,
        reason: typeof args.reason === "string" ? args.reason : null,
        arguments: objectArgs(args.arguments),
        remoteWorkspaceId: argOptionalString(args, "remoteWorkspaceId"),
        idempotencyKey: argOptionalString(args, "idempotencyKey"),
      });
      return rpcResult(id, textContent(operation));
    }
    if (name === "record_customer_support_audit") {
      const operation = await recordCustomerSupportAudit(actor, {
        deploymentId: argString(args, "deploymentId"),
        action: argString(args, "action"),
        reason: argString(args, "reason"),
        summary: argString(args, "summary"),
        outcome: argOptionalString(args, "outcome"),
        evidence: Object.prototype.hasOwnProperty.call(args, "evidence") ? args.evidence : undefined,
        remoteWorkspaceId: argOptionalString(args, "remoteWorkspaceId"),
        idempotencyKey: argOptionalString(args, "idempotencyKey"),
      });
      return rpcResult(id, textContent(operation));
    }

    return rpcError(id, -32602, "Unknown control-plane tool.");
  } catch (error) {
    return handleRouteError(error);
  }
}
