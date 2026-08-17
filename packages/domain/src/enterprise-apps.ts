import type {
  AppInstallationStatus,
  AppRuntimeMode,
  AppRuntimeStatus,
  AppSurface,
  Prisma,
} from "@prisma/client";
import { prisma, randomOpaqueToken, sha256, toInputJson } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { ALL_SCOPES } from "./agent-auth";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { AppError, invariant } from "./errors";
import { isCanonicalWorkspaceSystemEmail } from "./workspaces";
import {
  createRailwayClientFromEnv,
  provisionRailwayAppRuntime,
  upgradeRailwayAppRuntimeRelease,
  type RailwayClient,
  type RailwayRuntimeServiceSource,
} from "./railway-client";

const APP_ADMIN_ROLES = new Set(["ADMIN"]);
const APP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,94}[a-z0-9]$/;
const DEFAULT_SESSION_TTL_SECONDS = 5 * 60;
const DEFAULT_APP_MCP_TIMEOUT_MS = 10_000;
const SESSION_TOKEN_PARAM = "corgtex_launch_token";
const APP_MCP_TOOL_SCOPE_REQUIREMENTS: Record<string, string[]> = {
  create_time_entries: ["finance:write"],
  create_expenses: ["finance:write"],
  submit_finance_entries: ["finance:write"],
};
const RETIRED_ENTERPRISE_APP_KEYS = new Set(["practice-ledger"]);

const APP_SURFACES: AppSurface[] = ["FINANCE"];
const INSTALLATION_STATUSES: AppInstallationStatus[] = ["REQUESTED", "APPROVED", "INSTALLED", "NEEDS_SETUP", "UNHEALTHY", "DISABLED"];
const RUNTIME_MODES: AppRuntimeMode[] = ["SHARED_MULTI_TENANT", "ISOLATED_SINGLE_TENANT", "SELF_MANAGED_EXTERNAL"];
const RUNTIME_STATUSES: AppRuntimeStatus[] = ["PROVISIONING", "ACTIVE", "UNHEALTHY", "DISABLED"];
const RELEASE_STATUSES = ["PREPARED", "ACTIVE", "ROLLED_BACK", "FAILED"] as const;
export const ENTERPRISE_APP_HEALTH_CHECK_JOB_TYPE = "enterprise-app.health.check";
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

type JsonRecord = Record<string, unknown>;

type EnterpriseAppInstallationRecord = Prisma.AppInstallationGetPayload<{
  include: {
    appDefinition: true;
    runtime: true;
    release: true;
    catalogItem: {
      select: {
        id: true;
        title: true;
        url: true;
        appMcpUrl: true;
        installationStatus: true;
      };
    };
    surfaceAssignments: true;
  };
}>;

export type EnterpriseAppManifest = {
  appKey: string;
  version: string;
  supportedSurfaces: AppSurface[];
  requestedScopes: string[];
  authMode: "corgtex_launch_token";
  healthUrl: string;
  mcpUrl: string | null;
  dataClassification: string;
  tenantMode: "single_tenant" | "multi_tenant" | "external";
  embed: {
    supported: boolean;
    path: string | null;
  };
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeAppKey(value: string | null | undefined) {
  const appKey = text(value)?.toLowerCase();
  invariant(appKey && APP_KEY_PATTERN.test(appKey), 400, "INVALID_INPUT", "App key must be a DNS-safe app identifier.");
  return appKey;
}

function assertAppKeyIsNotRetired(appKey: string) {
  invariant(
    !RETIRED_ENTERPRISE_APP_KEYS.has(appKey),
    410,
    "APP_RETIRED",
    "The standalone Practice Ledger app is retired. Use native Corgtex Finance instead.",
  );
}

function enumOrDefault<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? value as T : fallback;
}

function normalizeSurface(value: string | null | undefined): AppSurface {
  const surface = text(value)?.toUpperCase();
  invariant(surface && APP_SURFACES.includes(surface as AppSurface), 400, "INVALID_INPUT", "Unsupported app surface.");
  return surface as AppSurface;
}

function normalizeOptionalUrl(value: string | null | undefined, label: string) {
  const raw = text(value);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(400, "INVALID_INPUT", `${label} must be a valid URL.`);
  }
  invariant(parsed.protocol === "https:" || parsed.protocol === "http:", 400, "INVALID_INPUT", `${label} must use http or https.`);
  return parsed.toString().replace(/\/$/, "");
}

function normalizePath(value: string | null | undefined) {
  const raw = text(value);
  if (!raw) return null;
  invariant(raw.startsWith("/"), 400, "INVALID_INPUT", "Launch path must start with /.");
  return raw;
}

function normalizeDataClassification(value: string | null | undefined) {
  return text(value)?.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64) ?? "INTERNAL";
}

function normalizeScopes(scopes: unknown, label = "scopes") {
  invariant(Array.isArray(scopes), 400, "INVALID_INPUT", `${label} must be an array.`);
  const normalized = [...new Set(scopes.map((scope) => text(scope)).filter((scope): scope is string => Boolean(scope)))];
  invariant(normalized.length > 0, 400, "INVALID_INPUT", `${label} must include at least one scope.`);
  const unknown = normalized.filter((scope) => !ALL_SCOPES.includes(scope as typeof ALL_SCOPES[number]));
  invariant(unknown.length === 0, 400, "INVALID_INPUT", `Unknown scope(s): ${unknown.join(", ")}.`);
  return normalized;
}

function canManageEnterpriseApps(membership: MembershipSummary | null | undefined) {
  return Boolean(membership && APP_ADMIN_ROLES.has(membership.role));
}

function assertCanManageEnterpriseApps(membership: MembershipSummary | null | undefined) {
  invariant(canManageEnterpriseApps(membership), 403, "FORBIDDEN", "Only workspace admins can manage enterprise apps.");
}

function installationStatus(value: string | null | undefined): AppInstallationStatus {
  return enumOrDefault(value, INSTALLATION_STATUSES, "NEEDS_SETUP");
}

function runtimeMode(value: string | null | undefined): AppRuntimeMode {
  return enumOrDefault(value, RUNTIME_MODES, "SHARED_MULTI_TENANT");
}

function runtimeStatus(value: string | null | undefined): AppRuntimeStatus {
  return enumOrDefault(value, RUNTIME_STATUSES, "ACTIVE");
}

function releaseStatus(value: string | null | undefined) {
  return enumOrDefault(value, RELEASE_STATUSES, "PREPARED");
}

function healthyStatus(value: string | null | undefined) {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === "ok" || normalized === "healthy" || normalized === "active" || normalized === "ready";
}

function unhealthyStatus(value: string | null | undefined) {
  if (!value) return "degraded";
  const normalized = value.trim().toLowerCase();
  if (normalized === "down" || normalized === "offline" || normalized === "failed") return "down";
  return "degraded";
}

function manifestHealthUrlFor(runtime: { healthUrl?: string | null; baseUrl?: string | null }) {
  if (runtime.healthUrl) return runtime.healthUrl;
  return runtime.baseUrl ? `${runtime.baseUrl.replace(/\/$/, "")}/api/health` : null;
}

function healthPayloadSummary(value: unknown) {
  if (!isRecord(value)) return null;
  const summary: JsonRecord = {};
  const status = text(value.status);
  const service = text(value.service);
  if (status) summary.status = status;
  if (service) summary.service = service;
  return Object.keys(summary).length > 0 ? summary : null;
}

