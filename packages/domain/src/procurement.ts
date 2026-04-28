import type { MemberRole, Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import {
  env,
  hashPassword,
  prisma,
  randomOpaqueToken,
  sendEmail,
  sha256,
} from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";
import { getMcpPublicUrl } from "./mcp-connector";
import { sendMemberSetupEmail, type MemberSetupEmailStatus } from "./members";

export const MAX_EMPLOYEE_INVITES = 50;
export const DEFAULT_PLAN_LABEL = "manual-invoice-v1";

const SETUP_SESSION_TOKEN_PREFIX = "setup_";
const SETUP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MEMBER_SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_IDEMPOTENCY_SCOPE = "procurement:v1:workspaces";
const EMPLOYEE_ROLES: MemberRole[] = ["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD"];

type Tx = Prisma.TransactionClient;

export type ProcurementEmployeeInviteInput = {
  email: string;
  displayName?: string | null;
  role?: MemberRole | null;
};

export type CreateSelfServeWorkspaceInput = {
  companyName: string;
  slug?: string | null;
  adminEmail: string;
  adminName?: string | null;
  employees?: ProcurementEmployeeInviteInput[];
  billingContactEmail: string;
  acceptedTermsVersion: string;
  sourceAgent?: Record<string, unknown> | null;
  planLabel?: string | null;
};

export type SetupSessionEmailStatus = {
  admin: MemberSetupEmailStatus;
  employees: MemberSetupEmailStatus[];
  billingNotification: {
    sent: boolean;
    error?: string;
  };
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
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
  return normalizeSlug(companyName) || "workspace";
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

function procurementActor(): AppActor {
  return {
    kind: "agent",
    authProvider: "bootstrap",
    label: "Public procurement setup",
    scopes: ["members:write"],
  };
}

function sourceAgentJson(sourceAgent?: Record<string, unknown> | null): Prisma.InputJsonValue | undefined {
  return sourceAgent ? (sourceAgent as Prisma.InputJsonObject) : undefined;
}

function responseFromJson(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new AppError(409, "IDEMPOTENCY_IN_PROGRESS", "The original idempotent request is still being processed.");
  }
  return value as Record<string, unknown>;
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

async function createMemberWithSetupToken(tx: Tx, actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName?: string | null;
  role: MemberRole;
}) {
  const email = normalizeEmail(params.email);
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");

  const randomPassword = randomOpaqueToken();
  const user = await tx.user.upsert({
    where: { email },
    update: {
      displayName: normalizeOptionalText(params.displayName) || undefined,
    },
    create: {
      email,
      displayName: normalizeOptionalText(params.displayName),
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
      role: params.role,
      isActive: true,
    },
    create: {
      workspaceId: params.workspaceId,
      userId: user.id,
      role: params.role,
      isActive: true,
    },
  });

  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      action: "member.created",
      entityType: "Member",
      entityId: member.id,
      meta: {
        email,
        role: params.role,
      },
    },
  });

  await appendEvents(tx, [
    {
      workspaceId: params.workspaceId,
      type: "member.created",
      aggregateType: "Member",
      aggregateId: member.id,
      payload: {
        memberId: member.id,
        userId: user.id,
        role: member.role,
      },
    },
  ]);

  const token = await issueSetupToken(tx, user.id);
  return { user, member, token };
}

async function findAvailableSlug(tx: Tx, requestedSlug: string, companyName: string) {
  const base = normalizeSlug(requestedSlug) || slugFromCompany(companyName);
  const existing = await tx.workspace.findUnique({
    where: { slug: base },
    select: { id: true },
  });
  if (!existing) {
    return base;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = sha256(`${base}:${companyName}:${attempt}`).slice(0, 6);
    const candidateBase = base.slice(0, Math.max(1, 64 - suffix.length - 1)).replace(/-$/g, "");
    const candidate = `${candidateBase}-${suffix}`;
    const collision = await tx.workspace.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!collision) {
      return candidate;
    }
  }

  throw new AppError(409, "SLUG_UNAVAILABLE", "Could not allocate an available workspace slug.");
}

function normalizeEmployees(employees: ProcurementEmployeeInviteInput[] | undefined) {
  return (employees ?? []).map((employee) => {
    const role = employee.role ?? "CONTRIBUTOR";
    if (!EMPLOYEE_ROLES.includes(role)) {
      throw new AppError(400, "INVALID_ROLE", "Initial employee invites cannot create admin members.");
    }
    return {
      email: normalizeEmail(employee.email),
      displayName: normalizeOptionalText(employee.displayName),
      role,
    };
  });
}

