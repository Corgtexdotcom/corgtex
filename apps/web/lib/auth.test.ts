import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((location: string) => {
  throw new Error(`redirect:${location}`);
});
const notFound = vi.fn(() => {
  throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
});
const cookies = vi.fn();
const headers = vi.fn();
const requireWorkspaceMembership = vi.fn();
const getWorkspaceSupportGrant = vi.fn();
const clearSession = vi.fn();
const resolveAgentActorFromBearer = vi.fn();
const resolveControlPlaneAgentFromBearer = vi.fn();
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
  notFound,
}));

vi.mock("next/headers", () => ({
  cookies,
  headers,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  clearSession,
  resolveAgentActorFromBearer,
  resolveControlPlaneAgentFromBearer,
  resolveSessionActor,
  requireWorkspaceMembership,
  getWorkspaceSupportGrant,
  isGlobalOperator: vi.fn().mockReturnValue(false),
}));

vi.mock("@corgtex/shared", () => ({
  beginAuthorizationContext: vi.fn(),
  setSupportAuthorizationActor: vi.fn(),
  env: { CONTROL_PLANE_MODE: false },
  isDatabaseUnavailableError,
  sessionCookieName: () => "corgtex_session",
}));

beforeEach(() => {
  vi.resetModules();
  isDatabaseUnavailableError.mockReturnValue(false);
  headers.mockResolvedValue(new Headers());
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("requirePageActor", () => {
  describe("workspace page access", () => {
    const actor = { kind: "user", user: { id: "viewer", email: "viewer@example.test" } };
    beforeEach(() => {
      cookies.mockResolvedValue({ get: () => ({ value: "token" }) });
      resolveSessionActor.mockResolvedValue(actor);
      getWorkspaceSupportGrant.mockResolvedValue(null);
      requireWorkspaceMembership.mockResolvedValue({ isActive: true, role: "CONTRIBUTOR" });
    });

    it.each([
      ["/en/workspaces/inaccessible/brain", {}],
      ["/es/workspaces/nonexistent/meetings", {}],
      ["/en/workspaces/stale-membership/actions", { rsc: "1", "next-router-state-tree": "synthetic-navigation" }],
    ])("uses the same 404 for inaccessible, missing and stale navigation: %s", async (pathname, navigationHeaders) => {
      headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": pathname, ...navigationHeaders }));
      requireWorkspaceMembership.mockRejectedValue(new MockAppError(403, "NOT_A_MEMBER", "Private denial details"));
      const { requirePageActor } = await import("./auth");
      await expect(requirePageActor()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(notFound).toHaveBeenCalledOnce();
      expect(redirect).not.toHaveBeenCalled();
    });

    it.each(["WORKSPACE_SCOPE_MISMATCH", "FORBIDDEN", "SUPPORT_CONTENT_RESTRICTED", "SUPPORT_AUTHORIZATION_REVOKED", "AGENT_WORKSPACE_SCOPE_REQUIRED"])("hides known membership denial %s", async (code) => {
      headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": "/en/workspaces/other" }));
      requireWorkspaceMembership.mockRejectedValue(new MockAppError(403, code, "Denied"));
      const { requirePageActor } = await import("./auth");
      await expect(requirePageActor()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    });

    it.each([new Error("database unavailable"), new MockAppError(503, "SERVICE_UNAVAILABLE", "Unavailable"), new MockAppError(403, "UPSTREAM_FORBIDDEN", "Backend credentials rejected"), new MockAppError(500, "NOT_A_MEMBER", "Unexpected failure")])("preserves backend failures: %s", async (error) => {
      headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": "/en/workspaces/ws-a" }));
      requireWorkspaceMembership.mockRejectedValue(error);
      const { requirePageActor } = await import("./auth");
      await expect(requirePageActor()).rejects.toBe(error);
      expect(notFound).not.toHaveBeenCalled();
    });

    it.each([false, true])("retains login redirect for missing/expired sessions (expired=%s)", async (expired) => {
      cookies.mockResolvedValue({ get: () => expired ? { value: "expired" } : undefined });
      resolveSessionActor.mockResolvedValue(null);
      const { requirePageActor } = await import("./auth");
      await expect(requirePageActor()).rejects.toThrow("redirect:/login");
      expect(requireWorkspaceMembership).not.toHaveBeenCalled();
      expect(notFound).not.toHaveBeenCalled();
    });

    it("retains the domain denial for server actions", async () => {
      headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": "/en/workspaces/ws-a", "next-action": "synthetic-action" }));
      const error = new MockAppError(403, "NOT_A_MEMBER", "Denied");
      requireWorkspaceMembership.mockRejectedValue(error);
      const { requirePageActor } = await import("./auth");
      await expect(requirePageActor()).rejects.toBe(error);
      expect(notFound).not.toHaveBeenCalled();
    });

    it("retains the domain denial for API reads", async () => {
      const error = new MockAppError(403, "NOT_A_MEMBER", "Denied");
      requireWorkspaceMembership.mockRejectedValue(error);
      const { resolveRequestActor } = await import("./auth");
      await expect(resolveRequestActor({
        method: "GET", headers: new Headers(), cookies: { get: () => ({ value: "token" }) },
        nextUrl: { pathname: "/api/workspaces/ws-a/actions" },
      } as never)).rejects.toBe(error);
      expect(notFound).not.toHaveBeenCalled();
    });

    it("rechecks access after a membership is revoked", async () => {
      headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": "/en/workspaces/ws-a/brain" }));
      const { requirePageActor } = await import("./auth");
      await expect(requirePageActor()).resolves.toBe(actor);
      requireWorkspaceMembership.mockRejectedValue(new MockAppError(403, "NOT_A_MEMBER", "Revoked"));
      await expect(requirePageActor()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(requireWorkspaceMembership).toHaveBeenCalledTimes(2);
    });
  });

  it("redirects Setup before a server-rendered workspace caller can read content", async () => {
    cookies.mockResolvedValue({ get: () => ({ value: "token" }) });
    resolveSessionActor.mockResolvedValue({ kind: "user", user: { id: "support", isSupportAccount: true } });
    headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": "/en/workspaces/ws-1/brain" }));
    getWorkspaceSupportGrant.mockResolvedValue({ isActive: true, role: "SETUP" });
    const { requirePageActor } = await import("./auth");
    await expect(requirePageActor()).rejects.toThrow("redirect:/support/ws-1");
    expect(requireWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("rejects replayed server actions even when sent to the setup shell", async () => {
    cookies.mockResolvedValue({ get: () => ({ value: "token" }) });
    resolveSessionActor.mockResolvedValue({ kind: "user", user: { id: "support", isSupportAccount: true } });
    headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": "/support/ws-1", "next-action": "action-id" }));
    const { requirePageActor } = await import("./auth");
    await expect(requirePageActor()).rejects.toMatchObject({ code: "SUPPORT_ACCESS_RESTRICTED" });
  });

  it("fails closed on missing page-path context", async () => {
    cookies.mockResolvedValue({ get: () => ({ value: "token" }) });
    resolveSessionActor.mockResolvedValue({ kind: "user", user: { id: "support", isSupportAccount: true } });
    const { requirePageActor } = await import("./auth");
    await expect(requirePageActor()).rejects.toMatchObject({ code: "AUTHORIZATION_CONTEXT_REQUIRED" });
  });
  it("retains ordinary workspace A access even when the user has support access elsewhere", async () => {
    const actor = { kind: "user", user: { id: "support", isSupportAccount: true } };
    cookies.mockResolvedValue({ get: () => ({ value: "token" }) });
    resolveSessionActor.mockResolvedValue(actor);
    headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": "/en/workspaces/ws-a/brain" }));
    getWorkspaceSupportGrant.mockResolvedValue(null);
    requireWorkspaceMembership.mockResolvedValue({ role: "ADMIN" });
    const { requirePageActor } = await import("./auth");
    await expect(requirePageActor()).resolves.toEqual(actor);
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor, workspaceId: "ws-a" });
  });
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

  it("redirects to the friendly unavailable state when session lookup times out", async () => {
    vi.useFakeTimers();
    cookies.mockResolvedValue({
      get: () => ({ value: "session-token" }),
    });
    resolveSessionActor.mockReturnValue(new Promise(() => undefined));
    isDatabaseUnavailableError.mockReturnValue(false);

    const { requirePageActor } = await import("./auth");
    const result = expect(requirePageActor()).rejects.toThrow("redirect:/login?error=session-unavailable");
    await vi.advanceTimersByTimeAsync(15_000);

    await result;
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

describe("public demo write fence", () => {
  const actor = { kind: "user", user: { id: "demo", email: "demo@jnj-demo.corgtex.app" } };

  it("rejects direct API mutations for the public identity", async () => {
    resolveSessionActor.mockResolvedValue(actor);
    const { resolveRequestActor } = await import("./auth");
    const request = {
      method: "POST",
      headers: new Headers(),
      cookies: { get: () => ({ value: "token" }) },
      nextUrl: { pathname: "/api/workspaces/demo/actions" },
    };
    await expect(resolveRequestActor(request as never)).rejects.toMatchObject({ code: "DEMO_MODE" });
  });

  it.each(["/api/oauth/authorize", "/api/integrations/google/callback", "/oauth/authorize"])("rejects page-auth credential routes %s", async (pathname) => {
    cookies.mockResolvedValue({ get: () => ({ value: "token" }) });
    resolveSessionActor.mockResolvedValue(actor);
    headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": pathname }));
    const { requirePageActor } = await import("./auth");
    await expect(requirePageActor()).rejects.toMatchObject({ code: "DEMO_MODE" });
  });

  it.each(["/api/integrations/google/connect", "/api/workspaces/demo/intercom-token", "/api/workspaces/demo/onboarding/google-drive"])("rejects GET side effects %s", async (pathname) => {
    resolveSessionActor.mockResolvedValue(actor);
    const { resolveRequestActor } = await import("./auth");
    const request = { method: "GET", headers: new Headers(), cookies: { get: () => ({ value: "token" }) }, nextUrl: { pathname } };
    await expect(resolveRequestActor(request as never)).rejects.toMatchObject({ code: "DEMO_MODE" });
  });

  it("rejects replayed server actions for the public identity", async () => {
    cookies.mockResolvedValue({ get: () => ({ value: "token" }) });
    resolveSessionActor.mockResolvedValue(actor);
    headers.mockResolvedValue(new Headers({ "x-corgtex-pathname": "/en/workspaces/demo", "next-action": "id" }));
    const { requirePageActor } = await import("./auth");
    await expect(requirePageActor()).rejects.toMatchObject({ code: "DEMO_MODE" });
  });
});
