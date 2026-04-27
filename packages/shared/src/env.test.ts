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

describe("env", () => {
  it("does not require DATABASE_URL until it is accessed", async () => {
    restoreEnv();
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.DATABASE_URL;

    const { env } = await import("./env");

    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(() => env.DATABASE_URL).toThrowError("Missing required environment variable: DATABASE_URL");
  });

  it("requires SESSION_COOKIE_SECRET in production", async () => {
    restoreEnv();
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.SESSION_COOKIE_SECRET;

    const { env } = await import("./env");

    expect(() => env.SESSION_COOKIE_SECRET).toThrowError("Missing required environment variable: SESSION_COOKIE_SECRET");
  });

  it("uses development defaults outside production", async () => {
    restoreEnv();
    Object.assign(process.env, { NODE_ENV: "development" });
    delete process.env.SESSION_COOKIE_SECRET;

    const { env } = await import("./env");

    expect(env.SESSION_COOKIE_SECRET).toBe("development-session-secret");
  });

  it("uses OpenRouter and model defaults for model configuration", async () => {
    restoreEnv();
    Object.assign(process.env, { NODE_ENV: "development" });
    delete process.env.MODEL_PROVIDER;
    delete process.env.MODEL_BASE_URL;
    delete process.env.MODEL_CHAT_DEFAULT;
    delete process.env.MODEL_EMBEDDING_DEFAULT;

    const { env } = await import("./env");

    expect(env.MODEL_PROVIDER).toBe("openrouter");
    expect(env.MODEL_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(env.MODEL_CHAT_DEFAULT).toBe("qwen/qwen3-32b");
    expect(env.MODEL_EMBEDDING_DEFAULT).toBe("google/gemini-embedding-001");
  });
});
