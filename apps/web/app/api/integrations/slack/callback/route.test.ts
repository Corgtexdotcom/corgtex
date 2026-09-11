import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requirePageActorMock,
  exchangeSlackOAuthCodeMock,
  getSlackOAuthInstallTargetMock,
  isSlackTenantBindingErrorMock,
  readSlackOAuthStateMock,
  saveSlackInstallationMock,
  cookiesMock,
  cookieGetMock,
  cookieDeleteMock,
} = vi.hoisted(() => ({
  requirePageActorMock: vi.fn(),
  exchangeSlackOAuthCodeMock: vi.fn(),
  getSlackOAuthInstallTargetMock: vi.fn(),
  isSlackTenantBindingErrorMock: vi.fn(),
  readSlackOAuthStateMock: vi.fn(),
  saveSlackInstallationMock: vi.fn(),
  cookiesMock: vi.fn(),
  cookieGetMock: vi.fn(),
  cookieDeleteMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor: requirePageActorMock,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: (error: Error & { status?: number; code?: string }) => Response.json({
    error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
  }, { status: error.status ?? 500 }),
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    get APP_URL() {
      return process.env.APP_URL ?? "";
    },
    get NODE_ENV() {
      return process.env.NODE_ENV ?? "test";
    },
  },
  isDatabaseUnavailableError: vi.fn(() => false),
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
  getSlackOAuthInstallTarget: getSlackOAuthInstallTargetMock,
  isSlackTenantBindingError: isSlackTenantBindingErrorMock,
  readSlackOAuthState: readSlackOAuthStateMock,
  saveSlackInstallation: saveSlackInstallationMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("APP_URL", "https://app.corgtex.com/");
  requirePageActorMock.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
  readSlackOAuthStateMock.mockReturnValue({
    version: 1,
    workspaceId: "workspace-1",
    nonce: "nonce-value",
    expectedTeamId: "T1",
    flow: { kind: "workspace" },
  });
  getSlackOAuthInstallTargetMock.mockResolvedValue({ workspaceId: "workspace-1", expectedTeamId: "T1" });
  exchangeSlackOAuthCodeMock.mockResolvedValue({ ok: true, team: { id: "T1" }, access_token: "xoxb-token" });
  saveSlackInstallationMock.mockResolvedValue({ id: "installation-1" });
  isSlackTenantBindingErrorMock.mockReturnValue(false);
  cookieGetMock.mockReturnValue({ value: "state-value:nonce-value" });
  cookiesMock.mockResolvedValue({
    get: cookieGetMock,
    delete: cookieDeleteMock,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/integrations/slack/callback", () => {
  it("exchanges Slack OAuth codes with the same callback URL used during install", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new Request("https://preview.example.test/api/integrations/slack/callback?code=auth-code&state=state-value"),
    );

    expect(exchangeSlackOAuthCodeMock).toHaveBeenCalledWith(
      "auth-code",
      "https://app.corgtex.com/api/integrations/slack/callback",
      "workspace-1",
    );
    expect(saveSlackInstallationMock).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      {
        workspaceId: "workspace-1",
        oauthResponse: { ok: true, team: { id: "T1" }, access_token: "xoxb-token" },
        expectedTeamId: "T1",
      },
    );
    expect(cookieDeleteMock).toHaveBeenCalledWith("slack_oauth_state");
    expect(response.headers.get("location")).toBe(
      "https://app.corgtex.com/workspaces/workspace-1/tools?type=CONNECTOR&q=slack&slack=connected",
    );
  });

  it("rejects wrong-team callbacks before saving Slack tokens", async () => {
    exchangeSlackOAuthCodeMock.mockResolvedValueOnce({ ok: true, team: { id: "T2" }, access_token: "xoxb-token" });
    const { GET } = await import("./route");

    const response = await GET(
      new Request("https://app.corgtex.com/api/integrations/slack/callback?code=auth-code&state=state-value"),
    );

    expect(saveSlackInstallationMock).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "https://app.corgtex.com/workspaces/workspace-1/tools?type=CONNECTOR&q=slack&slack=wrong-team",
    );
  });

  it("redirects binding conflicts without leaking tenant details", async () => {
    const bindingError = Object.assign(new Error("bound elsewhere"), { code: "SLACK_TEAM_ALREADY_CONNECTED" });
    saveSlackInstallationMock.mockRejectedValueOnce(bindingError);
    isSlackTenantBindingErrorMock.mockReturnValueOnce(true);
    const { GET } = await import("./route");

    const response = await GET(
      new Request("https://app.corgtex.com/api/integrations/slack/callback?code=auth-code&state=state-value"),
    );

    expect(response.headers.get("location")).toBe(
      "https://app.corgtex.com/workspaces/workspace-1/tools?type=CONNECTOR&q=slack&slack=wrong-team",
    );
  });

  it("rechecks admin authorization before exchanging a valid callback code", async () => {
    getSlackOAuthInstallTargetMock.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.corgtex.com/api/integrations/slack/callback?code=auth-code&state=state-value&workspaceId=other"));
    expect(getSlackOAuthInstallTargetMock).toHaveBeenCalledWith({ kind: "user", user: { id: "user-1" } }, "workspace-1");
    expect(response.status).toBe(403);
    expect(exchangeSlackOAuthCodeMock).not.toHaveBeenCalled();
    expect(saveSlackInstallationMock).not.toHaveBeenCalled();
  });

  it("does not resolve scope or exchange when the cookie does not match state", async () => {
    cookieGetMock.mockReturnValueOnce({ value: "different-state:nonce-value" });
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.corgtex.com/api/integrations/slack/callback?code=auth-code&state=state-value"));
    expect(response.headers.get("location")).toContain("slack-invalid-state");
    expect(getSlackOAuthInstallTargetMock).not.toHaveBeenCalled();
    expect(exchangeSlackOAuthCodeMock).not.toHaveBeenCalled();
    expect(saveSlackInstallationMock).not.toHaveBeenCalled();
  });

  it("lets Next.js handle auth redirects instead of converting them to JSON errors", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    requirePageActorMock.mockRejectedValueOnce(redirectError);
    const { GET } = await import("./route");

    await expect(
      GET(new Request("https://app.corgtex.com/api/integrations/slack/callback?code=auth-code&state=state-value")),
    ).rejects.toBe(redirectError);
  });
});