function runtimeMetadata(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function hasCompleteRailwayAppRuntime(runtime: {
  railwayProjectId?: string | null;
  railwayEnvironmentId?: string | null;
  railwayServiceId?: string | null;
  metadataJson?: unknown;
}) {
  const metadata = runtimeMetadata(runtime.metadataJson);
  return Boolean(
    runtime.railwayProjectId
      && runtime.railwayEnvironmentId
      && runtime.railwayServiceId
      && text(metadata.railwayPostgresServiceId)
      && text(metadata.railwayRedisServiceId),
  );
}

function hasAnyRailwayAppRuntimeResource(runtime: {
  railwayProjectId?: string | null;
  railwayEnvironmentId?: string | null;
  railwayServiceId?: string | null;
  metadataJson?: unknown;
}) {
  const metadata = runtimeMetadata(runtime.metadataJson);
  return Boolean(
    runtime.railwayProjectId
      || runtime.railwayEnvironmentId
      || runtime.railwayServiceId
      || text(metadata.railwayPostgresServiceId)
      || text(metadata.railwayRedisServiceId),
  );
}

function projectNameForAppRuntime(appKey: string, workspaceId: string, mode: AppRuntimeMode) {
  const suffix = mode === "SHARED_MULTI_TENANT" ? "shared" : workspaceId.slice(0, 8).toLowerCase();
  return `corgtex-app-${appKey}-${suffix}`.replace(/[^a-z0-9-]/g, "-").slice(0, 96);
}

function buildEnterpriseAppRuntimeVariables(params: {
  appKey: string;
  workspaceId: string;
  runtimeMode: AppRuntimeMode;
  baseUrl: string;
  releaseVersion?: string | null;
  imageTag?: string | null;
  overrides?: Record<string, string> | null;
}) {
  return {
    CORGTEX_APP_KEY: params.appKey,
    CORGTEX_WORKSPACE_ID: params.workspaceId,
    CORGTEX_APP_RUNTIME_MODE: params.runtimeMode,
    APP_URL: params.baseUrl,
    ...(params.releaseVersion ? { CORGTEX_APP_RELEASE_VERSION: params.releaseVersion } : {}),
    ...(params.imageTag ? { CORGTEX_APP_RELEASE_IMAGE_TAG: params.imageTag } : {}),
    ...(params.overrides ?? {}),
  };
}

function assertManifestCompatible(manifest: unknown, definition: {
  appKey: string;
  supportedSurfaces: AppSurface[];
  requestedScopes: string[];
}) {
  const parsed = validateEnterpriseAppManifest(manifest);
  invariant(parsed.appKey === definition.appKey, 400, "APP_MANIFEST_MISMATCH", "Manifest app key does not match the app definition.");
  const missingSurfaces = definition.supportedSurfaces.filter((surface) => !parsed.supportedSurfaces.includes(surface));
  invariant(missingSurfaces.length === 0, 400, "APP_MANIFEST_INCOMPATIBLE", `Manifest is missing supported surface(s): ${missingSurfaces.join(", ")}.`);
  const missingScopes = definition.requestedScopes.filter((scope) => !parsed.requestedScopes.includes(scope));
  invariant(missingScopes.length === 0, 400, "APP_MANIFEST_INCOMPATIBLE", `Manifest is missing requested scope(s): ${missingScopes.join(", ")}.`);
  return parsed;
}

async function fetchJsonWithTimeout(url: string, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function postJsonWithTimeout(url: string, params: {
  token: string;
  body: unknown;
  timeoutMs?: number | null;
}) {
  const timeoutMs = Math.min(Math.max(Math.floor(params.timeoutMs ?? DEFAULT_APP_MCP_TIMEOUT_MS), 1_000), 30_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function serializeInstallation(row: EnterpriseAppInstallationRecord) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status,
    tenantExternalId: row.tenantExternalId,
    tenantMappingJson: row.tenantMappingJson,
    requestedScopes: row.requestedScopes,
    grantedScopes: row.grantedScopes,
    launchPath: row.launchPath,
    sessionTtlSeconds: row.sessionTtlSeconds,
    lastHealthAt: row.lastHealthAt,
    lastHealthStatus: row.lastHealthStatus,
    lastHealthError: row.lastHealthError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    app: {
      id: row.appDefinition.id,
      appKey: row.appDefinition.appKey,
      title: row.appDefinition.title,
      category: row.appDefinition.category,
      status: row.appDefinition.status,
      dataClassification: row.appDefinition.dataClassification,
      supportedSurfaces: row.appDefinition.supportedSurfaces,
      requestedScopes: row.appDefinition.requestedScopes,
    },
    runtime: row.runtime ? {
      id: row.runtime.id,
      mode: row.runtime.mode,
      status: row.runtime.status,
      environment: row.runtime.environment,
      baseUrl: row.runtime.baseUrl,
      healthUrl: row.runtime.healthUrl,
      mcpUrl: row.runtime.mcpUrl,
      lastHealthAt: row.runtime.lastHealthAt,
      lastHealthStatus: row.runtime.lastHealthStatus,
      lastHealthError: row.runtime.lastHealthError,
    } : null,
    release: row.release ? {
      id: row.release.id,
      version: row.release.version,
      gitSha: row.release.gitSha,
      imageTag: row.release.imageTag,
      manifestVersion: row.release.manifestVersion,
      status: row.release.status,
      healthStatus: row.release.healthStatus,
      releasedAt: row.release.releasedAt,
      metadataJson: row.release.metadataJson,
    } : null,
    catalogItem: row.catalogItem,
    surfaces: row.surfaceAssignments.map((assignment) => ({
      id: assignment.id,
      surface: assignment.surface,
      enabled: assignment.enabled,
      reasonMd: assignment.reasonMd,
      updatedAt: assignment.updatedAt,
    })),
  };
}

async function getInstallation(workspaceId: string, appInstallationId: string) {
  const row = await prisma.appInstallation.findFirst({
    where: { id: appInstallationId, workspaceId },
    include: {
      appDefinition: true,
      runtime: true,
      release: true,
      catalogItem: {
        select: {
          id: true,
          title: true,
          url: true,
          appMcpUrl: true,
          installationStatus: true,
        },
      },
      surfaceAssignments: true,
    },
  });
  invariant(row, 404, "NOT_FOUND", "Enterprise app installation not found.");
  return row;
}

async function getInstallationByAppKey(workspaceId: string, appKey: string) {
  const row = await prisma.appInstallation.findFirst({
    where: {
      workspaceId,
      appDefinition: { appKey },
    },
    include: {
      appDefinition: true,
      runtime: true,
      release: true,
      catalogItem: {
        select: {
          id: true,
          title: true,
          url: true,
          appMcpUrl: true,
          installationStatus: true,
        },
      },
      surfaceAssignments: true,
    },
  });
  invariant(row, 404, "NOT_FOUND", "Enterprise app installation not found.");
  return row;
}

async function getInstallationBySurface(workspaceId: string, surface: AppSurface) {
  const assignment = await prisma.appSurfaceAssignment.findUnique({
    where: {
      workspaceId_surface: {
        workspaceId,
        surface,
      },
    },
    include: {
      appInstallation: {
        include: {
          appDefinition: true,
          runtime: true,
          release: true,
          catalogItem: {
            select: {
              id: true,
              title: true,
              url: true,
              appMcpUrl: true,
              installationStatus: true,
            },
          },
          surfaceAssignments: true,
        },
      },
    },
  });
  invariant(assignment?.enabled, 404, "NOT_FOUND", "No enabled enterprise app is assigned to this surface.");
  return assignment.appInstallation;
}

function unavailableReasons(row: EnterpriseAppInstallationRecord) {
  const reasons: string[] = [];
  if (row.appDefinition.status !== "ACTIVE") reasons.push("App definition is disabled.");
  if (row.status !== "INSTALLED") reasons.push(`Installation status is ${row.status}.`);
  if (!row.runtime) reasons.push("Runtime is not configured.");
  if (row.runtime && row.runtime.status !== "ACTIVE") reasons.push(`Runtime status is ${row.runtime.status}.`);
  if (row.runtime && !row.runtime.baseUrl) reasons.push("Runtime base URL is missing.");
  if (row.lastHealthStatus && !healthyStatus(row.lastHealthStatus)) reasons.push(`Installation health is ${row.lastHealthStatus}.`);
  if (row.runtime?.lastHealthStatus && !healthyStatus(row.runtime.lastHealthStatus)) reasons.push(`Runtime health is ${row.runtime.lastHealthStatus}.`);
  return reasons;
}

function buildLaunchUrl(row: EnterpriseAppInstallationRecord, token: string) {
  invariant(row.runtime?.baseUrl, 400, "APP_RUNTIME_UNAVAILABLE", "App runtime URL is not configured.");
  const path = row.launchPath || "/dashboard?embedded=1";
  const url = new URL(path, row.runtime.baseUrl.endsWith("/") ? row.runtime.baseUrl : `${row.runtime.baseUrl}/`);
  url.searchParams.set(SESSION_TOKEN_PARAM, token);
  url.searchParams.set("corgtex_workspace_id", row.workspaceId);
  url.searchParams.set("corgtex_app_installation_id", row.id);
  url.searchParams.set("embedded", "1");
  return url.toString();
}

function normalizeOptionalScopes(scopes: unknown, label = "scopes") {
  if (scopes === null || scopes === undefined) return [];
  invariant(Array.isArray(scopes), 400, "INVALID_INPUT", `${label} must be an array.`);
  const normalized = [...new Set(scopes.map((scope) => text(scope)).filter((scope): scope is string => Boolean(scope)))];
  const unknown = normalized.filter((scope) => !ALL_SCOPES.includes(scope as typeof ALL_SCOPES[number]));
  invariant(unknown.length === 0, 400, "INVALID_INPUT", `Unknown scope(s): ${unknown.join(", ")}.`);
  return normalized;
}

function appMcpUrlFor(row: EnterpriseAppInstallationRecord) {
  return row.runtime?.mcpUrl || row.catalogItem?.appMcpUrl || null;
}

function scopedAppToolRequirements(toolName: string, requiredScopes?: string[] | null) {
  const inferredScopes = APP_MCP_TOOL_SCOPE_REQUIREMENTS[toolName] ?? [];
  const explicitScopes = requiredScopes ?? [];
  invariant(
    inferredScopes.length > 0 || explicitScopes.length > 0,
    400,
    "APP_MCP_SCOPE_REQUIRED",
    "Installed app MCP calls require at least one required scope.",
  );
  return [...new Set([
    ...inferredScopes,
    ...explicitScopes,
  ])];
}

async function createEnterpriseAppSession(actor: AppActor, params: {
  workspaceId: string;
  row: EnterpriseAppInstallationRecord;
  ttlSeconds?: number | null;
}) {
  const row = params.row;
  const token = randomOpaqueToken();
  const expiresAt = new Date(Date.now() + Math.max(params.ttlSeconds || row.sessionTtlSeconds || DEFAULT_SESSION_TTL_SECONDS, 60) * 1000);
  const actorPayload = actor.kind === "user"
    ? await requireLiveEnterpriseAppUser(actor.user.id, params.workspaceId).then((liveActor) => ({
      user: {
        id: liveActor.user.id,
        email: liveActor.user.email,
        displayName: liveActor.user.displayName,
        role: liveActor.membership.role,
      },
    }))
    : {
      agent: {
        label: actor.label,
        authProvider: actor.authProvider,
        credentialId: actor.credentialId,
        agentIdentityId: actor.agentIdentityId,
      },
    };
  const payload = {
    issuer: "corgtex",
    audience: row.appDefinition.appKey,
    appKey: row.appDefinition.appKey,
    appInstallationId: row.id,
    workspaceId: params.workspaceId,
    ...actorPayload,
    tenantExternalId: row.tenantExternalId,
    tenantMappingJson: row.tenantMappingJson,
    scopes: row.grantedScopes,
    dataClassification: row.appDefinition.dataClassification,
    expiresAt: expiresAt.toISOString(),
  };
  await prisma.appSession.create({
    data: {
      workspaceId: params.workspaceId,
      appInstallationId: row.id,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      audience: row.appDefinition.appKey,
      tokenHash: sha256(token),
      scopes: row.grantedScopes,
      payloadJson: toInputJson(payload),
      expiresAt,
    },
  });

  return { token, expiresAt, payload };
}

async function requireLiveEnterpriseAppUser(userId: string, workspaceId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      memberships: {
        where: { workspaceId },
        select: {
          id: true,
          role: true,
          kind: true,
          isActive: true,
          mergedAt: true,
          mergedIntoMemberId: true,
        },
      },
    },
  });
  const membership = user?.memberships[0];
  invariant(
    user
      && !isCanonicalWorkspaceSystemEmail(user.email)
      && membership
      && membership.isActive
      && membership.mergedAt === null
      && membership.mergedIntoMemberId === null,
    401,
    "INVALID_APP_SESSION_ACTOR",
    "Enterprise app session actor is no longer eligible for this workspace.",
  );
  return { user, membership };
}

