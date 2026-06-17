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
    it("defaults company-understanding goal generation to automatic apply mode", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { listAgentConfigs } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findMany).mockResolvedValue([]);

      const configs = await listAgentConfigs(
        { kind: "user", user: { id: "u-1" } } as any,
        "ws-1",
      );
      const companyUnderstandingConfig = configs.find((config) => config.agentKey === "company-understanding");

      expect(companyUnderstandingConfig?.configJson).toMatchObject({
        goalApplyMode: "AUTO",
      });
    });

    it("normalizes invalid company-understanding goal apply mode to automatic", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { listAgentConfigs } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findMany).mockResolvedValue([{
        workspaceId: "ws-1",
        agentKey: "company-understanding",
        enabled: true,
        modelOverride: null,
        governancePolicy: null,
        configJson: { goalApplyMode: "REVIEW_QUEUE" },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any]);

      const configs = await listAgentConfigs(
        { kind: "user", user: { id: "u-1" } } as any,
        "ws-1",
      );
      const companyUnderstandingConfig = configs.find((config) => config.agentKey === "company-understanding");

      expect(companyUnderstandingConfig?.configJson).toMatchObject({
        goalApplyMode: "AUTO",
      });
    });

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

  describe("company-understanding goal apply mode", () => {
    it("defaults to automatic when unset", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getCompanyUnderstandingGoalApplyMode } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue(null);

      await expect(getCompanyUnderstandingGoalApplyMode("ws-1")).resolves.toBe("AUTO");
    });

    it("reads manual mode from config", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getCompanyUnderstandingGoalApplyMode } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue({
        configJson: { goalApplyMode: "MANUAL" },
      } as any);

      await expect(getCompanyUnderstandingGoalApplyMode("ws-1")).resolves.toBe("MANUAL");
    });

    it("merges the goal apply mode into the company-understanding config", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateCompanyUnderstandingGoalApplyMode } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findUnique).mockResolvedValue({
        configJson: { existing: true },
      } as any);
      vi.mocked(prisma.workspaceAgentConfig.upsert).mockResolvedValue({} as any);

      await updateCompanyUnderstandingGoalApplyMode(
        { kind: "user", user: { id: "u-1" } } as any,
        { workspaceId: "ws-1", mode: "MANUAL" },
      );

      expect(prisma.workspaceAgentConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { workspaceId_agentKey: { workspaceId: "ws-1", agentKey: "company-understanding" } },
        create: expect.objectContaining({
          configJson: { existing: true, goalApplyMode: "MANUAL" },
        }),
        update: {
          configJson: { existing: true, goalApplyMode: "MANUAL" },
        },
      }));
    });
  });

  describe("getWorkspaceDigestSettings", () => {
    it("returns an empty map and issues no query for an empty workspace list", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getWorkspaceDigestSettings } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findMany).mockClear();

      const settings = await getWorkspaceDigestSettings([]);

      expect(settings.size).toBe(0);
      expect(prisma.workspaceAgentConfig.findMany).not.toHaveBeenCalled();
    });

    it("resolves enabled flag and cadence per workspace in a single batched query", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getWorkspaceDigestSettings } = await import("./agent-config");

      vi.mocked(prisma.workspaceAgentConfig.findMany).mockResolvedValue([
        { workspaceId: "ws-1", enabled: true, configJson: { newspaperCadence: "WEEKLY" } },
        { workspaceId: "ws-2", enabled: false, configJson: { newspaperCadence: "OFF" } },
        { workspaceId: "ws-3", enabled: true, configJson: { newspaperCadence: "MONTHLY" } },
      ] as any);

      const settings = await getWorkspaceDigestSettings(["ws-1", "ws-2", "ws-3", "ws-4"]);

      expect(prisma.workspaceAgentConfig.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.workspaceAgentConfig.findMany).toHaveBeenCalledWith({
        where: { agentKey: "daily-digest", workspaceId: { in: ["ws-1", "ws-2", "ws-3", "ws-4"] } },
        select: { workspaceId: true, enabled: true, configJson: true },
      });
      expect(settings.get("ws-1")).toEqual({ enabled: true, cadence: "WEEKLY" });
      expect(settings.get("ws-2")).toEqual({ enabled: false, cadence: "OFF" });
      // Invalid configured cadence falls back to the daily default.
      expect(settings.get("ws-3")).toEqual({ enabled: true, cadence: "DAILY" });
      // A workspace with no config row defaults to enabled + the daily default.
      expect(settings.get("ws-4")).toEqual({ enabled: true, cadence: "DAILY" });
    });
  });
});
