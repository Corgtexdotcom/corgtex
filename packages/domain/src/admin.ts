import { createHash, createHmac } from "node:crypto";

import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { CustomerDeploymentCloudProvider, MemberRole, Prisma } from "@prisma/client";
import { AppError, invariant } from "./errors";
import { requestPasswordReset } from "./password-reset";
import { createMember } from "./members";
import { requireGlobalOperator } from "./auth";
import { createWorkspace } from "./workspaces";
import {
  createRailwayClientFromEnv,
  provisionRailwayCustomerStack,
  upgradeRailwayCustomerRelease,
  type RailwayClient,
  type RailwayRuntimeServiceSource,
} from "./railway-client";
import {
  customerSlugFromText,
  deploymentStatusFromProvisioningStatus,
  linkManagedWorkspaceDeployment,
  registerCustomerDeployment as upsertCustomerDeployment,
} from "./customer-lifecycle";

const CUSTOMER_DEPLOYMENT_PROVISIONING_STATUSES = new Set([
  "draft",
  "provisioning",
  "awaiting_dns",
  "bootstrapping",
  "active",
  "degraded",
  "suspended",
]);

const CUSTOMER_DEPLOYMENT_BOOTSTRAP_STATUSES = new Set([
  "not_started",
  "pending",
  "bootstrapping",
  "applied",
  "failed",
]);

const CONTROL_PLANE_CLIENTS_WRITE_SCOPE = "control-plane:clients:write";

const CUSTOMER_DEPLOYMENT_CLOUD_PROVIDER_LABELS: Record<CustomerDeploymentCloudProvider, string> = {
  RAILWAY: "Railway",
  AZURE: "Azure",
  SELF_HOSTED: "Self-hosted",
  UNKNOWN: "Unknown",
};

type CustomerDeploymentProviderFields = {
  cloudProvider?: CustomerDeploymentCloudProvider | null;
  railwayProjectId?: string | null;
  railwayEnvironmentId?: string | null;
  railwayWebServiceId?: string | null;
  railwayWorkerServiceId?: string | null;
  railwayPostgresServiceId?: string | null;
  railwayRedisServiceId?: string | null;
  providerSubscriptionId?: string | null;
  providerResourceGroup?: string | null;
  providerProjectId?: string | null;
  providerEnvironmentId?: string | null;
  providerWebServiceId?: string | null;
  providerWorkerServiceId?: string | null;
  providerPostgresServiceId?: string | null;
  providerRedisServiceId?: string | null;
  providerStorageResourceId?: string | null;
  providerLogsUrl?: string | null;
  providerCostUrl?: string | null;
  providerMetadata?: unknown;
  storageBucketName?: string | null;
};

export type CustomerDeploymentProviderReadModel = {
  cloudProvider: CustomerDeploymentCloudProvider;
  providerLabel: string;
  providerSubscriptionId: string | null;
  providerResourceGroup: string | null;
  providerProjectId: string | null;
  providerEnvironmentId: string | null;
  providerWebServiceId: string | null;
  providerWorkerServiceId: string | null;
  providerPostgresServiceId: string | null;
  providerRedisServiceId: string | null;
  providerStorageResourceId: string | null;
  providerLogsUrl: string | null;
  providerCostUrl: string | null;
  providerMetadata: unknown;
};

export function buildCustomerDeploymentProviderReadModel(
  deployment: CustomerDeploymentProviderFields,
): CustomerDeploymentProviderReadModel {
  const cloudProvider = deployment.cloudProvider ?? "RAILWAY";
  const useRailwayFallback = cloudProvider === "RAILWAY";
  return {
    cloudProvider,
    providerLabel: CUSTOMER_DEPLOYMENT_CLOUD_PROVIDER_LABELS[cloudProvider],
    providerSubscriptionId: deployment.providerSubscriptionId ?? null,
    providerResourceGroup: deployment.providerResourceGroup ?? null,
    providerProjectId: deployment.providerProjectId ?? (useRailwayFallback ? deployment.railwayProjectId ?? null : null),
    providerEnvironmentId: deployment.providerEnvironmentId ?? (useRailwayFallback ? deployment.railwayEnvironmentId ?? null : null),
    providerWebServiceId: deployment.providerWebServiceId ?? (useRailwayFallback ? deployment.railwayWebServiceId ?? null : null),
    providerWorkerServiceId: deployment.providerWorkerServiceId ?? (useRailwayFallback ? deployment.railwayWorkerServiceId ?? null : null),
    providerPostgresServiceId: deployment.providerPostgresServiceId ?? (useRailwayFallback ? deployment.railwayPostgresServiceId ?? null : null),
    providerRedisServiceId: deployment.providerRedisServiceId ?? (useRailwayFallback ? deployment.railwayRedisServiceId ?? null : null),
    providerStorageResourceId: deployment.providerStorageResourceId ?? deployment.storageBucketName ?? null,
    providerLogsUrl: deployment.providerLogsUrl ?? null,
    providerCostUrl: deployment.providerCostUrl ?? null,
    providerMetadata: deployment.providerMetadata ?? null,
  };
}

type CustomerDeploymentHealthPayload = {
  status?: string;
  database?: string;
  schema?: string;
  release?: { imageTag?: string | null; gitSha?: string | null };
  runtime?: { redis?: string; storage?: string };
};

export type CustomerDeploymentReadinessCheck = {
  key: string;
  label: string;
  status: "ok" | "warning" | "missing";
  detail: string;
};

