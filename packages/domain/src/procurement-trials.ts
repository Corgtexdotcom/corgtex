import type { MemberRole, Prisma } from "@prisma/client";
import {
  decryptSecret,
  encryptSecret,
  env,
  hashPassword,
  prisma,
  randomOpaqueToken,
  sha256,
} from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";
import { getMcpPublicUrl } from "./mcp-connector";
import { sendMemberSetupEmail, type MemberSetupEmailStatus } from "./members";
import {
  TRIAL_STATUS_ACTIVE,
  TRIAL_STATUS_REVIEW_REQUIRED,
  TRIAL_STATUS_SUSPENDED,
  TRIAL_STATUS_EXPIRED,
  TRIAL_STATUS_CONVERTED,
} from "./trial-entitlements";
import { registerCustomerDeployment } from "./customer-lifecycle";

export const PROCUREMENT_TRIAL_TTL_DAYS = 14;
export const PROCUREMENT_TRIAL_LIMITS = {
  modelMonthlyBudgetCents: 500,
  storageLimitMb: 100,
  memberLimit: 5,
  mcpDailyCallLimit: 100,
} as const;

export const TRIAL_CONNECTOR_SCOPES = [
  "workspace:read",
  "members:read",
  "governance:read",
  "proposals:read",
  "proposals:write",
  "actions:read",
  "actions:write",
  "tensions:read",
  "tensions:write",
  "goals:read",
  "goals:write",
  "brain:read",
  "brain:write",
  "conversations:write",
] as const;

const AGENT_CREDENTIAL_PREFIX = "agentc-";
const MEMBER_SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRIAL_IDEMPOTENCY_SCOPE = "procurement:v1:trials";

const PERSONAL_EMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
]);

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "temp-mail.org",
  "tempmail.com",
  "yopmail.com",
]);

type Tx = Prisma.TransactionClient;

export type ProcurementTrialInput = {
  companyName: string;
  adminEmail: string;
  adminName?: string | null;
  billingContactEmail?: string | null;
  acceptedTermsVersion: string;
  sourceAgent?: Record<string, unknown> | null;
};

type NormalizedTrialInput = {
  companyName: string;
  adminEmail: string;
  adminName: string | null;
  billingContactEmail: string | null;
  acceptedTermsVersion: string;
  sourceAgent: Record<string, unknown> | null;
  emailDomain: string;
};

type RiskAssessment = {
  riskStatus: "LOW" | "REVIEW_REQUIRED";
  riskReasons: string[];
};

type TrialUniquenessReason = "ACTIVE_TRIAL_FOR_EMAIL" | "ACTIVE_TRIAL_FOR_DOMAIN";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function emailDomain(email: string) {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function normalizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function slugFromCompany(companyName: string) {
  return normalizeSlug(companyName) || "trial";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function idempotencyKeyHash(scope: string, idempotencyKey: string) {
  return sha256(`${scope}:${idempotencyKey.trim()}`);
}

function requestHash(value: unknown) {
  return sha256(stableStringify(value));
}

function sourceAgentJson(sourceAgent?: Record<string, unknown> | null): Prisma.InputJsonValue | undefined {
  return sourceAgent ? (sourceAgent as Prisma.InputJsonObject) : undefined;
}

function normalizeInput(input: ProcurementTrialInput): NormalizedTrialInput {
  const companyName = input.companyName.trim();
  const adminEmail = normalizeEmail(input.adminEmail);
  const domain = emailDomain(adminEmail);
  const acceptedTermsVersion = input.acceptedTermsVersion.trim();

  invariant(companyName.length > 0, 400, "INVALID_INPUT", "Company name is required.");
  invariant(adminEmail.length > 0 && domain.length > 0, 400, "INVALID_INPUT", "Admin email is required.");
  invariant(acceptedTermsVersion.length > 0, 400, "TERMS_REQUIRED", "acceptedTermsVersion is required.");

  return {
    companyName,
    adminEmail,
    adminName: normalizeOptionalText(input.adminName),
    billingContactEmail: input.billingContactEmail ? normalizeEmail(input.billingContactEmail) : null,
    acceptedTermsVersion,
    sourceAgent: input.sourceAgent ?? null,
    emailDomain: domain,
  };
}

async function findAvailableSlug(tx: Tx, companyName: string) {
  const base = slugFromCompany(companyName);
  const existing = await tx.workspace.findUnique({
    where: { slug: base },
    select: { id: true },
  });
  if (!existing) return base;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = sha256(`${base}:${companyName}:${attempt}`).slice(0, 6);
    const candidateBase = base.slice(0, Math.max(1, 64 - suffix.length - 1)).replace(/-$/g, "");
    const candidate = `${candidateBase}-${suffix}`;
    const collision = await tx.workspace.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!collision) return candidate;
  }

  throw new AppError(409, "SLUG_UNAVAILABLE", "Could not allocate an available workspace slug.");
}

