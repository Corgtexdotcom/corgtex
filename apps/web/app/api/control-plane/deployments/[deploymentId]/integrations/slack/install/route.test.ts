import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSlackOAuthStateMock,
  getControlPlaneSlackSetupTargetMock,
  getSlackWorkspaceBindingMock,
  isDatabaseUnavailableErrorMock,
  requirePageActorMock,
  slackOAuthScopesMock,
  cookiesMock,
  cookieSetMock,
} = vi.hoisted(() => ({
  createSlackOAuthStateMock: vi.fn(),
  getControlPlaneSlackSetupTargetMock: vi.fn(),
  getSlackWorkspaceBindingMock: vi.fn(),
  isDatabaseUnavailableErrorMock: vi.fn(),
  requirePageActorMock: vi.fn(),
  slackOAuthScopesMock: vi.fn(),
  cookiesMock: vi.fn(),
  cookieSetMock: vi.fn(),
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
  createSlackOAuthState: createSlackOAuthStateMock,
  getControlPlaneSlackSetupTarget: getControlPlaneSlackSetupTargetMock,
  getSlackWorkspaceBinding: getSlackWorkspaceBindingMock,
  slackOAuthScopes: slackOAuthScopesMock,
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    APP_URL: "https://app.corgtex.com/",
    CONTROL_PLANE_MODE: true,
    NODE_ENV: "test",
    SLACK_CLIENT_ID: "slack-client-id",
  },
  isDatabaseUnavailableError: isDatabaseUnavailableErrorMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  requirePageActorMock.mockResolvedValue({ kind: "user", user: { id: "operator-1" } });
  getControlPlaneSlackSetupTargetMock.mockResolvedValue({ deploymentId: "dep-1", managedWorkspaceId: "ws-1", expectedTeamId: "T1" });
  createSlackOAuthStateMock.mockReturnValue({ value: "state-value", nonce: "nonce-value", expectedTeamId: "T1" });
  getSlackWorkspaceBindingMock.mockReturnValue({ source: "legacy", clientId: "slack-client-id", clientSecret: "synthetic-legacy-secret", teamId: null, scopes: null });
  slackOAuthScopesMock.mockReturnValue("commands,chat:write");
  isDatabaseUnavailableErrorMock.mockReturnValue(false);
  cookiesMock.mockResolvedValue({ set: cookieSetMock });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/control-plane/deployments/[deploymentId]/integrations/slack/install", () => {
  it("starts Slack OAuth for a managed deployment with the control-plane callback URL", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new Request("https://preview.example.test/api/control-plane/deployments/dep-1/integrations/slack/install"),
      { params: Promise.resolve({ deploymentId: "dep-1" }) },
    );
    const authorizeUrl = new URL(response.headers.get("location") ?? "");

    expect(getControlPlaneSlackSetupTargetMock).toHaveBeenCalledWith(
      { kind: "user", user: { id: "operator-1" } },
      "dep-1",
    );
    expect(authorizeUrl.origin).toBe("https://slack.com");
    expect(authorizeUrl.pathname).toBe("/oauth/v2/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("slack-client-id");
    expect(authorizeUrl.searchParams.get("scope")).toBe("commands,chat:write");
    expect(authorizeUrl.searchParams.get("state")).toBe("state-value");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://app.corgtex.com/api/control-plane/deployments/dep-1/integrations/slack/callback");
    expect(authorizeUrl.searchParams.get("team")).toBe("T1");
    expect(createSlackOAuthStateMock).toHaveBeenCalledWith("ws-1", {
      expectedTeamId: "T1",
      flow: {
        kind: "control_plane",
        deploymentId: "dep-1",
        initiatedByUserId: "operator-1",
      },
    });
    expect(cookieSetMock).toHaveBeenCalledWith(
      "control_plane_slack_oauth_state",
      "state-value:nonce-value:dep-1:operator-1",
      expect.objectContaining({
        httpOnly: true,
        path: "/api/control-plane/deployments/dep-1/integrations/slack/callback",
        sameSite: "lax",
      }),
    );
  });
  it("selects the authorized managed workspace's scoped app and exact permissions", async () => {
    getSlackWorkspaceBindingMock.mockReturnValueOnce({ source: "workspace", clientId: "scoped-client", clientSecret: "synthetic-scoped-secret", teamId: "T1", scopes: ["commands", "channels:history"] });
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.corgtex.com/api/control-plane/deployments/dep-1/integrations/slack/install?workspaceId=untrusted"), { params: Promise.resolve({ deploymentId: "dep-1" }) });
    expect(getSlackWorkspaceBindingMock).toHaveBeenCalledExactlyOnceWith("ws-1");
    expect(getControlPlaneSlackSetupTargetMock.mock.invocationCallOrder[0]).toBeLessThan(getSlackWorkspaceBindingMock.mock.invocationCallOrder[0]);
    const url = new URL(response.headers.get("location")!);
    expect(url.searchParams.get("client_id")).toBe("scoped-client");
    expect(url.searchParams.get("scope")).toBe("commands,channels:history");
    expect(url.searchParams.get("team")).toBe("T1");
    expect(slackOAuthScopesMock).not.toHaveBeenCalled();
    expect(url.toString()).not.toContain("synthetic-scoped-secret");
  });

  it("fails authorization before reading credentials or creating state", async () => {
    getControlPlaneSlackSetupTargetMock.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403, code: "FORBIDDEN" }));
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.corgtex.com/install"), { params: Promise.resolve({ deploymentId: "dep-1" }) });
    expect(response.status).toBe(403);
    expect(getSlackWorkspaceBindingMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("fails closed without falling back to globals for an unconfigured managed workspace", async () => {
    getSlackWorkspaceBindingMock.mockReturnValueOnce(null);
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.corgtex.com/install"), { params: Promise.resolve({ deploymentId: "dep-1" }) });
    expect(response.headers.get("location")).toContain("slack=not-configured");
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("rejects malformed map and team conflicts before writing OAuth state", async () => {
    const { GET } = await import("./route");
    getSlackWorkspaceBindingMock.mockImplementationOnce(() => { throw Object.assign(new Error("Slack workspace configuration is invalid."), { status: 503, code: "SLACK_WORKSPACE_BINDINGS_INVALID" }); });
    const invalid = await GET(new Request("https://app.corgtex.com/install"), { params: Promise.resolve({ deploymentId: "dep-1" }) });
    expect(invalid.status).toBe(503);
    getSlackWorkspaceBindingMock.mockReturnValueOnce({ source: "workspace", clientId: "scoped-client", clientSecret: "synthetic-secret", teamId: "TOTHER", scopes: ["commands"] });
    const mismatch = await GET(new Request("https://app.corgtex.com/install"), { params: Promise.resolve({ deploymentId: "dep-1" }) });
    expect(mismatch.status).toBe(409);
    expect(cookieSetMock).not.toHaveBeenCalled();
    expect(createSlackOAuthStateMock).not.toHaveBeenCalled();
  });

  it("binds a first installation's OAuth state to the configured Slack team", async () => {
    getControlPlaneSlackSetupTargetMock.mockResolvedValueOnce({ deploymentId: "dep-1", managedWorkspaceId: "ws-1", expectedTeamId: null });
    getSlackWorkspaceBindingMock.mockReturnValueOnce({ source: "workspace", clientId: "scoped-client", clientSecret: "synthetic-secret", teamId: "TCONFIGURED", scopes: ["commands"] });
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.corgtex.com/install"), { params: Promise.resolve({ deploymentId: "dep-1" }) });
    expect(new URL(response.headers.get("location")!).searchParams.get("team")).toBe("TCONFIGURED");
    expect(createSlackOAuthStateMock).toHaveBeenCalledWith("ws-1", expect.objectContaining({ expectedTeamId: "TCONFIGURED" }));
  });
});
