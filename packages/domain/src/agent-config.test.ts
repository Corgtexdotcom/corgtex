import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      workspaceAgentConfig: { upsert: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    },
  };
});

describe("agent-config", () => {
  describe("updateAgentConfig", () => {
    it("updates agent config with governance policy", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateAgentConfig } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.upsert).mockResolvedValue({
        workspaceId: "ws-1",
        agentKey: "inbox-triage",
        enabled: true,
        modelOverride: null,
        governancePolicy: "always be polite",
        configJson: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const actor = { kind: "user", user: { id: "u-1" } } as any;

      vi.mock("./auth", () => ({
        requireWorkspaceMembership: vi.fn().mockResolvedValue(true),
      }));

      await updateAgentConfig(actor, {
        workspaceId: "ws-1",
        agentKey: "inbox-triage",
        governancePolicy: "always be polite",
      });

      expect(prisma.workspaceAgentConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId_agentKey: { workspaceId: "ws-1", agentKey: "inbox-triage" } },
          create: expect.objectContaining({ governancePolicy: "always be polite" }),
          update: expect.objectContaining({ governancePolicy: "always be polite" }),
        })
      );
    });
  });

  describe("getAgentGovernancePolicy", () => {
    it("returns the configured policy or null", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getAgentGovernancePolicy } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue({
        governancePolicy: "custom policy here",
      } as any);

      const policy = await getAgentGovernancePolicy("ws-1", "inbox-triage");
      expect(policy).toBe("custom policy here");
      expect(prisma.workspaceAgentConfig.findUnique).toHaveBeenCalledWith({
        where: { workspaceId_agentKey: { workspaceId: "ws-1", agentKey: "inbox-triage" } },
        select: { governancePolicy: true },
      });
    });
  });
});