async function issueSetupToken(tx: Tx, userId: string) {
  await tx.passwordResetToken.updateMany({
    where: {
      userId,
      usedAt: null,
    },
    data: {
      usedAt: new Date(),
    },
  });

  const token = randomOpaqueToken();
  await tx.passwordResetToken.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + MEMBER_SETUP_TOKEN_TTL_MS),
    },
  });
  return token;
}

async function createTrialAdmin(tx: Tx, params: {
  workspaceId: string;
  email: string;
  displayName: string | null;
}) {
  const randomPassword = randomOpaqueToken();
  const user = await tx.user.upsert({
    where: { email: params.email },
    update: {
      displayName: params.displayName || undefined,
    },
    create: {
      email: params.email,
      displayName: params.displayName,
      passwordHash: hashPassword(randomPassword),
    },
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  });

  const member = await tx.member.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: params.workspaceId,
        userId: user.id,
      },
    },
    update: {
      role: "ADMIN",
      isActive: true,
    },
    create: {
      workspaceId: params.workspaceId,
      userId: user.id,
      role: "ADMIN",
      isActive: true,
    },
  });

  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: null,
      action: "procurement_trial.admin_created",
      entityType: "Member",
      entityId: member.id,
      meta: {
        email: params.email,
        role: "ADMIN",
      },
    },
  });

  const token = await issueSetupToken(tx, user.id);
  return { user, member, token };
}