export type CustomerDeploymentReadiness = {
  status: "ready" | "attention";
  checks: CustomerDeploymentReadinessCheck[];
};

function normalizeSlug(value: string) {
  const slug = value.trim().toLowerCase();
  invariant(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug), 400, "INVALID_INPUT", "Customer slug must be a DNS-safe slug.");
  return slug;
}

function normalizeOptional(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasControlPlaneAgentScope(actor: AppActor, scope: string) {
  if (actor.kind !== "agent" || actor.authProvider !== "control-plane") return false;
  const scopes = new Set(actor.scopes?.length ? actor.scopes : []);
  return scopes.has("control-plane:*") || scopes.has(scope);
}

function requireCustomerProvisioningAccess(actor: AppActor) {
  if (hasControlPlaneAgentScope(actor, CONTROL_PLANE_CLIENTS_WRITE_SCOPE)) return;
  requireGlobalOperator(actor);
}

function requireStatus(value: string, valid: Set<string>, label: string) {
  const normalized = value.trim().toLowerCase();
  invariant(valid.has(normalized), 400, "INVALID_INPUT", `Invalid ${label} status.`);
  return normalized;
}

function assertDataResidency(region: string, dataResidency: string) {
  const normalizedResidency = dataResidency.trim().toLowerCase();
  const normalizedRegion = region.trim().toLowerCase();
  if (normalizedResidency === "eu") {
    invariant(
      normalizedRegion.startsWith("eu") || normalizedRegion.includes("europe"),
      400,
      "DATA_RESIDENCY_REGION_MISMATCH",
      "EU data residency requires an EU Railway region.",
    );
  }
}

function hasCompleteRailwayStack(deployment: {
  railwayProjectId?: string | null;
  railwayEnvironmentId?: string | null;
  railwayWebServiceId?: string | null;
  railwayWorkerServiceId?: string | null;
  railwayPostgresServiceId?: string | null;
  railwayRedisServiceId?: string | null;
}) {
  return Boolean(
    deployment.railwayProjectId
      && deployment.railwayEnvironmentId
      && deployment.railwayWebServiceId
      && deployment.railwayWorkerServiceId
      && deployment.railwayPostgresServiceId
      && deployment.railwayRedisServiceId,
  );
}

function hasAnyRailwayStackResource(deployment: {
  railwayProjectId?: string | null;
  railwayEnvironmentId?: string | null;
  railwayWebServiceId?: string | null;
  railwayWorkerServiceId?: string | null;
  railwayPostgresServiceId?: string | null;
  railwayRedisServiceId?: string | null;
}) {
  return Boolean(
    deployment.railwayProjectId
      || deployment.railwayEnvironmentId
      || deployment.railwayWebServiceId
      || deployment.railwayWorkerServiceId
      || deployment.railwayPostgresServiceId
      || deployment.railwayRedisServiceId,
  );
}

async function findManagedWorkspaceId(customerSlug: string | null | undefined) {
  const slug = normalizeOptional(customerSlug);
  if (!slug) return null;
  const workspace = await prisma.workspace.findUnique({
    where: { slug },
    select: { id: true },
  });
  return workspace?.id ?? null;
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256Hex(secret: string, value: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function bootstrapSignaturePayload(params: {
  customerSlug: string;
  bundleUri: string;
  checksum: string;
  schemaVersion: string;
  expiresAt: string;
  tokenHash: string;
}) {
  return JSON.stringify({
    customerSlug: params.customerSlug,
    bundleUri: params.bundleUri,
    checksum: params.checksum.toLowerCase(),
    schemaVersion: params.schemaVersion,
    expiresAt: params.expiresAt,
    tokenHash: params.tokenHash.toLowerCase(),
  });
}

export function buildCustomerDeploymentRuntimeVariables(params: {
  customerSlug: string;
  releaseGitSha?: string | null;
  url: string;
  releaseImageTag: string;
  releaseVersion?: string | null;
  overrides?: Record<string, string>;
}) {
  const releaseGitSha = normalizeOptional(params.releaseGitSha)
    ?? (params.releaseImageTag.startsWith("sha-") ? params.releaseImageTag.slice("sha-".length) : null);

  return {
    APP_URL: params.url,
    WORKSPACE_SLUG: params.customerSlug,
    REDIS_KEY_PREFIX: `${params.customerSlug}-prod`,
    ...(releaseGitSha ? { CORGTEX_RELEASE_GIT_SHA: releaseGitSha } : {}),
    CORGTEX_RELEASE_IMAGE_TAG: params.releaseImageTag,
    ...(normalizeOptional(params.releaseVersion) ? { CORGTEX_RELEASE_VERSION: normalizeOptional(params.releaseVersion)! } : {}),
    ...buildCustomerDeploymentApplicationInsightsVariables(),
    ...buildCustomerDeploymentPostHogVariables(params.customerSlug),
    ...(params.overrides ?? {}),
  };
}

function postHogEnv(name: string, fallback: string) {
  return normalizeOptional(process.env[name]) ?? fallback;
}

function postHogEnabled() {
  const enabled = normalizeOptional(process.env.POSTHOG_ENABLED)?.toLowerCase();
  return enabled === "1" || enabled === "true";
}

function buildCustomerDeploymentPostHogVariables(customerSlug: string): Record<string, string> {
  const token = normalizeOptional(process.env.POSTHOG_PROJECT_TOKEN);
  if (!postHogEnabled() || !token) {
    return {};
  }

  return {
    POSTHOG_ENABLED: "true",
    POSTHOG_CAPTURE_KILL_SWITCH: postHogEnv("POSTHOG_CAPTURE_KILL_SWITCH", "false"),
    POSTHOG_PROJECT_TOKEN: token,
    POSTHOG_API_HOST: postHogEnv("POSTHOG_API_HOST", "https://us.i.posthog.com"),
    POSTHOG_INSTANCE_ID: `client-${customerSlug}-production`,
    POSTHOG_ENVIRONMENT: postHogEnv("POSTHOG_ENVIRONMENT", "production"),
    POSTHOG_EVENT_SAMPLE_RATE: postHogEnv("POSTHOG_EVENT_SAMPLE_RATE", "1"),
    POSTHOG_CAPTURE_TIMEOUT_MS: postHogEnv("POSTHOG_CAPTURE_TIMEOUT_MS", "1500"),
    POSTHOG_CAPTURE_DEBUG: postHogEnv("POSTHOG_CAPTURE_DEBUG", "false"),
  };
}

function buildCustomerDeploymentApplicationInsightsVariables(): Record<string, string> {
  const connectionString = normalizeOptional(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);
  if (!connectionString) {
    return {};
  }

  return {
    APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString,
  };
}

async function recordCustomerDeploymentEvent(
  actor: AppActor,
  deploymentId: string | null,
  action: string,
  meta: Record<string, unknown> = {},
) {
  await prisma.customerDeploymentEvent.create({
    data: {
      deploymentId,
      actorUserId: actorUserId(actor),
      action,
      meta: meta as Prisma.InputJsonObject,
    },
  });
}

export async function listAllWorkspaces(actor: AppActor) {
  requireGlobalOperator(actor);
  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { members: true },
      },
    },
  });
  return workspaces.map(w => ({
    id: w.id,
    slug: w.slug,
    name: w.name,
    createdAt: w.createdAt,
    memberCount: w._count.members,
  }));
}

