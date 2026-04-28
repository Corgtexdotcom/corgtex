import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, randomOpaqueTokenMock, sendEmailMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    procurementIdempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    approvalPolicy: {
      createMany: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
    },
    member: {
      upsert: vi.fn(),
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
    procurementSetupSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    procurementBillingHandoff: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  return {
    prismaMock: prisma,
    randomOpaqueTokenMock: vi.fn(),
    sendEmailMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  hashPassword: vi.fn((value: string) => `hash:${value}`),
  randomOpaqueToken: randomOpaqueTokenMock,
  sendEmail: sendEmailMock,
  sha256: vi.fn((value: string) => `abcdef${value}`),
  env: {
    APP_URL: "https://app.test",
    MCP_PUBLIC_URL: "https://mcp.test/mcp",
    RESEND_API_KEY: undefined,
    PROCUREMENT_NOTIFY_EMAIL: undefined,
  },
}));

describe("procurement self-serve setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    randomOpaqueTokenMock
      .mockReturnValueOnce("session-token")
      .mockReturnValueOnce("admin-password")
      .mockReturnValueOnce("admin-member-token")
      .mockReturnValueOnce("employee-password")
      .mockReturnValueOnce("employee-member-token");
    prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return (arg as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock);
    });
    prismaMock.procurementIdempotencyKey.findUnique.mockResolvedValue(null);
    prismaMock.workspace.findUnique.mockResolvedValue(null);
    prismaMock.workspace.create.mockResolvedValue({ id: "ws-1", name: "Acme", slug: "acme" });
    prismaMock.approvalPolicy.createMany.mockResolvedValue({ count: 2 });
    prismaMock.user.upsert
      .mockResolvedValueOnce({ id: "user-admin", email: "admin@acme.test", displayName: "Admin" })
      .mockResolvedValueOnce({ id: "user-employee", email: "employee@acme.test", displayName: "Employee" });
    prismaMock.member.upsert
      .mockResolvedValueOnce({ id: "member-admin", role: "ADMIN" })
      .mockResolvedValueOnce({ id: "member-employee", role: "CONTRIBUTOR" });
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.passwordResetToken.create.mockResolvedValue({});
    prismaMock.procurementSetupSession.create.mockResolvedValue({
      id: "setup-1",
      expiresAt: new Date("2026-04-29T00:00:00.000Z"),
      invitedEmployeeCount: 1,
      maxEmployeeInvites: 50,
    });
    prismaMock.procurementSetupSession.update.mockResolvedValue({});
    prismaMock.procurementSetupSession.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.procurementBillingHandoff.create.mockResolvedValue({ id: "handoff-1" });
    prismaMock.procurementBillingHandoff.update.mockResolvedValue({});
    prismaMock.procurementIdempotencyKey.create.mockResolvedValue({});
    prismaMock.procurementIdempotencyKey.update.mockResolvedValue({});
  });

  it("creates workspace, admin, employees, setup session, and billing handoff without exposing member setup tokens", async () => {
    const { createSelfServeWorkspace } = await import("./procurement");

    const response = await createSelfServeWorkspace({
      idempotencyKey: "idem-1",
      origin: "https://app.test",
      input: {
        companyName: "Acme",
        adminEmail: "ADMIN@ACME.TEST",
        adminName: " Admin ",
        billingContactEmail: "billing@acme.test",
        acceptedTermsVersion: "2026-04",
        employees: [{ email: "employee@acme.test", displayName: "Employee" }],
      },
    });

    expect(prismaMock.workspace.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: "Acme",
        slug: "acme",
      }),
    }));
    expect(prismaMock.procurementSetupSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        adminEmail: "admin@acme.test",
        billingContactEmail: "billing@acme.test",
        acceptedTermsVersion: "2026-04",
        invitedEmployeeCount: 1,
      }),
    }));
    expect(prismaMock.procurementBillingHandoff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        billingContactEmail: "billing@acme.test",
      }),
    }));

    expect(response).toMatchObject({
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
      setupSession: { id: "setup-1", invitedEmployeeCount: 1 },
      setupSessionToken: "setup_session-token",
      mcpConnectorUrl: "https://mcp.test/mcp",
      billingHandoff: { id: "handoff-1", status: "PENDING_MANUAL_INVOICE" },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("admin-member-token");
    expect(serialized).not.toContain("employee-member-token");
  });

  it("rejects duplicate initial invite emails before writing", async () => {
    const { createSelfServeWorkspace } = await import("./procurement");

    await expect(createSelfServeWorkspace({
      idempotencyKey: "idem-1",
      input: {
        companyName: "Acme",
        adminEmail: "admin@acme.test",
        billingContactEmail: "billing@acme.test",
        acceptedTermsVersion: "2026-04",
        employees: [{ email: "ADMIN@ACME.TEST" }],
      },
    })).rejects.toMatchObject({
      status: 400,
      code: "DUPLICATE_INVITE",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("returns the original response for the same idempotency key", async () => {
    let storedRequestHash = "";
    let storedResponse: unknown;
    prismaMock.procurementIdempotencyKey.create.mockImplementationOnce(async ({ data }: any) => {
      storedRequestHash = data.requestHash;
      return {};
    });
    prismaMock.procurementIdempotencyKey.update.mockImplementationOnce(async ({ data }: any) => {
      storedResponse = data.responseJson;
      return {};
    });

    const { createSelfServeWorkspace } = await import("./procurement");
    const original = await createSelfServeWorkspace({
      idempotencyKey: "idem-1",
      input: {
        companyName: "Acme",
        adminEmail: "admin@acme.test",
        billingContactEmail: "billing@acme.test",
        acceptedTermsVersion: "2026-04",
      },
    });

    prismaMock.procurementIdempotencyKey.findUnique.mockResolvedValueOnce({
      requestHash: storedRequestHash,
      responseJson: storedResponse,
    });
    const response = await createSelfServeWorkspace({
      idempotencyKey: "idem-1",
      input: {
        companyName: "Acme",
        adminEmail: "admin@acme.test",
        billingContactEmail: "billing@acme.test",
        acceptedTermsVersion: "2026-04",
      },
    });

    expect(response).toEqual(original);
    expect(prismaMock.workspace.create).toHaveBeenCalledTimes(1);
  });

  it("rejects the same idempotency key with a different body", async () => {
    prismaMock.procurementIdempotencyKey.findUnique.mockResolvedValueOnce({
      requestHash: "different-request",
      responseJson: { workspace: { id: "ws-original" } },
    });

    const { createSelfServeWorkspace } = await import("./procurement");
    await expect(createSelfServeWorkspace({
      idempotencyKey: "idem-1",
      input: {
        companyName: "Acme",
        adminEmail: "admin@acme.test",
        billingContactEmail: "billing@acme.test",
        acceptedTermsVersion: "2026-04",
      },
    })).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("uses a deterministic suffix when the requested slug is taken", async () => {
    prismaMock.workspace.findUnique
      .mockResolvedValueOnce({ id: "existing-ws" })
      .mockResolvedValueOnce(null);

    const { createSelfServeWorkspace } = await import("./procurement");
    await createSelfServeWorkspace({
      idempotencyKey: "idem-1",
      input: {
        companyName: "Acme",
        slug: "acme",
        adminEmail: "admin@acme.test",
        billingContactEmail: "billing@acme.test",
        acceptedTermsVersion: "2026-04",
      },
    });

    expect(prismaMock.workspace.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        slug: "acme-abcdef",
      }),
    }));
  });

  it("expires setup session tokens and rejects tokens for another session", async () => {
    const { getSelfServeSetupSessionStatus } = await import("./procurement");
    prismaMock.procurementSetupSession.findUnique.mockResolvedValueOnce({
      id: "other-session",
      workspaceId: "ws-1",
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 60_000),
      invitedEmployeeCount: 0,
      maxEmployeeInvites: 50,
      emailStatus: null,
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    await expect(getSelfServeSetupSessionStatus({
      sessionId: "setup-1",
      token: "setup_session-token",
    })).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });

    prismaMock.procurementSetupSession.findUnique.mockResolvedValueOnce({
      id: "setup-1",
      workspaceId: "ws-1",
      status: "ACTIVE",
      expiresAt: new Date(Date.now() - 60_000),
      invitedEmployeeCount: 0,
      maxEmployeeInvites: 50,
      emailStatus: null,
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    await expect(getSelfServeSetupSessionStatus({
      sessionId: "setup-1",
      token: "setup_session-token",
    })).rejects.toMatchObject({
      status: 401,
      code: "SETUP_SESSION_EXPIRED",
    });
    expect(prismaMock.procurementSetupSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "setup-1",
        status: "ACTIVE",
      },
      data: {
        status: "EXPIRED",
      },
    }));
  });
});
