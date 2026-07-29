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
      MODEL_CHAT_QUALITY: "corgtex-ds-v4-pro",
    });

    const { resolveModel } = await import("./model-routing");

    expect(resolveModel("quality", "deepseek/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
  });
});
