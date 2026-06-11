import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSlackOAuthStateMock,
  getControlPlaneSlackSetupTargetMock,
  isDatabaseUnavailableErrorMock,
  requirePageActorMock,
  slackOAuthScopesMock,
  cookiesMock,
  cookieSetMock,
} = vi.hoisted(() => ({
  createSlackOAuthStateMock: vi.fn(),
  getControlPlaneSlackSetupTargetMock: vi.fn(),
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
  getControlPlaneSlackSetupTargetMock.mockResolvedValue({ deploymentId: "dep-1", managedWorkspaceId: "ws-1" });
  createSlackOAuthStateMock.mockReturnValue({ value: "state-value", nonce: "nonce-value" });
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
});
