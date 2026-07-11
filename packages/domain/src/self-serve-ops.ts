import { createHmac, timingSafeEqual } from "node:crypto";
import type { CustomerDeploymentAccessRole, MemberRole, Prisma } from "@prisma/client";
import {
  decryptSecret,
  encryptSecret,
  env,
  hashPassword,
  prisma,
  randomOpaqueToken,
  sha256,
  toInputJson,
} from "@corgtex/shared";
import type { AgentActor, AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { isGlobalOperator } from "./auth";
import { activeRoleAssignmentWhere } from "./role-assignment-activity";

const SUPPORT_SESSION_TTL_MS = 60 * 60 * 1000;
const SUPPORT_EMAIL_DOMAIN = "corgtex.local";
const CONTROL_PLANE_READ_SCOPE = "control-plane:read";
const CONTROL_PLANE_DEPLOYMENT_WRITE_ROLES = new Set<CustomerDeploymentAccessRole>(["SUPPORT_ADMIN", "CUSTOMER_IT_ADMIN"]);
const REGISTRY_SYNC_SCHEMA_VERSION = "self-serve-registry-sync-v1";
const REGISTRY_SYNC_MAX_AGE_MS = 5 * 60 * 1000;

type JsonRecord = Record<string, unknown>;
export type SelfServeRegistrySyncPayload = {
  schemaVersion: typeof REGISTRY_SYNC_SCHEMA_VERSION;
  sourceId: string;
  sourceUrl: string;
  sourceDeploymentId?: string | null;
  generatedAt: string;
  summary: JsonRecord;
  items: JsonRecord[];
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function emailDomain(email: string) {
  const normalized = normalizeEmail(email);
  const index = normalized.lastIndexOf("@");
  return index >= 0 ? normalized.slice(index + 1) : "";
}

function configuredCaptureDomains() {
  return new Set((env.SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

function assertSmokeCaptureSecret(secret: string | null | undefined) {
  if (!env.SMOKE_EMAIL_CAPTURE_SECRET) {
    throw new AppError(503, "SMOKE_CAPTURE_NOT_CONFIGURED", "Smoke email capture is not configured.");
  }
  invariant(secret === env.SMOKE_EMAIL_CAPTURE_SECRET, 401, "UNAUTHORIZED", "Invalid smoke capture secret.");
}

function canCaptureEmail(email: string) {
  const domains = configuredCaptureDomains();
  return Boolean(env.SMOKE_EMAIL_CAPTURE_SECRET) && domains.size > 0 && domains.has(emailDomain(email));
}

function actorLabel(actor: AppActor) {
  if (actor.kind === "user") return actor.user.email;
  return actor.label ?? actor.authProvider;
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function isControlPlaneAgent(actor: AppActor): actor is AgentActor & { authProvider: "control-plane" } {
  return actor.kind === "agent" && actor.authProvider === "control-plane";
}

function hasControlPlaneScope(actor: AppActor, scope: string) {
  if (!isControlPlaneAgent(actor)) return true;
  const scopes = new Set(actor.scopes?.length ? actor.scopes : [CONTROL_PLANE_READ_SCOPE]);
  return scopes.has("control-plane:*") || scopes.has(scope);
}

function requireSelfServeControlPlaneScope(actor: AppActor, scope: string) {
  invariant(hasControlPlaneScope(actor, scope), 403, "CONTROL_PLANE_SCOPE_REQUIRED", `Control Plane scope required: ${scope}.`);
}

async function requireSelfServeControlPlaneAccess(actor: AppActor, params: { deploymentId?: string; write?: boolean } = {}) {
  if (isGlobalOperator(actor)) return;
  if (isControlPlaneAgent(actor)) {
    requireSelfServeControlPlaneScope(actor, CONTROL_PLANE_READ_SCOPE);
    return;
  }
  if (actor.kind === "user" && params.deploymentId) {
    const access = await prisma.customerDeploymentAccess.findUnique({
      where: {
        deploymentId_userId: {
          deploymentId: params.deploymentId,
          userId: actor.user.id,
        },
      },
      select: { role: true, isActive: true },
    });
    if (access?.isActive && (!params.write || CONTROL_PLANE_DEPLOYMENT_WRITE_ROLES.has(access.role))) return;
  }
  if (params.write) {
    throw new AppError(403, "CONTROL_PLANE_WRITE_ACCESS_REQUIRED", "Control plane write access is required for this deployment.");
  }
  throw new AppError(403, "FORBIDDEN", "Control plane access is required.");
}

function redactValue(key: string, value: unknown): unknown {
  const normalizedKey = key.toLowerCase();
  const isSecretLikeKey = /token|secret|password|authorization|bearer|connectionstring/.test(normalizedKey)
    || normalizedKey === "supportcredential"
    || (normalizedKey.includes("credential") && /(enc|hash|secret|token|password|value)$/.test(normalizedKey));
  if (isSecretLikeKey) return "[redacted]";
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}...`;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "object" && item !== null ? redactObject(item as JsonRecord) : item));
  }
  if (value && typeof value === "object") return redactObject(value as JsonRecord);
  return value;
}

function redactObject(value: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactValue(key, entry)]),
  );
}

function dateIso(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function compactSmokeSummary(value: unknown): JsonRecord | null {
  const summary = asRecord(value);
  if (!summary) return null;
  const steps = Array.isArray(summary.steps)
    ? summary.steps.map((step) => {
      const record = asRecord(step) ?? {};
      return {
        name: typeof record.name === "string" ? record.name : null,
        status: typeof record.status === "string" ? record.status : null,
      };
    })
    : [];
  const warnings = Array.isArray(summary.warnings)
    ? summary.warnings.map((warning) => {
      const record = asRecord(warning) ?? {};
      return {
        name: typeof record.name === "string" ? record.name : null,
      };
    })
    : [];
  return {
    steps,
    warnings,
  };
}

function compactSmokeRun(value: unknown) {
  const run = asRecord(value);
  if (!run) return null;
  return {
    runId: run.runId,
    runKind: run.runKind,
    status: run.status,
    baseUrl: run.baseUrl,
    siteUrl: run.siteUrl,
    error: typeof run.error === "string" ? run.error.slice(0, 500) : null,
    startedAt: dateIso(run.startedAt),
    completedAt: dateIso(run.completedAt),
    createdAt: dateIso(run.createdAt),
    summary: compactSmokeSummary(run.summary),
  };
}

function compactWorkspace(value: unknown) {
  const workspace = asRecord(value);
  if (!workspace) return null;
  const counts = asRecord(workspace._count);
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    plan: workspace.plan,
    trialEndsAt: dateIso(workspace.trialEndsAt),
    counts: counts
      ? {
        members: counts.members,
        roleOnboardingSessions: counts.roleOnboardingSessions,
        onboardingStates: counts.onboardingStates,
      }
      : null,
  };
}

function compactBilling(value: unknown) {
  const billing = asRecord(value);
  if (!billing) return null;
  return {
    billingStatus: billing.billingStatus,
    paymentMethodReady: billing.paymentMethodReady,
    updatedAt: dateIso(billing.updatedAt),
  };
}

function compactDeployment(value: unknown) {
  const deployment = asRecord(value);
  if (!deployment) return null;
  return {
    id: deployment.id,
    label: deployment.label,
    deploymentStatus: deployment.deploymentStatus,
    supportConnectorStatus: deployment.supportConnectorStatus,
  };
}

function compactEmailCapture(value: unknown) {
  const capture = asRecord(value);
  if (!capture) return null;
  return {
    id: capture.id,
    runId: capture.runId,
    source: capture.source,
    expiresAt: dateIso(capture.expiresAt),
    consumedAt: dateIso(capture.consumedAt),
    createdAt: dateIso(capture.createdAt),
  };
}

function compactSupportSession(value: unknown) {
  const session = asRecord(value);
  if (!session) return null;
  return {
    id: session.id,
    operationId: session.operationId,
    expiresAt: dateIso(session.expiresAt),
    usedAt: dateIso(session.usedAt),
    createdAt: dateIso(session.createdAt),
  };
}

function numberField(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function stringField(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function registryCounts(value: unknown) {
  const counts = asRecord(value) ?? {};
  return {
    members: numberField(counts.members),
    roleOnboardingSessions: numberField(counts.roleOnboardingSessions),
    onboardingStates: numberField(counts.onboardingStates),
  };
}

function syncedWorkspace(value: unknown) {
  const workspace = asRecord(value);
  if (!workspace) return null;
  return {
    id: stringField(workspace.id),
    name: stringField(workspace.name),
    slug: stringField(workspace.slug),
    plan: stringField(workspace.plan),
    trialEndsAt: dateIso(workspace.trialEndsAt),
    _count: registryCounts(workspace._count ?? workspace.counts),
  };
}

function syncedBilling(value: unknown) {
  const billing = asRecord(value);
  if (!billing) return null;
  return {
    billingStatus: stringOrNull(billing.billingStatus),
    paymentMethodReady: Boolean(billing.paymentMethodReady),
    updatedAt: dateIso(billing.updatedAt),
  };
}

function syncedDeployment(value: unknown) {
  const deployment = asRecord(value);
  if (!deployment) return null;
  return {
    id: stringField(deployment.id),
    managedWorkspaceId: stringOrNull(deployment.managedWorkspaceId),
    label: stringOrNull(deployment.label),
    deploymentStatus: stringOrNull(deployment.deploymentStatus),
    supportConnectorStatus: stringOrNull(deployment.supportConnectorStatus),
  };
}

function syncedSmokeRun(value: unknown) {
  const smoke = compactSmokeRun(value);
  if (!smoke) return null;
  return {
    runId: stringOrNull(smoke.runId),
    runKind: stringOrNull(smoke.runKind),
    status: stringOrNull(smoke.status),
    baseUrl: stringOrNull(smoke.baseUrl),
    siteUrl: stringOrNull(smoke.siteUrl),
    error: stringOrNull(smoke.error),
    summary: smoke.summary,
    startedAt: smoke.startedAt,
    completedAt: smoke.completedAt,
    createdAt: smoke.createdAt,
  };
}

function syncedEmailCapture(value: unknown) {
  const capture = compactEmailCapture(value);
  if (!capture) return null;
  return {
    id: stringField(capture.id),
    procurementTrialId: null,
    toEmail: null,
    runId: stringOrNull(capture.runId),
    source: stringOrNull(capture.source),
    expiresAt: capture.expiresAt,
    consumedAt: capture.consumedAt,
    createdAt: capture.createdAt,
  };
}

function syncedSupportSession(value: unknown) {
  const session = compactSupportSession(value);
  if (!session) return null;
  return {
    id: stringField(session.id),
    workspaceId: null,
    operationId: stringOrNull(session.operationId),
    targetMemberId: null,
    expiresAt: session.expiresAt,
    usedAt: session.usedAt,
    createdAt: session.createdAt,
  };
}

function redactedEmailForDomain(value: unknown) {
  const domain = stringOrNull(value);
  return domain ? `redacted@${domain}` : "redacted";
}

function syncedExistingActiveTrial(value: unknown) {
  const existing = asRecord(value);
  if (!existing) return null;
  return {
    trialId: stringField(existing.trialId),
    status: stringField(existing.status),
    companyName: stringField(existing.companyName),
    adminEmail: redactedEmailForDomain(existing.emailDomain),
    emailDomain: stringField(existing.emailDomain),
    trialExpiresAt: dateIso(existing.trialExpiresAt),
    createdAt: dateIso(existing.createdAt),
    workspace: syncedWorkspace(existing.workspace),
    deployment: syncedDeployment(existing.deployment),
  };
}

function syncedRegistryItem(params: {
  item: unknown;
  eventId: string;
  eventCreatedAt: Date;
  sourceId: string | null;
  sourceUrl: string | null;
  sourceDeploymentId: string | null;
  generatedAt: string | null;
  receivedAt: string | null;
}) {
  const record = asRecord(params.item) ?? {};
  const emailDomainValue = stringField(record.emailDomain);
  return {
    trialId: stringField(record.trialId),
    status: stringField(record.status),
    riskStatus: stringField(record.riskStatus, "UNKNOWN"),
    riskReasons: Array.isArray(record.riskReasons) ? record.riskReasons : [],
    companyName: stringField(record.companyName, "Unknown self-serve customer"),
    adminEmail: redactedEmailForDomain(emailDomainValue),
    adminName: null,
    emailDomain: emailDomainValue,
    trialExpiresAt: dateIso(record.trialExpiresAt),
    createdAt: dateIso(record.createdAt) ?? params.eventCreatedAt,
    updatedAt: dateIso(record.updatedAt) ?? dateIso(record.createdAt) ?? params.eventCreatedAt,
    suspendedAt: dateIso(record.suspendedAt),
    suspensionReason: stringOrNull(record.suspensionReason),
    claimEmailStatus: { sent: Boolean(record.claimEmailCaptured) },
    workspace: syncedWorkspace(record.workspace),
    deployment: syncedDeployment(record.deployment),
    billing: syncedBilling(record.billing),
    existingActiveTrial: syncedExistingActiveTrial(record.existingActiveTrial),
    latestSmoke: syncedSmokeRun(record.latestSmoke),
    latestEmailCapture: syncedEmailCapture(record.latestEmailCapture),
    latestSupportSession: syncedSupportSession(record.latestSupportSession),
    source: {
      kind: "registry_sync",
      eventId: params.eventId,
      sourceId: params.sourceId,
      sourceUrl: params.sourceUrl,
      sourceDeploymentId: params.sourceDeploymentId,
      generatedAt: params.generatedAt,
      receivedAt: params.receivedAt,
      syncedAt: params.eventCreatedAt,
    },
  };
}

function sanitizeRegistryItem(item: unknown): JsonRecord {
  const record = asRecord(item) ?? {};
  const existingActiveTrial = asRecord(record.existingActiveTrial);
  return {
    trialId: record.trialId,
    status: record.status,
    riskStatus: record.riskStatus,
    riskReasons: Array.isArray(record.riskReasons) ? record.riskReasons : [],
    companyName: record.companyName,
    emailDomain: record.emailDomain,
    trialExpiresAt: dateIso(record.trialExpiresAt),
    createdAt: dateIso(record.createdAt),
    updatedAt: dateIso(record.updatedAt),
    suspendedAt: dateIso(record.suspendedAt),
    suspensionReason: record.suspensionReason,
    claimEmailCaptured: Boolean(record.claimEmailStatus),
    workspace: compactWorkspace(record.workspace),
    billing: compactBilling(record.billing),
    deployment: compactDeployment(record.deployment),
    existingActiveTrial: existingActiveTrial
      ? {
        trialId: existingActiveTrial.trialId,
        status: existingActiveTrial.status,
        companyName: existingActiveTrial.companyName,
        emailDomain: existingActiveTrial.emailDomain,
        trialExpiresAt: dateIso(existingActiveTrial.trialExpiresAt),
        createdAt: dateIso(existingActiveTrial.createdAt),
        workspace: compactWorkspace(existingActiveTrial.workspace),
        deployment: compactDeployment(existingActiveTrial.deployment),
      }
      : null,
    latestSmoke: compactSmokeRun(record.latestSmoke),
    latestEmailCapture: compactEmailCapture(record.latestEmailCapture),
    latestSupportSession: compactSupportSession(record.latestSupportSession),
  };
}

function safeEqualHex(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function signSelfServeRegistrySyncPayload(params: {
  secret: string;
  timestamp: string;
  body: string;
}) {
  return createHmac("sha256", params.secret).update(`${params.timestamp}.${params.body}`).digest("hex");
}

export function verifySelfServeRegistrySyncSignature(params: {
  secret?: string | null;
  timestamp?: string | null;
  body: string;
  signature?: string | null;
  now?: Date;
}) {
  const secret = params.secret?.trim();
  const timestampRaw = params.timestamp?.trim();
  invariant(secret, 503, "REGISTRY_SYNC_NOT_CONFIGURED", "Self-serve registry sync is not configured.");
  invariant(timestampRaw, 401, "REGISTRY_SYNC_TIMESTAMP_REQUIRED", "Registry sync timestamp is required.");
  const timestamp = new Date(timestampRaw);
  invariant(!Number.isNaN(timestamp.getTime()), 401, "REGISTRY_SYNC_TIMESTAMP_INVALID", "Registry sync timestamp is invalid.");
  const ageMs = Math.abs((params.now ?? new Date()).getTime() - timestamp.getTime());
  invariant(ageMs <= REGISTRY_SYNC_MAX_AGE_MS, 401, "REGISTRY_SYNC_STALE", "Registry sync signature is stale.");

  const signature = params.signature?.trim().replace(/^sha256=/i, "");
  invariant(signature, 401, "REGISTRY_SYNC_SIGNATURE_REQUIRED", "Registry sync signature is required.");
  const expected = signSelfServeRegistrySyncPayload({
    secret,
    timestamp: timestampRaw,
    body: params.body,
  });
  invariant(safeEqualHex(signature, expected), 401, "REGISTRY_SYNC_SIGNATURE_INVALID", "Registry sync signature is invalid.");
}

export async function buildSelfServeRegistrySyncPayload(actor: AppActor, params: {
  take?: number | null;
  status?: string | null;
  sourceId?: string | null;
  sourceUrl?: string | null;
  sourceDeploymentId?: string | null;
} = {}): Promise<SelfServeRegistrySyncPayload> {
  const registry = await listSelfServeCustomerRegistry(actor, {
    take: params.take,
    status: params.status,
  });
  return {
    schemaVersion: REGISTRY_SYNC_SCHEMA_VERSION,
    sourceId: params.sourceId?.trim() || "self-serve",
    sourceUrl: params.sourceUrl?.trim() || env.APP_URL,
    sourceDeploymentId: params.sourceDeploymentId?.trim() || null,
    generatedAt: new Date().toISOString(),
    summary: registry.summary as JsonRecord,
    items: registry.items.map((item) => sanitizeRegistryItem(item)),
  };
}

export async function recordSelfServeRegistrySync(payload: SelfServeRegistrySyncPayload) {
  invariant(payload.schemaVersion === REGISTRY_SYNC_SCHEMA_VERSION, 400, "INVALID_INPUT", "Unsupported self-serve registry sync schema version.");
  const sourceId = payload.sourceId.trim();
  invariant(sourceId.length > 0, 400, "INVALID_INPUT", "Registry sync source id is required.");
  const sourceDeploymentId = payload.sourceDeploymentId?.trim() || null;
  const deployment = sourceDeploymentId
    ? await prisma.customerDeployment.findUnique({ where: { id: sourceDeploymentId }, select: { id: true } })
    : null;
  const receivedAt = new Date().toISOString();
  const event = await prisma.customerDeploymentEvent.create({
    data: {
      deploymentId: deployment?.id ?? null,
      actorUserId: null,
      action: "self_serve.registry_synced",
      meta: toInputJson({
        ...payload,
        receivedAt,
        sourceDeploymentId,
      }) as Prisma.InputJsonObject,
    },
    select: { id: true, createdAt: true },
  });

  return {
    eventId: event.id,
    sourceId,
    sourceDeploymentId,
    itemCount: payload.items.length,
    summary: payload.summary,
    receivedAt,
    createdAt: event.createdAt,
  };
}

export async function maybeCaptureSelfServeSetupEmail(params: {
  email: string;
  subject: string;
  setupUrl: string;
  providerStatus: unknown;
  workspaceId?: string | null;
  procurementTrialId?: string | null;
  runId?: string | null;
  source?: string | null;
}) {
  const email = normalizeEmail(params.email);
  if (!canCaptureEmail(email)) return null;

  const ttlMinutes = Math.max(env.SMOKE_EMAIL_CAPTURE_TTL_MINUTES, 1);
  return prisma.selfServeEmailCapture.create({
    data: {
      workspaceId: params.workspaceId?.trim() || null,
      procurementTrialId: params.procurementTrialId?.trim() || null,
      toEmail: email,
      emailDomain: emailDomain(email),
      subject: params.subject,
      setupUrlEnc: encryptSecret(params.setupUrl),
      providerStatus: params.providerStatus === undefined ? undefined : toInputJson(params.providerStatus),
      runId: params.runId?.trim() || null,
      source: params.source?.trim() || "member_setup",
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    },
  });
}

export async function getLatestSelfServeEmailCapture(params: {
  secret: string | null | undefined;
  toEmail: string;
  runId?: string | null;
  consume?: boolean;
}) {
  assertSmokeCaptureSecret(params.secret);
  const capture = await prisma.selfServeEmailCapture.findFirst({
    where: {
      toEmail: normalizeEmail(params.toEmail),
      expiresAt: { gt: new Date() },
      consumedAt: null,
      ...(params.runId?.trim() ? { runId: params.runId.trim() } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  invariant(capture, 404, "NOT_FOUND", "No setup email capture found.");

  if (params.consume && !capture.consumedAt) {
    await prisma.selfServeEmailCapture.update({
      where: { id: capture.id },
      data: { consumedAt: new Date() },
    });
  }

  return {
    id: capture.id,
    toEmail: capture.toEmail,
    runId: capture.runId,
    source: capture.source,
    setupUrl: decryptSecret(capture.setupUrlEnc),
    providerStatus: capture.providerStatus,
    expiresAt: capture.expiresAt,
    createdAt: capture.createdAt,
  };
}

export async function upsertSelfServeSmokeRun(params: {
  secret?: string | null;
  actor?: AppActor | null;
  runId: string;
  runKind: string;
  status: string;
  deploymentId?: string | null;
  workspaceId?: string | null;
  procurementTrialId?: string | null;
  baseUrl?: string | null;
  siteUrl?: string | null;
  summary?: unknown;
  artifacts?: unknown;
  error?: string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
}) {
  if (params.secret !== undefined) {
    assertSmokeCaptureSecret(params.secret);
  } else if (params.actor) {
    requireSelfServeControlPlaneScope(params.actor, "control-plane:support:write");
  } else {
    throw new AppError(401, "UNAUTHORIZED", "Smoke run writes require an actor or smoke capture secret.");
  }

  const runId = params.runId.trim();
  invariant(runId.length > 0, 400, "INVALID_INPUT", "Smoke run id is required.");

  const startedAt = params.startedAt ? new Date(params.startedAt) : new Date();
  const completedAt = params.completedAt ? new Date(params.completedAt) : null;
  const data = {
    deploymentId: params.deploymentId?.trim() || null,
    workspaceId: params.workspaceId?.trim() || null,
    procurementTrialId: params.procurementTrialId?.trim() || null,
    runKind: params.runKind.trim() || "browser",
    status: params.status.trim() || "UNKNOWN",
    baseUrl: params.baseUrl?.trim() || null,
    siteUrl: params.siteUrl?.trim() || null,
    triggeredByUserId: params.actor ? actorUserId(params.actor) : null,
    triggeredByLabel: params.actor ? actorLabel(params.actor) : "self-serve-smoke",
    summary: params.summary === undefined ? undefined : toInputJson(params.summary),
    artifacts: params.artifacts === undefined ? undefined : toInputJson(params.artifacts),
    error: params.error?.trim() || null,
    startedAt,
    completedAt,
  };

  return prisma.selfServeSmokeRun.upsert({
    where: { runId },
    create: {
      runId,
      ...data,
    },
    update: data,
  });
}

export async function listSelfServeCustomerRegistry(actor: AppActor, params: {
  take?: number | null;
  status?: string | null;
} = {}) {
  requireSelfServeControlPlaneScope(actor, "control-plane:read");
  await requireSelfServeControlPlaneAccess(actor);

  const take = Math.min(Math.max(Math.floor(params.take ?? 100), 1), 250);
  const status = params.status?.trim();
  const trialWorkspaceInclude = {
    workspace: {
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        trialEndsAt: true,
        billingProfile: {
          select: {
            billingStatus: true,
            paymentMethodReady: true,
            stripeCustomerId: true,
            updatedAt: true,
          },
        },
        _count: {
          select: {
            members: true,
            roleOnboardingSessions: true,
            onboardingStates: true,
          },
        },
      },
    },
  } satisfies Prisma.ProcurementTrialInclude;
  const trials = await prisma.procurementTrial.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take,
    include: trialWorkspaceInclude,
  });

  const reviewTrials = trials.filter((trial) => trial.status === "REVIEW_REQUIRED");
  const reviewEmails = [...new Set(reviewTrials.map((trial) => normalizeEmail(trial.adminEmail)).filter(Boolean))];
  const reviewDomains = [...new Set(reviewTrials.map((trial) => trial.emailDomain.toLowerCase()).filter(Boolean))];
  const existingActiveTrials = reviewTrials.length
    ? await prisma.procurementTrial.findMany({
      where: {
        status: "ACTIVE",
        workspaceId: { not: null },
        OR: [
          ...(reviewEmails.length ? [{ adminEmail: { in: reviewEmails } }] : []),
          ...(reviewDomains.length ? [{ emailDomain: { in: reviewDomains } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(reviewTrials.length * 3, 10), 250),
      include: trialWorkspaceInclude,
    })
    : [];
  const trialsForLookups = [...trials, ...existingActiveTrials];
  const workspaceIds = [...new Set(trialsForLookups.map((trial) => trial.workspaceId).filter((value): value is string => Boolean(value)))];
  const trialIds = trials.map((trial) => trial.id);
  const [deployments, smokeRuns, emailCaptures, supportSessions, registrySyncEvents] = await Promise.all([
    workspaceIds.length
      ? prisma.customerDeployment.findMany({
        where: { managedWorkspaceId: { in: workspaceIds } },
        select: { id: true, managedWorkspaceId: true, label: true, deploymentStatus: true, supportConnectorStatus: true },
      })
      : Promise.resolve([]),
    prisma.selfServeSmokeRun.findMany({
      where: {
        OR: [
          { procurementTrialId: { in: trialIds } },
          ...(workspaceIds.length ? [{ workspaceId: { in: workspaceIds } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.selfServeEmailCapture.findMany({
      where: { procurementTrialId: { in: trialIds } },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        procurementTrialId: true,
        toEmail: true,
        runId: true,
        source: true,
        expiresAt: true,
        consumedAt: true,
        createdAt: true,
      },
    }),
    workspaceIds.length
      ? prisma.selfServeSupportSession.findMany({
        where: { workspaceId: { in: workspaceIds } },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: {
          id: true,
          workspaceId: true,
          operationId: true,
          targetMemberId: true,
          expiresAt: true,
          usedAt: true,
          createdAt: true,
        },
      })
      : Promise.resolve([]),
    prisma.customerDeploymentEvent.findMany({
      where: { action: "self_serve.registry_synced" },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        deploymentId: true,
        meta: true,
        createdAt: true,
      },
    }),
  ]);

  const deploymentByWorkspaceId = new Map(deployments.map((deployment) => [deployment.managedWorkspaceId, deployment]));
  const latestSmokeByKey = new Map<string, typeof smokeRuns[number]>();
  for (const run of smokeRuns) {
    for (const key of [run.procurementTrialId && `trial:${run.procurementTrialId}`, run.workspaceId && `workspace:${run.workspaceId}`].filter(Boolean) as string[]) {
      if (!latestSmokeByKey.has(key)) latestSmokeByKey.set(key, run);
    }
  }
  const latestEmailByTrialId = new Map<string, typeof emailCaptures[number]>();
  for (const capture of emailCaptures) {
    if (capture.procurementTrialId && !latestEmailByTrialId.has(capture.procurementTrialId)) {
      latestEmailByTrialId.set(capture.procurementTrialId, capture);
    }
  }
  const latestSupportByWorkspaceId = new Map<string, typeof supportSessions[number]>();
  for (const session of supportSessions) {
    if (!latestSupportByWorkspaceId.has(session.workspaceId)) {
      latestSupportByWorkspaceId.set(session.workspaceId, session);
    }
  }
  const activeTrialsForReviewLookup = [...trials, ...existingActiveTrials]
    .filter((trial) => trial.status === "ACTIVE" && trial.workspaceId && trial.workspace);

  function findExistingActiveTrial(trial: typeof trials[number]) {
    if (trial.status !== "REVIEW_REQUIRED" || trial.workspaceId || trial.workspace) return null;
    const adminEmail = normalizeEmail(trial.adminEmail);
    const domain = trial.emailDomain.toLowerCase();
    return activeTrialsForReviewLookup.find((candidate) => (
      candidate.id !== trial.id
      && (normalizeEmail(candidate.adminEmail) === adminEmail || candidate.emailDomain.toLowerCase() === domain)
    )) ?? null;
  }

  const localItems = trials.map((trial) => {
    const deployment = trial.workspaceId ? deploymentByWorkspaceId.get(trial.workspaceId) ?? null : null;
    const existingActiveTrial = findExistingActiveTrial(trial);
    const existingActiveDeployment = existingActiveTrial?.workspaceId
      ? deploymentByWorkspaceId.get(existingActiveTrial.workspaceId) ?? null
      : null;
    const latestSmoke = latestSmokeByKey.get(`trial:${trial.id}`)
      ?? (trial.workspaceId ? latestSmokeByKey.get(`workspace:${trial.workspaceId}`) : null)
      ?? null;
    return {
      trialId: trial.id,
      status: trial.status,
      riskStatus: trial.riskStatus,
      riskReasons: trial.riskReasons,
      companyName: trial.companyName,
      adminEmail: trial.adminEmail,
      adminName: trial.adminName,
      emailDomain: trial.emailDomain,
      trialExpiresAt: trial.trialExpiresAt,
      createdAt: trial.createdAt,
      updatedAt: trial.updatedAt,
      suspendedAt: trial.suspendedAt,
      suspensionReason: trial.suspensionReason,
      claimEmailStatus: trial.claimEmailStatus,
      workspace: trial.workspace,
      deployment,
      billing: trial.workspace?.billingProfile ?? null,
      existingActiveTrial: existingActiveTrial
        ? {
          trialId: existingActiveTrial.id,
          status: existingActiveTrial.status,
          companyName: existingActiveTrial.companyName,
          adminEmail: existingActiveTrial.adminEmail,
          emailDomain: existingActiveTrial.emailDomain,
          trialExpiresAt: existingActiveTrial.trialExpiresAt,
          createdAt: existingActiveTrial.createdAt,
          workspace: existingActiveTrial.workspace,
          deployment: existingActiveDeployment,
        }
        : null,
      latestSmoke,
      latestEmailCapture: latestEmailByTrialId.get(trial.id) ?? null,
      latestSupportSession: trial.workspaceId ? latestSupportByWorkspaceId.get(trial.workspaceId) ?? null : null,
    };
  });
  const localTrialIds = new Set(localItems.map((item) => item.trialId).filter(Boolean));
  const latestSyncedItems = [];
  const seenSources = new Set<string>();
  for (const event of registrySyncEvents) {
    const meta = asRecord(event.meta) ?? {};
    const sourceId = stringOrNull(meta.sourceId);
    const sourceDeploymentId = stringOrNull(meta.sourceDeploymentId) ?? event.deploymentId ?? null;
    const sourceUrl = stringOrNull(meta.sourceUrl);
    const sourceKey = [sourceId, sourceDeploymentId, sourceUrl].filter(Boolean).join("|") || event.id;
    if (seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);

    const rawItems = Array.isArray(meta.items) ? meta.items : [];
    for (const rawItem of rawItems) {
      const item = syncedRegistryItem({
        item: rawItem,
        eventId: event.id,
        eventCreatedAt: event.createdAt,
        sourceId,
        sourceUrl,
        sourceDeploymentId,
        generatedAt: stringOrNull(meta.generatedAt),
        receivedAt: stringOrNull(meta.receivedAt),
      });
      if (localTrialIds.has(item.trialId)) continue;
      if (status && item.status !== status) continue;
      latestSyncedItems.push(item);
    }
  }
  const items = [...localItems, ...latestSyncedItems]
    .sort((left, right) => {
      const leftTime = new Date(left.createdAt ?? 0).getTime();
      const rightTime = new Date(right.createdAt ?? 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, take);

  return {
    items,
    summary: {
      total: items.length,
      activeTrials: items.filter((item) => item.status === "ACTIVE").length,
      reviewRequired: items.filter((item) => item.status === "REVIEW_REQUIRED").length,
      suspendedTrials: items.filter((item) => item.status === "SUSPENDED").length,
      failedSmoke: items.filter((item) => item.latestSmoke?.status === "FAILED").length,
      smokeCovered: items.filter((item) => Boolean(item.latestSmoke)).length,
    },
  };
}

function supportEmailForWorkspace(workspaceId: string, sessionNonce: string) {
  const workspaceKey = workspaceId.slice(0, 12).replace(/[^a-z0-9]/gi, "").toLowerCase() || "workspace";
  const sessionKey = sessionNonce.slice(0, 12).replace(/[^a-z0-9]/gi, "").toLowerCase()
    || randomOpaqueToken().slice(0, 12).replace(/[^a-z0-9]/gi, "").toLowerCase()
    || "session";
  return `support+${workspaceKey}-${sessionKey}@${SUPPORT_EMAIL_DOMAIN}`;
}

async function cloneRoleAssignments(tx: Prisma.TransactionClient, params: {
  sourceMemberId: string | null;
  supportMemberId: string;
}) {
  await tx.roleAssignment.deleteMany({ where: { memberId: params.supportMemberId } });
  if (!params.sourceMemberId) return;
  const assignments = await tx.roleAssignment.findMany({
    where: {
      memberId: params.sourceMemberId,
      ...activeRoleAssignmentWhere(),
    },
    select: { roleId: true, expiresAt: true, transferReason: true },
  });
  if (assignments.length === 0) return;
  await tx.roleAssignment.createMany({
    data: assignments.map((assignment) => ({
      memberId: params.supportMemberId,
      roleId: assignment.roleId,
      expiresAt: assignment.expiresAt,
      transferReason: assignment.transferReason,
    })),
    skipDuplicates: true,
  });
}

async function createSupportLoginSession(tx: Prisma.TransactionClient, params: {
  userId: string;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const token = randomOpaqueToken();
  await tx.session.create({
    data: {
      userId: params.userId,
      tokenHash: sha256(token),
      expiresAt: params.expiresAt,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    },
  });
  return { token, expiresAt: params.expiresAt };
}

export async function createSelfServeSupportSession(actor: AppActor, params: {
  deploymentId?: string | null;
  workspaceId?: string | null;
  targetMemberId?: string | null;
  reason: string;
}) {
  requireSelfServeControlPlaneScope(actor, "control-plane:support:write");
  if (params.deploymentId?.trim()) {
    await requireSelfServeControlPlaneAccess(actor, { deploymentId: params.deploymentId.trim(), write: true });
  } else {
    invariant(isGlobalOperator(actor) || isControlPlaneAgent(actor), 403, "FORBIDDEN", "Control plane access is required.");
  }

  const deploymentId = params.deploymentId?.trim() || null;
  let deployment = deploymentId
    ? await prisma.customerDeployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, managedWorkspaceId: true, label: true },
    })
    : null;
  invariant(!deploymentId || deployment, 404, "NOT_FOUND", "Customer deployment not found.");
  const requestedWorkspaceId = params.workspaceId?.trim() || null;
  if (!deployment && requestedWorkspaceId) {
    deployment = await prisma.customerDeployment.findFirst({
      where: { managedWorkspaceId: requestedWorkspaceId },
      select: { id: true, managedWorkspaceId: true, label: true },
    });
  }
  const trialBoundary = !deployment && requestedWorkspaceId
    ? await prisma.procurementTrial.findFirst({
      where: { workspaceId: requestedWorkspaceId },
      select: { id: true },
    })
    : null;
  invariant(deployment || trialBoundary, 404, "NOT_FOUND", "Self-serve deployment or trial not found for support session.");
  const workspaceId = requestedWorkspaceId || deployment?.managedWorkspaceId || "";
  invariant(workspaceId, 400, "INVALID_INPUT", "A managed workspace is required for support sessions.");
  invariant(!deployment || workspaceId === deployment.managedWorkspaceId, 400, "INVALID_INPUT", "Workspace does not match the deployment.");

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");

  const requestedTargetMemberId = params.targetMemberId?.trim() || null;
  const targetMember = requestedTargetMemberId
    ? await prisma.member.findUnique({
      where: { id: requestedTargetMemberId },
      select: { id: true, workspaceId: true, role: true, user: { select: { email: true, displayName: true } } },
    })
    : null;
  invariant(!requestedTargetMemberId || targetMember, 404, "NOT_FOUND", "Target member not found.");
  invariant(!targetMember || targetMember.workspaceId === workspaceId, 400, "INVALID_INPUT", "Target member does not belong to the workspace.");
  const supportRole: MemberRole = targetMember?.role ?? "ADMIN";
  const secret = randomOpaqueToken();
  const supportEmail = supportEmailForWorkspace(workspaceId, randomOpaqueToken());
  const expiresAt = new Date(Date.now() + SUPPORT_SESSION_TTL_MS);
  const reason = params.reason.trim();
  invariant(reason.length > 0, 400, "INVALID_INPUT", "Support session reason is required.");

  const created = await prisma.$transaction(async (tx) => {
    const supportUser = await tx.user.create({
      data: {
        email: supportEmail,
        displayName: "Corgtex Support",
        passwordHash: hashPassword(randomOpaqueToken()),
      },
      select: { id: true, email: true, displayName: true },
    });

    const supportMember = await tx.member.create({
      data: {
        workspaceId,
        userId: supportUser.id,
        role: supportRole,
        kind: "SYSTEM",
        isActive: true,
      },
      select: { id: true, role: true },
    });
    await cloneRoleAssignments(tx, {
      sourceMemberId: targetMember?.id ?? null,
      supportMemberId: supportMember.id,
    });

    const operation = await tx.supportOperation.create({
      data: {
        deploymentId: deployment?.id ?? null,
        workspaceId,
        actorUserId: actorUserId(actor),
        actorLabel: actorLabel(actor),
        action: "support.session.open",
        reason,
        status: "COMPLETED",
        startedAt: new Date(),
        completedAt: new Date(),
        inputSummary: redactObject({
          targetMemberId: targetMember?.id ?? null,
          targetMemberEmail: targetMember?.user.email ?? null,
          clonedRole: supportRole,
        }) as Prisma.InputJsonObject,
        resultSummary: { workspaceId, supportMemberId: supportMember.id },
      },
      select: { id: true },
    });

    const session = await tx.selfServeSupportSession.create({
      data: {
        deploymentId: deployment?.id ?? null,
        workspaceId,
        operationId: operation.id,
        supportUserId: supportUser.id,
        supportMemberId: supportMember.id,
        targetMemberId: targetMember?.id ?? null,
        tokenHash: sha256(secret),
        reason,
        expiresAt,
      },
      select: { id: true },
    });

    await tx.auditLog.create({
      data: {
        workspaceId,
        actorUserId: actorUserId(actor),
        action: "support.session.opened",
        entityType: "SelfServeSupportSession",
        entityId: session.id,
        meta: toInputJson({
          deploymentId: deployment?.id ?? null,
          operationId: operation.id,
          targetMemberId: targetMember?.id ?? null,
          supportMemberId: supportMember.id,
          expiresAt: expiresAt.toISOString(),
        }) as Prisma.InputJsonObject,
      },
    });

    return { operation, session, supportMember, supportUser };
  });

  return {
    id: created.session.id,
    operationId: created.operation.id,
    workspaceId,
    supportUser: created.supportUser,
    supportMember: created.supportMember,
    targetMemberId: targetMember?.id ?? null,
    url: `${env.APP_URL.replace(/\/$/, "")}/support/sessions/${encodeURIComponent(secret)}`,
    expiresAt,
  };
}

export async function consumeSelfServeSupportSession(params: {
  token: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const token = params.token.trim();
  invariant(token.length > 0, 400, "INVALID_INPUT", "Support session token is required.");
  const now = new Date();
  const supportSession = await prisma.selfServeSupportSession.findUnique({
    where: { tokenHash: sha256(token) },
  });
  invariant(supportSession, 404, "NOT_FOUND", "Support session not found.");
  invariant(!supportSession.usedAt, 410, "SUPPORT_SESSION_USED", "Support session has already been used.");
  invariant(supportSession.expiresAt > now, 410, "SUPPORT_SESSION_EXPIRED", "Support session has expired.");

  const session = await prisma.$transaction(async (tx) => {
    const claim = await tx.selfServeSupportSession.updateMany({
      where: {
        id: supportSession.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    invariant(claim.count === 1, 410, "SUPPORT_SESSION_USED", "Support session has already been used.");

    const loginSession = await createSupportLoginSession(tx, {
      userId: supportSession.supportUserId,
      expiresAt: supportSession.expiresAt,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
    await tx.auditLog.create({
      data: {
        workspaceId: supportSession.workspaceId,
        actorUserId: supportSession.supportUserId,
        action: "support.session.consumed",
        entityType: "SelfServeSupportSession",
        entityId: supportSession.id,
        meta: {
          operationId: supportSession.operationId,
          targetMemberId: supportSession.targetMemberId,
        },
      },
    });
    return loginSession;
  });

  return {
    workspaceId: supportSession.workspaceId,
    session,
  };
}
