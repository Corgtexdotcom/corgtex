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

describe("db", () => {
  it("does not require DATABASE_URL when the module is imported", async () => {
    restoreEnv();
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.DATABASE_URL;

    await expect(import("./db")).resolves.toBeDefined();
  });

  it("requires DATABASE_URL when a client is requested", async () => {
    restoreEnv();
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.DATABASE_URL;

    const { getPrismaClient } = await import("./db");

    expect(() => getPrismaClient()).toThrowError("Missing required environment variable: DATABASE_URL");
  });
});
