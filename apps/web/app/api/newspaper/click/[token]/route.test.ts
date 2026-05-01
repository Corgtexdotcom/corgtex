import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordNewspaperLinkClickMock } = vi.hoisted(() => ({
  recordNewspaperLinkClickMock: vi.fn(),
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

describe("GET /api/newspaper/click/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the aggregate click and redirects to the stored target", async () => {
    recordNewspaperLinkClickMock.mockResolvedValue({ targetUrl: "https://example.com/report" });
    const { GET } = await import("./route");

    const response = await GET(new Request("https://app.example.com/api/newspaper/click/token-1") as any, {
      params: Promise.resolve({ token: "token-1" }),
    });

    expect(recordNewspaperLinkClickMock).toHaveBeenCalledWith("token-1");
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
});