function uniqueErrorTarget(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { code?: unknown; message?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") return "";
  const target = Array.isArray(candidate.meta?.target)
    ? candidate.meta.target.join(",")
    : String(candidate.meta?.target ?? "");
  return `${target} ${typeof candidate.message === "string" ? candidate.message : ""}`;
}

function activeTrialUniquenessReason(error: unknown): TrialUniquenessReason | null {
  const target = uniqueErrorTarget(error);
  if (target.includes("ProcurementTrial_active_adminEmail_key")) {
    return "ACTIVE_TRIAL_FOR_EMAIL";
  }
  if (target.includes("ProcurementTrial_active_emailDomain_key")) {
    return "ACTIVE_TRIAL_FOR_DOMAIN";
  }
  if (target.includes("adminEmail")) {
    return "ACTIVE_TRIAL_FOR_EMAIL";
  }
  if (target.includes("emailDomain")) {
    return "ACTIVE_TRIAL_FOR_DOMAIN";
  }
  return null;
}

function idempotencyKeyUniquenessConflict(error: unknown) {
  const target = uniqueErrorTarget(error);
  return target.includes("ProcurementIdempotencyKey_keyHash_key") || target.includes("keyHash");
}

async function expireStaleTrialsForIdentity(input: NormalizedTrialInput) {
  const staleTrials = await prisma.procurementTrial.findMany({
    where: {
      status: TRIAL_STATUS_ACTIVE,
      trialExpiresAt: { lte: new Date() },
      OR: [
        { adminEmail: input.adminEmail },
        { emailDomain: input.emailDomain },
      ],
    },
    select: {
      id: true,
      agentCredentialId: true,
    },
  });
  if (staleTrials.length === 0) return;

  const staleIds = staleTrials.map((trial) => trial.id);
  const credentialIds = staleTrials
    .map((trial) => trial.agentCredentialId)
    .filter((id): id is string => Boolean(id));
  await prisma.$transaction([
    prisma.procurementTrial.updateMany({
      where: { id: { in: staleIds } },
      data: { status: TRIAL_STATUS_EXPIRED },
    }),
    ...(credentialIds.length > 0
      ? [
          prisma.agentCredential.updateMany({
            where: { id: { in: credentialIds } },
            data: { isActive: false },
          }),
        ]
      : []),
  ]);
}

async function expireTrialConnector(trial: { id: string; agentCredentialId: string | null }) {
  await prisma.$transaction([
    prisma.procurementTrial.updateMany({
      where: { id: trial.id, status: TRIAL_STATUS_ACTIVE },
      data: { status: TRIAL_STATUS_EXPIRED },
    }),
    ...(trial.agentCredentialId
      ? [
          prisma.agentCredential.updateMany({
            where: { id: trial.agentCredentialId },
            data: { isActive: false },
          }),
        ]
      : []),
  ]);
}

async function assessTrialRisk(input: NormalizedTrialInput): Promise<RiskAssessment> {
  const riskReasons: string[] = [];
  if (PERSONAL_EMAIL_DOMAINS.has(input.emailDomain)) {
    riskReasons.push("PERSONAL_EMAIL_DOMAIN");
  }
  if (DISPOSABLE_EMAIL_DOMAINS.has(input.emailDomain)) {
    riskReasons.push("DISPOSABLE_EMAIL_DOMAIN");
  }
  if (!input.emailDomain.includes(".")) {
    riskReasons.push("INVALID_EMAIL_DOMAIN");
  }

  const now = new Date();
  const [activeForEmail, activeForDomain] = await Promise.all([
    prisma.procurementTrial.count({
      where: {
        adminEmail: input.adminEmail,
        status: TRIAL_STATUS_ACTIVE,
        trialExpiresAt: { gt: now },
      },
    }),
    prisma.procurementTrial.count({
      where: {
        emailDomain: input.emailDomain,
        status: TRIAL_STATUS_ACTIVE,
        trialExpiresAt: { gt: now },
      },
    }),
  ]);
  if (activeForEmail > 0) {
    riskReasons.push("ACTIVE_TRIAL_FOR_EMAIL");
  }
  if (activeForDomain > 0) {
    riskReasons.push("ACTIVE_TRIAL_FOR_DOMAIN");
  }

  return {
    riskStatus: riskReasons.length > 0 ? "REVIEW_REQUIRED" : "LOW",
    riskReasons,
  };
}

function trialLimits() {
  return {
    modelMonthlyBudgetCents: PROCUREMENT_TRIAL_LIMITS.modelMonthlyBudgetCents,
    storageLimitMb: PROCUREMENT_TRIAL_LIMITS.storageLimitMb,
    memberLimit: PROCUREMENT_TRIAL_LIMITS.memberLimit,
    mcpDailyCallLimit: PROCUREMENT_TRIAL_LIMITS.mcpDailyCallLimit,
  };
}

function trialStatusUrl(origin: string | undefined, trialId: string) {
  const base = (origin ?? "").replace(/\/$/, "");
  return `${base}/api/procurement/v1/trials/${trialId}`;
}

function workspaceUrl(origin: string | undefined, workspaceId: string) {
  const base = (origin ?? "").replace(/\/$/, "");
  return `${base}/workspaces/${workspaceId}`;
}

function publicTrialResponse(params: {
  origin?: string;
  trial: {
    id: string;
    status: string;
    riskStatus: string;
    riskReasons: string[];
    trialExpiresAt: Date;
    workspaceId: string | null;
    connectorTokenEnc?: string | null;
    claimEmailStatus?: unknown;
    modelMonthlyBudgetCents: number;
    storageLimitMb: number;
    memberLimit: number;
    mcpDailyCallLimit: number;
  };
  connectorToken?: string | null;
}) {
  const body: Record<string, unknown> = {
    trialId: params.trial.id,
    status: params.trial.status,
    riskStatus: params.trial.riskStatus,
    riskReasons: params.trial.riskReasons,
    statusUrl: trialStatusUrl(params.origin, params.trial.id),
    trialExpiresAt: params.trial.trialExpiresAt.toISOString(),
    limits: {
      trialDays: PROCUREMENT_TRIAL_TTL_DAYS,
      modelMonthlyBudgetCents: params.trial.modelMonthlyBudgetCents,
      storageLimitMb: params.trial.storageLimitMb,
      memberLimit: params.trial.memberLimit,
      mcpDailyCallLimit: params.trial.mcpDailyCallLimit,
    },
    claimEmailStatus: params.trial.claimEmailStatus ?? null,
  };

  if (params.trial.workspaceId) {
    body.workspace = {
      id: params.trial.workspaceId,
      url: workspaceUrl(params.origin, params.trial.workspaceId),
    };
    body.mcpConnectorUrl = getMcpPublicUrl(params.origin);
  }
  if (params.connectorToken) {
    body.connector = {
      token: params.connectorToken,
      scopes: TRIAL_CONNECTOR_SCOPES,
      mcpConnectorUrl: getMcpPublicUrl(params.origin),
    };
  }

  return body;
}

function publicIdempotencyResponse(params: {
  origin?: string;
  responseJson: unknown;
  connectorToken?: string | null;
}) {
  const response = params.responseJson && typeof params.responseJson === "object"
    ? { ...(params.responseJson as Record<string, unknown>) }
    : {};
  if (params.connectorToken) {
    response.connector = {
      token: params.connectorToken,
      scopes: TRIAL_CONNECTOR_SCOPES,
      mcpConnectorUrl: getMcpPublicUrl(params.origin),
    };
  }
  return response;
}

async function existingTrialResponse(params: {
  origin?: string;
  responseJson: unknown;
  workspaceId: string | null;
}) {
  if (!params.workspaceId) {
    return publicIdempotencyResponse({
      origin: params.origin,
      responseJson: params.responseJson,
    });
  }

  const trial = await prisma.procurementTrial.findUnique({
    where: { workspaceId: params.workspaceId },
    select: {
      id: true,
      workspaceId: true,
      agentCredentialId: true,
      connectorTokenEnc: true,
      status: true,
      riskStatus: true,
      riskReasons: true,
      trialExpiresAt: true,
      claimEmailStatus: true,
      modelMonthlyBudgetCents: true,
      storageLimitMb: true,
      memberLimit: true,
      mcpDailyCallLimit: true,
    },
  });
  if (!trial) {
    return publicIdempotencyResponse({
      origin: params.origin,
      responseJson: params.responseJson,
    });
  }

  const expired = trial.status === TRIAL_STATUS_ACTIVE && trial.trialExpiresAt.getTime() <= Date.now();
  if (expired) {
    await expireTrialConnector(trial);
  }
  const status = expired ? TRIAL_STATUS_EXPIRED : trial.status;
  const connectorToken = trial.connectorTokenEnc && status === TRIAL_STATUS_ACTIVE
    ? decryptSecret(trial.connectorTokenEnc)
    : null;

  return publicTrialResponse({
    origin: params.origin,
    trial: {
      id: trial.id,
      status,
      riskStatus: trial.riskStatus,
      riskReasons: trial.riskReasons,
      trialExpiresAt: trial.trialExpiresAt,
      workspaceId: trial.workspaceId,
      claimEmailStatus: trial.claimEmailStatus,
      modelMonthlyBudgetCents: trial.modelMonthlyBudgetCents,
      storageLimitMb: trial.storageLimitMb,
      memberLimit: trial.memberLimit,
      mcpDailyCallLimit: trial.mcpDailyCallLimit,
    },
    connectorToken,
  });
}

async function replayExistingIdempotencyResponse(params: {
  idemKeyHash: string;
  idemRequestHash: string;
  origin?: string;
}) {
  const existingIdempotency = await prisma.procurementIdempotencyKey.findUnique({
    where: { keyHash: params.idemKeyHash },
    select: {
      requestHash: true,
      responseJson: true,
      workspaceId: true,
    },
  });
  if (!existingIdempotency) return null;
  if (existingIdempotency.requestHash !== params.idemRequestHash) {
    throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "The same Idempotency-Key was used with a different request body.");
  }
  return {
    statusCode: existingIdempotency.workspaceId ? 201 : 202,
    body: await existingTrialResponse({
      origin: params.origin,
      responseJson: existingIdempotency.responseJson,
      workspaceId: existingIdempotency.workspaceId,
    }),
  };
}

