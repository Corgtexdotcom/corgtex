import { afterEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((location: string) => {
  throw new Error(`redirect:${location}`);
});
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

vi.mock("next/navigation", () => ({
  redirect,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  listActorWorkspaces,
  loginUserWithPassword,
}));

vi.mock("@/lib/auth", () => ({
  setSessionCookie,
}));

function buildFormData(email: string, password: string) {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("password", password);
  return formData;
}

afterEach(() => {
  vi.clearAllMocks();
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
    });

    expect(consoleError).toHaveBeenCalledWith("Login action failed.", expect.any(Error));
  });

  it("sets the session cookie and redirects after a successful login", async () => {
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
      },
    });
    listActorWorkspaces.mockResolvedValue([
      {
        id: "workspace-1",
      },
    ]);

    await expect(
      loginAction(initialLoginActionState, buildFormData("admin@example.com", "password123")),
    ).rejects.toThrow("redirect:/workspaces/workspace-1");

    expect(setSessionCookie).toHaveBeenCalledWith("session-token", expiresAt);
    expect(redirect).toHaveBeenCalledWith("/workspaces/workspace-1");
  });
});
