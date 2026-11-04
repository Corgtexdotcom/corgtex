import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordNewspaperLinkClickMock, resolveRequestActorMock } = vi.hoisted(() => ({
  recordNewspaperLinkClickMock: vi.fn(),
  resolveRequestActorMock: vi.fn(),
}));

class TestAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock("@corgtex/domain", () => ({
  AppError: TestAppError,
  recordNewspaperLinkClick: recordNewspaperLinkClickMock,
}));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: resolveRequestActorMock }));

describe("GET /api/newspaper/click/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestActorMock.mockResolvedValue({ kind: "user", user: { id: "u-1" } });
  });

  it("records the aggregate click and redirects to the stored target", async () => {
    recordNewspaperLinkClickMock.mockResolvedValue({ targetUrl: "https://example.com/report" });
    const { GET } = await import("./route");

    const response = await GET(new Request("https://app.example.com/api/newspaper/click/token-1") as any, {
      params: Promise.resolve({ token: "token-1" }),
    });

    expect(recordNewspaperLinkClickMock).toHaveBeenCalledWith({ kind: "user", user: { id: "u-1" } }, "token-1");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/report");
  });

  it("returns 404 for unknown or blocked tokens", async () => {
    recordNewspaperLinkClickMock.mockRejectedValue(new TestAppError(404, "NOT_FOUND", "Missing"));
    const { GET } = await import("./route");

    const response = await GET(new Request("https://app.example.com/api/newspaper/click/missing") as any, {
      params: Promise.resolve({ token: "missing" }),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it.each(["Missing session.", "Session expired."])("continues a signed-out click through login: %s", async (message) => {
    resolveRequestActorMock.mockRejectedValue(new TestAppError(401, "UNAUTHENTICATED", message));
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.example.com/api/newspaper/click/token-1") as any, {
      params: Promise.resolve({ token: "token-1" }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.example.com/login?next=%2Fapi%2Fnewspaper%2Fclick%2Ftoken-1");
    expect(recordNewspaperLinkClickMock).not.toHaveBeenCalled();
  });
  it.each([403, 404])("keeps authentication denial %s opaque", async (status) => {
    resolveRequestActorMock.mockRejectedValue(new TestAppError(status, "DENIED", "Denied"));
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.example.com/api/newspaper/click/token") as any, { params: Promise.resolve({ token: "token" }) });
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(recordNewspaperLinkClickMock).not.toHaveBeenCalled();
  });

  it("does not turn a domain authorization 401 into login continuation", async () => {
    recordNewspaperLinkClickMock.mockRejectedValue(new TestAppError(401, "DENIED", "Denied"));
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.example.com/api/newspaper/click/token") as any, { params: Promise.resolve({ token: "token" }) });
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects malformed decoded token paths instead of building a continuation", async () => {
    resolveRequestActorMock.mockRejectedValue(new TestAppError(401, "UNAUTHENTICATED", "Missing session"));
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.example.com/api/newspaper/click/token") as any, { params: Promise.resolve({ token: "token?next=https://evil.test" }) });
    expect(response.status).toBe(404);
    expect(recordNewspaperLinkClickMock).not.toHaveBeenCalled();
  });

  it("preserves operational authentication errors instead of treating them as signed-out", async () => {
    const error = new TestAppError(503, "SESSION_UNAVAILABLE", "Try again");
    resolveRequestActorMock.mockRejectedValue(error);
    const { GET } = await import("./route");
    await expect(GET(new Request("https://app.example.com/api/newspaper/click/token") as any, { params: Promise.resolve({ token: "token" }) })).rejects.toBe(error);
    expect(recordNewspaperLinkClickMock).not.toHaveBeenCalled();
  });

});