export async function listAllUsers(actor: AppActor) {
  requireGlobalOperator(actor);
  return prisma.user.findMany({
    orderBy: { email: "asc" },
    include: {
      sessions: {
        orderBy: { createdAt: "desc" },
        take: 1
      },
      memberships: {
        include: {
          workspace: { select: { slug: true, name: true } }
        }
      }
    }
  });
}

export async function adminTriggerPasswordReset(actor: AppActor, email: string) {
  requireGlobalOperator(actor);
  const result = await requestPasswordReset(email);
  if (!result) {
    throw new AppError(404, "NOT_FOUND", "User not found.");
  }
  return result.token;
}

export async function adminAddToWorkspace(actor: AppActor, params: {
  userId: string;
  workspaceId: string;
  role: "CONTRIBUTOR" | "FACILITATOR" | "FINANCE_STEWARD" | "ADMIN";
}) {
  requireGlobalOperator(actor);
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
  });
  if (!user) throw new AppError(404, "NOT_FOUND", "User not found.");

  return createMember(actor, {
    workspaceId: params.workspaceId,
    email: user.email,
    displayName: user.displayName,
    role: params.role,
  });
}

export async function adminRemoveFromWorkspace(actor: AppActor, params: {
  memberId: string;
}) {
  requireGlobalOperator(actor);
  await prisma.member.delete({
    where: { id: params.memberId },
  });
}

export async function getOperatorOverview(actor: AppActor) {
  requireGlobalOperator(actor);
  const workspacesCount = await prisma.workspace.count();
  const usersCount = await prisma.user.count();
  const activeMembersCount = await prisma.member.count({ where: { isActive: true } });
  
  const lastJob = await prisma.workflowJob.findFirst({
    where: { status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  const pendingJobs = await prisma.workflowJob.count({ where: { status: "PENDING" } });
  const failedJobs = await prisma.workflowJob.count({ where: { status: "FAILED" } });
  
  const workerHealthy = failedJobs < 10;
  
  return {
    workspacesCount,
    usersCount,
    activeMembersCount,
    worker: {
      isHealthy: workerHealthy,
      lastJobAt: lastJob?.createdAt || null,
      pendingJobs,
      failedJobs
    }
  };
}

export async function listAllWorkspacesEnriched(actor: AppActor) {
  requireGlobalOperator(actor);
  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      members: {
        select: { isActive: true, role: true }
      },
      _count: {
        select: {
          members: true,
          workflowJobs: { where: { status: "FAILED" } }
        }
      }
    }
  });

  return workspaces.map(w => {
    const activeMemberCount = w.members.filter(m => m.isActive).length;
    const adminCount = w.members.filter(m => m.role === "ADMIN").length;
    return {
      id: w.id,
      slug: w.slug,
      name: w.name,
      createdAt: w.createdAt,
      memberCount: w._count.members,
      activeMemberCount,
      adminCount,
      failedJobsCount: w._count.workflowJobs,
    };
  });
}

export async function getWorkspaceAdminDetail(actor: AppActor, workspaceId: string) {
  requireGlobalOperator(actor);
  
  const members = await prisma.member.findMany({
    where: { workspaceId },
    include: {
      user: {
        include: {
          sessions: { orderBy: { createdAt: "desc" }, take: 1 }
        }
      }
    }
  });

  const failedJobs = await prisma.workflowJob.findMany({
    where: { workspaceId, status: "FAILED" },
    orderBy: { createdAt: "desc" },
    take: 20
  });

  const commInstallations = await prisma.communicationInstallation.findMany({
    where: { workspaceId },
  });

  return { members, failedJobs, commInstallations };
}

