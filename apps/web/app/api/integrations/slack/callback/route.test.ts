import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requirePageActorMock,
  exchangeSlackOAuthCodeMock,
  readSlackOAuthStateMock,
  saveSlackInstallationMock,
  cookiesMock,
  cookieGetMock,
  cookieDeleteMock,
} = vi.hoisted(() => ({
  requirePageActorMock: vi.fn(),
  exchangeSlackOAuthCodeMock: vi.fn(),
  readSlackOAuthStateMock: vi.fn(),
  saveSlackInstallationMock: vi.fn(),
  cookiesMock: vi.fn(),
  cookieGetMock: vi.fn(),
  cookieDeleteMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor: requirePageActorMock,
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
  readSlackOAuthState: readSlackOAuthStateMock,
  saveSlackInstallation: saveSlackInstallationMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("APP_URL", "https://app.corgtex.com/");
  requirePageActorMock.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
  readSlackOAuthStateMock.mockReturnValue({ workspaceId: "workspace-1", nonce: "nonce-value" });
  exchangeSlackOAuthCodeMock.mockResolvedValue({ ok: true, team: { id: "T1" }, access_token: "xoxb-token" });
  saveSlackInstallationMock.mockResolvedValue({ id: "installation-1" });
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
    );
    expect(saveSlackInstallationMock).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      {
        workspaceId: "workspace-1",
        oauthResponse: { ok: true, team: { id: "T1" }, access_token: "xoxb-token" },
      },
    );
    expect(cookieDeleteMock).toHaveBeenCalledWith("slack_oauth_state");
    expect(response.headers.get("location")).toBe(
      "https://app.corgtex.com/workspaces/workspace-1/settings?tab=general&slack=connected",
    );
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
