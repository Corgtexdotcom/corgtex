import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { requirePageActor, saveOAuthConnectionAndEnqueueCalendarSync } = vi.hoisted(() => ({
  requirePageActor: vi.fn(),
  saveOAuthConnectionAndEnqueueCalendarSync: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  saveOAuthConnectionAndEnqueueCalendarSync,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
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
      new NextRequest("http://localhost/api/integrations/google/callback?code=auth-code&state=user-1:ws-1"),
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
        scopes: ["calendar", "profile"],
      },
    );
    expect(response.headers.get("location")).toBe("http://localhost:3000/workspaces/ws-1/settings?success=google_connected");
  });
});