export function validateEnterpriseAppManifest(value: unknown): EnterpriseAppManifest {
  invariant(isRecord(value), 400, "INVALID_INPUT", "App manifest must be an object.");
  const appKey = normalizeAppKey(text(value.appKey));
  const version = text(value.version);
  invariant(version, 400, "INVALID_INPUT", "App manifest version is required.");
  const surfacesRaw = Array.isArray(value.supportedSurfaces) ? value.supportedSurfaces : [];
  const supportedSurfaces = [...new Set(surfacesRaw.map((surface) => normalizeSurface(text(surface))))];
  invariant(supportedSurfaces.length > 0, 400, "INVALID_INPUT", "App manifest must declare at least one supported surface.");
  const requestedScopes = normalizeScopes(value.requestedScopes ?? value.scopes, "requestedScopes");
  const auth = isRecord(value.auth) ? value.auth : null;
  const authMode = text(auth?.mode ?? value.authMode);
  invariant(authMode === "corgtex_launch_token", 400, "INVALID_INPUT", "App manifest must use Corgtex launch-token auth.");
  const healthUrl = normalizeOptionalUrl(text(value.healthUrl), "healthUrl");
  invariant(healthUrl, 400, "INVALID_INPUT", "App manifest healthUrl is required.");
  const mcpUrl = normalizeOptionalUrl(text(value.mcpUrl), "mcpUrl");
  const embed = isRecord(value.embed) ? value.embed : {};
  return {
    appKey,
    version,
    supportedSurfaces,
    requestedScopes,
    authMode: "corgtex_launch_token",
    healthUrl,
    mcpUrl,
    dataClassification: normalizeDataClassification(text(value.dataClassification)),
    tenantMode: enumOrDefault(text(value.tenantMode), ["single_tenant", "multi_tenant", "external"], "multi_tenant"),
    embed: {
      supported: Boolean(embed.supported ?? value.embedSupported),
      path: normalizePath(text(embed.path ?? value.embedPath)),
    },
  };
}

export async function runEnterpriseAppHealthCheckJob(params: {
  runtimeId: string;
  reason?: string | null;
  timeoutMs?: number | null;
}) {
  const runtimeId = text(params.runtimeId);
  invariant(runtimeId, 400, "INVALID_INPUT", "Runtime ID is required.");
  const runtime = await prisma.appRuntime.findUnique({
    where: { id: runtimeId },
    include: {
      appDefinition: true,
      installations: true,
      releases: true,
    },
  });
  invariant(runtime, 404, "NOT_FOUND", "Enterprise app runtime not found.");

  const timeoutMs = Math.min(Math.max(Math.floor(params.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS), 1_000), 30_000);
  const checkedAt = new Date();
  let manifest: EnterpriseAppManifest | null = null;
  let status = "ok";
  let error: string | null = null;
  let healthPayload: unknown = null;

  try {
    if (runtime.appDefinition.manifestUrl) {
      const manifestResponse = await fetchJsonWithTimeout(runtime.appDefinition.manifestUrl, timeoutMs);
      invariant(manifestResponse.response.ok, 400, "APP_MANIFEST_UNAVAILABLE", `Manifest returned status ${manifestResponse.response.status}.`);
      const nextManifest = validateEnterpriseAppManifest(manifestResponse.body);
      invariant(nextManifest.appKey === runtime.appDefinition.appKey, 400, "APP_MANIFEST_MISMATCH", "Manifest app key does not match the app definition.");
      manifest = nextManifest;
    }

    const healthUrl = manifest?.healthUrl ?? manifestHealthUrlFor(runtime);
    invariant(healthUrl, 400, "APP_HEALTH_URL_MISSING", "Enterprise app runtime health URL is not configured.");
    const healthResponse = await fetchJsonWithTimeout(healthUrl, timeoutMs);
    healthPayload = healthResponse.body;
    if (!healthResponse.response.ok) {
      status = "down";
      error = `Health returned status ${healthResponse.response.status}.`;
    } else if (isRecord(healthPayload) && typeof healthPayload.status === "string" && !healthyStatus(healthPayload.status)) {
      status = unhealthyStatus(healthPayload.status);
      error = `Health reported ${healthPayload.status}.`;
    }
  } catch (healthError) {
    status = healthError instanceof AppError && healthError.code !== "APP_HEALTH_URL_MISSING" ? "degraded" : "down";
    error = healthError instanceof Error ? healthError.message : "Enterprise app health check failed.";
  }

  const nextRuntimeStatus: AppRuntimeStatus = runtime.status === "DISABLED"
    ? "DISABLED"
    : status === "ok"
      ? "ACTIVE"
      : "UNHEALTHY";
  const nextInstallationStatus = (installation: typeof runtime.installations[number]): AppInstallationStatus => {
    if (installation.status === "DISABLED" || installation.status === "REQUESTED" || installation.status === "APPROVED") return installation.status;
    if (status !== "ok") return installation.status === "NEEDS_SETUP" ? "NEEDS_SETUP" : "UNHEALTHY";
    return installation.tenantExternalId && runtime.baseUrl ? "INSTALLED" : installation.status;
  };

  await prisma.$transaction(async (tx) => {
    if (manifest) {
      await tx.appDefinition.update({
        where: { id: runtime.appDefinitionId },
        data: {
          manifestJson: toInputJson(manifest),
          supportedSurfaces: manifest.supportedSurfaces,
          requestedScopes: manifest.requestedScopes,
          dataClassification: manifest.dataClassification,
        },
      });
    }
    await tx.appRuntime.update({
      where: { id: runtime.id },
      data: {
        status: nextRuntimeStatus,
        healthUrl: manifest?.healthUrl ?? runtime.healthUrl,
        mcpUrl: manifest?.mcpUrl ?? runtime.mcpUrl,
        lastHealthAt: checkedAt,
        lastHealthStatus: status,
        lastHealthError: error,
        metadataJson: toInputJson({
          ...(isRecord(runtime.metadataJson) ? runtime.metadataJson : {}),
          lastHealthReason: text(params.reason),
          lastHealthPayload: healthPayloadSummary(healthPayload),
        }),
      },
    });
    for (const installation of runtime.installations) {
      await tx.appInstallation.update({
        where: { id: installation.id },
        data: {
          status: nextInstallationStatus(installation),
          lastHealthAt: checkedAt,
          lastHealthStatus: status,
          lastHealthError: error,
        },
      });
    }
    await tx.appRelease.updateMany({
      where: {
        runtimeId: runtime.id,
        status: { in: ["PREPARED", "ACTIVE"] },
      },
      data: {
        healthStatus: status,
      },
    });
  });

  return {
    runtimeId: runtime.id,
    appKey: runtime.appDefinition.appKey,
    status,
    error,
    checkedAt,
    manifestVersion: manifest?.version ?? null,
    installationCount: runtime.installations.length,
    releaseCount: runtime.releases.length,
  };
}

