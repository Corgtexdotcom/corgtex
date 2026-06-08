import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sweepPath = fileURLToPath(new URL("./customer-readiness-sweep.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(sweepPath), "../..");

function runDryRun(customers) {
  const result = spawnSync(process.execPath, [sweepPath, "--dry-run"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLIENT_READINESS_CUSTOMERS_JSON: JSON.stringify(customers),
      CLIENT_READINESS_CUSTOMER_SLUGS: "",
      CLIENT_READINESS_INCLUDE_INACTIVE: "true",
    },
    encoding: "utf8",
  });

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

describe("customer readiness sweep URL selection", () => {
  it("prefers supportBaseUrl over a deployment workspace URL", () => {
    const output = runDryRun([
      {
        id: "deployment-chirone",
        slug: "chirone",
        label: "Chirone Production",
        url: "https://ops.corgtex.com/workspaces/workspace-1",
        supportBaseUrl: "https://chirone.example",
        provisioningStatus: "degraded",
      },
    ]);

    expect(output.customers).toHaveLength(1);
    expect(output.customers[0]).toMatchObject({
      slug: "chirone",
      url: "https://chirone.example",
      healthUrl: "https://chirone.example/api/health",
    });
  });

  it("skips workspace UI URLs when no runtime URL is configured", () => {
    const output = runDryRun([
      {
        id: "deployment-chirone",
        slug: "chirone",
        label: "Chirone Production",
        url: "https://ops.corgtex.com/workspaces/workspace-1",
        supportBaseUrl: null,
        provisioningStatus: "degraded",
      },
    ]);

    expect(output.customers).toEqual([]);
    expect(resultText(output)).not.toContain("/workspaces/workspace-1/api/health");
  });

  it("skips nested workspace UI URLs", () => {
    const output = runDryRun([
      {
        id: "deployment-chirone",
        slug: "chirone",
        label: "Chirone Production",
        url: "https://ops.corgtex.com/workspaces/workspace-1/settings",
        supportBaseUrl: null,
        provisioningStatus: "degraded",
      },
    ]);

    expect(output.customers).toEqual([]);
    expect(resultText(output)).not.toContain("/workspaces/workspace-1/settings/api/health");
  });

  it("filters workspace supportBaseUrl values before falling back to deployment URLs", () => {
    const output = runDryRun([
      {
        id: "deployment-chirone",
        slug: "chirone",
        label: "Chirone Production",
        url: "https://chirone.example",
        supportBaseUrl: "https://ops.corgtex.com/workspaces/workspace-1/settings",
        provisioningStatus: "degraded",
      },
    ]);

    expect(output.customers).toHaveLength(1);
    expect(output.customers[0]).toMatchObject({
      slug: "chirone",
      url: "https://chirone.example",
      healthUrl: "https://chirone.example/api/health",
    });
  });

  it("skips invalid supportBaseUrl values before falling back to deployment URLs", () => {
    const output = runDryRun([
      {
        id: "deployment-chirone",
        slug: "chirone",
        label: "Chirone Production",
        url: "https://chirone.example",
        supportBaseUrl: "mailto:support@example.com",
        provisioningStatus: "degraded",
      },
    ]);

    expect(output.customers).toHaveLength(1);
    expect(output.customers[0]).toMatchObject({
      slug: "chirone",
      url: "https://chirone.example",
      healthUrl: "https://chirone.example/api/health",
    });
  });

  it("keeps ordinary deployment runtime URLs", () => {
    const output = runDryRun([
      {
        id: "deployment-acme",
        slug: "acme",
        label: "Acme Production",
        url: "https://acme.example",
        supportBaseUrl: null,
        provisioningStatus: "active",
      },
    ]);

    expect(output.customers).toHaveLength(1);
    expect(output.customers[0]).toMatchObject({
      slug: "acme",
      url: "https://acme.example",
      healthUrl: "https://acme.example/api/health",
    });
  });
});

function resultText(value) {
  return JSON.stringify(value);
}
