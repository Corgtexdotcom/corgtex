import type {
  AppCategory,
  AppDefinitionStatus,
  AppHostingMode,
  AppInstallationStatus,
  AppIntegrationDepth,
  AppRuntimeMode,
  AppRuntimeStatus,
  AppSurface,
  AppVisibility,
  Prisma,
} from "@prisma/client";
import { prisma, randomOpaqueToken, sha256, toInputJson } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { ALL_SCOPES } from "./agent-auth";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { AppError, invariant } from "./errors";

const APP_ADMIN_ROLES = new Set(["ADMIN"]);
const APP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,94}[a-z0-9]$/;
const DEFAULT_SESSION_TTL_SECONDS = 5 * 60;
const SESSION_TOKEN_PARAM = "corgtex_launch_token";

const APP_SURFACES: AppSurface[] = ["FINANCE"];
const APP_CATEGORIES: AppCategory[] = ["FINANCE", "KNOWLEDGE", "COMMUNICATION", "AI", "OPERATIONS", "GOVERNANCE", "DATA", "OTHER"];
const APP_VISIBILITIES: AppVisibility[] = ["PUBLIC_MARKETPLACE", "UNLISTED", "WORKSPACE_PRIVATE", "CORGTEX_MANAGED"];
const HOSTING_MODES: AppHostingMode[] = ["EXTERNAL_URL", "CORGTEX_MANAGED_EXTERNAL", "CORGTEX_HOSTED_STATIC", "CORGTEX_HOSTED_CONTAINER", "MCP_SERVER"];
const INTEGRATION_DEPTHS: AppIntegrationDepth[] = ["CATALOG_ONLY", "LAUNCHABLE", "MCP_ACTIONABLE", "KNOWLEDGE_SYNCED", "WORKFLOW_NATIVE"];
const INSTALLATION_STATUSES: AppInstallationStatus[] = ["REQUESTED", "APPROVED", "INSTALLED", "NEEDS_SETUP", "UNHEALTHY", "DISABLED"];
const RUNTIME_MODES: AppRuntimeMode[] = ["SHARED_MULTI_TENANT", "ISOLATED_SINGLE_TENANT", "SELF_MANAGED_EXTERNAL"];
const RUNTIME_STATUSES: AppRuntimeStatus[] = ["PROVISIONING", "ACTIVE", "UNHEALTHY", "DISABLED"];
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

function practiceLedgerDefinition() {
  const appUrl = normalizeOptionalUrl(process.env.PRACTICE_LEDGER_APP_URL, "Practice Ledger app URL");
  const mcpUrl = normalizeOptionalUrl(process.env.PRACTICE_LEDGER_MCP_URL, "Practice Ledger MCP URL");
  const healthUrl = appUrl ? `${appUrl}/api/health` : null;
  const manifest: EnterpriseAppManifest = {
    appKey: "practice-ledger",
    version: "0.1.0",
    supportedSurfaces: ["FINANCE"],
    requestedScopes: ["workspace:read", "brain:read", "brain:write", "finance:read", "finance:write"],
    authMode: "corgtex_launch_token",
    healthUrl: healthUrl ?? "https://practice-ledger.example.invalid/api/health",
    mcpUrl,
    dataClassification: "CLIENT_PRIVATE",
    tenantMode: "multi_tenant",
    embed: {
      supported: true,
      path: "/dashboard?embedded=1",
    },
  };
  return {
    appKey: "practice-ledger",
    title: "Practice Ledger",
    descriptionMd: "Corgtex-managed consulting finance app for budgets, billing codes, time, expenses, margin, finance intake, and MCP posting.",
    repositoryUrl: "https://github.com/Corgtexdotcom/practice-ledger",
    manifestUrl: appUrl ? `${appUrl}/.well-known/corgtex-app.json` : null,
    category: "FINANCE" as AppCategory,
    visibility: "CORGTEX_MANAGED" as AppVisibility,
    defaultHostingMode: "CORGTEX_MANAGED_EXTERNAL" as AppHostingMode,
    defaultIntegrationDepth: "KNOWLEDGE_SYNCED" as AppIntegrationDepth,
    dataClassification: "CLIENT_PRIVATE",
    supportedSurfaces: ["FINANCE"] as AppSurface[],
    requestedScopes: manifest.requestedScopes,
    manifestJson: manifest,
    capabilitiesJson: [
      { key: "expenses.create_draft", requiredScopes: ["finance:write", "brain:read", "brain:write"] },
      { key: "time_entries.create_draft", requiredScopes: ["finance:write", "brain:read", "brain:write"] },
      { key: "budgets.read_status", requiredScopes: ["finance:read", "brain:read"] },
      { key: "knowledge.sync_summary", requiredScopes: ["brain:write"] },
    ],
  };
}

async function ensureDefaultAppDefinitions() {
  const definition = practiceLedgerDefinition();
  await prisma.appDefinition.upsert({
    where: { appKey: definition.appKey },
    create: {
      ...definition,
      manifestJson: toInputJson(definition.manifestJson),
      capabilitiesJson: toInputJson(definition.capabilitiesJson),
    },
    update: {
      title: definition.title,
      descriptionMd: definition.descriptionMd,
      repositoryUrl: definition.repositoryUrl,
      manifestUrl: definition.manifestUrl,
      category: definition.category,
      visibility: definition.visibility,
      defaultHostingMode: definition.defaultHostingMode,
      defaultIntegrationDepth: definition.defaultIntegrationDepth,
      dataClassification: definition.dataClassification,
      supportedSurfaces: definition.supportedSurfaces,
      requestedScopes: definition.requestedScopes,
      manifestJson: toInputJson(definition.manifestJson),
      capabilitiesJson: toInputJson(definition.capabilitiesJson),
      status: "ACTIVE" as AppDefinitionStatus,
    },
  });
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
      status: row.release.status,
      healthStatus: row.release.healthStatus,
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
  await ensureDefaultAppDefinitions();
  return prisma.appDefinition.findMany({
    where: { status: "ACTIVE" },
    orderBy: [{ category: "asc" }, { title: "asc" }],
  });
}

export async function listWorkspaceEnterpriseApps(actor: AppActor, workspaceId: string) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  await ensureDefaultAppDefinitions();
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
  await ensureDefaultAppDefinitions();
  const appKey = normalizeAppKey(params.appKey);
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
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const row = await getInstallation(params.workspaceId, params.appInstallationId);
  const reasons = unavailableReasons(row);
  invariant(reasons.length === 0, 400, "APP_RUNTIME_UNAVAILABLE", reasons.join(" "));
  const token = randomOpaqueToken();
  const expiresAt = new Date(Date.now() + Math.max(row.sessionTtlSeconds || DEFAULT_SESSION_TTL_SECONDS, 60) * 1000);
  const payload = {
    issuer: "corgtex",
    audience: row.appDefinition.appKey,
    appKey: row.appDefinition.appKey,
    appInstallationId: row.id,
    workspaceId: params.workspaceId,
    user: {
      id: actor.user.id,
      email: actor.user.email,
      displayName: actor.user.displayName,
      role: membership?.role ?? "ADMIN",
    },
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
      actorUserId: actor.user.id,
      audience: row.appDefinition.appKey,
      tokenHash: sha256(token),
      scopes: row.grantedScopes,
      payloadJson: toInputJson(payload),
      expiresAt,
    },
  });

  return {
    token,
    expiresAt,
    launchUrl: buildLaunchUrl(row, token),
    payload,
  };
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
    payload: session.payloadJson,
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
