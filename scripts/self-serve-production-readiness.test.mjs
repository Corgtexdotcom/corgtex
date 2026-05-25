import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "self-serve-production-readiness.mjs");

function runReadiness(env) {
  return spawnSync(process.execPath, [scriptPath], {
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
});