export async function adminCreateMember(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName: string | null;
  role: MemberRole;
}) {
  requireGlobalOperator(actor);
  return createMember(actor, {
    workspaceId: params.workspaceId,
    email: params.email,
    displayName: params.displayName,
    role: params.role,
    skipAdminCheck: true,
  });
}

export async function adminUpdateMember(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  role: MemberRole;
}) {
  requireGlobalOperator(actor);
  await prisma.member.update({
    where: { id: params.memberId },
    data: { role: params.role }
  });
}

export async function adminDeactivateMember(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
}) {
  requireGlobalOperator(actor);
  await prisma.member.update({
    where: { id: params.memberId },
    data: { isActive: false }
  });
}

export async function adminBulkInvite(actor: AppActor, params: {
  workspaceId: string;
  members: Array<{ email: string; displayName?: string; role: MemberRole }>;
}) {
  requireGlobalOperator(actor);
  for (const m of params.members) {
    await createMember(actor, {
      workspaceId: params.workspaceId,
      email: m.email,
      displayName: m.displayName || null,
      role: m.role,
      skipAdminCheck: true,
    });
  }
}

export async function adminResendAccessLink(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
}) {
  requireGlobalOperator(actor);
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: params.memberId },
    include: { user: true }
  });
  const token = await requestPasswordReset(member.user.email);
  return { user: member.user, token: token?.token };
}

export async function adminCreateWorkspace(actor: AppActor, params: {
  name: string;
  slug: string;
  description: string | null;
}) {
  requireGlobalOperator(actor);
  const workspace = await createWorkspace(actor, {
    name: params.name,
    slug: params.slug,
  });
  await linkManagedWorkspaceDeployment({
    workspaceId: workspace.id,
    accountStatus: "ACTIVE",
    deploymentKind: "SHARED_WORKSPACE",
    deploymentStatus: "ACTIVE",
    primary: true,
  });
  return workspace;
}

export async function listCustomerDeployments(actor: AppActor) {
  requireGlobalOperator(actor);
  const deployments = await prisma.customerDeployment.findMany({
    orderBy: { createdAt: "desc" }
  });
  return deployments.map((deployment) => ({
    ...deployment,
    provider: buildCustomerDeploymentProviderReadModel(deployment),
    readiness: buildCustomerDeploymentReadiness(deployment),
  }));
}

