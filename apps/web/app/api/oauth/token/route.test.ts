import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  exchangeAuthorizationCodeMock,
  exchangeMcpAuthorizationCodeMock,
  getMcpOAuthClientByClientIdMock,
  refreshAccessTokenMock,
  refreshMcpAccessTokenMock,
} = vi.hoisted(() => ({
  exchangeAuthorizationCodeMock: vi.fn(),
  exchangeMcpAuthorizationCodeMock: vi.fn(),
  getMcpOAuthClientByClientIdMock: vi.fn(),
  refreshAccessTokenMock: vi.fn(),
  refreshMcpAccessTokenMock: vi.fn(),
}));

class MockAppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  exchangeAuthorizationCode: exchangeAuthorizationCodeMock,
  exchangeMcpAuthorizationCode: exchangeMcpAuthorizationCodeMock,
  getMcpOAuthClientByClientId: getMcpOAuthClientByClientIdMock,
  refreshAccessToken: refreshAccessTokenMock,
  refreshMcpAccessToken: refreshMcpAccessTokenMock,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

describe("OAuth token route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid_grant for bad MCP refresh tokens", async () => {
    getMcpOAuthClientByClientIdMock.mockResolvedValueOnce({ id: "client-db-1" });
    refreshMcpAccessTokenMock.mockRejectedValueOnce(
      new MockAppError(401, "UNAUTHENTICATED", "Invalid or revoked refresh token."),
    );

    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://app.test/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "mcp_client_test",
        refresh_token: "mcp_rt_bad",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: "invalid_grant",
      error_description: "Invalid or revoked refresh token.",
    });
  });
});
