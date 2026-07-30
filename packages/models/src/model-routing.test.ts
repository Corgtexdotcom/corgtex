import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("resolveModel", () => {
  it("routes Azure Foundry aliases by tier and keeps embeddings separate", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_CHAT_DEFAULT: "corgtex-ds-v4-flash",
      MODEL_CHAT_FAST: "corgtex-ds-v4-flash",
      MODEL_CHAT_STANDARD: "corgtex-ds-v4-flash",
      MODEL_CHAT_QUALITY: "corgtex-ds-v4-pro",
      MODEL_CHAT_CONVERSATION: "corgtex-ds-v4-pro",
      MODEL_CHAT_EXCELLENT: "corgtex-gpt56-luna",
      MODEL_EMBEDDING_DEFAULT: "google/gemini-embedding-001",
    });

    const { resolveModel } = await import("./model-routing");
    const { env } = await import("@corgtex/shared");

    expect(resolveModel("none")).toBe("corgtex-ds-v4-flash");
    expect(resolveModel("fast")).toBe("corgtex-ds-v4-flash");
    expect(resolveModel("standard")).toBe("corgtex-ds-v4-flash");
    expect(resolveModel("quality")).toBe("corgtex-ds-v4-pro");
    expect(resolveModel("excellent")).toBe("corgtex-gpt56-luna");
    expect(env.MODEL_EMBEDDING_DEFAULT).toBe("google/gemini-embedding-001");
  });

  it("lets agent overrides preserve the OpenRouter rollback path", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_CHAT_QUALITY: "corgtex-ds-v4-pro",
    });

    const { resolveModel } = await import("./model-routing");

    expect(resolveModel("quality", "deepseek/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
  });

  it("migrates unrouted provider-scoped overrides to the Azure tier alias", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_CHAT_QUALITY: "corgtex-ds-v4-pro",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-ds-v4-pro",
          provider: "azure-foundry",
          baseUrl: "https://corgtex-foundry-models-wus3.services.ai.azure.com/openai/v1",
          authMode: "managed_identity",
        },
      ]),
    });

    const { resolveModel } = await import("./model-routing");

    expect(resolveModel("quality", "qwen/qwen3-32b")).toBe("corgtex-ds-v4-pro");
  });

  it("keeps provider-scoped overrides when an explicit provider route exists", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-openai",
      MODEL_CHAT_QUALITY: "corgtex-ds-v4-pro",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "qwen/qwen3-32b",
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_ROUTE_API_KEY",
        },
      ]),
    });

    const { resolveModel } = await import("./model-routing");

    expect(resolveModel("quality", "qwen/qwen3-32b")).toBe("qwen/qwen3-32b");
  });
});
