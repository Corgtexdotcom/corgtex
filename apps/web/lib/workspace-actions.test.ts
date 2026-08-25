import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { redirectMock, requirePageActorMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(),
  requirePageActorMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor: requirePageActorMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("APP_URL", "https://customer-alpha.corgtex.test");
  vi.stubEnv("WORKSPACE_SLUG", "customer-alpha");
  requirePageActorMock.mockResolvedValue({
    kind: "user",
    user: {
      id: "user-1",
      email: "user@example.com",
      displayName: "User",
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("createWorkspaceAction", () => {
  it("inherits the domain guard for a foreign dedicated-deployment slug", async () => {
    const formData = new FormData();
    formData.set("name", "Foreign Workspace");
    formData.set("slug", "foreign-workspace");

    const { createWorkspaceAction } = await import("./workspace-actions");

    await expect(createWorkspaceAction(formData)).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_SCOPE_MISMATCH",
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