async function createReviewGatedTrial(params: {
  normalized: NormalizedTrialInput;
  risk: RiskAssessment;
  expiresAt: Date;
  origin?: string;
  idemKeyHash: string;
  idemRequestHash: string;
}) {
  const claimEmailStatus: MemberSetupEmailStatus = {
    email: params.normalized.adminEmail,
    sent: false,
    error: "Trial request requires review before account claim.",
  };
  try {
    const created = await prisma.$transaction(async (tx) => {
      const trial = await tx.procurementTrial.create({
        data: {
          status: TRIAL_STATUS_REVIEW_REQUIRED,
          companyName: params.normalized.companyName,
          adminEmail: params.normalized.adminEmail,
          adminName: params.normalized.adminName,
          emailDomain: params.normalized.emailDomain,
          billingContactEmail: params.normalized.billingContactEmail,
          acceptedTermsVersion: params.normalized.acceptedTermsVersion,
          sourceAgent: sourceAgentJson(params.normalized.sourceAgent),
          riskStatus: "REVIEW_REQUIRED",
          riskReasons: params.risk.riskReasons,
          claimEmailStatus: claimEmailStatus as unknown as Prisma.InputJsonValue,
          trialExpiresAt: params.expiresAt,
          ...trialLimits(),
        },
      });
      const response = publicTrialResponse({
        origin: params.origin,
        trial,
      });
      await tx.procurementIdempotencyKey.create({
        data: {
          scope: TRIAL_IDEMPOTENCY_SCOPE,
          keyHash: params.idemKeyHash,
          requestHash: params.idemRequestHash,
          responseJson: response as Prisma.InputJsonObject,
        },
      });
      return { trial, response };
    });

    return {
      statusCode: 202,
      body: created.response,
    };
  } catch (error) {
    if (idempotencyKeyUniquenessConflict(error)) {
      const replayed = await replayExistingIdempotencyResponse({
        idemKeyHash: params.idemKeyHash,
        idemRequestHash: params.idemRequestHash,
        origin: params.origin,
      });
      if (replayed) return replayed;
    }
    throw error;
  }
}