export async function listEnterpriseAppDefinitions() {
  return prisma.appDefinition.findMany({
    where: {
      status: "ACTIVE",
      appKey: { notIn: [...RETIRED_ENTERPRISE_APP_KEYS] },
    },
    orderBy: [{ category: "asc" }, { title: "asc" }],
  });
}

export async function listWorkspaceEnterpriseApps(actor: AppActor, workspaceId: string) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const installations = await prisma.appInstallation.findMany({
    where: { workspaceId },
    include: {
      appDefinition: true,
      runtime: true,
      release: true,
      catalogItem: {
        select: {
          id: true,
          title: true,
          url: true,
          appMcpUrl: true,
          installationStatus: true,
        },
      },
      surfaceAssignments: true,
    },
    orderBy: [{ updatedAt: "desc" }],
  });

  return {
    canManage: canManageEnterpriseApps(membership),
    installations: installations.map(serializeInstallation),
  };
}

export async function installEnterpriseApp(actor: AppActor, params: {
  workspaceId: string;
  appKey: string;
  catalogItemId?: string | null;
  surface?: string | null;
  runtimeMode?: string | null;
  runtimeStatus?: string | null;
  runtimeBaseUrl?: string | null;
  runtimeHealthUrl?: string | null;
  runtimeMcpUrl?: string | null;
  tenantExternalId?: string | null;
  tenantMappingJson?: Record<string, unknown> | null;
  launchPath?: string | null;
  status?: string | null;
  grantedScopes?: string[];
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const appKey = normalizeAppKey(params.appKey);
  assertAppKeyIsNotRetired(appKey);
  const definition = await prisma.appDefinition.findUnique({ where: { appKey } });
  invariant(definition, 404, "NOT_FOUND", "Enterprise app definition not found.");
  invariant(definition.status === "ACTIVE", 400, "APP_DISABLED", "Enterprise app definition is disabled.");

  const runtimeBaseUrl = normalizeOptionalUrl(params.runtimeBaseUrl, "Runtime base URL");
  const runtimeHealthUrl = normalizeOptionalUrl(params.runtimeHealthUrl, "Runtime health URL");
  const runtimeMcpUrl = normalizeOptionalUrl(params.runtimeMcpUrl, "Runtime MCP URL");
  const tenantExternalId = text(params.tenantExternalId);
  const launchPath = normalizePath(params.launchPath);
  const status = params.status
    ? installationStatus(params.status)
    : runtimeBaseUrl && tenantExternalId
      ? "INSTALLED"
      : "NEEDS_SETUP";
  const grantedScopes = params.grantedScopes?.length ? normalizeScopes(params.grantedScopes, "grantedScopes") : definition.requestedScopes;

  const installation = await prisma.$transaction(async (tx) => {
    const existing = await tx.appInstallation.findUnique({
      where: {
        workspaceId_appDefinitionId: {
          workspaceId: params.workspaceId,
          appDefinitionId: definition.id,
        },
      },
      include: { runtime: true },
    });
    let runtimeId = existing?.runtimeId ?? null;
    if (runtimeBaseUrl || runtimeHealthUrl || runtimeMcpUrl) {
      if (runtimeId) {
        await tx.appRuntime.update({
          where: { id: runtimeId },
          data: {
            mode: runtimeMode(params.runtimeMode),
            status: runtimeStatus(params.runtimeStatus),
            baseUrl: runtimeBaseUrl,
            healthUrl: runtimeHealthUrl ?? (runtimeBaseUrl ? `${runtimeBaseUrl}/api/health` : null),
            mcpUrl: runtimeMcpUrl,
          },
        });
      } else {
        const runtime = await tx.appRuntime.create({
          data: {
            appDefinitionId: definition.id,
            mode: runtimeMode(params.runtimeMode),
            status: runtimeStatus(params.runtimeStatus),
            baseUrl: runtimeBaseUrl,
            healthUrl: runtimeHealthUrl ?? (runtimeBaseUrl ? `${runtimeBaseUrl}/api/health` : null),
            mcpUrl: runtimeMcpUrl,
          },
        });
        runtimeId = runtime.id;
      }
    }

    const row = await tx.appInstallation.upsert({
      where: {
        workspaceId_appDefinitionId: {
          workspaceId: params.workspaceId,
          appDefinitionId: definition.id,
        },
      },
      create: {
        workspaceId: params.workspaceId,
        appDefinitionId: definition.id,
        catalogItemId: params.catalogItemId ?? null,
        runtimeId,
        status,
        tenantExternalId,
        tenantMappingJson: params.tenantMappingJson ? toInputJson(params.tenantMappingJson) : undefined,
        installedByUserId: actor.kind === "user" ? actor.user.id : null,
        installedAt: status === "INSTALLED" ? new Date() : null,
        requestedScopes: definition.requestedScopes,
        grantedScopes,
        launchPath,
      },
      update: {
        catalogItemId: params.catalogItemId ?? undefined,
        runtimeId: runtimeId ?? undefined,
        status,
        tenantExternalId,
        tenantMappingJson: params.tenantMappingJson ? toInputJson(params.tenantMappingJson) : undefined,
        installedByUserId: actor.kind === "user" ? actor.user.id : undefined,
        installedAt: status === "INSTALLED" ? new Date() : undefined,
        requestedScopes: definition.requestedScopes,
        grantedScopes,
        launchPath,
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.installed",
      entityType: "AppInstallation",
      entityId: row.id,
      meta: {
        appKey,
        status,
        surface: params.surface ?? null,
        reason: text(params.reason),
      },
    });

    if (params.surface) {
      const surface = normalizeSurface(params.surface);
      await tx.appSurfaceAssignment.upsert({
        where: {
          workspaceId_surface: {
            workspaceId: params.workspaceId,
            surface,
          },
        },
        create: {
          workspaceId: params.workspaceId,
          surface,
          appInstallationId: row.id,
          assignedByUserId: actor.kind === "user" ? actor.user.id : null,
          reasonMd: text(params.reason),
        },
        update: {
          appInstallationId: row.id,
          enabled: true,
          assignedByUserId: actor.kind === "user" ? actor.user.id : null,
          reasonMd: text(params.reason),
        },
      });
    }

    return row;
  });

  return serializeInstallation(await getInstallation(params.workspaceId, installation.id));
}

export async function assignEnterpriseAppSurface(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  surface: string;
  enabled?: boolean;
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  const surface = normalizeSurface(params.surface);
  const enabled = params.enabled !== false;

  await prisma.$transaction(async (tx) => {
    await tx.appSurfaceAssignment.upsert({
      where: {
        workspaceId_surface: {
          workspaceId: params.workspaceId,
          surface,
        },
      },
      create: {
        workspaceId: params.workspaceId,
        surface,
        appInstallationId: row.id,
        enabled,
        assignedByUserId: actor.kind === "user" ? actor.user.id : null,
        reasonMd: text(params.reason),
      },
      update: {
        appInstallationId: row.id,
        enabled,
        assignedByUserId: actor.kind === "user" ? actor.user.id : null,
        reasonMd: text(params.reason),
      },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.surface_assigned",
      entityType: "AppSurfaceAssignment",
      entityId: `${params.workspaceId}:${surface}`,
      meta: {
        appInstallationId: row.id,
        appKey: row.appDefinition.appKey,
        surface,
        enabled,
        reason: text(params.reason),
      },
    });
  });

  return getEnterpriseAppSurface(actor, { workspaceId: params.workspaceId, surface });
}

export async function updateEnterpriseAppInstallation(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  status?: string | null;
  runtimeMode?: string | null;
  runtimeStatus?: string | null;
  runtimeBaseUrl?: string | null;
  runtimeHealthUrl?: string | null;
  runtimeMcpUrl?: string | null;
  tenantExternalId?: string | null;
  tenantMappingJson?: Record<string, unknown> | null;
  launchPath?: string | null;
  grantedScopes?: string[];
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  const runtimeBaseUrl = params.runtimeBaseUrl !== undefined ? normalizeOptionalUrl(params.runtimeBaseUrl, "Runtime base URL") : undefined;
  const runtimeHealthUrl = params.runtimeHealthUrl !== undefined ? normalizeOptionalUrl(params.runtimeHealthUrl, "Runtime health URL") : undefined;
  const runtimeMcpUrl = params.runtimeMcpUrl !== undefined ? normalizeOptionalUrl(params.runtimeMcpUrl, "Runtime MCP URL") : undefined;
  const status = params.status !== undefined ? installationStatus(params.status) : undefined;
  const tenantExternalId = params.tenantExternalId !== undefined ? text(params.tenantExternalId) : undefined;
  const launchPath = params.launchPath !== undefined ? normalizePath(params.launchPath) : undefined;
  const grantedScopes = params.grantedScopes !== undefined ? normalizeScopes(params.grantedScopes, "grantedScopes") : undefined;
  const runtimeChanged = params.runtimeMode !== undefined
    || params.runtimeStatus !== undefined
    || params.runtimeBaseUrl !== undefined
    || params.runtimeHealthUrl !== undefined
    || params.runtimeMcpUrl !== undefined;

  const installation = await prisma.$transaction(async (tx) => {
    let runtimeId = row.runtimeId;
    if (runtimeChanged) {
      const runtimeData = {
        ...(params.runtimeMode !== undefined ? { mode: runtimeMode(params.runtimeMode) } : {}),
        ...(params.runtimeStatus !== undefined ? { status: runtimeStatus(params.runtimeStatus) } : {}),
        ...(params.runtimeBaseUrl !== undefined ? { baseUrl: runtimeBaseUrl } : {}),
        ...(params.runtimeHealthUrl !== undefined ? { healthUrl: runtimeHealthUrl } : params.runtimeBaseUrl !== undefined && runtimeBaseUrl ? { healthUrl: `${runtimeBaseUrl}/api/health` } : {}),
        ...(params.runtimeMcpUrl !== undefined ? { mcpUrl: runtimeMcpUrl } : {}),
      };
      if (runtimeId) {
        await tx.appRuntime.update({ where: { id: runtimeId }, data: runtimeData });
      } else {
        const runtime = await tx.appRuntime.create({
          data: {
            appDefinitionId: row.appDefinitionId,
            mode: params.runtimeMode !== undefined ? runtimeMode(params.runtimeMode) : "SELF_MANAGED_EXTERNAL",
            status: params.runtimeStatus !== undefined ? runtimeStatus(params.runtimeStatus) : "ACTIVE",
            baseUrl: runtimeBaseUrl ?? null,
            healthUrl: runtimeHealthUrl ?? (runtimeBaseUrl ? `${runtimeBaseUrl}/api/health` : null),
            mcpUrl: runtimeMcpUrl ?? null,
          },
        });
        runtimeId = runtime.id;
      }
    }

    const updated = await tx.appInstallation.update({
      where: { id: row.id },
      data: {
        ...(runtimeChanged && runtimeId ? { runtimeId } : {}),
        ...(status ? { status, installedAt: status === "INSTALLED" && !row.installedAt ? new Date() : undefined } : {}),
        ...(tenantExternalId !== undefined ? { tenantExternalId } : {}),
        ...(params.tenantMappingJson ? { tenantMappingJson: toInputJson(params.tenantMappingJson) } : {}),
        ...(launchPath !== undefined ? { launchPath } : {}),
        ...(grantedScopes !== undefined ? { grantedScopes } : {}),
      },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.updated",
      entityType: "AppInstallation",
      entityId: row.id,
      meta: {
        appKey: row.appDefinition.appKey,
        status: status ?? row.status,
        runtimeChanged,
        reason: text(params.reason),
      },
    });
    return updated;
  });

  return serializeInstallation(await getInstallation(params.workspaceId, installation.id));
}

export async function probeEnterpriseAppInstallationHealth(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  invariant(row.runtimeId, 400, "APP_RUNTIME_UNAVAILABLE", "App runtime is not configured.");
  const result = await runEnterpriseAppHealthCheckJob({
    runtimeId: row.runtimeId,
    reason: text(params.reason) ?? "Manual enterprise app health probe.",
  });
  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.health_probed",
      entityType: "AppInstallation",
      entityId: row.id,
      meta: {
        appKey: row.appDefinition.appKey,
        status: result.status,
        reason: text(params.reason),
      },
    });
  });
  return {
    result,
    installation: serializeInstallation(await getInstallation(params.workspaceId, row.id)),
  };
}

