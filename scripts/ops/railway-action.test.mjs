import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./railway-action.mjs", import.meta.url));

describe("railway-action CLI", () => {
  it("reports non-JSON Railway API responses with HTTP context", async () => {
    const result = await runRailwayAction((_request, response) => {
      response.writeHead(503, { "Content-Type": "text/html" });
      response.end("<html><head><title>Railway</title></head><body>unconditional drop overload</body></html>");
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Railway API returned non-JSON response: HTTP 503");
    expect(result.stderr).toContain("unconditional drop overload");
    expect(result.stderr).not.toContain("Unexpected token");
  });

  it("keeps Railway GraphQL error messages readable", async () => {
    const result = await runRailwayAction((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ errors: [{ message: "Railway service unavailable" }] }));
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Railway service unavailable");
  });
});

async function runRailwayAction(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected test server to listen on a TCP port.");
  }

  try {
    const output = await execFileAsync(process.execPath, [scriptPath, "inspect", "--service", "web"], {
      env: {
        ...process.env,
        RAILWAY_API_TOKEN: "test-token",
        RAILWAY_GRAPHQL_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`,
        RAILWAY_OPS_ALLOWLIST_JSON: JSON.stringify([
          {
            service: "web",
            serviceId: "svc-web",
            environmentId: "env-prod",
          },
        ]),
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