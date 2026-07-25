import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  findEnterpriseAccountsForEmail,
  rateLimitAuth,
} = vi.hoisted(() => ({
  findEnterpriseAccountsForEmail: vi.fn(),
  rateLimitAuth: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  findEnterpriseAccountsForEmail,
}));

vi.mock("@/lib/rate-limit-middleware", () => ({
  rateLimitAuth,
}));

vi.mock("@/lib/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http")>();
  return {
    ...actual,
    handleRouteError: (error: Error & { status?: number; code?: string }) => Response.json({
      error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
    }, { status: error.status ?? 500 }),
  };
});

function discoveryRequest(email: string) {
  return new NextRequest("https://customer-alpha.corgtex.test/api/auth/enterprise-accounts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("APP_URL", "https://customer-alpha.corgtex.test");
  vi.stubEnv("WORKSPACE_SLUG", "customer-alpha");
  rateLimitAuth.mockResolvedValue(null);
  findEnterpriseAccountsForEmail.mockResolvedValue({
    email: "user@example.com",
    matches: [
      {
        slug: "corgtex-validation",
        label: "Corgtex Internal Validation",
        loginUrl: "https://app.corgtex.com/login?email=user%40example.com",
        source: "central_membership",
        matchKind: "exact_email",
        workspaceId: "ws-validation",
      },
      {
        slug: "customer-alpha",
        label: "Customer Alpha",
        loginUrl: "https://customer-alpha.corgtex.test/login?email=user%40example.com",
        source: "directory",
        matchKind: "email_domain",
      },
    ],
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/auth/enterprise-accounts", () => {
  it("returns only the configured workspace on dedicated customer deployments", async () => {
    const { POST } = await import("./route");
    const response = await POST(discoveryRequest("user@example.com"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      email: "user@example.com",
      matches: [
        {
          slug: "customer-alpha",
          label: "Customer Alpha",
          loginUrl: "https://customer-alpha.corgtex.test/login?email=user%40example.com",
          source: "directory",
          matchKind: "email_domain",
        },
      ],
    });
  });
});
