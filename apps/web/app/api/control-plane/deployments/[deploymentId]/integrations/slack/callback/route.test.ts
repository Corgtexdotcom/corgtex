import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  exchangeSlackOAuthCodeMock,
  getControlPlaneSlackSetupTargetMock,
  isSlackTenantBindingErrorMock,
  isDatabaseUnavailableErrorMock,
  readSlackOAuthStateMock,
  requirePageActorMock,
  saveControlPlaneSlackInstallationMock,
  cookiesMock,
  cookieDeleteMock,
  cookieGetMock,
} = vi.hoisted(() => ({
  exchangeSlackOAuthCodeMock: vi.fn(),
  getControlPlaneSlackSetupTargetMock: vi.fn(),
  isSlackTenantBindingErrorMock: vi.fn(),
  isDatabaseUnavailableErrorMock: vi.fn(),
  readSlackOAuthStateMock: vi.fn(),
  requirePageActorMock: vi.fn(),
  saveControlPlaneSlackInstallationMock: vi.fn(),
  cookiesMock: vi.fn(),
  cookieDeleteMock: vi.fn(),
  cookieGetMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor: requirePageActorMock,
}));

vi.mock("@/lib/posthog-server", () => ({
  capturePostHogEvent: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: class AppError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  exchangeSlackOAuthCode: exchangeSlackOAuthCodeMock,
  getControlPlaneSlackSetupTarget: getControlPlaneSlackSetupTargetMock,
  isSlackTenantBindingError: isSlackTenantBindingErrorMock,
  readSlackOAuthState: readSlackOAuthStateMock,
  saveControlPlaneSlackInstallation: saveControlPlaneSlackInstallationMock,
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    APP_URL: "https://app.corgtex.com/",
    CONTROL_PLANE_MODE: true,
    NODE_ENV: "test",
  },
  isDatabaseUnavailableError: isDatabaseUnavailableErrorMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  requirePageActorMock.mockResolvedValue({ kind: "user", user: { id: "operator-1" } });
  getControlPlaneSlackSetupTargetMock.mockResolvedValue({ deploymentId: "dep-1", managedWorkspaceId: "ws-1", expectedTeamId: "T1" });
  readSlackOAuthStateMock.mockReturnValue({
    version: 1,
    workspaceId: "ws-1",
    nonce: "nonce-value",
    expectedTeamId: "T1",
    flow: {
      kind: "control_plane",
      deploymentId: "dep-1",
      initiatedByUserId: "operator-1",
    },
  });
  exchangeSlackOAuthCodeMock.mockResolvedValue({ ok: true, team: { id: "T1" }, access_token: "xoxb-token" });
  saveControlPlaneSlackInstallationMock.mockResolvedValue({ deploymentId: "dep-1", managedWorkspaceId: "ws-1" });
  isSlackTenantBindingErrorMock.mockReturnValue(false);
  isDatabaseUnavailableErrorMock.mockReturnValue(false);
  cookieGetMock.mockReturnValue({ value: "state-value:nonce-value:dep-1:operator-1" });
  cookiesMock.mockResolvedValue({
    get: cookieGetMock,
    delete: cookieDeleteMock,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/control-plane/deployments/[deploymentId]/integrations/slack/callback", () => {
  it("validates state, exchanges the code, saves Slack, and redirects to Control Plane Tools", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new Request("https://preview.example.test/api/control-plane/deployments/dep-1/integrations/slack/callback?code=auth-code&state=state-value"),
      { params: Promise.resolve({ deploymentId: "dep-1" }) },
    );

    expect(getControlPlaneSlackSetupTargetMock).toHaveBeenCalledWith(
      { kind: "user", user: { id: "operator-1" } },
      "dep-1",
    );
    expect(exchangeSlackOAuthCodeMock).toHaveBeenCalledWith(
      "auth-code",
      "https://app.corgtex.com/api/control-plane/deployments/dep-1/integrations/slack/callback",
    );
    expect(saveControlPlaneSlackInstallationMock).toHaveBeenCalledWith(
      { kind: "user", user: { id: "operator-1" } },
      {
        deploymentId: "dep-1",
        oauthResponse: { ok: true, team: { id: "T1" }, access_token: "xoxb-token" },
        expectedTeamId: "T1",
        reason: "Connected Slack through Control Plane.",
      },
    );
    expect(cookieDeleteMock).toHaveBeenCalledWith("control_plane_slack_oauth_state");
    expect(response.headers.get("location")).toBe("https://app.corgtex.com/control-plane/deployments/dep-1?tab=tools&slack=connected");
  });

  it("rejects wrong-team callbacks before saving Control Plane Slack tokens", async () => {
    exchangeSlackOAuthCodeMock.mockResolvedValueOnce({ ok: true, team: { id: "T2" }, access_token: "xoxb-token" });
    const { GET } = await import("./route");

    const response = await GET(
      new Request("https://preview.example.test/api/control-plane/deployments/dep-1/integrations/slack/callback?code=auth-code&state=state-value"),
      { params: Promise.resolve({ deploymentId: "dep-1" }) },
    );

    expect(saveControlPlaneSlackInstallationMock).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://app.corgtex.com/control-plane/deployments/dep-1?tab=tools&slack=wrong-team");
  });

  it("redirects Control Plane binding conflicts without leaking tenant details", async () => {
    const bindingError = Object.assign(new Error("bound elsewhere"), { code: "SLACK_TEAM_ALREADY_CONNECTED" });
    saveControlPlaneSlackInstallationMock.mockRejectedValueOnce(bindingError);
    isSlackTenantBindingErrorMock.mockReturnValueOnce(true);
    const { GET } = await import("./route");

    const response = await GET(
      new Request("https://preview.example.test/api/control-plane/deployments/dep-1/integrations/slack/callback?code=auth-code&state=state-value"),
      { params: Promise.resolve({ deploymentId: "dep-1" }) },
    );

    expect(response.headers.get("location")).toBe("https://app.corgtex.com/control-plane/deployments/dep-1?tab=tools&slack=wrong-team");
  });
});
