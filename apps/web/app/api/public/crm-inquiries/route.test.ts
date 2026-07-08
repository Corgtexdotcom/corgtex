import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureCrmInquiryMock, checkRateLimitMock, capturePostHogEventMock } = vi.hoisted(() => ({
  captureCrmInquiryMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  capturePostHogEventMock: vi.fn(),
}));

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
  CRM_INQUIRY_PERSONAS: [
    "OWNER",
    "EMPLOYEE",
    "TRANSFORMER",
    "INVESTOR",
    "PARTNER",
    "GENERAL",
  ],
  captureCrmInquiry: captureCrmInquiryMock,
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    checkRateLimit: checkRateLimitMock,
  };
});

vi.mock("@/lib/posthog-server", () => ({
  capturePostHogEvent: capturePostHogEventMock,
}));

const originalWorkspaceSlug = process.env.WORKSPACE_SLUG;
const targetWorkspaceSlug = ["cr", "ina"].join("");
const targetCrmHost = `${targetWorkspaceSlug}.corgtex.com`;

function inquiryPayload(overrides: Record<string, unknown> = {}) {
  return {
    source: "corporate_rebels_website",
    sourceExternalId: "submission-123",
    persona: "OWNER",
    name: "Ava Chen",
    email: "ava@meridian.example",
    company: "Meridian Works",
    website: "https://meridian.example",
    message: "I want to talk about selling my business.",
    sourceUrl: "https://us.corporate-rebels.com/contact",
    consentToContact: true,
    honeypot: "",
    ...overrides,
  };
}

function crmInquiryRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  host = targetCrmHost,
) {
  return new Request(`https://${host}/api/public/crm-inquiries`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.55",
      ...headers,
    },
    body: JSON.stringify(body),
  }) as never;
}

function proxiedCrmInquiryRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  internalHost = "corgtex-web-production.internal",
) {
  return new Request(`https://${internalHost}/api/public/crm-inquiries`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.55",
      ...headers,
    },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/public/crm-inquiries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.WORKSPACE_SLUG = targetWorkspaceSlug;
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 9,
      limit: 10,
      resetAtMs: Date.now() + 60_000,
    });
    captureCrmInquiryMock.mockResolvedValue({
      duplicate: false,
      submissionId: "conv-1",
    });
  });

  afterEach(() => {
    if (originalWorkspaceSlug === undefined) {
      delete process.env.WORKSPACE_SLUG;
    } else {
      process.env.WORKSPACE_SLUG = originalWorkspaceSlug;
    }
  });

  it("accepts allowed Corporate Rebels browser origins", async () => {
    const { POST } = await import("./route");

    const response = await POST(crmInquiryRequest(inquiryPayload(), {
      origin: "https://us.corporate-rebels.com",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://us.corporate-rebels.com");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      duplicate: false,
      submissionId: "conv-1",
    });
    expect(captureCrmInquiryMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceSlug: targetWorkspaceSlug,
      source: "corporate_rebels_website",
      sourceExternalId: "submission-123",
      persona: "OWNER",
      email: "ava@meridian.example",
      consentToContact: true,
    }));
  });

  it("accepts Corporate Rebels browser origins when the deployed host is supplied by proxy headers", async () => {
    const { POST } = await import("./route");

    const response = await POST(proxiedCrmInquiryRequest(inquiryPayload(), {
      origin: "https://us.corporate-rebels.com",
      host: "corgtex-web-production.internal",
      "x-forwarded-host": targetCrmHost,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://us.corporate-rebels.com");
    expect(captureCrmInquiryMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceSlug: targetWorkspaceSlug,
      sourceExternalId: "submission-123",
    }));
  });

  it("rejects disallowed browser origins before CRM writes", async () => {
    const { POST } = await import("./route");

    const response = await POST(crmInquiryRequest(inquiryPayload(), {
      origin: "https://evil.example",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ORIGIN_NOT_ALLOWED",
        message: "Origin is not allowed.",
      },
    });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(captureCrmInquiryMock).not.toHaveBeenCalled();
  });

  it("rejects Corporate Rebels browser origins on other deployments before CRM writes", async () => {
    process.env.WORKSPACE_SLUG = "alumipres";
    const { POST } = await import("./route");

    const response = await POST(crmInquiryRequest(inquiryPayload(), {
      origin: "https://us.corporate-rebels.com",
    }, "alumipres.corgtex.com"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ORIGIN_NOT_ALLOWED",
        message: "Origin is not allowed.",
      },
    });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(captureCrmInquiryMock).not.toHaveBeenCalled();
  });

  it("does not let forwarded host override another public Corgtex deployment host", async () => {
    process.env.WORKSPACE_SLUG = "alumipres";
    const { POST } = await import("./route");

    const response = await POST(crmInquiryRequest(inquiryPayload(), {
      origin: "https://us.corporate-rebels.com",
      "x-forwarded-host": targetCrmHost,
    }, "alumipres.corgtex.com"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ORIGIN_NOT_ALLOWED",
        message: "Origin is not allowed.",
      },
    });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(captureCrmInquiryMock).not.toHaveBeenCalled();
  });

  it("accepts connector-style requests without browser origin on other Corgtex deployments", async () => {
    process.env.WORKSPACE_SLUG = "alumipres";
    const { POST } = await import("./route");

    const response = await POST(crmInquiryRequest(inquiryPayload({
      source: "partner_connector",
      sourceExternalId: "connector-123",
      persona: "PARTNER",
    }), {}, "alumipres.corgtex.com"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      ok: true,
      duplicate: false,
      submissionId: "conv-1",
    });
    expect(captureCrmInquiryMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceSlug: "alumipres",
      source: "partner_connector",
      sourceExternalId: "connector-123",
      persona: "PARTNER",
    }));
  });

  it("rejects non-empty honeypot submissions", async () => {
    const { POST } = await import("./route");

    const response = await POST(crmInquiryRequest(inquiryPayload({
      honeypot: "filled",
    }), {
      origin: "https://www.us.corporate-rebels.com",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "HONEYPOT_REJECTED",
        message: "Inquiry was rejected.",
      },
    });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(captureCrmInquiryMock).not.toHaveBeenCalled();
  });

  it("rejects rate-limited IPs before CRM writes", async () => {
    checkRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      limit: 10,
      resetAtMs: Date.now() + 30_000,
    });
    const { POST } = await import("./route");

    const response = await POST(crmInquiryRequest(inquiryPayload(), {
      origin: "https://us.corporate-rebels.com",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many CRM inquiry requests from this network.",
      },
    });
    expect(captureCrmInquiryMock).not.toHaveBeenCalled();
  });
});