export async function revokeEnterpriseAppInstallationSessions(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  const revokedAt = new Date();
  const revoked = await prisma.$transaction(async (tx) => {
    const result = await tx.appSession.updateMany({
      where: {
        workspaceId: params.workspaceId,
        appInstallationId: row.id,
        revokedAt: null,
        expiresAt: { gt: revokedAt },
      },
      data: { revokedAt },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.sessions_revoked",
      entityType: "AppInstallation",
      entityId: row.id,
      meta: {
        appKey: row.appDefinition.appKey,
        count: result.count,
        reason: text(params.reason),
      },
    });
    return result.count;
  });
  return { appInstallationId: row.id, revoked };
}

export async function provisionEnterpriseAppRuntime(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  runtimeMode: string;
  runtimeBaseUrl?: string | null;
  runtimeHealthUrl?: string | null;
  runtimeMcpUrl?: string | null;
  environment?: string | null;
  region?: string | null;
  customDomain?: string | null;
  secretsRef?: string | null;
  releaseVersion?: string | null;
  releaseImageTag?: string | null;
  appImage?: string | null;
  appSource?: RailwayRuntimeServiceSource | null;
  variables?: Record<string, string>;
  reason?: string | null;
}, railwayClient?: RailwayClient) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  const mode = runtimeMode(params.runtimeMode);
  const runtimeBaseUrl = normalizeOptionalUrl(params.runtimeBaseUrl, "Runtime base URL");
  const runtimeHealthUrl = normalizeOptionalUrl(params.runtimeHealthUrl, "Runtime health URL");
  const runtimeMcpUrl = normalizeOptionalUrl(params.runtimeMcpUrl, "Runtime MCP URL");
  const customDomain = text(params.customDomain)?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null;
  const baseUrl = runtimeBaseUrl ?? (customDomain ? `https://${customDomain}` : null);
  invariant(baseUrl, 400, "APP_RUNTIME_URL_REQUIRED", "Runtime base URL or custom domain is required.");
  const environment = text(params.environment) ?? "production";
  const secretsRef = text(params.secretsRef);

  if (mode === "SELF_MANAGED_EXTERNAL") {
    const installation = await prisma.$transaction(async (tx) => {
      const runtime = row.runtimeId
        ? await tx.appRuntime.update({
            where: { id: row.runtimeId },
            data: {
              mode,
              status: "PROVISIONING",
              environment,
              baseUrl,
              healthUrl: runtimeHealthUrl ?? `${baseUrl}/api/health`,
              mcpUrl: runtimeMcpUrl,
              secretsRef,
              metadataJson: toInputJson({
                ...runtimeMetadata(row.runtime?.metadataJson),
                hosting: "self_managed_external",
                lastProvisionedAt: new Date().toISOString(),
              }),
            },
          })
        : await tx.appRuntime.create({
            data: {
              appDefinitionId: row.appDefinitionId,
              mode,
              status: "PROVISIONING",
              environment,
              baseUrl,
              healthUrl: runtimeHealthUrl ?? `${baseUrl}/api/health`,
              mcpUrl: runtimeMcpUrl,
              secretsRef,
              metadataJson: toInputJson({
                hosting: "self_managed_external",
                lastProvisionedAt: new Date().toISOString(),
              }),
            },
          });
      const updated = await tx.appInstallation.update({
        where: { id: row.id },
        data: {
          runtimeId: runtime.id,
          status: row.status === "DISABLED" ? "DISABLED" : "NEEDS_SETUP",
        },
      });
      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId,
        action: "enterprise_app.runtime_registered",
        entityType: "AppRuntime",
        entityId: runtime.id,
        meta: {
          appKey: row.appDefinition.appKey,
          mode,
          reason: text(params.reason),
        },
      });
      return updated;
    });
    return serializeInstallation(await getInstallation(params.workspaceId, installation.id));
  }

  invariant(secretsRef, 400, "APP_RUNTIME_SECRETS_REF_REQUIRED", "Managed app runtimes require a secretsRef.");
  const region = text(params.region);
  invariant(region, 400, "INVALID_INPUT", "Managed app runtimes require a Railway region.");
  invariant(params.appImage || params.appSource?.repo, 400, "INVALID_INPUT", "Managed app runtimes require an app image or repository source.");
  if (row.runtime && row.runtime.mode !== "SELF_MANAGED_EXTERNAL") {
    if (hasCompleteRailwayAppRuntime(row.runtime)) {
      await recordAudit(prisma, actor, {
        workspaceId: params.workspaceId,
        action: "enterprise_app.runtime_provisioning_skipped",
        entityType: "AppRuntime",
        entityId: row.runtime.id,
        meta: {
          appKey: row.appDefinition.appKey,
          mode: row.runtime.mode,
          reason: "complete_railway_stack_already_registered",
        },
      });
      return serializeInstallation(row);
    }
    if (hasAnyRailwayAppRuntimeResource(row.runtime)) {
      throw new AppError(409, "RAILWAY_APP_RUNTIME_RECONCILIATION_REQUIRED", "Existing app runtime has a partial Railway stack. Reconcile it before retrying provisioning.");
    }
  }

  const provisionalRuntime = row.runtimeId
    ? await prisma.appRuntime.update({
        where: { id: row.runtimeId },
        data: {
          mode,
          status: "PROVISIONING",
          environment,
          baseUrl,
          healthUrl: runtimeHealthUrl ?? `${baseUrl}/api/health`,
          mcpUrl: runtimeMcpUrl,
          secretsRef,
          lastHealthError: null,
        },
      })
    : await prisma.appRuntime.create({
        data: {
          appDefinitionId: row.appDefinitionId,
          mode,
          status: "PROVISIONING",
          environment,
          baseUrl,
          healthUrl: runtimeHealthUrl ?? `${baseUrl}/api/health`,
          mcpUrl: runtimeMcpUrl,
          secretsRef,
        },
      });

  await prisma.appInstallation.update({
    where: { id: row.id },
    data: {
      runtimeId: provisionalRuntime.id,
      status: row.status === "DISABLED" ? "DISABLED" : "NEEDS_SETUP",
    },
  });

  try {
    const result = await provisionRailwayAppRuntime(railwayClient ?? createRailwayClientFromEnv(), {
      projectName: projectNameForAppRuntime(row.appDefinition.appKey, params.workspaceId, mode),
      environmentName: environment,
      region,
      appImage: params.appImage,
      appSource: params.appSource,
      customDomain,
      variables: buildEnterpriseAppRuntimeVariables({
        appKey: row.appDefinition.appKey,
        workspaceId: params.workspaceId,
        runtimeMode: mode,
        baseUrl,
        releaseVersion: params.releaseVersion,
        imageTag: params.releaseImageTag,
        overrides: params.variables,
      }),
    });
    await prisma.$transaction(async (tx) => {
      await tx.appRuntime.update({
        where: { id: provisionalRuntime.id },
        data: {
          status: "PROVISIONING",
          baseUrl: result.appDomain ? `https://${result.appDomain}` : baseUrl,
          healthUrl: runtimeHealthUrl ?? `${result.appDomain ? `https://${result.appDomain}` : baseUrl}/api/health`,
          mcpUrl: runtimeMcpUrl,
          railwayProjectId: result.projectId,
          railwayEnvironmentId: result.environmentId,
          railwayServiceId: result.appServiceId,
          secretsRef,
          lastHealthError: null,
          metadataJson: toInputJson({
            railwayPostgresServiceId: result.postgresServiceId,
            railwayRedisServiceId: result.redisServiceId,
            lastProvisionedAt: new Date().toISOString(),
            releaseVersion: text(params.releaseVersion),
            releaseImageTag: text(params.releaseImageTag),
          }),
        },
      });
      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId,
        action: "enterprise_app.runtime_provisioned",
        entityType: "AppRuntime",
        entityId: provisionalRuntime.id,
        meta: {
          appKey: row.appDefinition.appKey,
          mode,
          railwayProjectId: result.projectId,
          railwayEnvironmentId: result.environmentId,
          railwayServiceId: result.appServiceId,
          reason: text(params.reason),
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Railway provisioning error.";
    await prisma.appRuntime.update({
      where: { id: provisionalRuntime.id },
      data: {
        status: "UNHEALTHY",
        lastHealthStatus: "down",
        lastHealthError: message,
      },
    });
    await recordAudit(prisma, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.runtime_provisioning_failed",
      entityType: "AppRuntime",
      entityId: provisionalRuntime.id,
      meta: {
        appKey: row.appDefinition.appKey,
        mode,
        error: message,
      },
    });
    throw error;
  }

  return serializeInstallation(await getInstallation(params.workspaceId, row.id));
}

export async function preflightEnterpriseAppRuntime(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  invariant(row.runtimeId, 400, "APP_RUNTIME_UNAVAILABLE", "App runtime is not configured.");
  if (row.appDefinition.manifestUrl) {
    const manifestResponse = await fetchJsonWithTimeout(row.appDefinition.manifestUrl);
    invariant(manifestResponse.response.ok, 400, "APP_MANIFEST_UNAVAILABLE", `Manifest returned status ${manifestResponse.response.status}.`);
    assertManifestCompatible(manifestResponse.body, row.appDefinition);
  } else if (row.appDefinition.manifestJson) {
    assertManifestCompatible(row.appDefinition.manifestJson, row.appDefinition);
  }
  const result = await runEnterpriseAppHealthCheckJob({
    runtimeId: row.runtimeId,
    reason: text(params.reason) ?? "Enterprise app runtime preflight.",
  });
  invariant(result.status === "ok", 400, "APP_PREFLIGHT_FAILED", result.error ?? "Enterprise app runtime preflight failed.");
  await prisma.$transaction(async (tx) => {
    await tx.appRuntime.update({
      where: { id: row.runtimeId! },
      data: { status: "ACTIVE" },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.runtime_preflight_passed",
      entityType: "AppRuntime",
      entityId: row.runtimeId!,
      meta: {
        appKey: row.appDefinition.appKey,
        reason: text(params.reason),
      },
    });
  });
  return {
    result,
    installation: serializeInstallation(await getInstallation(params.workspaceId, row.id)),
  };
}

export async function createEnterpriseAppRelease(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  version: string;
  gitSha?: string | null;
  imageTag?: string | null;
  manifestVersion?: string | null;
  manifestJson?: unknown;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  invariant(row.runtimeId, 400, "APP_RUNTIME_UNAVAILABLE", "App runtime is not configured.");
  const version = text(params.version);
  invariant(version, 400, "INVALID_INPUT", "Release version is required.");
  const manifest = params.manifestJson ? assertManifestCompatible(params.manifestJson, row.appDefinition) : null;
  const existing = await prisma.appRelease.findFirst({
    where: {
      appDefinitionId: row.appDefinitionId,
      runtimeId: row.runtimeId,
      version,
    },
  });
  const release = existing
    ? await prisma.appRelease.update({
        where: { id: existing.id },
        data: {
          gitSha: text(params.gitSha),
          imageTag: text(params.imageTag),
          manifestVersion: text(params.manifestVersion) ?? manifest?.version ?? existing.manifestVersion,
          status: existing.status === "ACTIVE" ? "ACTIVE" : "PREPARED",
          metadataJson: toInputJson({
            ...runtimeMetadata(existing.metadataJson),
            manifestCheckedAt: manifest ? new Date().toISOString() : undefined,
          }),
        },
      })
    : await prisma.appRelease.create({
        data: {
          appDefinitionId: row.appDefinitionId,
          runtimeId: row.runtimeId,
          version,
          gitSha: text(params.gitSha),
          imageTag: text(params.imageTag),
          manifestVersion: text(params.manifestVersion) ?? manifest?.version ?? null,
          status: "PREPARED",
          metadataJson: toInputJson({
            createdByUserId: actor.kind === "user" ? actor.user.id : null,
            manifestCheckedAt: manifest ? new Date().toISOString() : undefined,
          }),
        },
      });
  await recordAudit(prisma, actor, {
    workspaceId: params.workspaceId,
    action: "enterprise_app.release_created",
    entityType: "AppRelease",
    entityId: release.id,
    meta: {
      appKey: row.appDefinition.appKey,
      version,
    },
  });
  return { release };
}

export async function promoteEnterpriseAppRelease(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  releaseId: string;
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  invariant(row.runtimeId, 400, "APP_RUNTIME_UNAVAILABLE", "App runtime is not configured.");
  const release = await prisma.appRelease.findFirst({
    where: {
      id: params.releaseId,
      appDefinitionId: row.appDefinitionId,
      runtimeId: row.runtimeId,
    },
  });
  invariant(release, 404, "NOT_FOUND", "Enterprise app release not found.");
  invariant(release.status !== "FAILED", 400, "APP_RELEASE_FAILED", "Failed releases cannot be promoted.");
  const promotedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.appRelease.updateMany({
      where: {
        appDefinitionId: row.appDefinitionId,
        runtimeId: row.runtimeId,
        status: "ACTIVE",
        id: { not: release.id },
      },
      data: {
        status: "ROLLED_BACK",
        metadataJson: toInputJson({
          rolledBackByReleaseId: release.id,
          rolledBackAt: promotedAt.toISOString(),
        }),
      },
    });
    await tx.appRelease.update({
      where: { id: release.id },
      data: {
        status: "ACTIVE",
        releasedAt: promotedAt,
        healthStatus: row.runtime?.lastHealthStatus ?? release.healthStatus,
      },
    });
    await tx.appInstallation.update({
      where: { id: row.id },
      data: {
        releaseId: release.id,
        status: row.runtime?.status === "ACTIVE" && row.tenantExternalId ? "INSTALLED" : row.status,
      },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.release_promoted",
      entityType: "AppRelease",
      entityId: release.id,
      meta: {
        appKey: row.appDefinition.appKey,
        version: release.version,
        reason: text(params.reason),
      },
    });
  });
  return serializeInstallation(await getInstallation(params.workspaceId, row.id));
}

