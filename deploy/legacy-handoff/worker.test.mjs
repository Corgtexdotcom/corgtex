import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyHandoffResponse as response, DESTINATION } from "./worker.mjs";
const request = (path, options = {}) => new Request(`https://chirone.corgtex.com${path}`, {
  headers: { accept: "text/html" }, ...options,
});

test("browser entries and recognized deep links go to fixed selfserve, without source IDs or secrets", () => {
  for (const path of ["/", "/en", "/es/login?token=secret&next=https://evil.example", "/find-account", "/en/workspaces/a928241f-39c9-43a3-8540-b4325d5ea068/actions/old-action?code=secret#private"]) {
    for (const method of ["GET", "HEAD"]) {
      const result = response(request(path, { method }));
      assert.equal(result.status, 302);
      assert.equal(result.headers.get("location"), DESTINATION);
      assert.equal(result.headers.get("location"), "https://selfserve.corgtex.com/#");
      assert.equal(result.headers.get("cache-control"), "no-store");
      assert.equal(result.headers.get("referrer-policy"), "no-referrer");
    }
  }
});

test("writes, APIs, MCP, OAuth, callbacks, webhook and unknown/encoded paths stay frozen", async () => {
  for (const path of ["/", "/en/login", "/api/auth/callback", "/api/integrations/google/callback", "/mcp", "/api/webhooks/stripe", "/oauth/callback", "/callback", "/en/api/session", "/%6cogin", "//evil.example", "/unknown"]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      if (["/", "/en/login"].includes(path) && ["GET", "HEAD"].includes(method)) continue;
      const result = response(request(path, { method }));
      assert.equal(result.status, 503, `${method} ${path}`);
      assert.equal(result.headers.get("location"), null);
      if (method !== "HEAD") assert.equal((await result.json()).applicationWrites, false);
    }
  }
});

test("health GET/HEAD pass through; health writes fail closed", () => {
  for (const path of ["/api/health", "/healthz"]) {
    assert.equal(response(request(path)), null);
    assert.equal(response(request(path, { method: "HEAD" })), null);
    assert.equal(response(request(path, { method: "POST" })).status, 503);
  }
});

test("nonbrowser reads cannot turn API clients into UI navigations", () => {
  assert.equal(response(request("/", { headers: { accept: "application/json" } })).status, 503);
});

test("unverified hosts and ports are never claimed", () => {
  for (const host of ["selfserve.corgtex.com", "ops.corgtex.com", "chirone.corgtex.com.evil.example", "chirone.corgtex.com:444", "crina.corgtex.com"]) {
    assert.equal(response(new Request(`https://${host}/`, { headers: { accept: "text/html" } })), null);
  }
});
