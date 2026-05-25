import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { requirePageActor, saveOAuthConnectionAndEnqueueCalendarSync, verifyIntegrationOAuthState } = vi.hoisted(() => ({
  requirePageActor: vi.fn(),
  saveOAuthConnectionAndEnqueueCalendarSync: vi.fn(),
  verifyIntegrationOAuthState: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  saveOAuthConnectionAndEnqueueCalendarSync,
  verifyIntegrationOAuthState,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
  vi.stubEnv("MICROSOFT_CLIENT_ID", "microsoft-client-id");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "microsoft-client-secret");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/integrations/[provider]/callback", () => {
  it("redirects back to workspace settings and enqueues a calendar sync job after a successful Google connect", async () => {
    requirePageActor.mockResolvedValue({
      kind: "user",
      user: { id: "user-1" },
    });
    saveOAuthConnectionAndEnqueueCalendarSync.mockResolvedValue({ id: "conn-1" });
    verifyIntegrationOAuthState.mockReturnValue({ userId: "user-1", workspaceId: "ws-1" });

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "calendar profile",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "google-user-1",
      }), { status: 200 }));

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/integrations/google/callback?code=auth-code&state=signed-state", {
        headers: { cookie: "corgtex_google_oauth_state=signed-state" },
      }),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(saveOAuthConnectionAndEnqueueCalendarSync).toHaveBeenCalledWith(
      {
        kind: "user",
        user: { id: "user-1" },
      },
      {
        workspaceId: "ws-1",
        provider: "GOOGLE",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 3600,
        providerAccountId: "google-user-1",
        providerEmail: null,
        scopes: ["calendar", "profile"],
      },
    );
    expect(response.headers.get("location")).toBe("http://localhost:3000/workspaces/ws-1/settings?tab=general&integration=google&integrationStatus=success&integrationSuccess=google_connected");
    expect(response.headers.get("set-cookie")).toContain("corgtex_google_oauth_state=");
  });

  it("redirects provider access errors back to settings with a safe Google verification message", async () => {
    requirePageActor.mockResolvedValue({
      kind: "user",
      user: { id: "user-1" },
    });
    verifyIntegrationOAuthState.mockReturnValue({ userId: "user-1", workspaceId: "ws-1" });

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/integrations/google/callback?error=access_denied&state=signed-state", {
        headers: { cookie: "corgtex_google_oauth_state=signed-state" },
      }),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(saveOAuthConnectionAndEnqueueCalendarSync).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("http://localhost:3000/workspaces/ws-1/settings?tab=general&integration=google&integrationStatus=error&integrationError=google_verification_or_tester_required");
  });

  it("redirects Microsoft tenant token failures back to settings instead of returning JSON", async () => {
    requirePageActor.mockResolvedValue({
      kind: "user",
      user: { id: "user-1" },
    });
    verifyIntegrationOAuthState.mockReturnValue({ userId: "user-1", workspaceId: "ws-1" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "AADSTS50020: User account does not exist in tenant.",
    }), { status: 400 }));

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/integrations/microsoft/callback?code=auth-code&state=signed-state", {
        headers: { cookie: "corgtex_microsoft_oauth_state=signed-state" },
      }),
      { params: Promise.resolve({ provider: "microsoft" }) },
    );

    expect(response.headers.get("location")).toBe("http://localhost:3000/workspaces/ws-1/settings?tab=general&integration=microsoft&integrationStatus=error&integrationError=microsoft_tenant_access_denied");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
  });

  it("redirects Microsoft invalid client secret failures with a specific operator-safe error", async () => {
    requirePageActor.mockResolvedValue({
      kind: "user",
      user: { id: "user-1" },
    });
    verifyIntegrationOAuthState.mockReturnValue({ userId: "user-1", workspaceId: "ws-1" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: "invalid_client",
      error_description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.",
    }), { status: 400 }));

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/integrations/microsoft/callback?code=auth-code&state=signed-state", {
        headers: { cookie: "corgtex_microsoft_oauth_state=signed-state" },
      }),
      { params: Promise.resolve({ provider: "microsoft" }) },
    );

    expect(response.headers.get("location")).toBe("http://localhost:3000/workspaces/ws-1/settings?tab=general&integration=microsoft&integrationStatus=error&integrationError=microsoft_invalid_client_secret");
  });

  it("rejects callbacks without the matching short-lived state cookie", async () => {
    requirePageActor.mockResolvedValue({
      kind: "user",
      user: { id: "user-1" },
    });

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/integrations/google/callback?code=auth-code&state=signed-state"),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(verifyIntegrationOAuthState).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("http://localhost:3000/?integration=google&integrationStatus=error&integrationError=oauth_state_invalid");
  });
});
