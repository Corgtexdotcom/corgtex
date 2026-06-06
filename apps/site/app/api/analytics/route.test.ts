import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { capturePostHogEvent } = vi.hoisted(() => ({
  capturePostHogEvent: vi.fn(),
}));

vi.mock("../../../lib/posthog-server", () => ({
  capturePostHogEvent,
}));

describe("POST /api/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturePostHogEvent.mockResolvedValue({ status: "disabled" });
  });

  it("accepts valid website analytics and mirrors the event to PostHog when enabled", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/analytics", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Referer": "https://corgtex.com/en",
          "User-Agent": "Test Browser",
        },
        body: JSON.stringify({
          anonymousId: "anon-123",
          name: "website_pageview",
          path: "/en",
          href: "https://corgtex.com/en",
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(capturePostHogEvent).toHaveBeenCalledWith({
      event: "corgtex_site_website_pageview",
      distinctId: "site:anon-123",
      properties: expect.objectContaining({
        anonymousId: "anon-123",
        href: "https://corgtex.com/en",
        name: "website_pageview",
        path: "/en",
        referer: "https://corgtex.com/en",
        surface: "website",
        userAgent: "Test Browser",
      }),
      timestamp: expect.any(String),
    });
  });

  it("rejects payloads without an event name before touching PostHog", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/en" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(capturePostHogEvent).not.toHaveBeenCalled();
  });
});
