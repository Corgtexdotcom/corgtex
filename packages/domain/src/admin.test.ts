import { describe, it, expect, vi, beforeEach } from "vitest";
import { 
  listAllWorkspaces, 
  adminTriggerPasswordReset, 
  getOperatorOverview,
  adminCreateMember,
  probeExternalInstanceHealth
} from "./admin";
import { prisma } from "@corgtex/shared";
import { requireGlobalOperator } from "./auth";

// Mock auth checks
vi.mock("./auth", () => ({
  requireGlobalOperator: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
}));

// Mock prisma
vi.mock("@corgtex/shared", () => ({
  prisma: {
    workspace: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    user: {
      count: vi.fn(),
    },
    member: {
      count: vi.fn(),
    },
    workflowJob: {
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    instanceRegistry: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    }
  }
}));

// Mock workspaces and members
vi.mock("./workspaces", () => ({
  createWorkspace: vi.fn().mockResolvedValue({ id: "ws_new" }),
}));
vi.mock("./members", () => ({
  createMember: vi.fn().mockResolvedValue({ id: "member_new" }),
}));

// Mock password reset
vi.mock("./password-reset", () => ({
  requestPasswordReset: vi.fn().mockResolvedValue({ token: "reset_token_123" }),
}));

const dummyActor = { userId: "operator_1" } as any;

describe("Platform Admin Tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listAllWorkspaces enforces operator check and returns data", async () => {
    (prisma.workspace.findMany as any).mockResolvedValue([
      { id: "ws_1", slug: "ws-1", name: "WS 1", createdAt: new Date(), _count: { members: 5 } }
    ]);

    const result = await listAllWorkspaces(dummyActor);
    
    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.workspace.findMany).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].memberCount).toBe(5);
  });

  it("getOperatorOverview aggregates system stats", async () => {
    (prisma.workspace.count as any).mockResolvedValue(10);
    (prisma.user.count as any).mockResolvedValue(50);
    (prisma.member.count as any).mockResolvedValue(45);
    (prisma.workflowJob.findFirst as any).mockResolvedValue({ createdAt: new Date() });
    (prisma.workflowJob.count as any).mockImplementation(({ where }: any) => {
      if (where.status === "PENDING") return 2;
      if (where.status === "FAILED") return 1;
      return 0;
    });

    const result = await getOperatorOverview(dummyActor);
    
    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(result.workspacesCount).toBe(10);
    expect(result.usersCount).toBe(50);
    expect(result.worker.failedJobs).toBe(1);
    expect(result.worker.isHealthy).toBe(true);
  });

  it("adminTriggerPasswordReset triggers reset logic", async () => {
    const token = await adminTriggerPasswordReset(dummyActor, "test@example.com");
    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(token).toBe("reset_token_123");
  });

  it("adminCreateMember bypasses normal admin check", async () => {
    const { createMember } = await import("./members");
    await adminCreateMember(dummyActor, {
      workspaceId: "ws_1",
      email: "new@example.com",
      displayName: "New User",
      role: "CONTRIBUTOR"
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(createMember).toHaveBeenCalledWith(dummyActor, expect.objectContaining({
      email: "new@example.com",
      skipAdminCheck: true
    }));
  });

  it("probeExternalInstanceHealth handles fetch errors gracefully", async () => {
    (prisma.instanceRegistry.findUniqueOrThrow as any).mockResolvedValue({
      id: "inst_1",
      url: "http://fake-instance.com"
    });

    global.fetch = vi.fn().mockRejectedValue(new Error("Network Error"));

    await probeExternalInstanceHealth(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "down",
        lastHealthError: "Network Error"
      })
    }));
  });
});