export async function rollbackEnterpriseAppRelease(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  releaseId: string;
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  invariant(row.runtimeId, 400, "APP_RUNTIME_UNAVAILABLE", "App runtime is not configured.");
  const target = await prisma.appRelease.findFirst({
    where: {
      id: params.releaseId,
      appDefinitionId: row.appDefinitionId,
      runtimeId: row.runtimeId,
    },
  });
  invariant(target, 404, "NOT_FOUND", "Enterprise app release not found.");
  invariant(target.status !== "FAILED", 400, "APP_RELEASE_FAILED", "Failed releases cannot be activated by rollback.");
  const rolledBackAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.appRelease.updateMany({
      where: {
        appDefinitionId: row.appDefinitionId,
        runtimeId: row.runtimeId,
        status: "ACTIVE",
        id: { not: target.id },
      },
      data: {
        status: "ROLLED_BACK",
        metadataJson: toInputJson({
          rollbackTargetReleaseId: target.id,
          rolledBackAt: rolledBackAt.toISOString(),
          reason: text(params.reason),
        }),
      },
    });
    await tx.appRelease.update({
      where: { id: target.id },
      data: {
        status: "ACTIVE",
        releasedAt: rolledBackAt,
        metadataJson: toInputJson({
          ...runtimeMetadata(target.metadataJson),
          rollbackActivatedAt: rolledBackAt.toISOString(),
          reason: text(params.reason),
        }),
      },
    });
    await tx.appInstallation.update({
      where: { id: row.id },
      data: { releaseId: target.id },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.release_rolled_back",
      entityType: "AppRelease",
      entityId: target.id,
      meta: {
        appKey: row.appDefinition.appKey,
        version: target.version,
        reason: text(params.reason),
      },
    });
  });
  return serializeInstallation(await getInstallation(params.workspaceId, row.id));
}