function assertUniqueInviteEmails(employees: { email: string }[], adminEmail?: string) {
  const seen = new Set<string>();
  for (const employee of employees) {
    invariant(employee.email.length > 0, 400, "INVALID_INPUT", "Employee email is required.");
    if (adminEmail && employee.email === adminEmail) {
      throw new AppError(400, "DUPLICATE_INVITE", "The initial admin email cannot also be invited as an employee.");
    }
    if (seen.has(employee.email)) {
      throw new AppError(400, "DUPLICATE_INVITE", `Duplicate employee invite email: ${employee.email}.`);
    }
    seen.add(employee.email);
  }
}

function normalizeCreateInput(input: CreateSelfServeWorkspaceInput) {
  const companyName = input.companyName.trim();
  const adminEmail = normalizeEmail(input.adminEmail);
  const billingContactEmail = normalizeEmail(input.billingContactEmail);
  const acceptedTermsVersion = input.acceptedTermsVersion.trim();
  const employees = normalizeEmployees(input.employees);

  invariant(companyName.length > 0, 400, "INVALID_INPUT", "Company name is required.");
  invariant(adminEmail.length > 0, 400, "INVALID_INPUT", "Admin email is required.");
  invariant(billingContactEmail.length > 0, 400, "INVALID_INPUT", "Billing contact email is required.");
  invariant(acceptedTermsVersion.length > 0, 400, "TERMS_REQUIRED", "acceptedTermsVersion is required.");
  invariant(employees.length <= MAX_EMPLOYEE_INVITES, 400, "INVITE_LIMIT_EXCEEDED", `Initial setup can invite at most ${MAX_EMPLOYEE_INVITES} employees.`);
  assertUniqueInviteEmails(employees, adminEmail);

  return {
    companyName,
    slug: normalizeOptionalText(input.slug),
    adminEmail,
    adminName: normalizeOptionalText(input.adminName),
    billingContactEmail,
    acceptedTermsVersion,
    employees,
    sourceAgent: input.sourceAgent ?? null,
    planLabel: normalizeOptionalText(input.planLabel) ?? DEFAULT_PLAN_LABEL,
  };
}

function publicWorkspaceResponse(params: {
  workspace: { id: string; name: string; slug: string };
  setupSessionId: string;
  expiresAt: Date;
  invitedEmployeeCount: number;
  maxEmployeeInvites: number;
  setupSessionToken?: string;
  mcpConnectorUrl: string;
  billingHandoffId: string;
  planLabel: string;
  emailStatus: SetupSessionEmailStatus;
}) {
  return {
    workspace: params.workspace,
    setupSession: {
      id: params.setupSessionId,
      status: "ACTIVE",
      expiresAt: params.expiresAt.toISOString(),
      invitedEmployeeCount: params.invitedEmployeeCount,
      maxEmployeeInvites: params.maxEmployeeInvites,
    },
    ...(params.setupSessionToken ? { setupSessionToken: params.setupSessionToken } : {}),
    mcpConnectorUrl: params.mcpConnectorUrl,
    billingHandoff: {
      id: params.billingHandoffId,
      status: "PENDING_MANUAL_INVOICE",
      planLabel: params.planLabel,
    },
    emailStatus: params.emailStatus,
  };
}

