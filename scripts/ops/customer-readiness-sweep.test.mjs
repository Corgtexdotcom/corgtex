import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sweepPath = fileURLToPath(new URL("./customer-readiness-sweep.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(sweepPath), "../..");

function runSweep(customers, { args = ["--dry-run"], env = {}, nodeArgs = [] } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, sweepPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLIENT_READINESS_CUSTOMERS_JSON: JSON.stringify(customers),
      CLIENT_READINESS_CUSTOMER_SLUGS: "",
      CLIENT_READINESS_INCLUDE_INACTIVE: "false",
      OPS_CREATE_GITHUB_ISSUES: "false",
      ...env,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
}

function runDryRun(customers) {
  const result = runSweep(customers);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

describe("customer readiness sweep required targets", () => {
  const active = { slug: "active-client", url: "https://active.example", provisioningStatus: "active" };
  const degraded = { slug: "degraded-client", url: "https://degraded.example", provisioningStatus: "degraded" };
  const inactive = { slug: "inactive-client", url: "https://inactive.example", provisioningStatus: "suspended" };

  function expectMissing(result, slugs) {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Required readiness targets unavailable: ${slugs.join(", ")}.`);
  }

  it.each([{ customers: [] }, { customers: [active] }])("fails when discovery has no match for an explicit target (%j)", ({ customers }) => {
    expectMissing(runSweep(customers, {
      args: ["--dry-run", "--customers", "corgtex-selfserve-production"],
    }), ["corgtex-selfserve-production"]);
  });

  it("requires every requested target, not just one match", () => {
    const result = runSweep([active], {
      args: ["--dry-run", "--customers", "active-client,missing-client,another-missing-client"],
    });
    expectMissing(result, ["missing-client", "another-missing-client"]);
  });

  it("fails when a required target is excluded by the inactive-status policy", () => {
    expectMissing(runSweep([active, inactive], {
      args: ["--dry-run", "--customers", "active-client,inactive-client"],
    }), ["inactive-client"]);
  });

  it("fails when a required target has no usable runtime URL", () => {
    expectMissing(runSweep([{ ...active, url: "https://ops.example/workspaces/workspace-1" }], {
      args: ["--dry-run", "--customers", "active-client"],
    }), ["active-client"]);
  });

  it("accepts all requested eligible targets and excludes unrelated customers", () => {
    const result = runSweep([active, inactive, degraded], {
      args: ["--dry-run", "--customers", "active-client,degraded-client"],
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).customers.map((customer) => customer.slug)).toEqual([
      "active-client", "degraded-client",
    ]);
  });

  it("honors the explicit opt-in to include an inactive required target", () => {
    const result = runSweep([inactive], {
      args: ["--dry-run", "--customers", "inactive-client"],
      env: { CLIENT_READINESS_INCLUDE_INACTIVE: "true" },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).customers.map((customer) => customer.slug)).toEqual(["inactive-client"]);
  });

  it("treats environment-selected targets as a required set too", () => {
    expectMissing(runSweep([active], {
      env: { CLIENT_READINESS_CUSTOMER_SLUGS: "active-client,missing-client" },
    }), ["missing-client"]);

    const result = runSweep([active, degraded], {
      env: { CLIENT_READINESS_CUSTOMER_SLUGS: "active-client,degraded-client" },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).customers).toHaveLength(2);
  });

  it("preserves CLI selection precedence over environment selection", () => {
    const result = runSweep([active], {
      args: ["--dry-run", "--customers", "active-client"],
      env: { CLIENT_READINESS_CUSTOMER_SLUGS: "missing-client" },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).customers.map((customer) => customer.slug)).toEqual(["active-client"]);
  });

  it.each([{ customers: [] }, { customers: [inactive] }])("preserves unfiltered fleet success with no eligible targets (%j)", ({ customers }) => {
    expect(runDryRun(customers).customers).toEqual([]);
  });

  it("preserves normal unfiltered active and degraded fleet selection", () => {
    expect(runDryRun([active, inactive, degraded]).customers.map((customer) => customer.slug)).toEqual([
      "active-client", "degraded-client",
    ]);
  });

  it.each([{ modeArgs: [] }, { modeArgs: ["--health-only"] }])("fails before health, credentials, smoke or issue sync (%j)", ({ modeArgs }) => {
    // Make downstream network/subprocess work impossible even if the preflight regresses.
    const preload = `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const unexpected = () => { throw new Error("Unexpected downstream readiness work"); };
      childProcess.spawnSync = unexpected;
      syncBuiltinESMExports();
      globalThis.fetch = unexpected;
    `;
    expectMissing(runSweep([active], {
      args: ["--customers", "active-client,missing-client", "--create-issues", ...modeArgs],
      nodeArgs: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`],
      env: { CLIENT_READINESS_CREDENTIALS_JSON: "invalid credential configuration" },
    }), ["missing-client"]);
  });
});

describe("customer readiness sweep URL selection", () => {
  it("fails a standalone health check when an incident is not being published", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "down" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const child = spawn(process.execPath, [sweepPath, "--health-only"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CLIENT_READINESS_CUSTOMERS_JSON: JSON.stringify([{
            id: "deployment-test",
            slug: "synthetic-client",
            url: `http://127.0.0.1:${server.address().port}`,
            provisioningStatus: "active",
          }]),
          CLIENT_READINESS_CUSTOMER_SLUGS: "",
          OPS_CREATE_GITHUB_ISSUES: "false",
        },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      const code = await new Promise((resolve) => child.on("close", resolve));
      expect(code).toBe(1);
      expect(JSON.parse(stdout).incidents).toHaveLength(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

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

  it("falls back to deployment URLs when supportBaseUrl is not a runtime URL", () => {
    const output = runDryRun([
      {
        id: "deployment-chirone",
        slug: "chirone",
        label: "Chirone Production",
        url: "https://deploy-chirone.example",
        supportBaseUrl: "https://app.corgtex.com/workspaces/workspace-1",
        provisioningStatus: "degraded",
      },
      {
        id: "deployment-malformed",
        slug: "malformed",
        label: "Malformed Support",
        url: "https://malformed.example",
        supportBaseUrl: "not-a-url",
        provisioningStatus: "active",
      },
    ]);

    expect(output.customers.map((customer) => customer.healthUrl)).toEqual([
      "https://deploy-chirone.example/api/health",
      "https://malformed.example/api/health",
    ]);
    expect(resultText(output)).not.toContain("/workspaces/workspace-1/api/health");
  });

  it("skips workspace UI URLs when no runtime URL is configured", () => {
    const output = runDryRun([
      {
        id: "deployment-chirone",
        slug: "chirone",
        label: "Chirone Production",
        url: "https://ops.corgtex.com/es/workspaces/workspace-1/settings",
        supportBaseUrl: null,
        provisioningStatus: "degraded",
      },
    ]);

    expect(output.customers).toEqual([]);
    expect(resultText(output)).not.toContain("/workspaces/workspace-1/settings/api/health");
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
      {
        id: "deployment-malformed",
        slug: "malformed",
        label: "Malformed Support",
        url: "https://malformed.example",
        supportBaseUrl: "https://[::1",
        provisioningStatus: "active",
      },
    ]);

    expect(output.customers.map((customer) => customer.healthUrl)).toEqual([
      "https://chirone.example/api/health",
      "https://malformed.example/api/health",
    ]);
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
