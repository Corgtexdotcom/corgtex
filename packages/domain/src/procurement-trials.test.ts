import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  checkRateLimitMock,
  decryptSecretMock,
  encryptSecretMock,
  prismaMock,
  randomOpaqueTokenMock,
  sendEmailMock,
  createCanonicalWorkspaceMock,
} = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    procurementIdempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    procurementTrial: {
      count: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    workspaceFeatureFlag: {
      createMany: vi.fn(),
    },
    workspaceBillingProfile: {
      upsert: vi.fn(),
    },
    customerAccount: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    customerDeployment: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    approvalPolicy: {
      createMany: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
    },
    member: {
      upsert: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
    passwordResetToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    agentCredential: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    agentIdentity: {
      create: vi.fn(),
    },
    modelUsageBudget: {
      upsert: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
    },
  };
  return {
    checkRateLimitMock: vi.fn(),
    decryptSecretMock: vi.fn((value: string) => value.replace(/^enc:/, "")),
    encryptSecretMock: vi.fn((value: string) => `enc:${value}`),
    prismaMock: prisma,
    randomOpaqueTokenMock: vi.fn(),
    sendEmailMock: vi.fn(),
    createCanonicalWorkspaceMock: vi.fn(),
  };
});

vi.mock("./workspaces", () => ({
  assertNonReservedWorkspaceSystemEmail: vi.fn(),
  createCanonicalWorkspace: createCanonicalWorkspaceMock,
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    checkRateLimit: checkRateLimitMock,
    decryptSecret: decryptSecretMock,
    encryptSecret: encryptSecretMock,
    env: {
      ...actual.env,
      APP_URL: "https://app.test",
      MCP_PUBLIC_URL: "https://mcp.test/mcp",
      RESEND_API_KEY: undefined,
      SMOKE_EMAIL_CAPTURE_SECRET: "capture-secret",
      SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS: "smoke.test",
    },
    hashPassword: vi.fn((value: string) => `hash:${value}`),
    prisma: prismaMock,
    randomOpaqueToken: randomOpaqueTokenMock,
    sendEmail: sendEmailMock,
    sha256: vi.fn((value: string) => `hash:${value}`),
  };
});