async function sendBillingHandoffNotification(params: {
  workspaceId: string;
  companyName: string;
  adminEmail: string;
  billingContactEmail: string;
  planLabel: string;
}) {
  if (!env.PROCUREMENT_NOTIFY_EMAIL) {
    return { sent: false, error: "PROCUREMENT_NOTIFY_EMAIL is not configured." };
  }
  if (!env.RESEND_API_KEY) {
    return { sent: false, error: "RESEND_API_KEY is not configured on the server." };
  }

  try {
    await sendEmail({
      to: env.PROCUREMENT_NOTIFY_EMAIL,
      subject: `Manual billing handoff: ${params.companyName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 20px;">
          <h2>New Corgtex self-serve workspace</h2>
          <p><strong>Company:</strong> ${params.companyName}</p>
          <p><strong>Workspace ID:</strong> ${params.workspaceId}</p>
          <p><strong>Admin:</strong> ${params.adminEmail}</p>
          <p><strong>Billing contact:</strong> ${params.billingContactEmail}</p>
          <p><strong>Plan:</strong> ${params.planLabel}</p>
          <p>Status: PENDING_MANUAL_INVOICE</p>
        </div>
      `,
    });
    return { sent: true };
  } catch (error) {
    return {
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createSelfServeWorkspace(params: {
  input: CreateSelfServeWorkspaceInput;
  idempotencyKey: string;
  origin?: string;
}) {
  const normalized = normalizeCreateInput(params.input);
  const idempotencyKey = params.idempotencyKey.trim();
  invariant(idempotencyKey.length > 0, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required.");

  const idemKeyHash = idempotencyKeyHash(WORKSPACE_IDEMPOTENCY_SCOPE, idempotencyKey);
  const idemRequestHash = requestHash(normalized);
  const existingIdempotency = await prisma.procurementIdempotencyKey.findUnique({
    where: { keyHash: idemKeyHash },
    select: {
      requestHash: true,
      responseJson: true,
    },
  });
  if (existingIdempotency) {
    if (existingIdempotency.requestHash !== idemRequestHash) {
      throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "The same Idempotency-Key was used with a different request body.");
    }
    return responseFromJson(existingIdempotency.responseJson);
  }

  const actor = procurementActor();
  const setupSessionToken = `${SETUP_SESSION_TOKEN_PREFIX}${randomOpaqueToken()}`;
  const setupSessionTokenHash = sha256(setupSessionToken);
  const expiresAt = new Date(Date.now() + SETUP_SESSION_TTL_MS);
  const mcpConnectorUrl = getMcpPublicUrl(params.origin);

  const created = await prisma.$transaction(async (tx) => {
    const slug = await findAvailableSlug(tx, normalized.slug ?? slugFromCompany(normalized.companyName), normalized.companyName);
    const workspace = await tx.workspace.create({
      data: {
        name: normalized.companyName,
        slug,
        description: `Self-serve Corgtex workspace for ${normalized.companyName}.`,
      },
      select: {
        id: true,
        name: true,
        slug: true,
      },
    });

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

    const admin = await createMemberWithSetupToken(tx, actor, {
      workspaceId: workspace.id,
      email: normalized.adminEmail,
      displayName: normalized.adminName,
      role: "ADMIN",
    });

    const employeeInvites = [];
    for (const employee of normalized.employees) {
      const createdEmployee = await createMemberWithSetupToken(tx, actor, {
        workspaceId: workspace.id,
        email: employee.email,
        displayName: employee.displayName,
        role: employee.role,
      });
      employeeInvites.push(createdEmployee);
    }

    const setupSession = await tx.procurementSetupSession.create({
      data: {
        workspaceId: workspace.id,
        tokenHash: setupSessionTokenHash,
        companyName: normalized.companyName,
        adminEmail: normalized.adminEmail,
        billingContactEmail: normalized.billingContactEmail,
        planLabel: normalized.planLabel,
        acceptedTermsVersion: normalized.acceptedTermsVersion,
        sourceAgent: sourceAgentJson(normalized.sourceAgent),
        invitedEmployeeCount: employeeInvites.length,
        maxEmployeeInvites: MAX_EMPLOYEE_INVITES,
        expiresAt,
      },
      select: {
        id: true,
        expiresAt: true,
        invitedEmployeeCount: true,
        maxEmployeeInvites: true,
      },
    });

    const billingHandoff = await tx.procurementBillingHandoff.create({
      data: {
        workspaceId: workspace.id,
        companyName: normalized.companyName,
        adminEmail: normalized.adminEmail,
        billingContactEmail: normalized.billingContactEmail,
        planLabel: normalized.planLabel,
        sourceAgent: sourceAgentJson(normalized.sourceAgent),
      },
      select: {
        id: true,
      },
    });

    await tx.procurementIdempotencyKey.create({
      data: {
        scope: WORKSPACE_IDEMPOTENCY_SCOPE,
        keyHash: idemKeyHash,
        requestHash: idemRequestHash,
        workspaceId: workspace.id,
        setupSessionId: setupSession.id,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actorUserId: null,
        action: "procurement.workspace.created",
        entityType: "Workspace",
        entityId: workspace.id,
        meta: {
          adminEmail: normalized.adminEmail,
          billingContactEmail: normalized.billingContactEmail,
          acceptedTermsVersion: normalized.acceptedTermsVersion,
          initialEmployeeInviteCount: employeeInvites.length,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: workspace.id,
        type: "procurement.workspace.created",
        aggregateType: "Workspace",
        aggregateId: workspace.id,
        payload: {
          workspaceId: workspace.id,
          setupSessionId: setupSession.id,
          billingHandoffId: billingHandoff.id,
        },
      },
    ]);

    return {
      workspace,
      setupSession,
      billingHandoff,
      admin,
      employeeInvites,
    };
  });

  const [adminEmailStatus, employeeEmailStatuses, billingNotification] = await Promise.all([
    sendMemberSetupEmail({
      email: created.admin.user.email,
      displayName: created.admin.user.displayName,
      token: created.admin.token,
      workspaceName: created.workspace.name,
    }),
    Promise.all(created.employeeInvites.map((employee) =>
      sendMemberSetupEmail({
        email: employee.user.email,
        displayName: employee.user.displayName,
        token: employee.token,
        workspaceName: created.workspace.name,
      }),
    )),
    sendBillingHandoffNotification({
      workspaceId: created.workspace.id,
      companyName: normalized.companyName,
      adminEmail: normalized.adminEmail,
      billingContactEmail: normalized.billingContactEmail,
      planLabel: normalized.planLabel,
    }),
  ]);

  const emailStatus: SetupSessionEmailStatus = {
    admin: adminEmailStatus,
    employees: employeeEmailStatuses,
    billingNotification,
  };

  const response = publicWorkspaceResponse({
    workspace: created.workspace,
    setupSessionId: created.setupSession.id,
    expiresAt: created.setupSession.expiresAt,
    invitedEmployeeCount: created.setupSession.invitedEmployeeCount,
    maxEmployeeInvites: created.setupSession.maxEmployeeInvites,
    setupSessionToken,
    mcpConnectorUrl,
    billingHandoffId: created.billingHandoff.id,
    planLabel: normalized.planLabel,
    emailStatus,
  });

  await prisma.$transaction([
    prisma.procurementSetupSession.update({
      where: { id: created.setupSession.id },
      data: { emailStatus: emailStatus as unknown as Prisma.InputJsonValue },
    }),
    prisma.procurementBillingHandoff.update({
      where: { id: created.billingHandoff.id },
      data: {
        notificationEmailSentAt: billingNotification.sent ? new Date() : null,
        notificationError: billingNotification.error ?? null,
      },
    }),
    prisma.procurementIdempotencyKey.update({
      where: { keyHash: idemKeyHash },
      data: { responseJson: response as unknown as Prisma.InputJsonValue },
    }),
  ]);

  return response;
}

async function requireSetupSession(params: {
  sessionId: string;
  token: string;
}) {
  const token = params.token.trim();
  invariant(token.startsWith(SETUP_SESSION_TOKEN_PREFIX), 401, "UNAUTHENTICATED", "Invalid setup session token.");

  const session = await prisma.procurementSetupSession.findUnique({
    where: {
      tokenHash: sha256(token),
    },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  });

  invariant(session && session.id === params.sessionId, 401, "UNAUTHENTICATED", "Invalid setup session token.");

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.procurementSetupSession.updateMany({
      where: {
        id: session.id,
        status: "ACTIVE",
      },
      data: {
        status: "EXPIRED",
      },
    });
    throw new AppError(401, "SETUP_SESSION_EXPIRED", "Setup session has expired.");
  }

  if (session.status !== "ACTIVE") {
    throw new AppError(409, "SETUP_SESSION_INACTIVE", "Setup session is not active.");
  }

  return session;
}

export async function getSelfServeSetupSessionStatus(params: {
  sessionId: string;
  token: string;
  origin?: string;
}) {
  const session = await requireSetupSession(params);
  const billingHandoff = await prisma.procurementBillingHandoff.findUnique({
    where: { workspaceId: session.workspaceId },
    select: {
      id: true,
      status: true,
      planLabel: true,
      notificationEmailSentAt: true,
      notificationError: true,
    },
  });

  return {
    workspace: session.workspace,
    setupSession: {
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt.toISOString(),
      invitedEmployeeCount: session.invitedEmployeeCount,
      maxEmployeeInvites: session.maxEmployeeInvites,
      emailStatus: session.emailStatus,
    },
    mcpConnectorUrl: getMcpPublicUrl(params.origin),
    billingHandoff,
  };
}

export async function bulkInviteSelfServeSetupMembers(params: {
  sessionId: string;
  token: string;
  members: ProcurementEmployeeInviteInput[];
  idempotencyKey: string;
}) {
  const idempotencyKey = params.idempotencyKey.trim();
  invariant(idempotencyKey.length > 0, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required.");

  const session = await requireSetupSession({
    sessionId: params.sessionId,
    token: params.token,
  });
  const members = normalizeEmployees(params.members);
  invariant(members.length > 0, 400, "INVALID_INPUT", "At least one member is required.");
  assertUniqueInviteEmails(members, session.adminEmail);
  invariant(
    session.invitedEmployeeCount + members.length <= session.maxEmployeeInvites,
    400,
    "INVITE_LIMIT_EXCEEDED",
    `Setup session can invite at most ${session.maxEmployeeInvites} employees.`,
  );

  const scope = `procurement:v1:setup-session:${session.id}:bulk-invite`;
  const idemKeyHash = idempotencyKeyHash(scope, idempotencyKey);
  const idemRequestHash = requestHash({ members });
  const existingIdempotency = await prisma.procurementIdempotencyKey.findUnique({
    where: { keyHash: idemKeyHash },
    select: {
      requestHash: true,
      responseJson: true,
    },
  });
  if (existingIdempotency) {
    if (existingIdempotency.requestHash !== idemRequestHash) {
      throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "The same Idempotency-Key was used with a different request body.");
    }
    return responseFromJson(existingIdempotency.responseJson);
  }

  const actor = procurementActor();
  const created = await prisma.$transaction(async (tx) => {
    const invited = [];
    for (const member of members) {
      const result = await createMemberWithSetupToken(tx, actor, {
        workspaceId: session.workspaceId,
        email: member.email,
        displayName: member.displayName,
        role: member.role,
      });
      invited.push(result);
    }

    const updatedSession = await tx.procurementSetupSession.update({
      where: { id: session.id },
      data: {
        invitedEmployeeCount: {
          increment: invited.length,
        },
      },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        invitedEmployeeCount: true,
        maxEmployeeInvites: true,
        emailStatus: true,
      },
    });

    await tx.procurementIdempotencyKey.create({
      data: {
        scope,
        keyHash: idemKeyHash,
        requestHash: idemRequestHash,
        workspaceId: session.workspaceId,
        setupSessionId: session.id,
      },
    });

    return { invited, updatedSession };
  });

  const emailStatuses = await Promise.all(created.invited.map((member) =>
    sendMemberSetupEmail({
      email: member.user.email,
      displayName: member.user.displayName,
      token: member.token,
      workspaceName: session.workspace.name,
    }),
  ));
  const priorEmailStatus = created.updatedSession.emailStatus && typeof created.updatedSession.emailStatus === "object"
    ? created.updatedSession.emailStatus as Record<string, unknown>
    : {};
  const priorEmployees = Array.isArray(priorEmailStatus.employees)
    ? priorEmailStatus.employees
    : [];
  const nextEmailStatus = {
    ...priorEmailStatus,
    employees: [...priorEmployees, ...emailStatuses],
  };
  const response = {
    setupSession: {
      id: created.updatedSession.id,
      status: created.updatedSession.status,
      expiresAt: created.updatedSession.expiresAt.toISOString(),
      invitedEmployeeCount: created.updatedSession.invitedEmployeeCount,
      maxEmployeeInvites: created.updatedSession.maxEmployeeInvites,
    },
    invited: created.invited.map((member) => ({
      memberId: member.member.id,
      userId: member.user.id,
      email: member.user.email,
      displayName: member.user.displayName,
      role: member.member.role,
    })),
    emailStatus: emailStatuses,
  };

  await prisma.$transaction([
    prisma.procurementSetupSession.update({
      where: { id: session.id },
      data: { emailStatus: nextEmailStatus as unknown as Prisma.InputJsonValue },
    }),
    prisma.procurementIdempotencyKey.update({
      where: { keyHash: idemKeyHash },
      data: { responseJson: response as unknown as Prisma.InputJsonValue },
    }),
  ]);

  return response;
}
