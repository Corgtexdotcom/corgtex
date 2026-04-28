import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicOrigin, getPublicRequestUrl } from "./public-origin";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getPublicOrigin", () => {
  it("prefers the configured public app URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://app.corgtex.com");

    const request = new Request("https://0.0.0.0:8080/.well-known/oauth-authorization-server", {
      headers: {
        host: "internal:8080",
      },
    });

    expect(getPublicOrigin(request)).toBe("https://app.corgtex.com");
  });

  it("prefers a public request host over the configured app URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://app.corgtex.com");

    const request = new Request("https://0.0.0.0:8080/mcp", {
      headers: {
        host: "mcp.corgtex.com",
      },
    });

    expect(getPublicOrigin(request)).toBe("https://mcp.corgtex.com");
  });

  it("ignores internal configured origins in production and falls back to forwarded headers", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://0.0.0.0:8080");

    const request = new Request("https://0.0.0.0:8080/.well-known/oauth-authorization-server", {
      headers: {
        "x-forwarded-host": "app.corgtex.com, internal:8080",
        "x-forwarded-proto": "https, http",
      },
    });

    expect(getPublicOrigin(request)).toBe("https://app.corgtex.com");
  });

  it("falls back to the host header when proxy host headers are absent", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://0.0.0.0:8080");

    const request = new Request("https://0.0.0.0:8080/mcp", {
      headers: {
        host: "app.corgtex.com",
      },
    });

    expect(getPublicOrigin(request)).toBe("https://app.corgtex.com");
  });

  it("builds a public request URL while preserving path and query", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://0.0.0.0:8080");

    const request = new Request("https://0.0.0.0:8080/api/mcp?session=abc", {
      headers: {
        host: "app.corgtex.com",
      },
    });

    expect(getPublicRequestUrl(request)).toBe("https://app.corgtex.com/api/mcp?session=abc");
  });
});
