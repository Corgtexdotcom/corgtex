import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      SESSION_COOKIE_SECRET: "test-session-secret",
    },
    randomOpaqueToken: vi.fn(() => "nonce"),
  };
});

describe("OAuth state", () => {
  it("round-trips signed state for the expected user", async () => {
    const { createIntegrationOAuthState, verifyIntegrationOAuthState } = await import("./oauth-state");

    const state = createIntegrationOAuthState({
      userId: "user-1",
      workspaceId: "ws-1",
    });

    expect(verifyIntegrationOAuthState(state, "user-1")).toEqual({
      userId: "user-1",
      workspaceId: "ws-1",
    });
  });

  it("rejects tampered state", async () => {
    const { createIntegrationOAuthState, verifyIntegrationOAuthState } = await import("./oauth-state");
    const state = createIntegrationOAuthState({
      userId: "user-1",
      workspaceId: "ws-1",
    });
    const [payload] = state.split(".");

    expect(() => verifyIntegrationOAuthState(`${payload}.bad`, "user-1")).toThrow("OAuth state is invalid.");
  });
});
