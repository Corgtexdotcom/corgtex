import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ login: vi.fn(), workspaces: vi.fn(), clear: vi.fn() }));
vi.mock("@corgtex/domain", () => ({
  loginUserWithPassword: mocks.login,
  listActorWorkspaces: mocks.workspaces,
  clearSession: mocks.clear,
}));
vi.mock("@corgtex/shared", () => ({ sessionCookieName: () => "session" }));

import { issueDemoSession } from "./demo-session";

describe("demo session tenant isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.login.mockResolvedValue({ user: { id: "demo-user", globalRole: "USER" }, token: "token", expiresAt: new Date("2027-01-01") });
  });

  it("opens the exact dedicated demo workspace", async () => {
    mocks.workspaces.mockResolvedValue([{ id: "demo", slug: "jnj-demo" }]);
    await expect(issueDemoSession()).resolves.toMatchObject({ workspaceId: "demo" });
  });

  it("refuses global operators even with a single demo workspace", async () => {
    mocks.login.mockResolvedValue({ user: { id: "operator", globalRole: "OPERATOR" }, token: "token" });
    mocks.workspaces.mockResolvedValue([{ id: "demo", slug: "jnj-demo" }]);
    await expect(issueDemoSession()).rejects.toThrow("exclusively");
    expect(mocks.clear).toHaveBeenCalledWith("token");
  });

  it.each([
    { workspaces: [] },
    { workspaces: [{ id: "customer", slug: "customer" }] },
    { workspaces: [{ id: "demo", slug: "jnj-demo" }, { id: "customer", slug: "customer" }] },
  ])("refuses missing demo or an account with other workspace access: %j", async ({ workspaces }) => {
    mocks.workspaces.mockResolvedValue(workspaces);
    await expect(issueDemoSession()).rejects.toThrow("exclusively");
    expect(mocks.clear).toHaveBeenCalledWith("token");
  });
});