export async function upgradeEnterpriseAppRuntimeRelease(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
  releaseId: string;
  appImage?: string | null;
  appSource?: RailwayRuntimeServiceSource | null;
  variables?: Record<string, string>;
  reason?: string | null;
}, railwayClient: RailwayClient = createRailwayClientFromEnv()) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  invariant(row.runtime, 400, "APP_RUNTIME_UNAVAILABLE", "App runtime is not configured.");
  invariant(row.runtime.mode !== "SELF_MANAGED_EXTERNAL", 400, "APP_RUNTIME_SELF_MANAGED", "Self-managed app runtimes must be upgraded outside Corgtex.");
  invariant(hasCompleteRailwayAppRuntime(row.runtime), 400, "APP_RUNTIME_INCOMPLETE", "Managed app runtime is missing Railway project, environment, app, Postgres, or Redis IDs.");
  invariant(params.appImage || params.appSource?.repo, 400, "INVALID_INPUT", "Release upgrade requires an app image or repository source.");
  const release = await prisma.appRelease.findFirst({
    where: {
      id: params.releaseId,
      appDefinitionId: row.appDefinitionId,
      runtimeId: row.runtimeId,
    },
  });
  invariant(release, 404, "NOT_FOUND", "Enterprise app release not found.");

  try {
    const result = await upgradeRailwayAppRuntimeRelease(railwayClient, {
      projectId: row.runtime.railwayProjectId!,
      environmentId: row.runtime.railwayEnvironmentId!,
      appServiceId: row.runtime.railwayServiceId!,
      appImage: params.appImage,
      appSource: params.appSource,
      variables: {
        CORGTEX_APP_RELEASE_VERSION: release.version,
        ...(release.imageTag ? { CORGTEX_APP_RELEASE_IMAGE_TAG: release.imageTag } : {}),
        ...(params.variables ?? {}),
      },
    });
    const updatedRelease = await prisma.appRelease.update({
      where: { id: release.id },
      data: {
        status: releaseStatus(release.status),
        metadataJson: toInputJson({
          ...runtimeMetadata(release.metadataJson),
          lastUpgradeDeploymentId: result.appDeploymentId,
          lastUpgradeAt: new Date().toISOString(),
        }),
      },
    });
    await recordAudit(prisma, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.release_upgrade_started",
      entityType: "AppRelease",
      entityId: release.id,
      meta: {
        appKey: row.appDefinition.appKey,
        version: release.version,
        deploymentId: result.appDeploymentId,
        reason: text(params.reason),
      },
    });
    return { release: updatedRelease, deployment: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Railway upgrade error.";
    await prisma.appRelease.update({
      where: { id: release.id },
      data: {
        status: release.status === "ACTIVE" ? "ACTIVE" : "FAILED",
        metadataJson: toInputJson({
          ...runtimeMetadata(release.metadataJson),
          lastUpgradeFailedAt: new Date().toISOString(),
          lastUpgradeError: message,
        }),
      },
    });
    await recordAudit(prisma, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.release_upgrade_failed",
      entityType: "AppRelease",
      entityId: release.id,
      meta: {
        appKey: row.appDefinition.appKey,
        version: release.version,
        error: message,
      },
    });
    throw error;
  }
}

