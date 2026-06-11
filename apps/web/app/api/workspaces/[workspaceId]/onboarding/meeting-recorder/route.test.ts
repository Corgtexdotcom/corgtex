import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  enableMeetingRecorderForWorkspace,
  getMeetingRecorderConfig,
  updateMeetingRecorderConfig,
  resolveRequestActor,
  checkApiDemoGuard,
  handleRouteError,
} = vi.hoisted(() => ({
  enableMeetingRecorderForWorkspace: vi.fn(),
  getMeetingRecorderConfig: vi.fn(),
  updateMeetingRecorderConfig: vi.fn(),
  resolveRequestActor: vi.fn(),
  checkApiDemoGuard: vi.fn(),
  handleRouteError: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  enableMeetingRecorderForWorkspace,
  getMeetingRecorderConfig,
  updateMeetingRecorderConfig,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/demo-guard", () => ({
  checkApiDemoGuard,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

function recorderConfig(overrides: Record<string, unknown> = {}, topLevelOverrides: Record<string, unknown> = {}) {
  return {
    featureEnabled: true,
    ...topLevelOverrides,
    config: {
      enabled: false,
      autoRecordEnabled: false,
      defaultProvider: "RECALL_AI",
      fallbackProvider: null,
      botName: "Corgtex Recorder",
      monthlyMinuteCap: 6000,
      ...overrides,
    },
    usage: { usedMinutes: 0 },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/workspaces/[workspaceId]/onboarding/meeting-recorder", () => {
  it("returns recorder setup status for the current workspace actor", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    getMeetingRecorderConfig.mockResolvedValue(recorderConfig({ enabled: true }));
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding/meeting-recorder"),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(getMeetingRecorderConfig).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      "ws-1",
    );
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      featureEnabled: true,
      enabled: true,
      defaultProvider: "RECALL_AI",
    }));
  });

  it("updates recorder setup through the demo guard", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    getMeetingRecorderConfig.mockResolvedValue(recorderConfig({ enabled: true }));
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding/meeting-recorder", {
        method: "POST",
        body: JSON.stringify({ enabled: true, autoRecordEnabled: false }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(checkApiDemoGuard).toHaveBeenCalledWith("ws-1");
    expect(enableMeetingRecorderForWorkspace).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1", enabled: true },
    );
    expect(updateMeetingRecorderConfig).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1", enabled: true, autoRecordEnabled: false },
    );
    expect(response.status).toBe(200);
  });

  it("enables recorder access from onboarding when the workspace did not have it yet", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    getMeetingRecorderConfig.mockResolvedValue(recorderConfig({ enabled: true }, { featureEnabled: true }));
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding/meeting-recorder", {
        method: "POST",
        body: JSON.stringify({ enabled: true, autoRecordEnabled: true }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(enableMeetingRecorderForWorkspace).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1", enabled: true },
    );
    expect(updateMeetingRecorderConfig).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1", enabled: true, autoRecordEnabled: false },
    );
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      featureEnabled: true,
      enabled: true,
      autoRecordEnabled: false,
    }));
  });
});
