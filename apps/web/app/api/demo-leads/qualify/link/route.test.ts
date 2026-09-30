import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ checkLink: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ checkQualificationLink: mocks.checkLink }));
vi.mock("@/lib/rate-limit-middleware", () => ({ rateLimitAuth: mocks.rateLimit }));
vi.mock("@/lib/http", () => ({
  handleRouteError: (error: { status: number; code: string; message: string }) => NextResponse.json({
    error: { code: error.code, message: error.message },
  }, { status: error.status }),
}));

import { OPTIONS, POST } from "./route";

function request(body: unknown) {
  return new NextRequest("https://selfserve.corgtex.com/api/demo-leads/qualify/link", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue(null);
  mocks.checkLink.mockResolvedValue({ available: true });
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://corgtex.com/");
});
afterEach(() => vi.unstubAllEnvs());

describe("public qualification link check", () => {
  it("returns availability only with scoped CORS and no caching", async () => {
    const response = await POST(request({ token: " synthetic-token ", email: "ignored@example.invalid" }));
    expect(await response.json()).toEqual({ available: true });
    expect(mocks.checkLink).toHaveBeenCalledExactlyOnceWith("synthetic-token");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://corgtex.com");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await OPTIONS()).status).toBe(204);
  });

  it.each([{}, { token: "" }, { token: 4 }, { token: "x".repeat(129) }])("rejects missing or oversized tokens before lookup", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(410);
    expect((await response.json()).error.code).toBe("QUALIFICATION_LINK_UNAVAILABLE");
    expect(mocks.checkLink).not.toHaveBeenCalled();
  });

  it("keeps rate limits and unavailable errors distinct from valid links", async () => {
    mocks.rateLimit.mockResolvedValueOnce(NextResponse.json({ error: "Rate limited" }, { status: 429 }));
    expect((await POST(request({ token: "synthetic-token" }))).status).toBe(429);
    expect(mocks.checkLink).not.toHaveBeenCalled();
    mocks.checkLink.mockRejectedValueOnce({ status: 410, code: "QUALIFICATION_LINK_UNAVAILABLE", message: "Link unavailable" });
    const response = await POST(request({ token: "retired-token" }));
    expect(response.status).toBe(410);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://corgtex.com");
    expect((await response.json()).error.code).toBe("QUALIFICATION_LINK_UNAVAILABLE");
  });
});