export async function getEnterpriseAppSurface(actor: AppActor, params: {
  workspaceId: string;
  surface: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const surface = normalizeSurface(params.surface);
  const assignment = await prisma.appSurfaceAssignment.findUnique({
    where: {
      workspaceId_surface: {
        workspaceId: params.workspaceId,
        surface,
      },
    },
    include: {
      appInstallation: {
        include: {
          appDefinition: true,
          runtime: true,
          release: true,
          catalogItem: {
            select: {
              id: true,
              title: true,
              url: true,
              appMcpUrl: true,
              installationStatus: true,
            },
          },
          surfaceAssignments: true,
        },
      },
    },
  });

  if (!assignment || !assignment.enabled) {
    return {
      mode: "native" as const,
      surface,
      canManage: canManageEnterpriseApps(membership),
    };
  }

  const row = assignment.appInstallation;
  if (RETIRED_ENTERPRISE_APP_KEYS.has(row.appDefinition.appKey)) {
    return {
      mode: "native" as const,
      surface,
      canManage: canManageEnterpriseApps(membership),
    };
  }
  const reasons = unavailableReasons(row);
  const serialized = serializeInstallation(row);
  if (reasons.length > 0) {
    return {
      mode: "unavailable" as const,
      surface,
      canManage: canManageEnterpriseApps(membership),
      nativeAvailable: true,
      reasons,
      installation: serialized,
    };
  }

  return {
    mode: "app" as const,
    surface,
    canManage: canManageEnterpriseApps(membership),
    installation: serialized,
  };
}

export async function issueEnterpriseAppSession(actor: AppActor, params: {
  workspaceId: string;
  appInstallationId: string;
}) {
  if (actor.kind !== "user") {
    throw new AppError(403, "FORBIDDEN", "Only signed-in users can launch enterprise app sessions.");
  }
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  assertAppKeyIsNotRetired(row.appDefinition.appKey);
  const reasons = unavailableReasons(row);
  invariant(reasons.length === 0, 400, "APP_RUNTIME_UNAVAILABLE", reasons.join(" "));
  const session = await createEnterpriseAppSession(actor, {
    workspaceId: params.workspaceId,
    row,
  });

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    launchUrl: buildLaunchUrl(row, session.token),
    payload: session.payload,
  };
}

export async function invokeInstalledAppTool(actor: AppActor, params: {
  workspaceId: string;
  appKey?: string | null;
  surface?: string | null;
  toolName: string;
  arguments?: Record<string, unknown> | null;
  requiredScopes?: string[] | null;
  timeoutMs?: number | null;
}) {
  const workspaceId = text(params.workspaceId);
  invariant(workspaceId, 400, "INVALID_INPUT", "Workspace ID is required.");
  const toolName = text(params.toolName);
  invariant(toolName, 400, "INVALID_INPUT", "Tool name is required.");
  await requireWorkspaceMembership({ actor, workspaceId });
  const appKey = params.appKey ? normalizeAppKey(params.appKey) : null;
  if (appKey) {
    assertAppKeyIsNotRetired(appKey);
  }
  const surface = params.surface ? normalizeSurface(params.surface) : null;
  invariant(appKey || surface, 400, "INVALID_INPUT", "Provide appKey or surface.");
  const row = surface
    ? await getInstallationBySurface(workspaceId, surface)
    : await getInstallationByAppKey(workspaceId, appKey!);
  assertAppKeyIsNotRetired(row.appDefinition.appKey);
  let requiredScopes: string[] = [];
  const auditBase = () => ({
    appKey: row.appDefinition.appKey,
    appInstallationId: row.id,
    toolName,
    scopes: requiredScopes,
  });

  try {
    requiredScopes = scopedAppToolRequirements(toolName, normalizeOptionalScopes(params.requiredScopes, "requiredScopes"));
    const mcpUrl = appMcpUrlFor(row);
    const reasons = unavailableReasons(row);
    invariant(reasons.length === 0, 400, "APP_RUNTIME_UNAVAILABLE", reasons.join(" "));
    invariant(mcpUrl, 400, "APP_MCP_UNAVAILABLE", "Installed app MCP URL is not configured.");
    const missingScopes = requiredScopes.filter((scope) => !row.grantedScopes.includes(scope));
    invariant(missingScopes.length === 0, 403, "APP_SCOPE_MISSING", `Installed app is missing granted scope(s): ${missingScopes.join(", ")}.`);

    const session = await createEnterpriseAppSession(actor, {
      workspaceId,
      row,
      ttlSeconds: DEFAULT_SESSION_TTL_SECONDS,
    });
    const response = await postJsonWithTimeout(mcpUrl, {
      token: session.token,
      timeoutMs: params.timeoutMs,
      body: {
        toolName,
        arguments: params.arguments ?? {},
      },
    });
    if (!response.response.ok) {
      const message = isRecord(response.body) && isRecord(response.body.error) && text(response.body.error.message)
        ? text(response.body.error.message)
        : `Installed app MCP returned status ${response.response.status}.`;
      throw new AppError(response.response.status, "APP_MCP_CALL_FAILED", message ?? "Installed app MCP call failed.");
    }
    await recordAudit(prisma, actor, {
      workspaceId,
      action: "enterprise_app.mcp_invoked",
      entityType: "AppInstallation",
      entityId: row.id,
      meta: {
        ...auditBase(),
        success: true,
        status: response.response.status,
      },
    });
    return {
      appKey: row.appDefinition.appKey,
      appInstallationId: row.id,
      toolName,
      scopes: requiredScopes,
      result: response.body,
    };
  } catch (error) {
    await recordAudit(prisma, actor, {
      workspaceId,
      action: "enterprise_app.mcp_invoked",
      entityType: "AppInstallation",
      entityId: row.id,
      meta: {
        ...auditBase(),
        success: false,
        failureReason: error instanceof Error ? error.message : "Installed app MCP call failed.",
      },
    }).catch(() => undefined);
    throw error;
  }
}

export async function consumeEnterpriseAppSessionToken(params: {
  token: string;
  audience?: string | null;
  workspaceId?: string | null;
  appInstallationId?: string | null;
}) {
  const token = text(params.token);
  invariant(token, 400, "INVALID_INPUT", "Token is required.");
  const session = await prisma.appSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      appInstallation: {
        include: {
          appDefinition: true,
          runtime: true,
          release: true,
          catalogItem: {
            select: {
              id: true,
              title: true,
              url: true,
              appMcpUrl: true,
              installationStatus: true,
            },
          },
          surfaceAssignments: true,
        },
      },
    },
  });
  invariant(session, 401, "INVALID_TOKEN", "Invalid enterprise app session token.");
  invariant(!session.revokedAt, 401, "TOKEN_REVOKED", "Enterprise app session token has been revoked.");
  invariant(session.expiresAt > new Date(), 401, "TOKEN_EXPIRED", "Enterprise app session token has expired.");
  const audience = text(params.audience);
  invariant(!audience || audience === session.audience, 401, "WRONG_AUDIENCE", "Enterprise app session token audience mismatch.");
  const workspaceId = text(params.workspaceId);
  invariant(!workspaceId || workspaceId === session.workspaceId, 401, "WRONG_WORKSPACE", "Enterprise app session token workspace mismatch.");
  const appInstallationId = text(params.appInstallationId);
  invariant(!appInstallationId || appInstallationId === session.appInstallationId, 401, "WRONG_INSTALLATION", "Enterprise app session token installation mismatch.");
  const liveActor = session.actorUserId
    ? await requireLiveEnterpriseAppUser(session.actorUserId, session.workspaceId)
    : null;

  const reasons = unavailableReasons(session.appInstallation);
  invariant(reasons.length === 0, 401, "APP_RUNTIME_UNAVAILABLE", reasons.join(" "));

  await prisma.appSession.update({
    where: { id: session.id },
    data: {
      consumedAt: session.consumedAt ?? new Date(),
      lastUsedAt: new Date(),
    },
  });

  return {
    sessionId: session.id,
    audience: session.audience,
    workspaceId: session.workspaceId,
    appInstallationId: session.appInstallationId,
    scopes: session.scopes,
    expiresAt: session.expiresAt,
    payload: liveActor
      ? {
        ...(isRecord(session.payloadJson) ? session.payloadJson : {}),
        user: {
          id: liveActor.user.id,
          email: liveActor.user.email,
          displayName: liveActor.user.displayName,
          role: liveActor.membership.role,
        },
      }
      : session.payloadJson,
  };
}

export async function revokeEnterpriseAppSession(actor: AppActor, params: {
  workspaceId: string;
  sessionId: string;
  reason?: string | null;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  assertCanManageEnterpriseApps(membership);
  const session = await prisma.appSession.findFirst({
    where: {
      id: params.sessionId,
      workspaceId: params.workspaceId,
    },
  });
  invariant(session, 404, "NOT_FOUND", "Enterprise app session not found.");
  await prisma.$transaction(async (tx) => {
    await tx.appSession.update({
      where: { id: params.sessionId },
      data: { revokedAt: new Date() },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "enterprise_app.session_revoked",
      entityType: "AppSession",
      entityId: params.sessionId,
      meta: {
        reason: text(params.reason),
      },
    });
  });
  return { sessionId: params.sessionId, revoked: true };
}
