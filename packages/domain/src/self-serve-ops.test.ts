import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, sharedEnv } = vi.hoisted(() => ({
  sharedEnv: {
    APP_URL: "https://app.example",
    SMOKE_EMAIL_CAPTURE_SECRET: "capture-secret",
    SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS: "smoke.example",
    SMOKE_EMAIL_CAPTURE_TTL_MINUTES: 15,
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
      update: vi.fn(),
    },
    selfServeSmokeRun: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    procurementTrial: {
      findMany: vi.fn(),
    },
    customerDeployment: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
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
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    user: {
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
    prismaMock.selfServeEmailCapture.create.mockResolvedValue({ id: "capture-1" });
    prismaMock.selfServeEmailCapture.update.mockResolvedValue({});
    prismaMock.selfServeSmokeRun.upsert.mockResolvedValue({ id: "run-row-1" });
    prismaMock.customerDeploymentAccess.findUnique.mockResolvedValue(null);
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
    prismaMock.user.upsert.mockResolvedValue({ id: "support-user", email: "support+workspace@corgtex.local", displayName: "Corgtex Support" });
    prismaMock.member.upsert.mockResolvedValue({ id: "support-member", role: "FACILITATOR" });
    prismaMock.roleAssignment.findMany.mockResolvedValue([{ roleId: "role-1" }]);
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

    expect(prismaMock.member.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ role: "FACILITATOR", isActive: true }),
      create: expect.objectContaining({ role: "FACILITATOR", isActive: true }),
    }));
    expect(prismaMock.roleAssignment.createMany).toHaveBeenCalledWith({
      data: [{ memberId: "support-member", roleId: "role-1" }],
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

  it("consumes support sessions once and creates a normal app session", async () => {
    prismaMock.selfServeSupportSession.findUnique.mockResolvedValue({
      id: "support-session-1",
      workspaceId: "workspace-1",
      operationId: "operation-1",
      supportUserId: "support-user",
      targetMemberId: "member-target",
      expiresAt: new Date(Date.now() + 60_000),
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
    expect(sessionExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 1_000);
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
