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
} from "./railway-client";

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
  release?: { imageTag?: string | null };
  runtime?: { redis?: string; storage?: string };
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

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
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
  return createWorkspace(actor, {
    name: params.name,
    slug: params.slug,
  });
}

export async function listExternalInstances(actor: AppActor) {
  requireGlobalOperator(actor);
  return prisma.instanceRegistry.findMany({
    orderBy: { createdAt: "desc" }
  });
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
  bootstrapBundleUri?: string;
  bootstrapBundleChecksum?: string;
  bootstrapBundleSchemaVersion?: string;
}) {
  requireGlobalOperator(actor);
  const instance = await prisma.instanceRegistry.create({
    data: {
      label: params.label,
      url: params.url,
      environment: params.environment || "production",
      notes: params.notes,
      customerSlug: params.customerSlug ? normalizeSlug(params.customerSlug) : null,
      region: normalizeOptional(params.region),
      dataResidency: normalizeOptional(params.dataResidency),
      customDomain: normalizeOptional(params.customDomain),
      supportOwnerEmail: normalizeOptional(params.supportOwnerEmail),
      releaseVersion: normalizeOptional(params.releaseVersion),
      releaseImageTag: normalizeOptional(params.releaseImageTag),
      bootstrapBundleUri: normalizeOptional(params.bootstrapBundleUri),
      bootstrapBundleChecksum: normalizeOptional(params.bootstrapBundleChecksum),
      bootstrapBundleSchemaVersion: normalizeOptional(params.bootstrapBundleSchemaVersion),
    }
  });
  await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.registered", {
    customerSlug: instance.customerSlug,
    region: instance.region,
    releaseImageTag: instance.releaseImageTag,
    hasBootstrapBundle: Boolean(instance.bootstrapBundleUri),
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
      if (instance.releaseImageTag && health?.release?.imageTag && health.release.imageTag !== instance.releaseImageTag) {
        status = "degraded";
        error = `Release drift: expected ${instance.releaseImageTag}, got ${health.release.imageTag}`;
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
    lastProvisioningError?: string | null;
  } = {};

  if (params.provisioningStatus) {
    data.provisioningStatus = requireStatus(params.provisioningStatus, HOSTED_PROVISIONING_STATUSES, "provisioning");
  }
  if (params.bootstrapStatus) {
    data.bootstrapStatus = requireStatus(params.bootstrapStatus, HOSTED_BOOTSTRAP_STATUSES, "bootstrap");
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
  webImage: string;
  workerImage: string;
  bootstrapBundleUri?: string | null;
  bootstrapBundleChecksum?: string | null;
  bootstrapBundleSchemaVersion?: string | null;
  variables?: Record<string, string>;
}, railwayClient: RailwayClient = createRailwayClientFromEnv()) {
  requireGlobalOperator(actor);
  const customerSlug = normalizeSlug(params.customerSlug);
  assertDataResidency(params.region, params.dataResidency);
  const url = params.customDomain?.trim()
    ? `https://${params.customDomain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")}`
    : `https://${customerSlug}.corgtex.com`;

  const instance = await prisma.instanceRegistry.upsert({
    where: { customerSlug },
    update: {
      label: params.label,
      url,
      environment: "production",
      customerSlug,
      region: params.region,
      dataResidency: params.dataResidency,
      customDomain: normalizeOptional(params.customDomain),
      supportOwnerEmail: normalizeOptional(params.supportOwnerEmail),
      releaseVersion: normalizeOptional(params.releaseVersion),
      releaseImageTag: params.releaseImageTag,
      bootstrapBundleUri: normalizeOptional(params.bootstrapBundleUri),
      bootstrapBundleChecksum: normalizeOptional(params.bootstrapBundleChecksum),
      bootstrapBundleSchemaVersion: normalizeOptional(params.bootstrapBundleSchemaVersion),
      provisioningStatus: "provisioning",
      bootstrapStatus: params.bootstrapBundleUri ? "pending" : "not_started",
      lastProvisioningError: null,
    },
    create: {
      label: params.label,
      url,
      environment: "production",
      customerSlug,
      region: params.region,
      dataResidency: params.dataResidency,
      customDomain: normalizeOptional(params.customDomain),
      supportOwnerEmail: normalizeOptional(params.supportOwnerEmail),
      releaseVersion: normalizeOptional(params.releaseVersion),
      releaseImageTag: params.releaseImageTag,
      bootstrapBundleUri: normalizeOptional(params.bootstrapBundleUri),
      bootstrapBundleChecksum: normalizeOptional(params.bootstrapBundleChecksum),
      bootstrapBundleSchemaVersion: normalizeOptional(params.bootstrapBundleSchemaVersion),
      provisioningStatus: "provisioning",
      bootstrapStatus: params.bootstrapBundleUri ? "pending" : "not_started",
    },
  });

  await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.provisioning_started", {
    customerSlug,
    region: params.region,
    dataResidency: params.dataResidency,
    releaseImageTag: params.releaseImageTag,
    hasBootstrapBundle: Boolean(params.bootstrapBundleUri),
  });

  try {
    const result = await provisionRailwayCustomerStack(railwayClient, {
      projectName: `corgtex-${customerSlug}`,
      environmentName: "production",
      region: params.region,
      webImage: params.webImage,
      workerImage: params.workerImage,
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
        lastProvisioningError: message,
      },
    });
    await recordHostedInstanceEvent(actor, instance.id, "hosted_instance.provisioning_failed", {
      error: message,
    });
    throw error;
  }
}

export async function upgradeHostedInstanceRelease(actor: AppActor, params: {
  instanceId: string;
  releaseVersion?: string | null;
  releaseImageTag: string;
  webImage: string;
  workerImage: string;
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

  const response = await fetch(`${instance.url.replace(/\/$/, "")}/api/internal/instance-bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customerSlug: instance.customerSlug,
      bundleUri: instance.bootstrapBundleUri,
      checksum: instance.bootstrapBundleChecksum,
      schemaVersion: instance.bootstrapBundleSchemaVersion,
      expiresAt: params.expiresAt.toISOString(),
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
    expiresAt: params.expiresAt.toISOString(),
  });
  return updated;
}
