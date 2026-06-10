import { describe, expect, it } from "vitest";

import {
  buildAzureSelfServeDomainReadiness,
  validateAzureSelfServeDomainReadiness,
} from "./azure-selfserve-domain-readiness.mjs";

const COMPLETE_ENV = {
  APP_URL: "https://selfserve.corgtex.com",
  NEXT_PUBLIC_APP_URL: "https://selfserve.corgtex.com",
  NEXT_PUBLIC_SITE_URL: "https://www.corgtex.com",
  MCP_PUBLIC_URL: "https://selfserve.corgtex.com/mcp",
  MEETING_RECORDER_PUBLIC_BASE_URL: "https://selfserve.corgtex.com",
  SESSION_COOKIE_SECRET: "session-secret",
  ENCRYPTION_KEY: "encryption-key",
  DATABASE_URL: "postgres://example",
  REDIS_URL: "rediss://example",
  SMOKE_EMAIL_CAPTURE_SECRET: "capture-secret",
  SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS: "selfserve.corgtex.com",
  SELF_SERVE_REGISTRY_SYNC_SECRET: "registry-secret",
  RESEND_API_KEY: "resend-key",
  EMAIL_FROM: "Corgtex <onboarding@corgtex.com>",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  MICROSOFT_CLIENT_ID: "microsoft-client",
  MICROSOFT_CLIENT_SECRET: "microsoft-secret",
  STRIPE_SECRET_KEY: "stripe-secret",
  STRIPE_WEBHOOK_SECRET: "stripe-webhook",
  STRIPE_PRICE_AI_USAGE_ID: "price-ai",
  RESEND_WEBHOOK_SECRET: "whsec_example",
};

describe("Azure self-serve domain readiness", () => {
  it("builds the provider callback inventory for the production self-serve domain", () => {
    const result = buildAzureSelfServeDomainReadiness({
      appUrl: "https://selfserve.corgtex.com/",
      siteUrl: "https://www.corgtex.com/",
    });

    expect(result).toMatchObject({
      appOrigin: "https://selfserve.corgtex.com",
      siteOrigin: "https://www.corgtex.com",
      mcpPublicUrl: "https://selfserve.corgtex.com/mcp",
      meetingRecorderPublicBaseUrl: "https://selfserve.corgtex.com",
      callbacks: {
        googleOAuthRedirect: "https://selfserve.corgtex.com/api/integrations/google/callback",
        microsoftOAuthRedirect: "https://selfserve.corgtex.com/api/integrations/microsoft/callback",
        workspaceSsoRedirect: "https://selfserve.corgtex.com/api/auth/sso/callback",
        slackOAuthRedirect: "https://selfserve.corgtex.com/api/integrations/slack/callback",
        stripeWebhook: "https://selfserve.corgtex.com/api/webhooks/stripe",
        resendInboundWebhook: "https://selfserve.corgtex.com/api/webhooks/resend-inbound",
        mcpServer: "https://selfserve.corgtex.com/mcp",
        mcpAuthorize: "https://selfserve.corgtex.com/api/oauth/authorize",
        mcpToken: "https://selfserve.corgtex.com/api/oauth/token",
      },
    });
  });

  it("passes strict readiness when the Azure runtime URLs and provider env are configured", () => {
    const result = validateAzureSelfServeDomainReadiness(COMPLETE_ENV, { strict: true });

    expect(result.checks.filter((check) => check.level === "error")).toEqual([]);
    expect(result.checks.find((check) => check.name === "mcp-public-url")).toMatchObject({ level: "ok" });
  });

  it("rejects an origin-only MCP_PUBLIC_URL because the MCP endpoint path would be missing", () => {
    const result = validateAzureSelfServeDomainReadiness({
      ...COMPLETE_ENV,
      MCP_PUBLIC_URL: "https://selfserve.corgtex.com",
    }, { strict: true });

    expect(result.checks).toContainEqual({
      level: "error",
      name: "mcp-public-url",
      detail: "MCP_PUBLIC_URL must be https://selfserve.corgtex.com/mcp.",
    });
  });

  it("rejects unapproved hosts so Railway production domains stay out of the Azure readiness contract", () => {
    const result = validateAzureSelfServeDomainReadiness({
      ...COMPLETE_ENV,
      APP_URL: "https://app.corgtex.com",
      NEXT_PUBLIC_APP_URL: "https://app.corgtex.com",
      MCP_PUBLIC_URL: "https://app.corgtex.com/mcp",
      MEETING_RECORDER_PUBLIC_BASE_URL: "https://app.corgtex.com",
    });

    expect(result.checks).toContainEqual({
      level: "error",
      name: "app-domain",
      detail: "app.corgtex.com is not in the approved Azure self-serve host allowlist.",
    });
  });
});
