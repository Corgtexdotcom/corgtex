import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./railway-action.mjs", import.meta.url));

describe("railway-action CLI", () => {
  it("reports non-JSON Railway API responses with HTTP context", async () => {
    const result = await runRailwayAction({}, (_request, response) => {
      response.writeHead(503, { "Content-Type": "text/html" });
      response.end("<html><head><title>Railway</title></head><body>unconditional drop overload</body></html>");
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Railway API returned non-JSON response: HTTP 503");
    expect(result.stderr).toContain("unconditional drop overload");
    expect(result.stderr).not.toContain("Unexpected token");
  });

  it("keeps Railway GraphQL error messages readable", async () => {
    const result = await runRailwayAction({}, (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ errors: [{ message: "Railway service unavailable" }] }));
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Railway service unavailable");
  });

  it("allows read-only inspect for active Railway customer deployments from control-plane data", async () => {
    const requests = [];
    const result = await runRailwayAction({
      args: ["inspect", "--service", "chirone"],
      allowlist: [],
      customers: [
        {
          id: "deployment-chirone",
          label: "Chirone Production",
          customerSlug: "chirone",
          cloudProvider: "RAILWAY",
          deploymentStatus: "ACTIVE",
          provisioningStatus: "active",
          providerWebServiceId: "svc-chirone-web",
          providerEnvironmentId: "env-chirone-prod",
          providerProjectId: "project-chirone",
        },
      ],
    }, async (request, response) => {
      const body = await readRequestBody(request);
      requests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        data: {
          deployments: {
            edges: [
              {
                node: {
                  id: "deployment-1",
                  status: "FAILED",
                  createdAt: "2026-07-30T23:20:00.000Z",
                },
              },
            ],
          },
        },
      }));
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        id: "deployment-1",
        status: "FAILED",
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].variables).toEqual({
      serviceId: "svc-chirone-web",
      environmentId: "env-chirone-prod",
    });
  });

  it("keeps customer restart blocked unless the service is statically allowlisted", async () => {
    const result = await runRailwayAction({
      args: ["restart", "--service", "chirone", "--confirm"],
      allowlist: [],
      customers: [
        {
          customerSlug: "chirone",
          cloudProvider: "RAILWAY",
          deploymentStatus: "ACTIVE",
          provisioningStatus: "active",
          providerWebServiceId: "svc-chirone-web",
          providerEnvironmentId: "env-chirone-prod",
        },
      ],
    }, (_request, response) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ errors: [{ message: "should not call Railway" }] }));
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Railway service is not allowlisted: chirone");
  });
});

async function runRailwayAction(options, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected test server to listen on a TCP port.");
  }

  try {
    const output = await execFileAsync(process.execPath, [scriptPath, ...(options.args ?? ["inspect", "--service", "web"])], {
      env: {
        ...process.env,
        RAILWAY_API_TOKEN: "test-token",
        RAILWAY_GRAPHQL_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`,
        RAILWAY_OPS_ALLOWLIST_JSON: JSON.stringify(options.allowlist ?? [
          {
            service: "web",
            serviceId: "svc-web",
            environmentId: "env-prod",
          },
        ]),
        RAILWAY_OPS_CUSTOMERS_JSON: JSON.stringify(options.customers ?? []),
      },
    });

    return {
      code: 0,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