describe("procurement trials", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    randomOpaqueTokenMock
      .mockReturnValueOnce("admin-password")
      .mockReturnValueOnce("admin-setup-token")
      .mockReturnValueOnce("credential-secret");
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 99,
      limit: 100,
      resetAtMs: Date.now() + 60_000,
    });
    prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return (arg as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock);
    });
    prismaMock.procurementIdempotencyKey.findUnique.mockResolvedValue(null);
    prismaMock.procurementIdempotencyKey.create.mockResolvedValue({});
    prismaMock.procurementIdempotencyKey.update.mockResolvedValue({});
    prismaMock.procurementIdempotencyKey.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.procurementTrial.count.mockResolvedValue(0);
    prismaMock.procurementTrial.findMany.mockResolvedValue([]);
    prismaMock.procurementTrial.create.mockImplementation(async ({ data }: any) => ({
      id: data.status === "ACTIVE" ? "trial-1" : "trial-review",
      claimEmailStatus: null,
      ...data,
    }));
    prismaMock.procurementTrial.findUnique.mockResolvedValue(null);
    prismaMock.procurementTrial.update.mockResolvedValue({ id: "trial-1", status: "SUSPENDED" });
    prismaMock.procurementTrial.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.workspace.findUnique.mockResolvedValue(null);
    prismaMock.workspace.create.mockResolvedValue({ id: "ws-1", name: "Acme", slug: "acme" });
    createCanonicalWorkspaceMock.mockResolvedValue({ id: "ws-1", name: "Acme", slug: "acme" });
    prismaMock.workspace.update.mockResolvedValue({ id: "ws-1" });
    prismaMock.workspace.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.workspaceFeatureFlag.createMany.mockResolvedValue({ count: 10 });
    prismaMock.workspaceBillingProfile.upsert.mockResolvedValue({});
    prismaMock.customerAccount.upsert.mockResolvedValue({ id: "cust-1", slug: "acme", primaryDeploymentId: null });
    prismaMock.customerAccount.findUnique.mockResolvedValue({ id: "cust-1", primaryDeploymentId: null });
    prismaMock.customerAccount.update.mockResolvedValue({ id: "cust-1", primaryDeploymentId: "inst-1" });
    prismaMock.customerDeployment.findUnique.mockResolvedValue(null);
    prismaMock.customerDeployment.upsert.mockResolvedValue({ id: "inst-1", customerSlug: "acme" });
    prismaMock.approvalPolicy.createMany.mockResolvedValue({ count: 2 });
    prismaMock.user.upsert.mockResolvedValue({ id: "user-admin", email: "admin@acme.test", displayName: "Admin" });
    prismaMock.member.upsert.mockResolvedValue({ id: "member-admin", role: "ADMIN" });
    prismaMock.member.count.mockResolvedValue(1);
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.passwordResetToken.create.mockResolvedValue({});
    prismaMock.agentCredential.create.mockResolvedValue({ id: "cred-1" });
    prismaMock.agentCredential.update.mockResolvedValue({});
    prismaMock.agentCredential.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.agentIdentity.create.mockResolvedValue({});
    prismaMock.modelUsageBudget.upsert.mockResolvedValue({});
    prismaMock.document.findMany.mockResolvedValue([]);
  });

  it("creates an active capped trial for a business domain and returns a connector token", async () => {
    const { createProcurementTrial } = await import("./procurement-trials");

    const result = await createProcurementTrial({
      idempotencyKey: "idem-1",
      origin: "https://app.test",
      input: {
        companyName: "Acme",
        adminEmail: "Admin@Acme.test",
        adminName: "Admin",
        acceptedTermsVersion: "2026-04",
      },
    });

    expect(result.statusCode).toBe(201);
    expect(result.body).toMatchObject({
      trialId: "trial-1",
      status: "ACTIVE",
      riskStatus: "LOW",
      workspace: { id: "ws-1" },
      connector: {
        token: "agentc-credential-secret",
      },
    });
    expect(prismaMock.agentCredential.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        scopes: expect.arrayContaining(["workspace:read", "conversations:write"]),
      }),
    }));
    expect(prismaMock.modelUsageBudget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ monthlyCostCapUsd: 5 }),
    }));
    expect(createCanonicalWorkspaceMock).toHaveBeenCalledWith(prismaMock, expect.objectContaining({
      data: expect.objectContaining({
        plan: "TRIAL",
        trialEndsAt: expect.any(Date),
      }),
    }));
    expect(prismaMock.workspaceFeatureFlag.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({ flag: "TOOL_LINKS", enabled: true }),
        expect.objectContaining({ flag: "CONTEXT_MAPS", enabled: true }),
        expect.objectContaining({ flag: "AI_WORKSPACES", enabled: true }),
        expect.objectContaining({ flag: "OPENWORK_DEFAULT", enabled: true }),
        expect.objectContaining({ flag: "EXECUTION_PACKETS", enabled: true }),
        expect.objectContaining({ flag: "MEETING_TRANSCRIPT_SOURCES", enabled: false }),
        expect.objectContaining({ flag: "MEETING_RECORDERS", enabled: false }),
      ]),
      skipDuplicates: true,
    }));
    expect(prismaMock.workspaceBillingProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      create: expect.objectContaining({ billingStatus: "NONE" }),
    }));
    expect(prismaMock.customerAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: "acme" },
      create: expect.objectContaining({
        slug: "acme",
        displayName: "Acme",
        status: "TRIAL",
        managementAuthority: "CORGTEX",
      }),
    }));
    expect(prismaMock.customerDeployment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { url: "https://app.test/workspaces/ws-1" },
      create: expect.objectContaining({
        customerAccountId: "cust-1",
        deploymentKind: "SHARED_WORKSPACE",
        deploymentStatus: "ACTIVE",
        managedWorkspaceId: "ws-1",
      }),
    }));
    const idempotencyCreate = prismaMock.procurementIdempotencyKey.create.mock.calls[0][0];
    expect(JSON.stringify(idempotencyCreate.data.responseJson)).not.toContain("agentc-credential-secret");
    expect(JSON.stringify(result.body)).not.toContain("admin-setup-token");
  });

  it("expires prior active smoke-domain trials before creating the next active smoke trial", async () => {
    prismaMock.procurementTrial.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "old-smoke-trial",
          workspaceId: "old-smoke-workspace",
          agentCredentialId: "old-smoke-credential",
        },
      ]);
    const { createProcurementTrial } = await import("./procurement-trials");

    const result = await createProcurementTrial({
      idempotencyKey: "idem-smoke-1",
      origin: "https://app.test",
      input: {
        companyName: "Smoke",
        adminEmail: "agent@smoke.test",
        adminName: "Smoke Agent",
        acceptedTermsVersion: "2026-04",
      },
    });

    expect(result.statusCode).toBe(201);
    expect(result.body).toMatchObject({
      status: "ACTIVE",
      riskStatus: "LOW",
    });
    expect(prismaMock.procurementTrial.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-smoke-trial"] } },
      data: { status: "EXPIRED" },
    });
    expect(prismaMock.agentCredential.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-smoke-credential"] } },
      data: { isActive: false },
    });
  });

  it("review-gates personal email domains without creating a workspace or connector", async () => {
    const { createProcurementTrial } = await import("./procurement-trials");

    const result = await createProcurementTrial({
      idempotencyKey: "idem-2",
      origin: "https://app.test",
      input: {
        companyName: "Acme",
        adminEmail: "person@gmail.com",
        acceptedTermsVersion: "2026-04",
      },
    });

    expect(result.statusCode).toBe(202);
    expect(result.body).toMatchObject({
      trialId: "trial-review",
      status: "REVIEW_REQUIRED",
      riskStatus: "REVIEW_REQUIRED",
      riskReasons: ["PERSONAL_EMAIL_DOMAIN"],
    });
    expect((result.body as Record<string, unknown>).connector).toBeUndefined();
    expect(prismaMock.workspace.create).not.toHaveBeenCalled();
    expect(prismaMock.agentCredential.create).not.toHaveBeenCalled();
  });

  it("rejects same-key different-body idempotency misuse", async () => {
    prismaMock.procurementIdempotencyKey.findUnique.mockResolvedValueOnce({
      requestHash: "different-request",
      responseJson: { trialId: "trial-1" },
      workspaceId: "ws-1",
    });
    const { createProcurementTrial } = await import("./procurement-trials");

    await expect(createProcurementTrial({
      idempotencyKey: "idem-1",
      input: {
        companyName: "Acme",
        adminEmail: "admin@acme.test",
        acceptedTermsVersion: "2026-04",
      },
    })).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("replays an active idempotent response without storing the raw connector token in JSON", async () => {
    prismaMock.procurementIdempotencyKey.findUnique.mockResolvedValueOnce({
      requestHash: "hash:{\"acceptedTermsVersion\":\"2026-04\",\"adminEmail\":\"admin@acme.test\",\"adminName\":null,\"billingContactEmail\":null,\"companyName\":\"Acme\",\"emailDomain\":\"acme.test\",\"sourceAgent\":null}",
      responseJson: { trialId: "trial-1", status: "ACTIVE" },
      workspaceId: "ws-1",
    });
    prismaMock.procurementTrial.findUnique.mockResolvedValueOnce({
      id: "trial-1",
      workspaceId: "ws-1",
      agentCredentialId: "cred-1",
      status: "ACTIVE",
      riskStatus: "LOW",
      riskReasons: [],
      trialExpiresAt: new Date(Date.now() + 60_000),
      claimEmailStatus: null,
      modelMonthlyBudgetCents: 500,
      storageLimitMb: 100,
      memberLimit: 5,
      mcpDailyCallLimit: 100,
      connectorTokenEnc: "enc:agentc-credential-secret",
    });
    const { createProcurementTrial } = await import("./procurement-trials");

    const result = await createProcurementTrial({
      idempotencyKey: "idem-1",
      origin: "https://app.test",
      input: {
        companyName: "Acme",
        adminEmail: "admin@acme.test",
        acceptedTermsVersion: "2026-04",
      },
    });

    expect(result.statusCode).toBe(201);
    expect(result.body).toMatchObject({
      trialId: "trial-1",
      connector: { token: "agentc-credential-secret" },
    });
    expect(decryptSecretMock).toHaveBeenCalledWith("enc:agentc-credential-secret");
  });

  it("does not reveal a connector token when replaying an expired active trial", async () => {
    prismaMock.procurementIdempotencyKey.findUnique.mockResolvedValueOnce({
      requestHash: "hash:{\"acceptedTermsVersion\":\"2026-04\",\"adminEmail\":\"admin@acme.test\",\"adminName\":null,\"billingContactEmail\":null,\"companyName\":\"Acme\",\"emailDomain\":\"acme.test\",\"sourceAgent\":null}",
      responseJson: { trialId: "trial-1", status: "ACTIVE" },
      workspaceId: "ws-1",
    });
    prismaMock.procurementTrial.findUnique.mockResolvedValueOnce({
      id: "trial-1",
      workspaceId: "ws-1",
      agentCredentialId: "cred-1",
      status: "ACTIVE",
      riskStatus: "LOW",
      riskReasons: [],
      trialExpiresAt: new Date(Date.now() - 60_000),
      claimEmailStatus: null,
      modelMonthlyBudgetCents: 500,
      storageLimitMb: 100,
      memberLimit: 5,
      mcpDailyCallLimit: 100,
      connectorTokenEnc: "enc:agentc-credential-secret",
    });
    const { createProcurementTrial } = await import("./procurement-trials");

    const result = await createProcurementTrial({
      idempotencyKey: "idem-1",
      origin: "https://app.test",
      input: {
        companyName: "Acme",
        adminEmail: "admin@acme.test",
        acceptedTermsVersion: "2026-04",
      },
    });

    expect(result.statusCode).toBe(201);
    expect(result.body).toMatchObject({
      trialId: "trial-1",
      status: "EXPIRED",
    });
    expect((result.body as Record<string, unknown>).connector).toBeUndefined();
    expect(decryptSecretMock).not.toHaveBeenCalled();
    expect(prismaMock.procurementTrial.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "trial-1", status: "ACTIVE" },
      data: { status: "EXPIRED" },
    }));
    expect(prismaMock.workspace.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ws-1" },
      data: expect.objectContaining({ plan: "CORE_FREE" }),
    }));
    expect(prismaMock.agentCredential.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cred-1" },
      data: { isActive: false },
    }));
  });

  it("review-gates when the active trial uniqueness guard wins a concurrent create race", async () => {
    const uniqueError = Object.assign(
      new Error("Unique constraint failed on ProcurementTrial_active_emailDomain_key"),
      {
        code: "P2002",
        meta: { target: ["emailDomain"] },
      },
    );
    prismaMock.procurementTrial.create.mockImplementation(async ({ data }: any) => {
      if (data.status === "ACTIVE") {
        throw uniqueError;
      }
      return {
        id: "trial-review",
        claimEmailStatus: null,
        ...data,
      };
    });
    const { createProcurementTrial } = await import("./procurement-trials");

    const result = await createProcurementTrial({
      idempotencyKey: "idem-race",
      origin: "https://app.test",
      input: {
        companyName: "Acme",
        adminEmail: "admin@acme.test",
        acceptedTermsVersion: "2026-04",
      },
    });

    expect(result.statusCode).toBe(202);
    expect(result.body).toMatchObject({
      trialId: "trial-review",
      status: "REVIEW_REQUIRED",
      riskStatus: "REVIEW_REQUIRED",
      riskReasons: ["ACTIVE_TRIAL_FOR_DOMAIN"],
    });
    expect((result.body as Record<string, unknown>).connector).toBeUndefined();
    const idempotencyCreate = prismaMock.procurementIdempotencyKey.create.mock.calls.at(-1)?.[0];
    expect(idempotencyCreate.data.workspaceId).toBeUndefined();
    expect(idempotencyCreate.data.responseJson).not.toHaveProperty("connector");
  });

  it("approves a review-gated trial by provisioning an active workspace on the same trial id", async () => {
    prismaMock.procurementTrial.findUnique.mockResolvedValueOnce({
      id: "trial-review",
      status: "REVIEW_REQUIRED",
      workspaceId: null,
      companyName: "Acme",
      adminEmail: "person@gmail.com",
      adminName: "Person",
      emailDomain: "gmail.com",
      billingContactEmail: null,
      acceptedTermsVersion: "2026-04",
      sourceAgent: { kind: "app-signup" },
      riskStatus: "REVIEW_REQUIRED",
      riskReasons: ["PERSONAL_EMAIL_DOMAIN"],
    });
    prismaMock.procurementTrial.update.mockImplementation(async ({ data }: any) => ({
      id: "trial-review",
      claimEmailStatus: null,
      ...data,
    }));
    const { approveReviewGatedProcurementTrial } = await import("./procurement-trials");

    const result = await approveReviewGatedProcurementTrial(
      {
        kind: "user",
        user: {
          id: "operator-1",
          email: "operator@corgtex.test",
          displayName: "Operator",
          globalRole: "OPERATOR",
        },
      },
      {
        trialId: "trial-review",
        reason: "Verified customer request.",
        origin: "https://app.test",
      },
    );

    expect(result.statusCode).toBe(201);
    expect(result.body).toMatchObject({
      trialId: "trial-review",
      status: "ACTIVE",
      riskStatus: "REVIEW_REQUIRED",
      riskReasons: ["PERSONAL_EMAIL_DOMAIN"],
      workspace: { id: "ws-1" },
      connector: { token: "agentc-credential-secret" },
    });
    expect(prismaMock.procurementTrial.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "trial-review" },
      data: expect.objectContaining({
        workspaceId: "ws-1",
        agentCredentialId: "cred-1",
        status: "ACTIVE",
        trialExpiresAt: expect.any(Date),
      }),
    }));
    expect(prismaMock.procurementTrial.create).not.toHaveBeenCalled();
    expect(prismaMock.procurementIdempotencyKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        scope: "procurement:v1:trials",
        workspaceId: null,
      }),
      data: expect.objectContaining({
        workspaceId: "ws-1",
      }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "procurement_trial.approved",
        actorUserId: "operator-1",
        meta: expect.objectContaining({ reason: "Verified customer request." }),
      }),
    }));
  });

  it("does not approve a review-gated trial when an active email conflict exists", async () => {
    prismaMock.procurementTrial.findUnique.mockResolvedValueOnce({
      id: "trial-review",
      status: "REVIEW_REQUIRED",
      workspaceId: null,
      companyName: "Acme",
      adminEmail: "person@gmail.com",
      adminName: "Person",
      emailDomain: "gmail.com",
      billingContactEmail: null,
      acceptedTermsVersion: "2026-04",
      sourceAgent: null,
      riskStatus: "REVIEW_REQUIRED",
      riskReasons: ["PERSONAL_EMAIL_DOMAIN"],
    });
    prismaMock.procurementTrial.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const { approveReviewGatedProcurementTrial } = await import("./procurement-trials");

    await expect(approveReviewGatedProcurementTrial(
      {
        kind: "user",
        user: {
          id: "operator-1",
          email: "operator@corgtex.test",
          displayName: "Operator",
          globalRole: "OPERATOR",
        },
      },
      {
        trialId: "trial-review",
        reason: "Verified customer request.",
      },
    )).rejects.toMatchObject({
      status: 409,
      code: "ACTIVE_TRIAL_FOR_EMAIL",
    });

    expect(prismaMock.workspace.create).not.toHaveBeenCalled();
    expect(prismaMock.procurementTrial.update).not.toHaveBeenCalled();
  });

  it("rejects a review-gated trial by suspending it with a reason", async () => {
    const suspendedAt = new Date("2026-04-30T17:00:00.000Z");
    prismaMock.procurementTrial.findUnique.mockResolvedValueOnce({
      id: "trial-review",
      status: "REVIEW_REQUIRED",
      workspaceId: null,
      agentCredentialId: null,
    });
    prismaMock.procurementTrial.update.mockResolvedValueOnce({
      id: "trial-review",
      workspaceId: null,
      status: "SUSPENDED",
      suspendedAt,
      suspensionReason: "Rejected from review queue.",
    });
    const { rejectReviewGatedProcurementTrial } = await import("./procurement-trials");

    await expect(rejectReviewGatedProcurementTrial(
      {
        kind: "user",
        user: {
          id: "operator-1",
          email: "operator@corgtex.test",
          displayName: "Operator",
          globalRole: "OPERATOR",
        },
      },
      {
        trialId: "trial-review",
        reason: " Rejected from review queue. ",
      },
    )).resolves.toMatchObject({
      id: "trial-review",
      status: "SUSPENDED",
      suspensionReason: "Rejected from review queue.",
    });

    expect(prismaMock.procurementTrial.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "trial-review" },
      data: expect.objectContaining({
        status: "SUSPENDED",
        suspensionReason: "Rejected from review queue.",
      }),
    }));
  });

  it("blocks MCP access for expired trials and revokes the connector", async () => {
    prismaMock.procurementTrial.findUnique.mockResolvedValueOnce({
      id: "trial-1",
      workspaceId: "ws-1",
      agentCredentialId: "cred-1",
      status: "ACTIVE",
      trialExpiresAt: new Date(Date.now() - 60_000),
      memberLimit: 5,
      storageLimitMb: 100,
      mcpDailyCallLimit: 100,
    });
    const { requireTrialMcpAccess } = await import("./trial-entitlements");

    await expect(requireTrialMcpAccess("ws-1")).rejects.toMatchObject({
      status: 403,
      code: "TRIAL_EXPIRED",
    });
    expect(prismaMock.procurementTrial.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "trial-1" },
      data: { status: "EXPIRED" },
    }));
    expect(prismaMock.workspace.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ws-1" },
      data: expect.objectContaining({ plan: "CORE_FREE" }),
    }));
    expect(prismaMock.agentCredential.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cred-1" },
      data: { isActive: false },
    }));
  });

  it("suspends a trial, revokes connector access, zeros budget, and records an event", async () => {
    const suspendedAt = new Date("2026-04-30T17:00:00.000Z");
    prismaMock.procurementTrial.findUnique.mockResolvedValueOnce({
      id: "trial-1",
      workspaceId: "ws-1",
      agentCredentialId: "cred-1",
      status: "ACTIVE",
    });
    prismaMock.procurementTrial.update.mockResolvedValueOnce({
      id: "trial-1",
      workspaceId: "ws-1",
      status: "SUSPENDED",
      suspendedAt,
      suspensionReason: "abuse",
    });
    const { suspendProcurementTrial } = await import("./trial-entitlements");

    const result = await suspendProcurementTrial(
      {
        kind: "user",
        user: {
          id: "operator-1",
          email: "operator@corgtex.test",
          displayName: "Operator",
          globalRole: "OPERATOR",
        },
      },
      {
        trialId: "trial-1",
        reason: " abuse ",
      },
    );

    expect(result).toMatchObject({
      id: "trial-1",
      status: "SUSPENDED",
      suspensionReason: "abuse",
    });
    expect(prismaMock.agentCredential.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cred-1" },
      data: { isActive: false },
    }));
    expect(prismaMock.workspace.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ws-1" },
      data: expect.objectContaining({ plan: "CORE_FREE" }),
    }));
    expect(prismaMock.modelUsageBudget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      update: { monthlyCostCapUsd: 0 },
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "procurement_trial.suspended",
        meta: { reason: "abuse" },
      }),
    }));
    expect(prismaMock.event.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        workspaceId: "ws-1",
        type: "procurement_trial.suspended",
        aggregateType: "ProcurementTrial",
        aggregateId: "trial-1",
        payload: { trialId: "trial-1", reason: "abuse" },
      })],
    }));
  });
});
