import type { MemberRole, Prisma } from "@prisma/client";
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

const SUPPORT_SESSION_TTL_MS = 60 * 60 * 1000;
const SUPPORT_EMAIL_DOMAIN = "corgtex.local";
const CONTROL_PLANE_READ_SCOPE = "control-plane:read";

type JsonRecord = Record<string, unknown>;

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

async function requireSelfServeControlPlaneAccess(actor: AppActor, params: { deploymentId?: string } = {}) {
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
      select: { isActive: true },
    });
    if (access?.isActive) return;
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
    where: { runId: params.runId.trim() },
    create: {
      runId: params.runId.trim(),
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
  const trials = await prisma.procurementTrial.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take,
    include: {
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
    },
  });

  const workspaceIds = trials.map((trial) => trial.workspaceId).filter((value): value is string => Boolean(value));
  const trialIds = trials.map((trial) => trial.id);
  const [deployments, smokeRuns, emailCaptures, supportSessions] = await Promise.all([
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

  const items = trials.map((trial) => {
    const deployment = trial.workspaceId ? deploymentByWorkspaceId.get(trial.workspaceId) ?? null : null;
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
      emailDomain: trial.emailDomain,
      trialExpiresAt: trial.trialExpiresAt,
      createdAt: trial.createdAt,
      workspace: trial.workspace,
      deployment,
      billing: trial.workspace?.billingProfile ?? null,
      latestSmoke,
      latestEmailCapture: latestEmailByTrialId.get(trial.id) ?? null,
      latestSupportSession: trial.workspaceId ? latestSupportByWorkspaceId.get(trial.workspaceId) ?? null : null,
    };
  });

  return {
    items,
    summary: {
      total: items.length,
      activeTrials: items.filter((item) => item.status === "ACTIVE").length,
      reviewRequired: items.filter((item) => item.status === "REVIEW_REQUIRED").length,
      failedSmoke: items.filter((item) => item.latestSmoke?.status === "FAILED").length,
      smokeCovered: items.filter((item) => Boolean(item.latestSmoke)).length,
    },
  };
}

function supportEmailForWorkspace(workspaceId: string) {
  return `support+${workspaceId.slice(0, 12).replace(/[^a-z0-9]/gi, "").toLowerCase()}@${SUPPORT_EMAIL_DOMAIN}`;
}

async function cloneRoleAssignments(tx: Prisma.TransactionClient, params: {
  sourceMemberId: string | null;
  supportMemberId: string;
}) {
  await tx.roleAssignment.deleteMany({ where: { memberId: params.supportMemberId } });
  if (!params.sourceMemberId) return;
  const assignments = await tx.roleAssignment.findMany({
    where: { memberId: params.sourceMemberId },
    select: { roleId: true },
  });
  if (assignments.length === 0) return;
  await tx.roleAssignment.createMany({
    data: assignments.map((assignment) => ({
      memberId: params.supportMemberId,
      roleId: assignment.roleId,
    })),
    skipDuplicates: true,
  });
}

async function createSupportLoginSession(tx: Prisma.TransactionClient, params: {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const token = randomOpaqueToken();
  const expiresAt = new Date(Date.now() + SUPPORT_SESSION_TTL_MS);
  await tx.session.create({
    data: {
      userId: params.userId,
      tokenHash: sha256(token),
      expiresAt,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    },
  });
  return { token, expiresAt };
}

export async function createSelfServeSupportSession(actor: AppActor, params: {
  deploymentId?: string | null;
  workspaceId?: string | null;
  targetMemberId?: string | null;
  reason: string;
}) {
  requireSelfServeControlPlaneScope(actor, "control-plane:support:write");
  if (params.deploymentId?.trim()) {
    await requireSelfServeControlPlaneAccess(actor, { deploymentId: params.deploymentId.trim() });
  } else {
    invariant(isGlobalOperator(actor) || isControlPlaneAgent(actor), 403, "FORBIDDEN", "Control plane access is required.");
  }

  const deploymentId = params.deploymentId?.trim() || null;
  const deployment = deploymentId
    ? await prisma.customerDeployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, managedWorkspaceId: true, label: true },
    })
    : null;
  invariant(!deploymentId || deployment, 404, "NOT_FOUND", "Customer deployment not found.");
  const workspaceId = params.workspaceId?.trim() || deployment?.managedWorkspaceId || "";
  invariant(workspaceId, 400, "INVALID_INPUT", "A managed workspace is required for support sessions.");
  invariant(!deployment || workspaceId === deployment.managedWorkspaceId, 400, "INVALID_INPUT", "Workspace does not match the deployment.");

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");

  const targetMember = params.targetMemberId?.trim()
    ? await prisma.member.findUnique({
      where: { id: params.targetMemberId.trim() },
      select: { id: true, workspaceId: true, role: true, user: { select: { email: true, displayName: true } } },
    })
    : null;
  invariant(!targetMember || targetMember.workspaceId === workspaceId, 400, "INVALID_INPUT", "Target member does not belong to the workspace.");
  const supportRole: MemberRole = targetMember?.role ?? "ADMIN";
  const supportEmail = supportEmailForWorkspace(workspaceId);
  const secret = randomOpaqueToken();
  const expiresAt = new Date(Date.now() + SUPPORT_SESSION_TTL_MS);
  const reason = params.reason.trim();
  invariant(reason.length > 0, 400, "INVALID_INPUT", "Support session reason is required.");

  const created = await prisma.$transaction(async (tx) => {
    const supportUser = await tx.user.upsert({
      where: { email: supportEmail },
      update: {
        displayName: "Corgtex Support",
        passwordHash: hashPassword(randomOpaqueToken()),
      },
      create: {
        email: supportEmail,
        displayName: "Corgtex Support",
        passwordHash: hashPassword(randomOpaqueToken()),
      },
      select: { id: true, email: true, displayName: true },
    });

    const supportMember = await tx.member.upsert({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: supportUser.id,
        },
      },
      update: {
        role: supportRole,
        isActive: true,
      },
      create: {
        workspaceId,
        userId: supportUser.id,
        role: supportRole,
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
