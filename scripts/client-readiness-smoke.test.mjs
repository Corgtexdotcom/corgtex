import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = [];
const servers = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

async function startRejectingLoginServer() {
  const server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", loginPath: "/login" }));
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <html>
        <body>
          <form>
            <input name="email" type="email" />
            <input name="password" type="password" />
            <button type="submit">Sign in</button>
            <p role="alert" style="display: none"></p>
          </form>
          <script>
            document.querySelector("form").addEventListener("submit", (event) => {
              event.preventDefault();
              const alert = document.querySelector('[role="alert"]');
              alert.textContent = "Invalid email or password.";
              alert.style.display = "block";
            });
          </script>
        </body>
      </html>`);
  });
  servers.push(server);
  const address = await listen(server);
  return `http://${address.address}:${address.port}`;
}

function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("client readiness smoke login handling", () => {
  it("reports visible login errors instead of timing out on workspace navigation", async () => {
    const baseUrl = await startRejectingLoginServer();
    const outDir = await mkdtemp(path.join(tmpdir(), "client-readiness-smoke-"));
    tempDirs.push(outDir);
    await mkdir(outDir, { recursive: true });

    const result = await runNode(
      ["scripts/client-readiness-smoke.mjs", baseUrl, outDir],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENT_E2E_EMAIL: "agent@example.com",
          AGENT_E2E_PASSWORD: "password123",
          CLIENT_READINESS_LOGIN_TIMEOUT_MS: "5000",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Login failed: Invalid email or password.");
    expect(result.stderr).not.toContain("page.waitForURL");

    const results = JSON.parse(await readFile(path.join(outDir, "qa-results.json"), "utf8"));
    expect(results.status).toBe("failed");
    expect(results.fatalError.message).toBe("Login failed: Invalid email or password.");
    expect(results.findings[0]).toMatchObject({
      name: "fatal",
      status: "failed",
      error: "Login failed: Invalid email or password.",
    });
  });
});
