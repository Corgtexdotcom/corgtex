import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requirePageActorMock,
  createSlackOAuthStateMock,
  slackOAuthScopesMock,
  cookiesMock,
  cookieSetMock,
} = vi.hoisted(() => ({
  requirePageActorMock: vi.fn(),
  createSlackOAuthStateMock: vi.fn(),
  slackOAuthScopesMock: vi.fn(),
  cookiesMock: vi.fn(),
  cookieSetMock: vi.fn(),
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
  createSlackOAuthState: createSlackOAuthStateMock,
  slackOAuthScopes: slackOAuthScopesMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("APP_URL", "https://app.corgtex.com/");
  vi.stubEnv("SLACK_CLIENT_ID", "slack-client-id");
  requirePageActorMock.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
  createSlackOAuthStateMock.mockReturnValue({ value: "state-value", nonce: "nonce-value" });
  slackOAuthScopesMock.mockReturnValue("commands,chat:write");
  cookiesMock.mockResolvedValue({
    set: cookieSetMock,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/integrations/slack/install", () => {
  it("sends Slack the production callback URL from APP_URL", async () => {
    const { GET } = await import("./route");

    const response = await GET(new Request("https://preview.example.test/api/integrations/slack/install?workspaceId=workspace-1"));
    const location = response.headers.get("location");
    const authorizeUrl = new URL(location ?? "");

    expect(authorizeUrl.origin).toBe("https://slack.com");
    expect(authorizeUrl.pathname).toBe("/oauth/v2/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("slack-client-id");
    expect(authorizeUrl.searchParams.get("scope")).toBe("commands,chat:write");
    expect(authorizeUrl.searchParams.get("state")).toBe("state-value");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://app.corgtex.com/api/integrations/slack/callback");
    expect(cookieSetMock).toHaveBeenCalledWith(
      "slack_oauth_state",
      "state-value:nonce-value",
      expect.objectContaining({
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
  });

  it("lets Next.js handle auth redirects instead of converting them to JSON errors", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    requirePageActorMock.mockRejectedValueOnce(redirectError);
    const { GET } = await import("./route");

    await expect(
      GET(new Request("https://app.corgtex.com/api/integrations/slack/install?workspaceId=workspace-1")),
    ).rejects.toBe(redirectError);
  });
});