async function createActiveTrial(params: {
  normalized: NormalizedTrialInput;
  risk: RiskAssessment;
  expiresAt: Date;
  origin?: string;
  idemKeyHash: string;
  idemRequestHash: string;
}) {
  const created = await prisma.$transaction(async (tx) => {
    const slug = await findAvailableSlug(tx, params.normalized.companyName);
    const workspace = await tx.workspace.create({
      data: {
        name: params.normalized.companyName,
        slug,
        description: `Corgtex trial workspace for ${params.normalized.companyName}.`,
      },
      select: {
        id: true,
        name: true,
        slug: true,
      },
    });

    await registerCustomerDeployment({
      accountSlug: workspace.slug,
      accountDisplayName: workspace.name,
      accountStatus: "TRIAL",
      managementAuthority: "CORGTEX",
      label: workspace.name,
      url: workspaceUrl(params.origin ?? env.APP_URL, workspace.id),
      environment: "production",
      notes: `Procurement trial workspace for ${params.normalized.companyName}.`,
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      customerSlug: workspace.slug,
      managedWorkspaceId: workspace.id,
      primary: true,
    }, tx);

    await tx.approvalPolicy.createMany({
      data: [
        {
          workspaceId: workspace.id,
          subjectType: "PROPOSAL",
          mode: "CONSENT",
          quorumPercent: 0,
          minApproverCount: 1,
          decisionWindowHours: 72,
        },
        {
          workspaceId: workspace.id,
          subjectType: "SPEND",
          mode: "SINGLE",
          quorumPercent: 0,
          minApproverCount: 1,
          decisionWindowHours: 72,
          requireProposalLink: false,
        },
      ],
    });

    const admin = await createTrialAdmin(tx, {
      workspaceId: workspace.id,
      email: params.normalized.adminEmail,
      displayName: params.normalized.adminName,
    });

    const credentialSecret = randomOpaqueToken();
    const connectorToken = `${AGENT_CREDENTIAL_PREFIX}${credentialSecret}`;
    const credential = await tx.agentCredential.create({
      data: {
        workspaceId: workspace.id,
        createdByUserId: admin.user.id,
        label: "Procurement trial connector",
        tokenHash: sha256(credentialSecret),
        scopes: [...TRIAL_CONNECTOR_SCOPES],
        isActive: true,
      },
      select: {
        id: true,
      },
    });

    await tx.agentIdentity.create({
      data: {
        workspaceId: workspace.id,
        agentKey: `ext_${credential.id.slice(0, 8)}`,
        memberType: "EXTERNAL",
        displayName: "Procurement trial connector",
        linkedCredentialId: credential.id,
        createdByUserId: admin.user.id,
        maxSpendPerRunCents: PROCUREMENT_TRIAL_LIMITS.modelMonthlyBudgetCents,
        maxRunsPerDay: PROCUREMENT_TRIAL_LIMITS.mcpDailyCallLimit,
      },
    });

    await tx.modelUsageBudget.upsert({
      where: { workspaceId: workspace.id },
      create: {
        workspaceId: workspace.id,
        monthlyCostCapUsd: PROCUREMENT_TRIAL_LIMITS.modelMonthlyBudgetCents / 100,
        alertThresholdPct: 80,
        periodStartDay: 1,
      },
      update: {
        monthlyCostCapUsd: PROCUREMENT_TRIAL_LIMITS.modelMonthlyBudgetCents / 100,
        alertThresholdPct: 80,
        periodStartDay: 1,
      },
    });

    const trial = await tx.procurementTrial.create({
      data: {
        workspaceId: workspace.id,
        agentCredentialId: credential.id,
        status: TRIAL_STATUS_ACTIVE,
        companyName: params.normalized.companyName,
        adminEmail: params.normalized.adminEmail,
        adminName: params.normalized.adminName,
        emailDomain: params.normalized.emailDomain,
        billingContactEmail: params.normalized.billingContactEmail,
        acceptedTermsVersion: params.normalized.acceptedTermsVersion,
        sourceAgent: sourceAgentJson(params.normalized.sourceAgent),
        riskStatus: params.risk.riskStatus,
        riskReasons: params.risk.riskReasons,
        connectorTokenEnc: encryptSecret(connectorToken),
        connectorTokenRevealedAt: new Date(),
        modelMonthlyBudgetCents: PROCUREMENT_TRIAL_LIMITS.modelMonthlyBudgetCents,
        storageLimitMb: PROCUREMENT_TRIAL_LIMITS.storageLimitMb,
        memberLimit: PROCUREMENT_TRIAL_LIMITS.memberLimit,
        mcpDailyCallLimit: PROCUREMENT_TRIAL_LIMITS.mcpDailyCallLimit,
        trialExpiresAt: params.expiresAt,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actorUserId: null,
        action: "procurement_trial.created",
        entityType: "ProcurementTrial",
        entityId: trial.id,
        meta: {
          adminEmail: params.normalized.adminEmail,
          emailDomain: params.normalized.emailDomain,
          riskStatus: params.risk.riskStatus,
          riskReasons: params.risk.riskReasons,
        },
      },
    });
    await appendEvents(tx, [
      {
        workspaceId: workspace.id,
        type: "procurement_trial.created",
        aggregateType: "ProcurementTrial",
        aggregateId: trial.id,
        payload: {
          trialId: trial.id,
          agentCredentialId: credential.id,
        },
      },
    ]);

    const response = publicTrialResponse({
      origin: params.origin,
      trial,
    });
    await tx.procurementIdempotencyKey.create({
      data: {
        scope: TRIAL_IDEMPOTENCY_SCOPE,
        keyHash: params.idemKeyHash,
        requestHash: params.idemRequestHash,
        workspaceId: workspace.id,
        responseJson: response as Prisma.InputJsonObject,
      },
    });

    return {
      admin,
      connectorToken,
      response,
      trial,
    };
  });

  const claimEmailStatus = await sendMemberSetupEmail({
    email: created.admin.user.email,
    displayName: created.admin.user.displayName,
    token: created.admin.token,
    workspaceName: params.normalized.companyName,
  });
  const responseWithEmailStatus = {
    ...created.response,
    claimEmailStatus,
  };
  await prisma.$transaction([
    prisma.procurementTrial.update({
      where: { id: created.trial.id },
      data: { claimEmailStatus: claimEmailStatus as unknown as Prisma.InputJsonValue },
    }),
    prisma.procurementIdempotencyKey.update({
      where: { keyHash: params.idemKeyHash },
      data: { responseJson: responseWithEmailStatus as Prisma.InputJsonObject },
    }),
  ]);

  return {
    statusCode: 201,
    body: {
      ...responseWithEmailStatus,
      connector: {
        token: created.connectorToken,
        scopes: TRIAL_CONNECTOR_SCOPES,
        mcpConnectorUrl: getMcpPublicUrl(params.origin),
      },
    },
  };
}

