import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { requirePageActor, createIntegrationOAuthState, requireWorkspaceMembership } = vi.hoisted(() => ({
  requirePageActor: vi.fn(),
  createIntegrationOAuthState: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: (error: Error & { status?: number; code?: string }) => Response.json({
    error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
  }, { status: error.status ?? 500 }),
}));

vi.mock("@corgtex/domain", () => ({
  createIntegrationOAuthState,
  requireWorkspaceMembership,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
  vi.stubEnv("MICROSOFT_CLIENT_ID", "microsoft-client-id");
  requirePageActor.mockResolvedValue({
    kind: "user",
    user: { id: "user-1" },
  });
  requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
  createIntegrationOAuthState.mockReturnValue("signed-state");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/integrations/[provider]/connect", () => {
  it("starts Google OAuth with public origin, read-only calendar scope, and a state cookie", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("https://preview.example.test/api/integrations/google/connect?workspaceId=ws-1", {
        headers: {
          "x-forwarded-host": "app.corgtex.com",
          "x-forwarded-proto": "https",
        },
      }),
      { params: Promise.resolve({ provider: "google" }) },
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("redirect_uri")).toBe("https://app.corgtex.com/api/integrations/google/callback");
    expect(location.searchParams.get("scope")).toBe("openid email profile https://www.googleapis.com/auth/calendar.readonly");
    expect(location.searchParams.get("scope")).not.toContain("gmail.readonly");
    expect(location.searchParams.get("scope")).not.toContain("drive.readonly");
    expect(location.searchParams.get("scope")).not.toContain("drive.file");
    expect(location.searchParams.get("include_granted_scopes")).toBeNull();
    expect(createIntegrationOAuthState).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      intent: "calendar",
    });
    expect(response.headers.get("set-cookie")).toContain("corgtex_google_oauth_state=signed-state");
  });

  it("starts Google document OAuth only when the documents intent is requested", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("https://app.corgtex.com/api/integrations/google/connect?workspaceId=ws-1&intent=documents"),
      { params: Promise.resolve({ provider: "google" }) },
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("scope")).toBe("openid email profile https://www.googleapis.com/auth/drive.file");
    expect(location.searchParams.get("scope")).not.toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(location.searchParams.get("scope")).not.toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(location.searchParams.get("scope")).not.toContain("gmail.readonly");
    expect(location.searchParams.get("include_granted_scopes")).toBe("true");
    expect(createIntegrationOAuthState).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      intent: "documents",
    });
  });

  it("starts Microsoft OAuth with calendar read-only scope only for self-serve", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("https://app.corgtex.com/api/integrations/microsoft/connect?workspaceId=ws-1"),
      { params: Promise.resolve({ provider: "microsoft" }) },
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://login.microsoftonline.com");
    expect(location.pathname).toBe("/organizations/oauth2/v2.0/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe("https://app.corgtex.com/api/integrations/microsoft/callback");
    expect(location.searchParams.get("scope")).toBe("offline_access User.Read Calendars.Read");
    expect(location.searchParams.get("scope")).not.toContain("Mail.Read");
    expect(location.searchParams.get("scope")).not.toContain("Files.Read");
    expect(response.headers.get("set-cookie")).toContain("corgtex_microsoft_oauth_state=signed-state");
  });

  it("redirects missing provider config back to Tools with a safe error", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("https://app.corgtex.com/api/integrations/google/connect?workspaceId=ws-1"),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.headers.get("location")).toBe("https://app.corgtex.com/workspaces/ws-1/tools?type=CONNECTOR&q=google&integration=google&integrationStatus=error&integrationError=google_not_configured");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
