import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, sharedEnv } = vi.hoisted(() => ({
  sharedEnv: {
    APP_URL: "https://app.example",
    SMOKE_EMAIL_CAPTURE_SECRET: "capture-secret",
    SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS: "smoke.example",
    SMOKE_EMAIL_CAPTURE_TTL_MINUTES: 15,
    SELF_SERVE_REGISTRY_SYNC_SECRET: "sync-secret",
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
  prismaMock: {
    $transaction: vi.fn(async (operations: unknown[] | ((tx: unknown) => unknown)) => (
      typeof operations === "function" ? operations(prismaMock) : Promise.all(operations)
    )),
    customerDeploymentAccess: {
      findUnique: vi.fn(),
    },
    selfServeEmailCapture: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    selfServeSmokeRun: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    procurementTrial: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    customerDeployment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    customerDeploymentEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    selfServeSupportSession: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    member: {
      create: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    user: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    roleAssignment: {
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
    supportOperation: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    session: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@corgtex/shared", () => ({
  env: sharedEnv,
  prisma: prismaMock,
  encryptSecret: vi.fn((value: string) => `enc:${value}`),
  decryptSecret: vi.fn((value: string) => value.replace(/^enc:/, "")),
  hashPassword: vi.fn((value: string) => `hash:${value}`),
  randomOpaqueToken: vi.fn(() => "support-token"),
  sha256: vi.fn((value: string) => `sha:${value}`),
  toInputJson: (value: unknown) => value,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
}));

const operatorActor: AppActor = {
  kind: "user",
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

describe("self-serve ops domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedEnv.SMOKE_EMAIL_CAPTURE_SECRET = "capture-secret";
    sharedEnv.SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS = "smoke.example";
    sharedEnv.SMOKE_EMAIL_CAPTURE_TTL_MINUTES = 15;
    sharedEnv.SELF_SERVE_REGISTRY_SYNC_SECRET = "sync-secret";
    prismaMock.selfServeEmailCapture.create.mockResolvedValue({ id: "capture-1" });
    prismaMock.selfServeEmailCapture.update.mockResolvedValue({});
    prismaMock.selfServeSmokeRun.upsert.mockResolvedValue({ id: "run-row-1" });
    prismaMock.selfServeSmokeRun.findMany.mockResolvedValue([]);
    prismaMock.customerDeploymentAccess.findUnique.mockResolvedValue(null);
    prismaMock.customerDeployment.findFirst.mockResolvedValue(null);
    prismaMock.customerDeployment.findMany.mockResolvedValue([]);
    prismaMock.customerDeployment.findUnique.mockResolvedValue(null);
    prismaMock.customerDeploymentEvent.create.mockResolvedValue({ id: "registry-event-1", createdAt: new Date("2026-06-09T12:00:00.000Z") });
    prismaMock.customerDeploymentEvent.findMany.mockResolvedValue([]);
    prismaMock.procurementTrial.findFirst.mockResolvedValue(null);
    prismaMock.procurementTrial.findMany.mockResolvedValue([]);
    prismaMock.selfServeEmailCapture.findMany.mockResolvedValue([]);
    prismaMock.selfServeSupportSession.findMany.mockResolvedValue([]);
    prismaMock.selfServeSupportSession.update.mockResolvedValue({});
    prismaMock.selfServeSupportSession.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.session.create.mockResolvedValue({});
  });

  it("captures setup links only for allowlisted smoke domains", async () => {
    const { maybeCaptureSelfServeSetupEmail } = await import("./self-serve-ops");

    await expect(maybeCaptureSelfServeSetupEmail({
      email: "real@example.com",
      subject: "Invite",
      setupUrl: "https://app.example/setup-account/raw-token",
      providerStatus: { status: "SENT" },
    })).resolves.toBeNull();

    await expect(maybeCaptureSelfServeSetupEmail({
      email: "AGENT@SMOKE.EXAMPLE",
      subject: "Invite",
      setupUrl: "https://app.example/setup-account/raw-token",
      providerStatus: { status: "SENT" },
      workspaceId: "workspace-1",
      procurementTrialId: "trial-1",
      runId: "run-1",
    })).resolves.toEqual({ id: "capture-1" });

    expect(prismaMock.selfServeEmailCapture.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.selfServeEmailCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        procurementTrialId: "trial-1",
        toEmail: "agent@smoke.example",
        emailDomain: "smoke.example",
        setupUrlEnc: "enc:https://app.example/setup-account/raw-token",
        runId: "run-1",
      }),
    });
  });

  it("returns and consumes the latest captured setup link with the internal secret", async () => {
    prismaMock.selfServeEmailCapture.findFirst.mockResolvedValue({
      id: "capture-1",
      toEmail: "agent@smoke.example",
      runId: "run-1",
      source: "member_setup",
      setupUrlEnc: "enc:https://app.example/setup-account/raw-token",
      providerStatus: { status: "SKIPPED" },
      expiresAt: new Date("2026-06-04T12:00:00.000Z"),
      createdAt: new Date("2026-06-04T11:59:00.000Z"),
      consumedAt: null,
    });
    const { getLatestSelfServeEmailCapture } = await import("./self-serve-ops");

    await expect(getLatestSelfServeEmailCapture({
      secret: "bad-secret",
      toEmail: "agent@smoke.example",
    })).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });

    await expect(getLatestSelfServeEmailCapture({
      secret: "capture-secret",
      toEmail: "agent@smoke.example",
      runId: "run-1",
      consume: true,
    })).resolves.toMatchObject({
      id: "capture-1",
      setupUrl: "https://app.example/setup-account/raw-token",
    });
    expect(prismaMock.selfServeEmailCapture.update).toHaveBeenCalledWith({
      where: { id: "capture-1" },
      data: { consumedAt: expect.any(Date) },
    });
    expect(prismaMock.selfServeEmailCapture.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        consumedAt: null,
      }),
    }));
  });

  it("persists smoke run evidence through the smoke secret", async () => {
    const { upsertSelfServeSmokeRun } = await import("./self-serve-ops");

    await upsertSelfServeSmokeRun({
      secret: "capture-secret",
      runId: "run-1",
      runKind: "browser",
      status: "PASSED",
      workspaceId: "workspace-1",
      summary: { steps: [{ name: "signup", status: "PASSED" }] },
      artifacts: [{ type: "screenshot", path: ".artifacts/run/signup.png" }],
      completedAt: "2026-06-04T12:00:00.000Z",
    });

    expect(prismaMock.selfServeSmokeRun.upsert).toHaveBeenCalledWith({
      where: { runId: "run-1" },
      create: expect.objectContaining({
        runId: "run-1",
        status: "PASSED",
        workspaceId: "workspace-1",
      }),
      update: expect.objectContaining({
        status: "PASSED",
        workspaceId: "workspace-1",
      }),
    });
  });

  it("rejects blank smoke run ids before writing evidence", async () => {
    const { upsertSelfServeSmokeRun } = await import("./self-serve-ops");

    await expect(upsertSelfServeSmokeRun({
      secret: "capture-secret",
      runId: " ",
      runKind: "browser",
      status: "PASSED",
    })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });

    expect(prismaMock.selfServeSmokeRun.upsert).not.toHaveBeenCalled();
  });

  it("links review-gated duplicate requests to their existing active workspace", async () => {
    const createdAt = new Date("2026-06-08T14:16:17.918Z");
    const activeCreatedAt = new Date("2026-05-25T17:47:59.348Z");
    const trialExpiresAt = new Date("2026-06-24T17:47:59.196Z");
    const workspace = {
      id: "workspace-1",
      name: "How To DAO",
      slug: "how-to-dao",
      plan: "TRIAL",
      trialEndsAt: trialExpiresAt,
      billingProfile: {
        billingStatus: "trialing",
        paymentMethodReady: false,
        stripeCustomerId: null,
        updatedAt: activeCreatedAt,
      },
      _count: {
        members: 1,
        roleOnboardingSessions: 0,
        onboardingStates: 0,
      },
    };
    prismaMock.procurementTrial.findMany
      .mockResolvedValueOnce([
        {
          id: "review-trial",
          status: "REVIEW_REQUIRED",
          riskStatus: "REVIEW_REQUIRED",
          riskReasons: ["ACTIVE_TRIAL_FOR_EMAIL", "ACTIVE_TRIAL_FOR_DOMAIN"],
          companyName: "How To DAO",
          adminEmail: "info@howtodao.xyz",
          adminName: "Jan Puncar Brezina",
          emailDomain: "howtodao.xyz",
          trialExpiresAt: null,
          createdAt,
          updatedAt: createdAt,
          suspendedAt: null,
          suspensionReason: null,
          claimEmailStatus: null,
          workspaceId: null,
          workspace: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "active-trial",
          status: "ACTIVE",
          riskStatus: "CLEAR",
          riskReasons: [],
          companyName: "How To DAO",
          adminEmail: "info@howtodao.xyz",
          adminName: "Jan Puncar Brezina",
          emailDomain: "howtodao.xyz",
          trialExpiresAt,
          createdAt: activeCreatedAt,
          updatedAt: activeCreatedAt,
          suspendedAt: null,
          suspensionReason: null,
          claimEmailStatus: { sent: true },
          workspaceId: "workspace-1",
          workspace,
        },
      ]);
    prismaMock.customerDeployment.findMany.mockResolvedValue([
      {
        id: "deployment-1",
        managedWorkspaceId: "workspace-1",
        label: "How To DAO",
        deploymentStatus: "DEGRADED",
        supportConnectorStatus: "CONFIGURED",
      },
    ]);
    const { listSelfServeCustomerRegistry } = await import("./self-serve-ops");

    const registry = await listSelfServeCustomerRegistry(operatorActor, {
      status: "REVIEW_REQUIRED",
      take: 50,
    });

    expect(registry.items).toHaveLength(1);
    expect(registry.items[0]).toMatchObject({
      trialId: "review-trial",
      status: "REVIEW_REQUIRED",
      existingActiveTrial: {
        trialId: "active-trial",
        companyName: "How To DAO",
        workspace: { id: "workspace-1", name: "How To DAO" },
        deployment: { id: "deployment-1", deploymentStatus: "DEGRADED" },
      },
    });
    expect(prismaMock.procurementTrial.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        status: "ACTIVE",
        workspaceId: { not: null },
      }),
    }));
  });

  it("signs registry sync payloads with timestamp-bound HMAC signatures", async () => {
    const {
      signSelfServeRegistrySyncPayload,
      verifySelfServeRegistrySyncSignature,
    } = await import("./self-serve-ops");
    const timestamp = "2026-06-09T12:00:00.000Z";
    const body = JSON.stringify({ sourceId: "azure-selfserve", items: [] });
    const signature = signSelfServeRegistrySyncPayload({
      secret: "sync-secret",
      timestamp,
      body,
    });

    expect(() => verifySelfServeRegistrySyncSignature({
      secret: "sync-secret",
      timestamp,
      body,
      signature: `sha256=${signature}`,
      now: new Date("2026-06-09T12:01:00.000Z"),
    })).not.toThrow();
    expect(() => verifySelfServeRegistrySyncSignature({
      secret: "sync-secret",
      timestamp,
      body,
      signature: "sha256=bad",
      now: new Date("2026-06-09T12:01:00.000Z"),
    })).toThrow(/signature is invalid/i);
    expect(() => verifySelfServeRegistrySyncSignature({
      secret: "sync-secret",
      timestamp,
      body,
      signature: `sha256=${signature}`,
      now: new Date("2026-06-09T12:10:01.000Z"),
    })).toThrow(/stale/i);
  });

  it("builds sanitized registry sync payloads without private admin or billing identifiers", async () => {
    const createdAt = new Date("2026-06-08T14:16:17.918Z");
    const trialExpiresAt = new Date("2026-06-24T17:47:59.196Z");
    prismaMock.procurementTrial.findMany.mockResolvedValueOnce([
      {
        id: "trial-1",
        status: "ACTIVE",
        riskStatus: "CLEAR",
        riskReasons: [],
        companyName: "Acme",
        adminEmail: "admin@acme.example",
        adminName: "Private Admin",
        emailDomain: "acme.example",
        trialExpiresAt,
        createdAt,
        updatedAt: createdAt,
        suspendedAt: null,
        suspensionReason: null,
        claimEmailStatus: { sentTo: "admin@acme.example" },
        workspaceId: "workspace-1",
        workspace: {
          id: "workspace-1",
          name: "Acme",
          slug: "acme",
          plan: "TRIAL",
          trialEndsAt: trialExpiresAt,
          billingProfile: {
            billingStatus: "trialing",
            paymentMethodReady: false,
            stripeCustomerId: "cus_private",
            updatedAt: createdAt,
          },
          _count: {
            members: 1,
            roleOnboardingSessions: 2,
            onboardingStates: 3,
          },
        },
      },
    ]);
    prismaMock.customerDeployment.findMany.mockResolvedValue([
      {
        id: "deployment-1",
        managedWorkspaceId: "workspace-1",
        label: "Acme",
        deploymentStatus: "ACTIVE",
        supportConnectorStatus: "CONFIGURED",
      },
    ]);
    prismaMock.selfServeSmokeRun.findMany.mockResolvedValue([
      {
        runId: "run-1",
        procurementTrialId: "trial-1",
        workspaceId: "workspace-1",
        runKind: "browser",
        status: "PASSED",
        baseUrl: "https://selfserve.example",
        siteUrl: "https://www.example",
        error: null,
        summary: {
          email: "admin@acme.example",
          steps: [{ name: "signup", status: "PASSED", private: "hidden" }],
          warnings: [{ name: "billing skipped", response: { stripeCustomerId: "cus_private" } }],
        },
        startedAt: createdAt,
        completedAt: createdAt,
        createdAt,
      },
    ]);
    prismaMock.selfServeEmailCapture.findMany.mockResolvedValue([
      {
        id: "capture-1",
        procurementTrialId: "trial-1",
        toEmail: "admin@acme.example",
        runId: "run-1",
        source: "member_setup",
        expiresAt: trialExpiresAt,
        consumedAt: null,
        createdAt,
      },
    ]);
    prismaMock.selfServeSupportSession.findMany.mockResolvedValue([
      {
        id: "support-session-1",
        workspaceId: "workspace-1",
        operationId: "operation-1",
        targetMemberId: "member-private",
        expiresAt: trialExpiresAt,
        usedAt: null,
        createdAt,
      },
    ]);
    const { buildSelfServeRegistrySyncPayload } = await import("./self-serve-ops");

    const payload = await buildSelfServeRegistrySyncPayload(operatorActor, {
      sourceId: "azure-selfserve",
      sourceUrl: "https://selfserve.example",
      sourceDeploymentId: "deployment-azure",
    });

    expect(payload).toMatchObject({
      schemaVersion: "self-serve-registry-sync-v1",
      sourceId: "azure-selfserve",
      sourceUrl: "https://selfserve.example",
      sourceDeploymentId: "deployment-azure",
      summary: { total: 1, activeTrials: 1 },
      items: [
        {
          trialId: "trial-1",
          companyName: "Acme",
          workspace: { id: "workspace-1", counts: { members: 1 } },
          billing: { billingStatus: "trialing", paymentMethodReady: false },
          latestEmailCapture: { id: "capture-1", runId: "run-1" },
          latestSupportSession: { id: "support-session-1", operationId: "operation-1" },
        },
      ],
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("admin@acme.example");
    expect(serialized).not.toContain("Private Admin");
    expect(serialized).not.toContain("cus_private");
    expect(serialized).not.toContain("member-private");
  });

  it("records registry sync payloads as control-plane deployment events", async () => {
    prismaMock.customerDeployment.findUnique.mockResolvedValue({ id: "deployment-azure" });
    const { recordSelfServeRegistrySync } = await import("./self-serve-ops");

    await expect(recordSelfServeRegistrySync({
      schemaVersion: "self-serve-registry-sync-v1",
      sourceId: "azure-selfserve",
      sourceUrl: "https://selfserve.example",
      sourceDeploymentId: "deployment-azure",
      generatedAt: "2026-06-09T12:00:00.000Z",
      summary: { total: 1 },
      items: [{ trialId: "trial-1", status: "ACTIVE" }],
    })).resolves.toMatchObject({
      eventId: "registry-event-1",
      sourceId: "azure-selfserve",
      sourceDeploymentId: "deployment-azure",
      itemCount: 1,
    });

    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deploymentId: "deployment-azure",
        action: "self_serve.registry_synced",
        meta: expect.objectContaining({
          sourceId: "azure-selfserve",
          sourceDeploymentId: "deployment-azure",
          items: [{ trialId: "trial-1", status: "ACTIVE" }],
          receivedAt: expect.any(String),
        }),
      }),
      select: { id: true, createdAt: true },
    });
  });

  it("lists latest synced registry items when the Ops runtime has no local trial rows", async () => {
    const createdAt = new Date("2026-06-11T03:24:37.407Z");
    prismaMock.customerDeploymentEvent.findMany.mockResolvedValue([
      {
        id: "sync-event-1",
        deploymentId: "deployment-azure",
        createdAt,
        meta: {
          schemaVersion: "self-serve-registry-sync-v1",
          sourceId: "azure-selfserve-production",
          sourceUrl: "https://selfserve.corgtex.com",
          sourceDeploymentId: "deployment-azure",
          generatedAt: "2026-06-11T03:24:37.000Z",
          receivedAt: "2026-06-11T03:24:37.405Z",
          summary: { total: 1, activeTrials: 1 },
          items: [
            {
              trialId: "trial-1",
              status: "ACTIVE",
              riskStatus: "CLEAR",
              riskReasons: [],
              companyName: "Corgtex Smoke",
              emailDomain: "selfserve.corgtex.com",
              trialExpiresAt: "2026-06-25T03:24:37.000Z",
              createdAt: "2026-06-11T03:20:00.000Z",
              updatedAt: "2026-06-11T03:21:00.000Z",
              claimEmailCaptured: true,
              workspace: {
                id: "workspace-1",
                name: "Corgtex Smoke",
                slug: "corgtex-smoke",
                plan: "TRIAL",
                trialEndsAt: "2026-06-25T03:24:37.000Z",
                counts: {
                  members: 1,
                  roleOnboardingSessions: 2,
                  onboardingStates: 3,
                },
              },
              billing: {
                billingStatus: "trialing",
                paymentMethodReady: false,
                updatedAt: "2026-06-11T03:21:00.000Z",
              },
              deployment: {
                id: "deployment-azure",
                label: "Corgtex Azure Self-Serve Production",
                deploymentStatus: "ACTIVE",
                supportConnectorStatus: "not_configured",
              },
              latestSmoke: {
                runId: "launch-run-1",
                runKind: "browser",
                status: "PASSED",
                baseUrl: "https://selfserve.corgtex.com",
                siteUrl: "https://www.corgtex.com",
                error: null,
                summary: { steps: [{ name: "signup", status: "PASSED" }] },
                startedAt: "2026-06-11T03:20:00.000Z",
                completedAt: "2026-06-11T03:22:00.000Z",
                createdAt: "2026-06-11T03:22:00.000Z",
              },
              latestEmailCapture: {
                id: "capture-1",
                runId: "launch-run-1",
                source: "member_setup",
                expiresAt: "2026-06-11T04:20:00.000Z",
                consumedAt: null,
                createdAt: "2026-06-11T03:20:30.000Z",
              },
            },
          ],
        },
      },
    ]);
    const { listSelfServeCustomerRegistry } = await import("./self-serve-ops");

    const registry = await listSelfServeCustomerRegistry(operatorActor, { take: 50 });

    expect(registry.summary).toMatchObject({
      total: 1,
      activeTrials: 1,
      smokeCovered: 1,
    });
    expect(registry.items).toHaveLength(1);
    expect(registry.items[0]).toMatchObject({
      trialId: "trial-1",
      status: "ACTIVE",
      companyName: "Corgtex Smoke",
      adminEmail: "redacted@selfserve.corgtex.com",
      claimEmailStatus: { sent: true },
      workspace: {
        id: "workspace-1",
        _count: {
          members: 1,
          roleOnboardingSessions: 2,
          onboardingStates: 3,
        },
      },
      deployment: {
        id: "deployment-azure",
        deploymentStatus: "ACTIVE",
      },
      latestSmoke: {
        runId: "launch-run-1",
        status: "PASSED",
      },
      latestEmailCapture: {
        id: "capture-1",
        runId: "launch-run-1",
      },
      source: {
        kind: "registry_sync",
        eventId: "sync-event-1",
        sourceId: "azure-selfserve-production",
      },
    });
  });

  it("creates an audited support session and clones the target member role shape", async () => {
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "deployment-1",
      managedWorkspaceId: "workspace-1",
      label: "Customer",
    });
    prismaMock.workspace.findUnique.mockResolvedValue({ id: "workspace-1", name: "Customer", slug: "customer" });
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-target",
      workspaceId: "workspace-1",
      role: "FACILITATOR",
      user: { email: "target@example.com", displayName: "Target" },
    });
    prismaMock.user.create.mockResolvedValue({ id: "support-user", email: "support+workspace@corgtex.local", displayName: "Corgtex Support" });
    prismaMock.member.create.mockResolvedValue({ id: "support-member", role: "FACILITATOR" });
    const expiresAt = new Date("2099-01-31T23:59:59.999Z");
    prismaMock.roleAssignment.findMany.mockResolvedValue([{
      roleId: "role-1",
      expiresAt,
      transferReason: "Temporary support coverage",
    }]);
    prismaMock.roleAssignment.createMany.mockResolvedValue({ count: 1 });
    prismaMock.supportOperation.create.mockResolvedValue({ id: "operation-1" });
    prismaMock.selfServeSupportSession.create.mockResolvedValue({ id: "support-session-1" });
    const { createSelfServeSupportSession } = await import("./self-serve-ops");

    await expect(createSelfServeSupportSession(operatorActor, {
      deploymentId: "deployment-1",
      targetMemberId: "member-target",
      reason: "Reproduce reported role onboarding bug.",
    })).resolves.toMatchObject({
      id: "support-session-1",
      operationId: "operation-1",
      workspaceId: "workspace-1",
      targetMemberId: "member-target",
      url: "https://app.example/support/sessions/support-token",
    });

    expect(prismaMock.member.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "FACILITATOR", isActive: true }),
    }));
    expect(prismaMock.roleAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        memberId: "member-target",
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: expect.any(Date) } },
        ],
      }),
      select: { roleId: true, expiresAt: true, transferReason: true },
    }));
    expect(prismaMock.roleAssignment.createMany).toHaveBeenCalledWith({
      data: [{
        memberId: "support-member",
        roleId: "role-1",
        expiresAt,
        transferReason: "Temporary support coverage",
      }],
      skipDuplicates: true,
    });
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "support.session.open",
        actorLabel: "operator@example.com",
        status: "COMPLETED",
      }),
    }));
  });

  it("rejects read-only deployment access before opening support sessions", async () => {
    const viewerActor: AppActor = {
      kind: "user",
      user: {
        id: "viewer-user",
        email: "viewer@example.com",
        displayName: "Viewer",
        globalRole: "USER",
      },
    };
    prismaMock.customerDeploymentAccess.findUnique.mockResolvedValue({
      role: "SUPPORT_VIEWER",
      isActive: true,
    });
    const { createSelfServeSupportSession } = await import("./self-serve-ops");

    await expect(createSelfServeSupportSession(viewerActor, {
      deploymentId: "deployment-1",
      reason: "Reproduce reported role onboarding bug.",
    })).rejects.toMatchObject({ status: 403, code: "CONTROL_PLANE_WRITE_ACCESS_REQUIRED" });

    expect(prismaMock.customerDeployment.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("rejects support sessions when a supplied workspace does not match the deployment", async () => {
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "deployment-1",
      managedWorkspaceId: "workspace-1",
      label: "Customer",
    });
    const { createSelfServeSupportSession } = await import("./self-serve-ops");

    await expect(createSelfServeSupportSession(operatorActor, {
      deploymentId: "deployment-1",
      workspaceId: "workspace-2",
      reason: "Reproduce reported role onboarding bug.",
    })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });

    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.selfServeSupportSession.create).not.toHaveBeenCalled();
  });

  it("rejects support sessions when a supplied deployment does not exist", async () => {
    prismaMock.customerDeployment.findUnique.mockResolvedValue(null);
    const { createSelfServeSupportSession } = await import("./self-serve-ops");

    await expect(createSelfServeSupportSession(operatorActor, {
      deploymentId: "missing-deployment",
      workspaceId: "workspace-1",
      reason: "Reproduce reported role onboarding bug.",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.selfServeSupportSession.create).not.toHaveBeenCalled();
  });

  it("rejects workspace-only support sessions without a self-serve boundary", async () => {
    const { createSelfServeSupportSession } = await import("./self-serve-ops");

    await expect(createSelfServeSupportSession(operatorActor, {
      workspaceId: "workspace-1",
      reason: "Reproduce reported role onboarding bug.",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    expect(prismaMock.customerDeployment.findFirst).toHaveBeenCalledWith({
      where: { managedWorkspaceId: "workspace-1" },
      select: { id: true, managedWorkspaceId: true, label: true },
    });
    expect(prismaMock.procurementTrial.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      select: { id: true },
    });
    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("rejects support sessions when a requested target member does not exist", async () => {
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "deployment-1",
      managedWorkspaceId: "workspace-1",
      label: "Customer",
    });
    prismaMock.workspace.findUnique.mockResolvedValue({ id: "workspace-1", name: "Customer", slug: "customer" });
    prismaMock.member.findUnique.mockResolvedValue(null);
    const { createSelfServeSupportSession } = await import("./self-serve-ops");

    await expect(createSelfServeSupportSession(operatorActor, {
      deploymentId: "deployment-1",
      targetMemberId: "missing-member",
      reason: "Reproduce reported role onboarding bug.",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(prismaMock.selfServeSupportSession.create).not.toHaveBeenCalled();
  });

  it("consumes support sessions once and creates a short support login session", async () => {
    const supportExpiresAt = new Date(Date.now() + 60_000);
    prismaMock.selfServeSupportSession.findUnique.mockResolvedValue({
      id: "support-session-1",
      workspaceId: "workspace-1",
      operationId: "operation-1",
      supportUserId: "support-user",
      targetMemberId: "member-target",
      expiresAt: supportExpiresAt,
      usedAt: null,
    });
    const { consumeSelfServeSupportSession } = await import("./self-serve-ops");

    await expect(consumeSelfServeSupportSession({
      token: "support-token",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    })).resolves.toMatchObject({
      workspaceId: "workspace-1",
      session: { token: "support-token", expiresAt: expect.any(Date) },
    });

    expect(prismaMock.session.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: "support-user",
        tokenHash: "sha:support-token",
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        expiresAt: expect.any(Date),
      }),
    }));
    const sessionExpiresAt = prismaMock.session.create.mock.calls[0]?.[0]?.data?.expiresAt as Date;
    expect(sessionExpiresAt).toEqual(supportExpiresAt);
    expect(prismaMock.selfServeSupportSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: "support-session-1",
        usedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { usedAt: expect.any(Date) },
    });
  });

  it("rejects a support session that loses the one-time claim race", async () => {
    prismaMock.selfServeSupportSession.findUnique.mockResolvedValue({
      id: "support-session-1",
      workspaceId: "workspace-1",
      operationId: "operation-1",
      supportUserId: "support-user",
      targetMemberId: "member-target",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    prismaMock.selfServeSupportSession.updateMany.mockResolvedValue({ count: 0 });
    const { consumeSelfServeSupportSession } = await import("./self-serve-ops");

    await expect(consumeSelfServeSupportSession({
      token: "support-token",
    })).rejects.toMatchObject({ status: 410, code: "SUPPORT_SESSION_USED" });

    expect(prismaMock.session.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});