export async function createProcurementTrial(params: {
  input: ProcurementTrialInput;
  idempotencyKey: string;
  origin?: string;
}) {
  const normalized = normalizeInput(params.input);
  const idempotencyKey = params.idempotencyKey.trim();
  invariant(idempotencyKey.length > 0, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required.");

  const idemKeyHash = idempotencyKeyHash(TRIAL_IDEMPOTENCY_SCOPE, idempotencyKey);
  const idemRequestHash = requestHash(normalized);
  const existingIdempotency = await replayExistingIdempotencyResponse({
    idemKeyHash,
    idemRequestHash,
    origin: params.origin,
  });
  if (existingIdempotency) {
    return existingIdempotency;
  }

  await expireStaleTrialsForIdentity(normalized);
  const risk = await assessTrialRisk(normalized);
  const expiresAt = new Date(Date.now() + PROCUREMENT_TRIAL_TTL_DAYS * 24 * 60 * 60 * 1000);

  if (risk.riskStatus === "REVIEW_REQUIRED") {
    return createReviewGatedTrial({
      normalized,
      risk,
      expiresAt,
      origin: params.origin,
      idemKeyHash,
      idemRequestHash,
    });
  }

  try {
    return await createActiveTrial({
      normalized,
      risk,
      expiresAt,
      origin: params.origin,
      idemKeyHash,
      idemRequestHash,
    });
  } catch (error) {
    const uniquenessReason = activeTrialUniquenessReason(error);
    if (uniquenessReason) {
      const replayed = await replayExistingIdempotencyResponse({
        idemKeyHash,
        idemRequestHash,
        origin: params.origin,
      });
      if (replayed) return replayed;
      return createReviewGatedTrial({
        normalized,
        risk: {
          riskStatus: "REVIEW_REQUIRED",
          riskReasons: Array.from(new Set([...risk.riskReasons, uniquenessReason])),
        },
        expiresAt,
        origin: params.origin,
        idemKeyHash,
        idemRequestHash,
      });
    }
    if (idempotencyKeyUniquenessConflict(error)) {
      const replayed = await replayExistingIdempotencyResponse({
        idemKeyHash,
        idemRequestHash,
        origin: params.origin,
      });
      if (replayed) return replayed;
    }
    throw error;
  }
}

export async function getProcurementTrialStatus(trialId: string, origin?: string) {
  const trial = await prisma.procurementTrial.findUnique({
    where: { id: trialId },
    select: {
      id: true,
      status: true,
      riskStatus: true,
      riskReasons: true,
      trialExpiresAt: true,
      workspaceId: true,
      claimEmailStatus: true,
      modelMonthlyBudgetCents: true,
      storageLimitMb: true,
      memberLimit: true,
      mcpDailyCallLimit: true,
      suspendedAt: true,
      suspensionReason: true,
      convertedAt: true,
    },
  });
  invariant(trial, 404, "NOT_FOUND", "Procurement trial not found.");

  const activeStatus = trial.status === TRIAL_STATUS_ACTIVE && trial.trialExpiresAt.getTime() <= Date.now()
    ? TRIAL_STATUS_EXPIRED
    : trial.status;

  return {
    ...publicTrialResponse({
      origin,
      trial: {
        ...trial,
        status: activeStatus,
      },
    }),
    suspendedAt: trial.suspendedAt?.toISOString() ?? null,
    suspensionReason: trial.suspensionReason,
    convertedAt: trial.convertedAt?.toISOString() ?? null,
  };
}

export type { MemberSetupEmailStatus, MemberRole };
export {
  TRIAL_STATUS_ACTIVE,
  TRIAL_STATUS_REVIEW_REQUIRED,
  TRIAL_STATUS_SUSPENDED,
  TRIAL_STATUS_EXPIRED,
  TRIAL_STATUS_CONVERTED,
};