export async function listCustomerDeploymentEvents(actor: AppActor, deploymentId: string) {
  requireGlobalOperator(actor);
  return prisma.customerDeploymentEvent.findMany({
    where: { deploymentId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function registerCustomerDeploymentRecord(actor: AppActor, params: {
  label: string;
  url: string;
  environment?: string;
  notes?: string;
  customerSlug?: string;
  region?: string;
  dataResidency?: string;
  customDomain?: string;
  supportOwnerEmail?: string;
  releaseVersion?: string;
  releaseImageTag?: string;
  storageBucketName?: string;
  bootstrapBundleUri?: string;
  bootstrapBundleChecksum?: string;
  bootstrapBundleSchemaVersion?: string;
}) {
  requireGlobalOperator(actor);
  const normalizedCustomerSlug = params.customerSlug
    ? normalizeSlug(params.customerSlug)
    : customerSlugFromText(params.label || params.url);
  const managedWorkspaceId = await findManagedWorkspaceId(normalizedCustomerSlug);
  const { deployment } = await upsertCustomerDeployment({
    accountSlug: normalizedCustomerSlug,
    accountDisplayName: params.label,
    accountStatus: managedWorkspaceId ? "ACTIVE" : "ONBOARDING",
    managementAuthority: "CORGTEX",
    label: params.label,
    url: params.url,
    environment: params.environment || "production",
    notes: params.notes,
    customerSlug: normalizedCustomerSlug,
    deploymentKind: managedWorkspaceId ? "SHARED_WORKSPACE" : "REMOTE_MANAGED",
    deploymentStatus: managedWorkspaceId ? "ACTIVE" : "DRAFT",
    region: params.region,
    dataResidency: params.dataResidency,
    customDomain: params.customDomain,
    supportOwnerEmail: params.supportOwnerEmail,
    releaseVersion: params.releaseVersion,
    releaseImageTag: params.releaseImageTag,
    storageBucketName: params.storageBucketName,
    bootstrapBundleUri: params.bootstrapBundleUri,
    bootstrapBundleChecksum: params.bootstrapBundleChecksum,
    bootstrapBundleSchemaVersion: params.bootstrapBundleSchemaVersion,
    managedWorkspaceId,
  });
  await recordCustomerDeploymentEvent(actor, deployment.id, "customer_deployment.registered", {
    customerSlug: deployment.customerSlug,
    region: deployment.region,
    releaseImageTag: deployment.releaseImageTag,
    hasBootstrapBundle: Boolean(deployment.bootstrapBundleUri),
    managedWorkspaceId,
  });
  return deployment;
}

export async function removeCustomerDeployment(actor: AppActor, id: string) {
  requireGlobalOperator(actor);
  await recordCustomerDeploymentEvent(actor, id, "customer_deployment.removed");
  await prisma.customerDeployment.delete({
    where: { id }
  });
}

export async function probeCustomerDeploymentHealth(actor: AppActor, id: string) {
  requireGlobalOperator(actor);
  const deployment = await prisma.customerDeployment.findUniqueOrThrow({ where: { id } });
  
  let status = "unknown";
  let error = null;
  let health: CustomerDeploymentHealthPayload | null = null;

  try {
    const res = await fetch(`${deployment.url}/api/health`, { method: "GET" });
    health = await res.json().catch(() => null) as CustomerDeploymentHealthPayload | null;
    if (res.ok) {
      status = "ok";
      const runtimeErrors = [];
      if (health?.database && health.database !== "up") {
        runtimeErrors.push(`Database ${health.database}`);
      }
      if (health?.schema && health.schema !== "ready") {
        runtimeErrors.push(`Schema ${health.schema}`);
      }
      if (health?.runtime?.redis && health.runtime.redis !== "configured") {
        runtimeErrors.push(`Redis ${health.runtime.redis}`);
      }
      if (health?.runtime?.storage && health.runtime.storage !== "configured") {
        runtimeErrors.push(`Storage ${health.runtime.storage}`);
      }
      const actualReleaseValues = [health?.release?.imageTag, health?.release?.gitSha]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (
        deployment.releaseImageTag &&
        actualReleaseValues.length > 0 &&
        !actualReleaseValues.includes(deployment.releaseImageTag)
      ) {
        runtimeErrors.push(`Release drift: expected ${deployment.releaseImageTag}, got ${actualReleaseValues.join(" / ")}`);
      }
      if (runtimeErrors.length > 0) {
        status = "degraded";
        error = runtimeErrors.join("; ");
      }
    } else {
      status = "degraded";
      error = `Status ${res.status}`;
    }
  } catch (e: any) {
    status = "down";
    error = e.message;
  }

  await prisma.customerDeployment.update({
    where: { id },
    data: {
      lastHealthCheck: new Date(),
      lastHealthStatus: status,
      lastHealthError: error,
      lastReleaseCheck: health?.release ? new Date() : null,
      provisioningStatus: status === "ok" ? "active" : "degraded",
      deploymentStatus: status === "ok" ? "ACTIVE" : "DEGRADED",
    }
  });
  await recordCustomerDeploymentEvent(actor, id, "customer_deployment.health_probed", { status, error });
}

export async function updateCustomerDeploymentStatus(actor: AppActor, params: {
  deploymentId: string;
  provisioningStatus?: string;
  bootstrapStatus?: string;
  lastProvisioningError?: string | null;
}) {
  requireGlobalOperator(actor);
  const data: {
    provisioningStatus?: string;
    bootstrapStatus?: string;
    deploymentStatus?: "DRAFT" | "PROVISIONING" | "BOOTSTRAPPING" | "ACTIVE" | "DEGRADED" | "SUSPENDED" | "RETIRED";
    lastProvisioningError?: string | null;
  } = {};

  if (params.provisioningStatus) {
    data.provisioningStatus = requireStatus(params.provisioningStatus, CUSTOMER_DEPLOYMENT_PROVISIONING_STATUSES, "provisioning");
    data.deploymentStatus = deploymentStatusFromProvisioningStatus(data.provisioningStatus);
  }
  if (params.bootstrapStatus) {
    data.bootstrapStatus = requireStatus(params.bootstrapStatus, CUSTOMER_DEPLOYMENT_BOOTSTRAP_STATUSES, "bootstrap");
    if (!data.deploymentStatus && data.bootstrapStatus === "bootstrapping") {
      data.deploymentStatus = "BOOTSTRAPPING";
    }
    if (!data.deploymentStatus && data.bootstrapStatus === "failed") {
      data.deploymentStatus = "DEGRADED";
    }
  }
  if (params.lastProvisioningError !== undefined) {
    data.lastProvisioningError = params.lastProvisioningError;
  }

  const deployment = await prisma.customerDeployment.update({
    where: { id: params.deploymentId },
    data,
  });
  await recordCustomerDeploymentEvent(actor, params.deploymentId, "customer_deployment.status_updated", data);
  return deployment;
}

export async function suspendCustomerDeployment(actor: AppActor, deploymentId: string) {
  requireGlobalOperator(actor);
  const deployment = await prisma.customerDeployment.update({
    where: { id: deploymentId },
    data: {
      provisioningStatus: "suspended",
      deploymentStatus: "SUSPENDED",
    },
  });
  await recordCustomerDeploymentEvent(actor, deploymentId, "customer_deployment.suspended");
  return deployment;
}

export async function provisionCustomerDeployment(actor: AppActor, params: {
  label: string;
  customerSlug: string;
  region: string;
  dataResidency: string;
  customDomain?: string | null;
  supportOwnerEmail?: string | null;
  releaseVersion?: string | null;
  releaseGitSha?: string | null;
  releaseImageTag: string;
  webImage?: string | null;
  workerImage?: string | null;
  webSource?: RailwayRuntimeServiceSource | null;
  workerSource?: RailwayRuntimeServiceSource | null;
  storageBucketName?: string | null;
  bootstrapBundleUri?: string | null;
  bootstrapBundleChecksum?: string | null;
  bootstrapBundleSchemaVersion?: string | null;
  primary?: boolean;
  variables?: Record<string, string>;
}, railwayClient: RailwayClient = createRailwayClientFromEnv()) {
  requireCustomerProvisioningAccess(actor);
  const customerSlug = normalizeSlug(params.customerSlug);
  assertDataResidency(params.region, params.dataResidency);
  const url = params.customDomain?.trim()
    ? `https://${params.customDomain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")}`
    : `https://${customerSlug}.corgtex.com`;

  const existingDeployment = await prisma.customerDeployment.findFirst({
    where: {
      customerSlug,
      deploymentKind: "HOSTED_DEDICATED",
      environment: "production",
    },
  });
  if (existingDeployment && hasCompleteRailwayStack(existingDeployment)) {
    await recordCustomerDeploymentEvent(actor, existingDeployment.id, "customer_deployment.provisioning_skipped_existing_stack", {
      customerSlug,
      railwayProjectId: existingDeployment.railwayProjectId,
      railwayEnvironmentId: existingDeployment.railwayEnvironmentId,
      reason: "complete_railway_stack_already_registered",
    });
    return existingDeployment;
  }
  if (existingDeployment) {
    throw new AppError(
      409,
      "RAILWAY_STACK_RECONCILIATION_REQUIRED",
      hasAnyRailwayStackResource(existingDeployment)
        ? "Existing hosted deployment has a partial Railway stack. Reconcile it before retrying provisioning."
        : "Existing hosted deployment was already registered. Reconcile its Railway stack before retrying provisioning.",
    );
  }

  const { deployment } = await upsertCustomerDeployment({
    accountSlug: customerSlug,
    accountDisplayName: params.label,
    accountStatus: "ONBOARDING",
    managementAuthority: "CORGTEX",
    label: params.label,
    url,
    environment: "production",
    customerSlug,
    deploymentKind: "HOSTED_DEDICATED",
    deploymentStatus: "PROVISIONING",
    region: params.region,
    dataResidency: params.dataResidency,
    customDomain: params.customDomain,
    supportOwnerEmail: params.supportOwnerEmail,
    releaseVersion: params.releaseVersion,
    releaseImageTag: params.releaseImageTag,
    storageBucketName: params.storageBucketName,
    bootstrapBundleUri: params.bootstrapBundleUri,
    bootstrapBundleChecksum: params.bootstrapBundleChecksum,
    bootstrapBundleSchemaVersion: params.bootstrapBundleSchemaVersion,
    provisioningStatus: "provisioning",
    bootstrapStatus: params.bootstrapBundleUri ? "pending" : "not_started",
    managedWorkspaceId: null,
    primary: params.primary === true,
  });

  await recordCustomerDeploymentEvent(actor, deployment.id, "customer_deployment.provisioning_started", {
    customerSlug,
    region: params.region,
    dataResidency: params.dataResidency,
    releaseImageTag: params.releaseImageTag,
    storageBucketConfigured: Boolean(params.storageBucketName),
    hasBootstrapBundle: Boolean(params.bootstrapBundleUri),
  });

  try {
    const result = await provisionRailwayCustomerStack(railwayClient, {
      projectName: `corgtex-${customerSlug}`,
      environmentName: "production",
      region: params.region,
      webImage: params.webImage,
      workerImage: params.workerImage,
      webSource: params.webSource,
      workerSource: params.workerSource,
      customDomain: params.customDomain,
      variables: buildCustomerDeploymentRuntimeVariables({
        customerSlug,
        url,
        releaseGitSha: params.releaseGitSha,
        releaseImageTag: params.releaseImageTag,
        releaseVersion: params.releaseVersion,
        overrides: params.variables,
      }),
    });

    const updated = await prisma.customerDeployment.update({
      where: { id: deployment.id },
      data: {
        railwayProjectId: result.projectId,
        railwayEnvironmentId: result.environmentId,
        railwayWebServiceId: result.webServiceId,
        railwayWorkerServiceId: result.workerServiceId,
        railwayPostgresServiceId: result.postgresServiceId,
        railwayRedisServiceId: result.redisServiceId,
        customDomain: result.webDomain ?? normalizeOptional(params.customDomain),
        provisioningStatus: result.webDomain ? "awaiting_dns" : "bootstrapping",
        deploymentStatus: "BOOTSTRAPPING",
        lastProvisioningError: null,
      },
    });
    await recordCustomerDeploymentEvent(actor, deployment.id, "customer_deployment.provisioned", {
      railwayProjectId: result.projectId,
      railwayEnvironmentId: result.environmentId,
      railwayWebServiceId: result.webServiceId,
      railwayWorkerServiceId: result.workerServiceId,
      hasCustomDomain: Boolean(result.webDomain),
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Railway provisioning error.";
    await prisma.customerDeployment.update({
      where: { id: deployment.id },
      data: {
        provisioningStatus: "degraded",
        deploymentStatus: "DEGRADED",
        lastProvisioningError: message,
      },
    });
    await recordCustomerDeploymentEvent(actor, deployment.id, "customer_deployment.provisioning_failed", {
      error: message,
    });
    throw error;
  }
}

function readinessCheck(
  key: string,
  label: string,
  ok: boolean,
  detail: string,
  missingDetail: string,
  statusWhenFalse: "warning" | "missing" = "missing",
): CustomerDeploymentReadinessCheck {
  return {
    key,
    label,
    status: ok ? "ok" : statusWhenFalse,
    detail: ok ? detail : missingDetail,
  };
}

export function buildCustomerDeploymentReadiness(deployment: {
  cloudProvider?: CustomerDeploymentCloudProvider | null;
  url?: string | null;
  customDomain?: string | null;
  region?: string | null;
  dataResidency?: string | null;
  supportOwnerEmail?: string | null;
  provisioningStatus?: string | null;
  bootstrapStatus?: string | null;
  releaseImageTag?: string | null;
  releaseVersion?: string | null;
  railwayProjectId?: string | null;
  railwayEnvironmentId?: string | null;
  railwayWebServiceId?: string | null;
  railwayWorkerServiceId?: string | null;
  railwayPostgresServiceId?: string | null;
  railwayRedisServiceId?: string | null;
  providerSubscriptionId?: string | null;
  providerResourceGroup?: string | null;
  providerProjectId?: string | null;
  providerEnvironmentId?: string | null;
  providerWebServiceId?: string | null;
  providerWorkerServiceId?: string | null;
  providerPostgresServiceId?: string | null;
  providerRedisServiceId?: string | null;
  providerStorageResourceId?: string | null;
  providerLogsUrl?: string | null;
  providerCostUrl?: string | null;
  providerMetadata?: unknown;
  storageBucketName?: string | null;
  lastHealthStatus?: string | null;
  lastHealthError?: string | null;
  lastHealthCheck?: Date | string | null;
  lastReleaseCheck?: Date | string | null;
}) {
  const provider = buildCustomerDeploymentProviderReadModel(deployment);
  const healthOk = deployment.lastHealthStatus === "ok";
  const releasePinned = Boolean(deployment.releaseImageTag || deployment.releaseVersion);
  const releaseVerified = releasePinned && Boolean(deployment.lastReleaseCheck) && !deployment.lastHealthError?.includes("Release drift:");
  const runtimeVerified = healthOk && !deployment.lastHealthError;
  const storageLabel = provider.cloudProvider === "AZURE"
    ? "Azure Blob storage"
    : provider.cloudProvider === "RAILWAY" ? "Railway Bucket storage" : `${provider.providerLabel} storage`;
  const providerResourcesCheck = (() => {
    if (provider.cloudProvider === "AZURE") {
      return readinessCheck(
        "azure_resources",
        "Azure resources",
        Boolean(
          provider.providerSubscriptionId
          && provider.providerResourceGroup
          && provider.providerEnvironmentId
          && provider.providerWebServiceId
          && provider.providerWorkerServiceId
          && provider.providerPostgresServiceId
          && provider.providerRedisServiceId,
        ),
        "Subscription, resource group, Container Apps, Postgres, and Redis resources are recorded.",
        "Record the Azure subscription, resource group, Container Apps environment, web, worker, Postgres, and Redis resource IDs.",
      );
    }
    if (provider.cloudProvider === "RAILWAY") {
      return readinessCheck(
        "railway_project",
        "Railway services",
        Boolean(
          provider.providerProjectId
          && provider.providerEnvironmentId
          && provider.providerWebServiceId
          && provider.providerWorkerServiceId
          && provider.providerPostgresServiceId
          && provider.providerRedisServiceId,
        ),
        "Project, environment, web, worker, Postgres, and Redis IDs are recorded.",
        "Record the Railway project, environment, web, worker, Postgres, and Redis IDs.",
      );
    }
    return readinessCheck(
      "provider_metadata",
      `${provider.providerLabel} resources`,
      Boolean(provider.providerMetadata),
      "Provider metadata is recorded.",
      "Record sanitized provider metadata for this deployment.",
      "warning",
    );
  })();

  const checks: CustomerDeploymentReadinessCheck[] = [
    providerResourcesCheck,
    readinessCheck(
      "region",
      "Region and residency",
      Boolean(deployment.region && deployment.dataResidency),
      `${deployment.region} / ${deployment.dataResidency}`,
      "Record the customer region and data residency.",
    ),
    readinessCheck(
      "domain",
      "Production domain",
      Boolean(deployment.url && deployment.customDomain),
      deployment.customDomain || deployment.url || "Domain recorded.",
      "Record the customer custom domain and production URL.",
      "warning",
    ),
    readinessCheck(
      "storage",
      storageLabel,
      Boolean(provider.providerStorageResourceId),
      provider.providerStorageResourceId || "Storage resource recorded.",
      provider.cloudProvider === "AZURE"
        ? "Record the Azure Blob Storage account or container resource ID for this customer."
        : `Record the ${storageLabel} resource for this customer.`,
    ),
    readinessCheck(
      "health",
      "Runtime health",
      runtimeVerified,
      "Web health, database, schema, Redis, storage, and release are healthy.",
      deployment.lastHealthError || "Run a health probe after all runtime variables are configured.",
    ),
    readinessCheck(
      "release",
      "Pinned release",
      releaseVerified,
      deployment.releaseImageTag || deployment.releaseVersion || "Release verified.",
      releasePinned ? "Run a health probe to verify the pinned release." : "Record a release tag or version before onboarding.",
    ),
    readinessCheck(
      "bootstrap",
      "Bootstrap status",
      deployment.bootstrapStatus === "applied",
      "Bootstrap has been applied.",
      "Mark bootstrap applied only after the production seed has completed.",
    ),
    readinessCheck(
      "support_owner",
      "Support owner",
      Boolean(deployment.supportOwnerEmail),
      deployment.supportOwnerEmail || "Support owner recorded.",
      "Record the Corgtex support owner for this customer.",
      "warning",
    ),
    readinessCheck(
      "provisioning",
      "Ops status",
      deployment.provisioningStatus === "active",
      "Ops marks this customer active.",
      `Current status is ${deployment.provisioningStatus || "unknown"}.`,
    ),
  ];

  return {
    status: checks.every((check) => check.status === "ok") ? "ready" : "attention",
    checks,
  } satisfies CustomerDeploymentReadiness;
}

export async function upgradeCustomerDeploymentRelease(actor: AppActor, params: {
  deploymentId: string;
  releaseVersion?: string | null;
  releaseGitSha?: string | null;
  releaseImageTag: string;
  webImage?: string | null;
  workerImage?: string | null;
  webSource?: RailwayRuntimeServiceSource | null;
  workerSource?: RailwayRuntimeServiceSource | null;
  variables?: Record<string, string>;
}, railwayClient: RailwayClient = createRailwayClientFromEnv()) {
  requireGlobalOperator(actor);
  const deployment = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: params.deploymentId } });

  invariant(deployment.customerSlug, 400, "INVALID_INPUT", "Customer deployment is missing a customer slug.");
  invariant(deployment.railwayProjectId, 400, "INVALID_INPUT", "Customer deployment is missing a Railway project ID.");
  invariant(deployment.railwayEnvironmentId, 400, "INVALID_INPUT", "Customer deployment is missing a Railway environment ID.");
  invariant(deployment.railwayWebServiceId, 400, "INVALID_INPUT", "Customer deployment is missing a Railway web service ID.");
  invariant(deployment.railwayWorkerServiceId, 400, "INVALID_INPUT", "Customer deployment is missing a Railway worker service ID.");

  const releaseVersion = normalizeOptional(params.releaseVersion);
  await prisma.customerDeployment.update({
    where: { id: deployment.id },
    data: {
      provisioningStatus: "provisioning",
      releaseVersion,
      releaseImageTag: params.releaseImageTag,
      lastProvisioningError: null,
    },
  });
  await recordCustomerDeploymentEvent(actor, deployment.id, "customer_deployment.upgrade_started", {
    customerSlug: deployment.customerSlug,
    releaseVersion,
    releaseImageTag: params.releaseImageTag,
  });

  try {
    const result = await upgradeRailwayCustomerRelease(railwayClient, {
      projectId: deployment.railwayProjectId,
      environmentId: deployment.railwayEnvironmentId,
      webServiceId: deployment.railwayWebServiceId,
      workerServiceId: deployment.railwayWorkerServiceId,
      webImage: params.webImage,
      workerImage: params.workerImage,
      webSource: params.webSource,
      workerSource: params.workerSource,
      variables: buildCustomerDeploymentRuntimeVariables({
        customerSlug: deployment.customerSlug,
        url: deployment.url,
        releaseGitSha: params.releaseGitSha,
        releaseImageTag: params.releaseImageTag,
        releaseVersion,
        overrides: params.variables,
      }),
    });

    const updated = await prisma.customerDeployment.update({
      where: { id: deployment.id },
      data: {
        provisioningStatus: "active",
        releaseVersion,
        releaseImageTag: params.releaseImageTag,
        lastReleaseCheck: new Date(),
        lastProvisioningError: null,
      },
    });
    await recordCustomerDeploymentEvent(actor, deployment.id, "customer_deployment.upgrade_succeeded", {
      releaseVersion,
      releaseImageTag: params.releaseImageTag,
      webDeploymentId: result.webDeploymentId,
      workerDeploymentId: result.workerDeploymentId,
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Railway upgrade error.";
    await prisma.customerDeployment.update({
      where: { id: deployment.id },
      data: {
        provisioningStatus: "degraded",
        lastProvisioningError: message,
      },
    });
    await recordCustomerDeploymentEvent(actor, deployment.id, "customer_deployment.upgrade_failed", {
      releaseVersion,
      releaseImageTag: params.releaseImageTag,
      error: message,
    });
    throw error;
  }
}

export async function triggerCustomerDeploymentBootstrap(actor: AppActor, params: {
  deploymentId: string;
  token: string;
  expiresAt: Date;
}) {
  requireGlobalOperator(actor);
  const deployment = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: params.deploymentId } });
  invariant(deployment.customerSlug, 400, "INVALID_INPUT", "Customer deployment is missing a customer slug.");
  invariant(deployment.bootstrapBundleUri, 400, "INVALID_INPUT", "Customer deployment is missing a bootstrap bundle URI.");
  invariant(deployment.bootstrapBundleChecksum, 400, "INVALID_INPUT", "Customer deployment is missing a bootstrap bundle checksum.");
  invariant(deployment.bootstrapBundleSchemaVersion, 400, "INVALID_INPUT", "Customer deployment is missing a bootstrap bundle schema version.");
  const token = params.token.trim();
  invariant(token, 400, "INVALID_INPUT", "Bootstrap token is required.");

  const expiresAt = params.expiresAt.toISOString();
  const tokenHash = sha256Hex(token);
  const signaturePayload = bootstrapSignaturePayload({
    customerSlug: deployment.customerSlug,
    bundleUri: deployment.bootstrapBundleUri,
    checksum: deployment.bootstrapBundleChecksum,
    schemaVersion: deployment.bootstrapBundleSchemaVersion,
    expiresAt,
    tokenHash,
  });

  const response = await fetch(`${deployment.url.replace(/\/$/, "")}/api/internal/customer-deployment-bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customerSlug: deployment.customerSlug,
      bundleUri: deployment.bootstrapBundleUri,
      checksum: deployment.bootstrapBundleChecksum,
      schemaVersion: deployment.bootstrapBundleSchemaVersion,
      expiresAt,
      tokenHash,
      signature: hmacSha256Hex(token, signaturePayload),
    }),
  });

  const bootstrapStatus = response.ok ? "bootstrapping" : "failed";
  const updated = await prisma.customerDeployment.update({
    where: { id: deployment.id },
    data: {
      bootstrapStatus,
      provisioningStatus: response.ok ? "bootstrapping" : "degraded",
      lastProvisioningError: response.ok ? null : `Bootstrap endpoint returned ${response.status}.`,
    },
  });
  await recordCustomerDeploymentEvent(actor, deployment.id, "customer_deployment.bootstrap_triggered", {
    status: response.status,
    ok: response.ok,
    expiresAt,
  });
  return updated;
}
