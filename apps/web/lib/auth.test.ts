import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((location: string) => {
  throw new Error(`redirect:${location}`);
});
const cookies = vi.fn();
const clearSession = vi.fn();
const resolveAgentActorFromBearer = vi.fn();
const resolveSessionActor = vi.fn();
const isDatabaseUnavailableError = vi.fn();

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

vi.mock("next/headers", () => ({
  cookies,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  clearSession,
  resolveAgentActorFromBearer,
  resolveSessionActor,
}));

vi.mock("@corgtex/shared", () => ({
  isDatabaseUnavailableError,
  sessionCookieName: () => "corgtex_session",
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("requirePageActor", () => {
  it("redirects to the friendly unavailable state when session lookup fails because the database is down", async () => {
    cookies.mockResolvedValue({
      get: () => ({ value: "session-token" }),
    });
    resolveSessionActor.mockRejectedValue(new Error("db down"));
    isDatabaseUnavailableError.mockReturnValue(true);

    const { requirePageActor } = await import("./auth");

    await expect(requirePageActor()).rejects.toThrow("redirect:/login?error=session-unavailable");
    expect(redirect).toHaveBeenCalledWith("/login?error=session-unavailable");
  });
});

describe("resolveRequestActor", () => {
  it("throws a 503 AppError when session lookup fails because the database is down", async () => {
    resolveSessionActor.mockRejectedValue(new Error("db down"));
    isDatabaseUnavailableError.mockReturnValue(true);

    const { resolveRequestActor } = await import("./auth");

    await expect(
      resolveRequestActor({
        headers: {
          get: () => null,
        },
        cookies: {
          get: () => ({ value: "session-token" }),
        },
      } as never),
    ).rejects.toMatchObject({
      status: 503,
      code: "SESSION_UNAVAILABLE",
      message: "Session is temporarily unavailable. Try again.",
    });
  });
});
