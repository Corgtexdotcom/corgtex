import { createHash, createHmac } from "node:crypto";

import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { MemberRole, Prisma } from "@prisma/client";
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
  registerCustomerDeployment,
} from "./customer-lifecycle";

const HOSTED_PROVISIONING_STATUSES = new Set([
  "draft",
  "provisioning",
  "awaiting_dns",
  "bootstrapping",
  "active",
  "degraded",
  "suspended",
]);

const HOSTED_BOOTSTRAP_STATUSES = new Set([
  "not_started",
  "pending",
  "bootstrapping",
  "applied",
  "failed",
]);

type InstanceHealthPayload = {
  status?: string;
  database?: string;
  schema?: string;
  release?: { imageTag?: string | null; gitSha?: string | null };
  runtime?: { redis?: string; storage?: string };
};

export type HostedInstanceReadinessCheck = {
  key: string;
  label: string;
  status: "ok" | "warning" | "missing";
  detail: string;
};

export type HostedInstanceReadiness = {
  status: "ready" | "attention";
  checks: HostedInstanceReadinessCheck[];
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

export function buildHostedCustomerRuntimeVariables(params: {
  customerSlug: string;
  url: string;
  releaseImageTag: string;
  releaseVersion?: string | null;
  overrides?: Record<string, string>;
}) {
  return {
    APP_URL: params.url,
    WORKSPACE_SLUG: params.customerSlug,
    REDIS_KEY_PREFIX: `${params.customerSlug}-prod`,
    CORGTEX_RELEASE_IMAGE_TAG: params.releaseImageTag,
    ...(normalizeOptional(params.releaseVersion) ? { CORGTEX_RELEASE_VERSION: normalizeOptional(params.releaseVersion)! } : {}),
    ...(params.overrides ?? {}),
  };
}

async function recordHostedInstanceEvent(
  actor: AppActor,
  instanceId: string | null,
  action: string,
  meta: Record<string, unknown> = {},
) {
  await prisma.hostedInstanceEvent.create({
    data: {
      instanceId,
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

export async function listExternalInstances(actor: AppActor) {
  requireGlobalOperator(actor);
  const instances = await prisma.instanceRegistry.findMany({
    orderBy: { createdAt: "desc" }
  });
  return instances.map((instance) => ({
    ...instance,
    readiness: buildHostedInstanceReadiness(instance),
  }));
}

export async function listHostedInstanceEvents(actor: AppActor, instanceId: string) {
  requireGlobalOperator(actor);
  return prisma.hostedInstanceEvent.findMany({
    where: { instanceId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function registerExternalInstance(actor: AppActor, params: {
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
  const { deployment: instance } = await registerCustomerDeployment({
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
  await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.registered", {
    customerSlug: instance.customerSlug,
    region: instance.region,
    releaseImageTag: instance.releaseImageTag,
    hasBootstrapBundle: Boolean(instance.bootstrapBundleUri),
    managedWorkspaceId,
  });
  return instance;
}

export async function removeExternalInstance(actor: AppActor, id: string) {
  requireGlobalOperator(actor);
  await recordHostedInstanceEvent(actor, id, "hosted_instance.removed");
  await prisma.instanceRegistry.delete({
    where: { id }
  });
}

export async function probeExternalInstanceHealth(actor: AppActor, id: string) {
  requireGlobalOperator(actor);
  const instance = await prisma.instanceRegistry.findUniqueOrThrow({ where: { id } });
  
  let status = "unknown";
  let error = null;
  let health: InstanceHealthPayload | null = null;

  try {
    const res = await fetch(`${instance.url}/api/health`, { method: "GET" });
    health = await res.json().catch(() => null) as InstanceHealthPayload | null;
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
      const actualRelease = health?.release?.imageTag || health?.release?.gitSha || null;
      if (instance.releaseImageTag && actualRelease && actualRelease !== instance.releaseImageTag) {
        runtimeErrors.push(`Release drift: expected ${instance.releaseImageTag}, got ${actualRelease}`);
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

  await prisma.instanceRegistry.update({
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
  await recordHostedInstanceEvent(actor, id, "hosted_instance.health_probed", { status, error });
}

export async function updateHostedInstanceStatus(actor: AppActor, params: {
  instanceId: string;
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
    data.provisioningStatus = requireStatus(params.provisioningStatus, HOSTED_PROVISIONING_STATUSES, "provisioning");
    data.deploymentStatus = deploymentStatusFromProvisioningStatus(data.provisioningStatus);
  }
  if (params.bootstrapStatus) {
    data.bootstrapStatus = requireStatus(params.bootstrapStatus, HOSTED_BOOTSTRAP_STATUSES, "bootstrap");
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

  const instance = await prisma.instanceRegistry.update({
    where: { id: params.instanceId },
    data,
  });
  await recordHostedInstanceEvent(actor, params.instanceId, "hosted_instance.status_updated", data);
  return instance;
}

export async function suspendHostedInstance(actor: AppActor, instanceId: string) {
  requireGlobalOperator(actor);
  const instance = await prisma.instanceRegistry.update({
    where: { id: instanceId },
    data: {
      provisioningStatus: "suspended",
      deploymentStatus: "SUSPENDED",
    },
  });
  await recordHostedInstanceEvent(actor, instanceId, "hosted_instance.suspended");
  return instance;
}

export async function provisionHostedCustomerInstance(actor: AppActor, params: {
  label: string;
  customerSlug: string;
  region: string;
  dataResidency: string;
  customDomain?: string | null;
  supportOwnerEmail?: string | null;
  releaseVersion?: string | null;
  releaseImageTag: string;
  webImage?: string | null;
  workerImage?: string | null;
  webSource?: RailwayRuntimeServiceSource | null;
  workerSource?: RailwayRuntimeServiceSource | null;
  storageBucketName?: string | null;
  bootstrapBundleUri?: string | null;
  bootstrapBundleChecksum?: string | null;
  bootstrapBundleSchemaVersion?: string | null;
  variables?: Record<string, string>;
}, railwayClient: RailwayClient = createRailwayClientFromEnv()) {
  requireGlobalOperator(actor);
  const customerSlug = normalizeSlug(params.customerSlug);
  const managedWorkspaceId = await findManagedWorkspaceId(customerSlug);
  assertDataResidency(params.region, params.dataResidency);
  const url = params.customDomain?.trim()
    ? `https://${params.customDomain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")}`
    : `https://${customerSlug}.corgtex.com`;

  const { deployment: instance } = await registerCustomerDeployment({
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
    managedWorkspaceId,
    primary: true,
  });

  await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.provisioning_started", {
    customerSlug,
    region: params.region,
    dataResidency: params.dataResidency,
    releaseImageTag: params.releaseImageTag,
    storageBucketConfigured: Boolean(params.storageBucketName),
    hasBootstrapBundle: Boolean(params.bootstrapBundleUri),
    managedWorkspaceId,
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
      variables: buildHostedCustomerRuntimeVariables({
        customerSlug,
        url,
        releaseImageTag: params.releaseImageTag,
        releaseVersion: params.releaseVersion,
        overrides: params.variables,
      }),
    });

    const updated = await prisma.instanceRegistry.update({
      where: { id: instance.id },
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
    await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.provisioned", {
      railwayProjectId: result.projectId,
      railwayEnvironmentId: result.environmentId,
      railwayWebServiceId: result.webServiceId,
      railwayWorkerServiceId: result.workerServiceId,
      hasCustomDomain: Boolean(result.webDomain),
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Railway provisioning error.";
    await prisma.instanceRegistry.update({
      where: { id: instance.id },
      data: {
        provisioningStatus: "degraded",
        deploymentStatus: "DEGRADED",
        lastProvisioningError: message,
      },
    });
    await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.provisioning_failed", {
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
): HostedInstanceReadinessCheck {
  return {
    key,
    label,
    status: ok ? "ok" : statusWhenFalse,
    detail: ok ? detail : missingDetail,
  };
}

export function buildHostedInstanceReadiness(instance: {
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
  storageBucketName?: string | null;
  lastHealthStatus?: string | null;
  lastHealthError?: string | null;
  lastHealthCheck?: Date | string | null;
  lastReleaseCheck?: Date | string | null;
}) {
  const railwayServicesPresent = Boolean(
    instance.railwayProjectId
    && instance.railwayEnvironmentId
    && instance.railwayWebServiceId
    && instance.railwayWorkerServiceId
    && instance.railwayPostgresServiceId
    && instance.railwayRedisServiceId,
  );
  const healthOk = instance.lastHealthStatus === "ok";
  const releasePinned = Boolean(instance.releaseImageTag || instance.releaseVersion);
  const releaseVerified = releasePinned && Boolean(instance.lastReleaseCheck) && !instance.lastHealthError?.includes("Release drift:");
  const runtimeVerified = healthOk && !instance.lastHealthError;

  const checks: HostedInstanceReadinessCheck[] = [
    readinessCheck(
      "railway_project",
      "Railway services",
      railwayServicesPresent,
      "Project, environment, web, worker, Postgres, and Redis IDs are recorded.",
      "Record the Railway project, environment, web, worker, Postgres, and Redis IDs.",
    ),
    readinessCheck(
      "region",
      "Region and residency",
      Boolean(instance.region && instance.dataResidency),
      `${instance.region} / ${instance.dataResidency}`,
      "Record the customer region and data residency.",
    ),
    readinessCheck(
      "domain",
      "Production domain",
      Boolean(instance.url && instance.customDomain),
      instance.customDomain || instance.url || "Domain recorded.",
      "Record the customer custom domain and production URL.",
      "warning",
    ),
    readinessCheck(
      "storage",
      "Railway Bucket storage",
      Boolean(instance.storageBucketName),
      instance.storageBucketName || "Storage bucket recorded.",
      "Record the Railway Bucket name for this customer.",
    ),
    readinessCheck(
      "health",
      "Runtime health",
      runtimeVerified,
      "Web health, database, schema, Redis, storage, and release are healthy.",
      instance.lastHealthError || "Run a health probe after all runtime variables are configured.",
    ),
    readinessCheck(
      "release",
      "Pinned release",
      releaseVerified,
      instance.releaseImageTag || instance.releaseVersion || "Release verified.",
      releasePinned ? "Run a health probe to verify the pinned release." : "Record a release tag or version before onboarding.",
    ),
    readinessCheck(
      "bootstrap",
      "Bootstrap status",
      instance.bootstrapStatus === "applied",
      "Bootstrap has been applied.",
      "Mark bootstrap applied only after the production seed has completed.",
    ),
    readinessCheck(
      "support_owner",
      "Support owner",
      Boolean(instance.supportOwnerEmail),
      instance.supportOwnerEmail || "Support owner recorded.",
      "Record the Corgtex support owner for this customer.",
      "warning",
    ),
    readinessCheck(
      "provisioning",
      "Ops status",
      instance.provisioningStatus === "active",
      "Ops marks this customer active.",
      `Current status is ${instance.provisioningStatus || "unknown"}.`,
    ),
  ];

  return {
    status: checks.every((check) => check.status === "ok") ? "ready" : "attention",
    checks,
  } satisfies HostedInstanceReadiness;
}

export async function upgradeHostedInstanceRelease(actor: AppActor, params: {
  instanceId: string;
  releaseVersion?: string | null;
  releaseImageTag: string;
  webImage?: string | null;
  workerImage?: string | null;
  webSource?: RailwayRuntimeServiceSource | null;
  workerSource?: RailwayRuntimeServiceSource | null;
  variables?: Record<string, string>;
}, railwayClient: RailwayClient = createRailwayClientFromEnv()) {
  requireGlobalOperator(actor);
  const instance = await prisma.instanceRegistry.findUniqueOrThrow({ where: { id: params.instanceId } });

  invariant(instance.customerSlug, 400, "INVALID_INPUT", "Instance is missing a customer slug.");
  invariant(instance.railwayProjectId, 400, "INVALID_INPUT", "Instance is missing a Railway project ID.");
  invariant(instance.railwayEnvironmentId, 400, "INVALID_INPUT", "Instance is missing a Railway environment ID.");
  invariant(instance.railwayWebServiceId, 400, "INVALID_INPUT", "Instance is missing a Railway web service ID.");
  invariant(instance.railwayWorkerServiceId, 400, "INVALID_INPUT", "Instance is missing a Railway worker service ID.");

  const releaseVersion = normalizeOptional(params.releaseVersion);
  await prisma.instanceRegistry.update({
    where: { id: instance.id },
    data: {
      provisioningStatus: "provisioning",
      releaseVersion,
      releaseImageTag: params.releaseImageTag,
      lastProvisioningError: null,
    },
  });
  await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.upgrade_started", {
    customerSlug: instance.customerSlug,
    releaseVersion,
    releaseImageTag: params.releaseImageTag,
  });

  try {
    const result = await upgradeRailwayCustomerRelease(railwayClient, {
      projectId: instance.railwayProjectId,
      environmentId: instance.railwayEnvironmentId,
      webServiceId: instance.railwayWebServiceId,
      workerServiceId: instance.railwayWorkerServiceId,
      webImage: params.webImage,
      workerImage: params.workerImage,
      webSource: params.webSource,
      workerSource: params.workerSource,
      variables: {
        CORGTEX_RELEASE_IMAGE_TAG: params.releaseImageTag,
        ...(releaseVersion ? { CORGTEX_RELEASE_VERSION: releaseVersion } : {}),
        ...(params.variables ?? {}),
      },
    });

    const updated = await prisma.instanceRegistry.update({
      where: { id: instance.id },
      data: {
        provisioningStatus: "active",
        releaseVersion,
        releaseImageTag: params.releaseImageTag,
        lastReleaseCheck: new Date(),
        lastProvisioningError: null,
      },
    });
    await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.upgrade_succeeded", {
      releaseVersion,
      releaseImageTag: params.releaseImageTag,
      webDeploymentId: result.webDeploymentId,
      workerDeploymentId: result.workerDeploymentId,
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Railway upgrade error.";
    await prisma.instanceRegistry.update({
      where: { id: instance.id },
      data: {
        provisioningStatus: "degraded",
        lastProvisioningError: message,
      },
    });
    await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.upgrade_failed", {
      releaseVersion,
      releaseImageTag: params.releaseImageTag,
      error: message,
    });
    throw error;
  }
}

export async function triggerHostedInstanceBootstrap(actor: AppActor, params: {
  instanceId: string;
  token: string;
  expiresAt: Date;
}) {
  requireGlobalOperator(actor);
  const instance = await prisma.instanceRegistry.findUniqueOrThrow({ where: { id: params.instanceId } });
  invariant(instance.customerSlug, 400, "INVALID_INPUT", "Instance is missing a customer slug.");
  invariant(instance.bootstrapBundleUri, 400, "INVALID_INPUT", "Instance is missing a bootstrap bundle URI.");
  invariant(instance.bootstrapBundleChecksum, 400, "INVALID_INPUT", "Instance is missing a bootstrap bundle checksum.");
  invariant(instance.bootstrapBundleSchemaVersion, 400, "INVALID_INPUT", "Instance is missing a bootstrap bundle schema version.");
  const token = params.token.trim();
  invariant(token, 400, "INVALID_INPUT", "Bootstrap token is required.");

  const expiresAt = params.expiresAt.toISOString();
  const tokenHash = sha256Hex(token);
  const signaturePayload = bootstrapSignaturePayload({
    customerSlug: instance.customerSlug,
    bundleUri: instance.bootstrapBundleUri,
    checksum: instance.bootstrapBundleChecksum,
    schemaVersion: instance.bootstrapBundleSchemaVersion,
    expiresAt,
    tokenHash,
  });

  const response = await fetch(`${instance.url.replace(/\/$/, "")}/api/internal/instance-bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customerSlug: instance.customerSlug,
      bundleUri: instance.bootstrapBundleUri,
      checksum: instance.bootstrapBundleChecksum,
      schemaVersion: instance.bootstrapBundleSchemaVersion,
      expiresAt,
      tokenHash,
      signature: hmacSha256Hex(token, signaturePayload),
    }),
  });

  const bootstrapStatus = response.ok ? "bootstrapping" : "failed";
  const updated = await prisma.instanceRegistry.update({
    where: { id: instance.id },
    data: {
      bootstrapStatus,
      provisioningStatus: response.ok ? "bootstrapping" : "degraded",
      lastProvisioningError: response.ok ? null : `Bootstrap endpoint returned ${response.status}.`,
    },
  });
  await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.bootstrap_triggered", {
    status: response.status,
    ok: response.ok,
    expiresAt,
  });
  return updated;
}
