import { afterEach, describe, expect, it, vi } from "vitest";

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

const enforceDemoGuard = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const revalidatePath = vi.fn();
const updateAgentConfig = vi.fn();
const updateCompanyUnderstandingGoalApplyMode = vi.fn();
const updateWorkspaceNewspaperCadence = vi.fn();
const updateWorkspaceNewspaperSchedule = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  updateAgentConfig,
  updateCompanyUnderstandingGoalApplyMode,
  updateWorkspaceNewspaperCadence,
  updateWorkspaceNewspaperSchedule,
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("agent settings actions", () => {
  it("updates the company-understanding goal apply mode", async () => {
    const { updateCompanyUnderstandingGoalApplyModeAction } = await import("./actions");

    await updateCompanyUnderstandingGoalApplyModeAction("workspace-1", "MANUAL");

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(updateCompanyUnderstandingGoalApplyMode).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      mode: "MANUAL",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/workspaces/workspace-1/settings/agents");
    expect(revalidatePath).toHaveBeenCalledWith("/workspaces/workspace-1/settings");
  });

  it("updates the newspaper schedule", async () => {
    const { updateAgentNewspaperScheduleAction } = await import("./actions");

    await updateAgentNewspaperScheduleAction("workspace-1", {
      cadence: "WEEKLY",
      weekday: "MONDAY",
      localTime: "08:00",
      timeZone: "America/Los_Angeles",
    });

    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(updateWorkspaceNewspaperSchedule).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      cadence: "WEEKLY",
      weekday: "MONDAY",
      localTime: "08:00",
      timeZone: "America/Los_Angeles",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/workspaces/workspace-1/settings/agents");
    expect(revalidatePath).toHaveBeenCalledWith("/workspaces/workspace-1/settings");
  });
});
