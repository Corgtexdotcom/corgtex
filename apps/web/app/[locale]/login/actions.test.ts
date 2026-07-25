import { afterEach, describe, expect, it, vi } from "vitest";

const loginUserWithPassword = vi.fn();
const listActorWorkspaces = vi.fn();
const setSessionCookie = vi.fn();

class MockAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  isGlobalOperator: (actor: { kind: string, user: { globalRole?: string | null } }) => (
    actor.kind === "user" && actor.user.globalRole === "OPERATOR"
  ),
  listActorWorkspaces,
  loginUserWithPassword,
}));

vi.mock("@/lib/auth", () => ({
  setSessionCookie,
}));

function buildFormData(email: string, password: string, locale = "en") {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("password", password);
  formData.set("locale", locale);
  return formData;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("loginAction", () => {
  it("returns an inline auth error for invalid credentials", async () => {
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    loginUserWithPassword.mockRejectedValue(
      new MockAppError(401, "UNAUTHENTICATED", "Invalid email or password."),
    );

    await expect(
      loginAction(initialLoginActionState, buildFormData("User@Example.com ", "password123")),
    ).resolves.toEqual({
      email: "user@example.com",
      error: "Invalid email or password.",
      redirectTo: null,
    });

    expect(listActorWorkspaces).not.toHaveBeenCalled();
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it("returns a retryable inline error when login takes longer than the timeout", async () => {
    vi.useFakeTimers();
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    loginUserWithPassword.mockReturnValue(new Promise(() => undefined));

    const result = loginAction(initialLoginActionState, buildFormData("ops@example.com", "password123"));
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(result).resolves.toEqual({
      email: "ops@example.com",
      error: "Login timed out. Try again.",
      redirectTo: null,
    });
    expect(listActorWorkspaces).not.toHaveBeenCalled();
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it("returns a generic inline error for operational failures", async () => {
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    loginUserWithPassword.mockRejectedValue(new Error("database unavailable"));

    await expect(
      loginAction(initialLoginActionState, buildFormData("ops@example.com", "password123")),
    ).resolves.toEqual({
      email: "ops@example.com",
      error: "Login is temporarily unavailable. Try again.",
      redirectTo: null,
    });

    expect(consoleError).toHaveBeenCalledWith("Login action failed.", expect.any(Error));
  });

  it("sets the session cookie and returns the first workspace redirect after a successful login", async () => {
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    const expiresAt = new Date("2026-04-03T00:00:00.000Z");
    loginUserWithPassword.mockResolvedValue({
      token: "session-token",
      expiresAt,
      user: {
        id: "user-1",
        email: "admin@example.com",
        displayName: "Admin",
        globalRole: null,
      },
    });
    listActorWorkspaces.mockResolvedValue([
      {
        id: "workspace-1",
      },
    ]);

    await expect(
      loginAction(initialLoginActionState, buildFormData("admin@example.com", "password123")),
    ).resolves.toEqual({
      email: "admin@example.com",
      error: null,
      redirectTo: "/workspaces/workspace-1",
    });

    expect(setSessionCookie).toHaveBeenCalledWith("session-token", expiresAt);
  });

  it("localizes the workspace redirect for Spanish login", async () => {
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    const expiresAt = new Date("2026-04-03T00:00:00.000Z");
    loginUserWithPassword.mockResolvedValue({
      token: "session-token",
      expiresAt,
      user: {
        id: "user-1",
        email: "admin@example.com",
        displayName: "Admin",
        globalRole: null,
      },
    });
    listActorWorkspaces.mockResolvedValue([
      {
        id: "workspace-1",
      },
    ]);

    await expect(
      loginAction(initialLoginActionState, buildFormData("admin@example.com", "password123", "es")),
    ).resolves.toEqual({
      email: "admin@example.com",
      error: null,
      redirectTo: "/es/workspaces/workspace-1",
    });

    expect(setSessionCookie).toHaveBeenCalledWith("session-token", expiresAt);
  });

  it("sends users with multiple workspaces to account selection", async () => {
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    const expiresAt = new Date("2026-04-03T00:00:00.000Z");
    loginUserWithPassword.mockResolvedValue({
      token: "session-token",
      expiresAt,
      user: {
        id: "user-1",
        email: "admin@example.com",
        displayName: "Admin",
        globalRole: null,
      },
    });
    listActorWorkspaces.mockResolvedValue([
      {
        id: "workspace-1",
      },
      {
        id: "workspace-2",
      },
    ]);

    await expect(
      loginAction(initialLoginActionState, buildFormData("admin@example.com", "password123")),
    ).resolves.toEqual({
      email: "admin@example.com",
      error: null,
      redirectTo: "/find-account",
    });

    expect(setSessionCookie).toHaveBeenCalledWith("session-token", expiresAt);
  });

  it("uses the configured customer workspace instead of account selection on dedicated deployments", async () => {
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    const expiresAt = new Date("2026-04-03T00:00:00.000Z");
    vi.stubEnv("APP_URL", "https://crina.corgtex.com");
    vi.stubEnv("WORKSPACE_SLUG", "crina");
    loginUserWithPassword.mockResolvedValue({
      token: "session-token",
      expiresAt,
      user: {
        id: "operator-1",
        email: "operator@example.com",
        displayName: "Operator",
        globalRole: "OPERATOR",
      },
    });
    listActorWorkspaces.mockResolvedValue([
      {
        id: "ws-validation",
        slug: "corgtex-validation",
      },
      {
        id: "ws-crina",
        slug: "crina",
      },
    ]);

    await expect(
      loginAction(initialLoginActionState, buildFormData("operator@example.com", "password123")),
    ).resolves.toEqual({
      email: "operator@example.com",
      error: null,
      redirectTo: "/workspaces/ws-crina",
    });

    expect(setSessionCookie).toHaveBeenCalledWith("session-token", expiresAt);
  });

  it("localizes the account selection redirect for Spanish users with multiple workspaces", async () => {
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    const expiresAt = new Date("2026-04-03T00:00:00.000Z");
    loginUserWithPassword.mockResolvedValue({
      token: "session-token",
      expiresAt,
      user: {
        id: "user-1",
        email: "admin@example.com",
        displayName: "Admin",
        globalRole: null,
      },
    });
    listActorWorkspaces.mockResolvedValue([
      {
        id: "workspace-1",
      },
      {
        id: "workspace-2",
      },
    ]);

    await expect(
      loginAction(initialLoginActionState, buildFormData("admin@example.com", "password123", "es")),
    ).resolves.toEqual({
      email: "admin@example.com",
      error: null,
      redirectTo: "/es/find-account",
    });

    expect(setSessionCookie).toHaveBeenCalledWith("session-token", expiresAt);
  });

  it("sends operators to their workspace on the normal app deployment", async () => {
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    const expiresAt = new Date("2026-04-03T00:00:00.000Z");
    vi.stubEnv("CONTROL_PLANE_MODE", "false");
    loginUserWithPassword.mockResolvedValue({
      token: "operator-session-token",
      expiresAt,
      user: {
        id: "operator-1",
        email: "operator@example.com",
        displayName: "Operator",
        globalRole: "OPERATOR",
      },
    });
    listActorWorkspaces.mockResolvedValue([
      {
        id: "workspace-1",
      },
    ]);

    await expect(
      loginAction(initialLoginActionState, buildFormData("operator@example.com", "password123", "es")),
    ).resolves.toEqual({
      email: "operator@example.com",
      error: null,
      redirectTo: "/es/workspaces/workspace-1",
    });

    expect(listActorWorkspaces).toHaveBeenCalled();
    expect(setSessionCookie).toHaveBeenCalledWith("operator-session-token", expiresAt);
  });

  it("sets the session cookie and returns the localized control plane redirect for operators in control-plane mode", async () => {
    const { loginAction } = await import("./actions");
    const { initialLoginActionState } = await import("./state");
    const expiresAt = new Date("2026-04-03T00:00:00.000Z");
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    loginUserWithPassword.mockResolvedValue({
      token: "operator-session-token",
      expiresAt,
      user: {
        id: "operator-1",
        email: "operator@example.com",
        displayName: "Operator",
        globalRole: "OPERATOR",
      },
    });

    await expect(
      loginAction(initialLoginActionState, buildFormData("operator@example.com", "password123", "es")),
    ).resolves.toEqual({
      email: "operator@example.com",
      error: null,
      redirectTo: "/es/control-plane",
    });

    expect(listActorWorkspaces).not.toHaveBeenCalled();
    expect(setSessionCookie).toHaveBeenCalledWith("operator-session-token", expiresAt);
  });
});
