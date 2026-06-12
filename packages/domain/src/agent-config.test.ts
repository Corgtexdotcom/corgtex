import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    workspaceAgentConfig: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value ?? null)),
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue(true),
}));

describe("agent-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

    it("normalizes Slack proactive timing config", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateAgentConfig } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.upsert).mockResolvedValue({} as any);

      await updateAgentConfig(
        { kind: "user", user: { id: "u-1" } } as any,
        {
          workspaceId: "ws-1",
          agentKey: "slack-agent",
          configJson: {
            unansweredFollowupDelayMinutes: 7,
            unansweredActionCreationDelayMinutes: 8,
            staleActionFollowupDelayMinutes: 9,
            proactiveConfidenceThreshold: 2,
          },
        },
      );

      const call = vi.mocked(prisma.workspaceAgentConfig.upsert).mock.calls[0][0] as any;
      expect(call.create.configJson).toMatchObject({
        unansweredFollowupDelayMinutes: 15,
        unansweredActionCreationDelayMinutes: 15,
        staleActionFollowupDelayMinutes: 15,
        proactiveConfidenceThreshold: 1,
      });
      expect(call.update.configJson).toMatchObject({
        unansweredFollowupDelayMinutes: 15,
        unansweredActionCreationDelayMinutes: 15,
        staleActionFollowupDelayMinutes: 15,
        proactiveConfidenceThreshold: 1,
      });
    });
  });

  describe("listAgentConfigs", () => {
    it("defaults Slack proactive timing to 24 hour ask, 24 hour action, and 72 hour follow-up", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { listAgentConfigs } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findMany).mockResolvedValue([]);

      const configs = await listAgentConfigs(
        { kind: "user", user: { id: "u-1" } } as any,
        "ws-1",
      );
      const slackConfig = configs.find((config) => config.agentKey === "slack-agent");

      expect(slackConfig?.configJson).toMatchObject({
        unansweredFollowupDelayMinutes: 1440,
        unansweredActionCreationDelayMinutes: 1440,
        staleActionFollowupDelayMinutes: 4320,
      });
    });

    it("fills omitted Slack timing fields for existing custom config", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { listAgentConfigs } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findMany).mockResolvedValue([{
        workspaceId: "ws-1",
        agentKey: "slack-agent",
        enabled: true,
        modelOverride: null,
        governancePolicy: null,
        configJson: {
          mutedChannelIds: ["C-muted"],
          unansweredFollowupDelayMinutes: 60,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any]);

      const configs = await listAgentConfigs(
        { kind: "user", user: { id: "u-1" } } as any,
        "ws-1",
      );
      const slackConfig = configs.find((config) => config.agentKey === "slack-agent");

      expect(slackConfig?.configJson).toMatchObject({
        mutedChannelIds: ["C-muted"],
        unansweredFollowupDelayMinutes: 60,
        unansweredActionCreationDelayMinutes: 1440,
        staleActionFollowupDelayMinutes: 4320,
      });
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

  describe("newspaper cadence", () => {
    it("defaults workspace newspaper cadence to daily when unset", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getWorkspaceNewspaperCadence } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue(null);

      await expect(getWorkspaceNewspaperCadence("ws-1")).resolves.toBe("DAILY");
    });

    it("reads configured workspace newspaper cadence", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getWorkspaceNewspaperCadence } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue({
        configJson: { newspaperCadence: "WEEKLY" },
      } as any);

      await expect(getWorkspaceNewspaperCadence("ws-1")).resolves.toBe("WEEKLY");
    });

    it("reads off as a configured workspace newspaper cadence", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getWorkspaceNewspaperCadence } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue({
        configJson: { newspaperCadence: "OFF" },
      } as any);

      await expect(getWorkspaceNewspaperCadence("ws-1")).resolves.toBe("OFF");
    });

    it("falls back to daily for invalid configured workspace newspaper cadence", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getWorkspaceNewspaperCadence } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue({
        configJson: { newspaperCadence: "MONTHLY" },
      } as any);

      await expect(getWorkspaceNewspaperCadence("ws-1")).resolves.toBe("DAILY");
    });

    it("merges admin newspaper cadence into the daily digest config", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateWorkspaceNewspaperCadence } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue({
        configJson: { existing: true },
      } as any);
      vi.mocked(prisma.workspaceAgentConfig.upsert).mockResolvedValue({} as any);

      await updateWorkspaceNewspaperCadence(
        { kind: "user", user: { id: "u-1" } } as any,
        { workspaceId: "ws-1", cadence: "WEEKLY" },
      );

      expect(prisma.workspaceAgentConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { workspaceId_agentKey: { workspaceId: "ws-1", agentKey: "daily-digest" } },
        create: expect.objectContaining({
          configJson: { existing: true, newspaperCadence: "WEEKLY" },
        }),
        update: {
          configJson: { existing: true, newspaperCadence: "WEEKLY" },
        },
      }));
    });

    it("allows admins to set the workspace newspaper cadence to off", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateWorkspaceNewspaperCadence } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue({
        configJson: { existing: true },
      } as any);
      vi.mocked(prisma.workspaceAgentConfig.upsert).mockResolvedValue({} as any);

      await updateWorkspaceNewspaperCadence(
        { kind: "user", user: { id: "u-1" } } as any,
        { workspaceId: "ws-1", cadence: "OFF" },
      );

      expect(prisma.workspaceAgentConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          configJson: { existing: true, newspaperCadence: "OFF" },
        }),
        update: {
          configJson: { existing: true, newspaperCadence: "OFF" },
        },
      }));
    });
  });
});
