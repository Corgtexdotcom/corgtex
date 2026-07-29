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
const AZURE_OPENAI_MODEL_ENV = {
  MODEL_CHAT_DEFAULT: "corgtex-chat-standard",
  MODEL_CHAT_FAST: "corgtex-chat-fast",
  MODEL_CHAT_STANDARD: "corgtex-chat-standard",
  MODEL_CHAT_QUALITY: "corgtex-chat-quality",
  MODEL_CHAT_EXCELLENT: "corgtex-chat-excellent",
  MODEL_CHAT_CONVERSATION: "corgtex-chat-quality",
  MODEL_EMBEDDING_DEFAULT: "corgtex-embedding",
};
const AZURE_OPENAI_PRICE_OVERRIDES_JSON = JSON.stringify([
  { provider: "azure-openai", model: "corgtex-chat-standard", inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000006 },
  { provider: "azure-openai", model: "corgtex-chat-fast", inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000006 },
  { provider: "azure-openai", model: "corgtex-chat-quality", inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000006 },
  { provider: "azure-openai", model: "corgtex-chat-excellent", inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000006 },
  { provider: "azure-openai", model: "corgtex-embedding", inputUsdPerToken: 0.00000002, outputUsdPerToken: 0 },
]);
const AZURE_FOUNDRY_MODEL_ENV = {
  MODEL_CHAT_DEFAULT: "corgtex-ds-v4-flash",
  MODEL_CHAT_FAST: "corgtex-ds-v4-flash",
  MODEL_CHAT_STANDARD: "corgtex-ds-v4-flash",
  MODEL_CHAT_QUALITY: "corgtex-ds-v4-pro",
  MODEL_CHAT_EXCELLENT: "corgtex-gpt56-luna",
  MODEL_CHAT_CONVERSATION: "corgtex-ds-v4-pro",
  MODEL_EMBEDDING_DEFAULT: "corgtex-ds-v4-flash",
};
const CUSTOM_AZURE_FOUNDRY_MODEL_ENV = {
  ...AZURE_FOUNDRY_MODEL_ENV,
  MODEL_CHAT_DEFAULT: "custom-foundry-deployment",
  MODEL_CHAT_FAST: "custom-foundry-deployment",
  MODEL_CHAT_STANDARD: "custom-foundry-deployment",
};
const AZURE_FOUNDRY_PRICE_OVERRIDES_JSON = JSON.stringify([
  { provider: "azure-foundry", model: "corgtex-ds-v4-flash", inputUsdPerToken: 0.00000019, outputUsdPerToken: 0.00000051 },
  { provider: "azure-foundry", model: "corgtex-ds-v4-pro", inputUsdPerToken: 0.00000174, outputUsdPerToken: 0.00000348 },
  { provider: "azure-foundry", model: "corgtex-gpt56-luna", inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000006 },
]);

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
      ...AZURE_OPENAI_MODEL_ENV,
      MODEL_PROVIDER: "azure-openai",
      MODEL_BASE_URL: "https://example.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
      MODEL_PRICE_OVERRIDES_JSON: AZURE_OPENAI_PRICE_OVERRIDES_JSON,
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   MODEL_PROVIDER configured");
    expect(result.stdout).toContain("OK   EMAIL_FROM uses notifications@auth.corgtex.com");
    expect(result.stdout).toContain("OK   EMAIL_REPLY_TO uses support@corgtex.com");
    expect(result.stdout).toContain("OK   MODEL_BASE_URL configured");
    expect(result.stdout).toContain("OK   MODEL_PRICE_OVERRIDES_JSON includes azure-openai/corgtex-chat-standard");
    expect(result.stdout).toContain("OK   AZURE_OPENAI_AUTH_MODE configured for managed identity");
    expect(result.stderr).toBe("");
  });

  it("accepts Azure Foundry managed identity with explicit model pricing in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...AZURE_FOUNDRY_MODEL_ENV,
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://example.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
      MODEL_PRICE_OVERRIDES_JSON: AZURE_FOUNDRY_PRICE_OVERRIDES_JSON,
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   MODEL_BASE_URL configured");
    expect(result.stdout).toContain("OK   MODEL_PRICE_OVERRIDES_JSON valid");
    expect(result.stdout).toContain("OK   MODEL_PRICE_OVERRIDES_JSON includes azure-foundry/corgtex-gpt56-luna");
    expect(result.stdout).toContain("OK   AZURE_OPENAI_AUTH_MODE configured for managed identity");
    expect(result.stderr).toBe("");
  });

  it("accepts built-in Azure Foundry pricing in strict mode without override JSON", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...AZURE_FOUNDRY_MODEL_ENV,
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://example.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   built-in price catalog includes azure-foundry/corgtex-ds-v4-flash");
    expect(result.stdout).toContain("OK   built-in price catalog includes azure-foundry/corgtex-gpt56-luna");
    expect(result.stderr).toBe("");
  });

  it("requires price overrides for custom Azure deployments in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...CUSTOM_AZURE_FOUNDRY_MODEL_ENV,
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://example.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_PRICE_OVERRIDES_JSON missing price for azure-foundry/custom-foundry-deployment");
  });

  it("requires exact Azure pricing entries in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...CUSTOM_AZURE_FOUNDRY_MODEL_ENV,
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://example.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
      MODEL_PRICE_OVERRIDES_JSON: "[]",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_PRICE_OVERRIDES_JSON missing price for azure-foundry/custom-foundry-deployment");
  });

  it("rejects malformed Azure pricing overrides in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...AZURE_FOUNDRY_MODEL_ENV,
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://example.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
      MODEL_PRICE_OVERRIDES_JSON: "{not-json",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_PRICE_OVERRIDES_JSON must be valid JSON");
  });

  it("rejects malformed Azure global base URLs in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...AZURE_FOUNDRY_MODEL_ENV,
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "not-a-url",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_BASE_URL must be an HTTP(S) URL for Azure Foundry");
  });

  it("accepts an Azure Foundry per-model canary route while OpenRouter remains the global provider", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key-placeholder",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-gpt56-luna",
          provider: "azure-foundry",
          baseUrl: "https://example.services.ai.azure.com/openai/v1",
          authMode: "managed_identity",
        },
      ]),
      MODEL_PRICE_OVERRIDES_JSON: JSON.stringify([
        {
          provider: "azure-foundry",
          model: "corgtex-gpt56-luna",
          inputUsdPerToken: 0.000001,
          outputUsdPerToken: 0.000006,
        },
      ]),
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   MODEL_API_KEY configured");
    expect(result.stdout).toContain("OK   MODEL_PROVIDER_ROUTES_JSON valid");
    expect(result.stdout).toContain("OK   MODEL_PROVIDER_ROUTES_JSON route for corgtex-gpt56-luna has Azure Foundry base URL");
    expect(result.stdout).toContain("OK   MODEL_PROVIDER_ROUTES_JSON route for corgtex-gpt56-luna uses managed identity");
    expect(result.stderr).toBe("");
  });

  it("accepts an OpenRouter rollback route while Azure is the global provider", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...AZURE_FOUNDRY_MODEL_ENV,
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://example.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "deepseek/deepseek-v4-pro",
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_ROLLBACK_KEY",
        },
      ]),
      MODEL_PRICE_OVERRIDES_JSON: AZURE_FOUNDRY_PRICE_OVERRIDES_JSON,
      OPENROUTER_ROLLBACK_KEY: "openrouter-key-placeholder",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   MODEL_PROVIDER_ROUTES_JSON route for deepseek/deepseek-v4-pro has OpenRouter base URL");
    expect(result.stdout).toContain("OK   OPENROUTER_ROLLBACK_KEY configured");
    expect(result.stderr).toBe("");
  });

  it("uses routed provider before requiring model prices for configured rollback models", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...AZURE_FOUNDRY_MODEL_ENV,
      MODEL_CHAT_QUALITY: "deepseek/deepseek-v4-pro",
      MODEL_CHAT_CONVERSATION: "deepseek/deepseek-v4-pro",
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://example.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "deepseek/deepseek-v4-pro",
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_ROLLBACK_KEY",
        },
      ]),
      MODEL_PRICE_OVERRIDES_JSON: AZURE_FOUNDRY_PRICE_OVERRIDES_JSON,
      OPENROUTER_ROLLBACK_KEY: "openrouter-key-placeholder",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK   MODEL_PROVIDER_ROUTES_JSON route for deepseek/deepseek-v4-pro has OpenRouter base URL");
    expect(result.stdout).not.toContain("MODEL_PRICE_OVERRIDES_JSON includes azure-foundry/deepseek/deepseek-v4-pro");
    expect(result.stderr).not.toContain("MODEL_PRICE_OVERRIDES_JSON missing price for azure-foundry/deepseek/deepseek-v4-pro");
  });

  it("rejects malformed per-model route base URLs", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key-placeholder",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-gpt56-luna",
          provider: "azure-foundry",
          baseUrl: "ftp://example.services.ai.azure.com/openai/v1",
          authMode: "managed_identity",
        },
      ]),
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_PROVIDER_ROUTES_JSON[0].baseUrl must be an HTTP(S) URL");
  });

  it("rejects duplicate per-model routes", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key-placeholder",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-gpt56-luna",
          provider: "azure-foundry",
          baseUrl: "https://example.services.ai.azure.com/openai/v1",
          authMode: "managed_identity",
        },
        {
          model: "corgtex-gpt56-luna",
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      ]),
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_PROVIDER_ROUTES_JSON contains duplicate route for corgtex-gpt56-luna");
  });

  it("requires explicit key envs for Azure API-key routed endpoints", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...AZURE_FOUNDRY_MODEL_ENV,
      MODEL_PROVIDER: "azure-openai",
      MODEL_BASE_URL: "https://global-openai.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "global-azure-key-placeholder",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-gpt56-luna",
          provider: "azure-foundry",
          baseUrl: "https://example.services.ai.azure.com/openai/v1",
          authMode: "api_key",
        },
      ]),
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Azure Foundry route for corgtex-gpt56-luna requires apiKeyEnv when using Azure API key authentication with a routed endpoint");
  });

  it("requires non-Azure rollback routes to include a base URL and key", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      ...AZURE_FOUNDRY_MODEL_ENV,
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://example.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "deepseek/deepseek-v4-pro",
          provider: "openrouter",
        },
      ]),
      MODEL_PRICE_OVERRIDES_JSON: AZURE_FOUNDRY_PRICE_OVERRIDES_JSON,
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_PROVIDER_ROUTES_JSON route for deepseek/deepseek-v4-pro requires baseUrl");
    expect(result.stderr).toContain("OpenRouter route for deepseek/deepseek-v4-pro requires apiKeyEnv when provider differs from MODEL_PROVIDER");
  });

  it("rejects malformed per-model provider routes in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key-placeholder",
      MODEL_PROVIDER_ROUTES_JSON: "{\"model\":\"corgtex-gpt56-luna\"}",
      MODEL_PRICE_OVERRIDES_JSON: "[]",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_PROVIDER_ROUTES_JSON must be an array");
  });

  it("requires MODEL_API_KEY for OpenAI-compatible providers in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "openrouter",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_API_KEY missing for OpenAI-compatible model provider");
  });

  it("rejects unsupported global model providers in strict mode", () => {
    const result = runReadiness({
      ...STRICT_BASE_ENV,
      MODEL_PROVIDER: "azuer-foundry",
      MODEL_API_KEY: "model-key-placeholder",
    }, ["--strict", "--skip-http"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_PROVIDER must be one of openrouter, openai, azure-openai, azure-foundry");
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
