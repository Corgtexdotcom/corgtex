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

  it("does not redirect when the caller has no current session", async () => {
    resolveRequestActorMock.mockRejectedValue(new TestAppError(401, "AUTH_REQUIRED", "Sign in required."));
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.example.com/api/newspaper/click/token-1") as any, {
      params: Promise.resolve({ token: "token-1" }),
    });
    expect(response.status).toBe(404);
    expect(recordNewspaperLinkClickMock).not.toHaveBeenCalled();
  });
});
