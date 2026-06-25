import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "self-serve-production-readiness.mjs");
const STRICT_BASE_ENV = {
  APP_URL: "https://selfserve.corgtex.com",
  NEXT_PUBLIC_APP_URL: "https://selfserve.corgtex.com",
  NEXT_PUBLIC_SITE_URL: "https://www.corgtex.com",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/corgtex",
  SESSION_COOKIE_SECRET: "test-session-secret",
  ENCRYPTION_KEY: "test-encryption-key",
  STRIPE_SECRET_KEY: "stripe-secret-placeholder",
  STRIPE_WEBHOOK_SECRET: "stripe-webhook-placeholder",
  STRIPE_PRICE_AI_USAGE_ID: "price_test",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  MICROSOFT_CLIENT_ID: "microsoft-client-id",
  MICROSOFT_CLIENT_SECRET: "microsoft-client-secret-value",
  RESEND_API_KEY: "resend-api-placeholder",
  EMAIL_FROM: "Corgtex <notifications@auth.corgtex.com>",
  EMAIL_REPLY_TO: "support@corgtex.com",
  WORKER_POLL_INTERVAL_MS: "1000",
  WORKER_MAX_POLL_INTERVAL_MS: "5000",
  WORKER_EVENT_BATCH_SIZE: "10",
  WORKER_JOB_BATCH_SIZE: "10",
  WORKER_HEALTH_PORT: "3001",
  WORKER_SHUTDOWN_TIMEOUT_MS: "1000",
};

function runReadiness(env, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    env: {
      PATH: process.env.PATH,
      ...env,
    },
    encoding: "utf8",
  });
}

describe("self-serve production readiness", () => {
  it("fails when the Microsoft client secret looks like an Entra Secret ID", () => {
    const secretId = ["3913e6c0", "7768", "4b8e", "b6d1", "866959ef2e18"].join("-");
    const result = runReadiness({
      MICROSOFT_CLIENT_SECRET: secretId,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MICROSOFT_CLIENT_SECRET looks like an Entra Secret ID");
    expect(result.stderr).not.toContain(secretId);
  });

  it("does not fail when the Microsoft client secret is a value-shaped secret", () => {
    const result = runReadiness({
      MICROSOFT_CLIENT_SECRET: "client-secret-value~with-symbols",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts Azure OpenAI managed identity without MODEL_API_KEY in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "azure-openai",
      MODEL_BASE_URL: "https://example.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   MODEL_PROVIDER configured");
    expect(result.stdout).toContain("OK   EMAIL_FROM uses notifications@auth.corgtex.com");
    expect(result.stdout).toContain("OK   EMAIL_REPLY_TO uses support@corgtex.com");
    expect(result.stdout).toContain("OK   MODEL_BASE_URL configured");
    expect(result.stdout).toContain("OK   AZURE_OPENAI_AUTH_MODE configured for managed identity");
    expect(result.stderr).toBe("");
  });

  it("requires MODEL_API_KEY for OpenAI-compatible providers in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "openrouter",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_API_KEY missing for OpenAI-compatible model provider");
  });

  it("rejects old app email sender domains in strict mode", () => {
    for (const emailFrom of [
      "Corgtex <onboarding@corgtex.com>",
      "Corgtex <onboarding@resend.dev>",
    ]) {
      const result = runReadiness({
        ...STRICT_BASE_ENV,
        MODEL_PROVIDER: "fake",
        EMAIL_FROM: emailFrom,
      }, ["--strict", "--skip-http"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("EMAIL_FROM must use notifications@auth.corgtex.com");
    }
  });

  it("requires support reply-to in strict mode", () => {
    const missingReplyTo = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "fake",
      EMAIL_REPLY_TO: "",
    }, ["--strict", "--skip-http"]);
    expect(missingReplyTo.status).toBe(1);
    expect(missingReplyTo.stderr).toContain("EMAIL_REPLY_TO missing");

    const wrongReplyTo = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "fake",
      EMAIL_REPLY_TO: "Corgtex <notifications@auth.corgtex.com>",
    }, ["--strict", "--skip-http"]);
    expect(wrongReplyTo.status).toBe(1);
    expect(wrongReplyTo.stderr).toContain("EMAIL_REPLY_TO must use support@corgtex.com");
  });
});
