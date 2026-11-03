import { describe, expect, it } from "vitest";
import { createGitHubClient } from "./github-api.mjs";

const api = { baseUrl: "https://api.example.test", token: "synthetic-token", owner: "test", repo: "repo" };
const issuePath = "/repos/test/repo/issues";
const reply = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers });
function harness(responses, options = {}) {
  const calls = [];
  const waits = [];
  let clock = 0;
  const client = createGitHubClient(api, {
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    operationId: () => "synthetic-operation-1",
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === "function") return response(url, init);
      if (!response) throw new Error("unexpected request");
      return response;
    },
    ...options,
  });
  return { ...client, calls, waits };
}

const markedBody = "Signal\n\n<!-- corgtex-ops-operation:synthetic-operation-1 -->";

describe("bounded GitHub synchronization transport", () => {
  it("recovers a transient read, uses GET only, and records bounded backoff", async () => {
    const h = harness([new Error("fetch failed"), reply(503, {}), reply(200, [])]);
    expect(await h.request(issuePath)).toEqual([]);
    expect(h.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
    expect(h.waits).toEqual([250, 500]);
    expect(h.stats).toMatchObject({ requests: 3, readRetries: 2 });
    expect(h.calls[0].redirect).toBe("error");
  });
  it("exhausts three read attempts without leaking error text or credentials", async () => {
    const h = harness(Array.from({ length: 3 }, () => new Error("private-network-value")));
    await expect(h.request(issuePath)).rejects.toMatchObject({ code: "transport_failed", attempts: 3, outcome: "failed" });
    expect(h.calls).toHaveLength(3);
  });
  it.each([401, 403, 404, 422])("does not retry nontransient HTTP %s", async (status) => {
    const h = harness([reply(status, { message: "private-response" })]);
    await expect(h.request(issuePath)).rejects.toMatchObject({ attempts: 1, status });
    expect(h.calls).toHaveLength(1);
    expect(h.waits).toEqual([]);
  });
  it.each([403, 429])("honors rate-limit Retry-After for %s", async (status) => {
    const h = harness([reply(status, {}, { "retry-after": "2" }), reply(200, [])]);
    expect(await h.request(issuePath)).toEqual([]);
    expect(h.waits).toEqual([2000]);
  });
  it("honors both reset and Retry-After and never truncates server delay", async () => {
    const h = harness([reply(403, {}, { "retry-after": "1", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3" }), reply(200, [])]);
    await h.request(issuePath);
    expect(h.waits).toEqual([3000]);
    const capped = harness([reply(429, {}, { "retry-after": "300" })]);
    await expect(capped.request(issuePath)).rejects.toMatchObject({ code: "rate_limited", attempts: 1 });
    expect(capped.calls).toHaveLength(1);
    expect(capped.waits).toEqual([]);
  });
  it("waits at least one minute for secondary rate limit without delay headers", async () => {
    const h = harness([reply(403, { message: "secondary rate limit" }), reply(200, [])]);
    await h.request(issuePath);
    expect(h.waits).toEqual([60_000]);
  });
  it("bounds a hanging response body and aborts it", async () => {
    const h = harness(Array.from({ length: 3 }, () => () => ({ status: 200, headers: new Headers(), text: () => new Promise(() => {}) })), { requestTimeoutMs: 5 });
    await expect(h.request(issuePath)).rejects.toMatchObject({ code: "timeout", attempts: 3 });
    expect(h.calls.every((call) => call.signal.aborted)).toBe(true);
  });
  it.each(["throws", "hangs"])("preserves rate-limit headers when the body %s", async (mode) => {
    for (const status of [403, 429]) {
      const broken = { status, headers: new Headers({ "retry-after": "2" }),
        text: () => mode === "throws" ? Promise.reject(new Error("truncated")) : new Promise(() => {}) };
      const h = harness([broken, reply(200, [])], { requestTimeoutMs: 5 });
      expect(await h.request(issuePath)).toEqual([]);
      expect(h.waits).toEqual([2000]);
      expect(h.calls).toHaveLength(2);
    }
  });
  it.each(["throws", "hangs"])("does not reconcile a known rate-limited write when the body %s", async (mode) => {
    for (const status of [403, 429]) {
      const broken = { status, headers: new Headers({ "retry-after": "2" }),
        text: () => mode === "throws" ? Promise.reject(new Error("truncated")) : new Promise(() => {}) };
      const h = harness([broken], { requestTimeoutMs: 5 });
      await expect(h.request(issuePath, { method: "POST", body: { title: "Signal", body: "Signal" } }))
        .rejects.toMatchObject({ code: "rate_limited", status, outcome: "unknown" });
      expect(h.calls.map((c) => c.method)).toEqual(["POST"]);
      expect(h.waits).toEqual([]);
    }
  });
  it.each(["throws", "hangs"])("preserves auth/reset decisions when the body %s", async (mode) => {
    const text = () => mode === "throws" ? Promise.reject(new Error("truncated")) : new Promise(() => {});
    const auth = harness([{ status: 401, headers: new Headers(), text }], { requestTimeoutMs: 5 });
    await expect(auth.request(issuePath)).rejects.toMatchObject({ code: "authorization_failed", attempts: 1, status: 401 });
    expect(auth.calls).toHaveLength(1);
    expect(auth.waits).toEqual([]);
    const limited = harness([{ status: 403, headers: new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "300" }), text }], { requestTimeoutMs: 5 });
    await expect(limited.request(issuePath)).rejects.toMatchObject({ code: "rate_limited", attempts: 1 });
    expect(limited.calls).toHaveLength(1);
    expect(limited.waits).toEqual([]);
  });
  it("keeps an uncertain write unknown after negative reconciliation, without resending", async () => {
    const h = harness([new Error("connection reset"), reply(200, [])]);
    await expect(h.request(issuePath, { method: "POST", body: { title: "Signal", body: "Signal" } }))
      .rejects.toMatchObject({ code: "mutation_outcome_unknown", outcome: "unknown", attempts: 1 });
    expect(h.calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(h.calls[1].url).toContain("state=all");
  });
  it("reconciles an applied issue even if already closed after a lost response", async () => {
    const record = { number: 3, title: "Signal", body: markedBody, state: "closed", html_url: "https://github.test/3" };
    const h = harness([new Error("lost response"), reply(200, [record])]);
    expect(await h.request(issuePath, { method: "POST", body: { title: "Signal", body: "Signal" } })).toEqual(record);
    expect(h.stats.reconciledWrites).toBe(1);
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("reconciles malformed successful comment response using exact marker and complete pagination", async () => {
    const record = { id: 7, body: markedBody, html_url: "https://github.test/comment" };
    const h = harness([new Response("{", { status: 201 }), reply(200, Array.from({ length: 100 }, () => ({ body: "unrelated" }))), reply(200, [record])]);
    expect(await h.request(`${issuePath}/3/comments`, { method: "POST", body: { body: "Signal" } })).toEqual(record);
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
    expect(h.calls[2].url).toContain("page=2");
  });
  it("does not accept partial or failed reconciliation even after finding a marker", async () => {
    const record = { id: 7, body: markedBody, html_url: "https://github.test/comment" };
    const h = harness([new Error("lost"), reply(200, [record, ...Array.from({ length: 99 }, () => ({ body: "other" }))]), reply(401, {})]);
    await expect(h.request(`${issuePath}/3/comments`, { method: "POST", body: { body: "Signal" } }))
      .rejects.toMatchObject({ outcome: "unknown" });
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
  });
  it("requires exact content, not just marker or similar comment", async () => {
    const h = harness([new Error("lost"), reply(200, [{ body: markedBody + " edited", html_url: "https://github.test/comment" }])]);
    await expect(h.request(`${issuePath}/3/comments`, { method: "POST", body: { body: "Signal" } }))
      .rejects.toMatchObject({ outcome: "unknown" });
  });
  it("reconciles PATCH only from exact intended labels/state and never repeats it", async () => {
    const h = harness([new Error("lost"), reply(200, { number: 3, labels: [{ name: "b" }, { name: "a" }] })]);
    expect(await h.request(`${issuePath}/3`, { method: "PATCH", body: { labels: ["a", "b"] } })).toHaveProperty("number", 3);
    expect(h.calls.map((c) => c.method)).toEqual(["PATCH", "GET"]);
    const mismatched = harness([reply(502, {}), reply(200, { state: "open", state_reason: null })]);
    await expect(mismatched.request(`${issuePath}/3`, { method: "PATCH", body: { state: "closed", state_reason: "completed" } }))
      .rejects.toMatchObject({ outcome: "unknown" });
  });
  it("reconciles label creation by exact name and color", async () => {
    const h = harness([new Error("lost"), reply(200, { name: "ops-incident", color: "b60205" })]);
    await h.request("/repos/test/repo/labels", { method: "POST", body: { name: "ops-incident", color: "B60205" } });
    expect(h.stats.reconciledWrites).toBe(1);
    expect(h.calls).toHaveLength(2);
  });
  it("treats missing write receipt fields as uncertain, even for valid JSON", async () => {
    const h = harness([reply(201, {}), reply(200, [])]);
    await expect(h.request(issuePath, { method: "POST", body: { title: "Signal", body: "Signal" } }))
      .rejects.toMatchObject({ outcome: "unknown" });
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });
  it("does not mistake an invalid-label 422 for a configured existing label", async () => {
    const h = harness([reply(422, { message: "validation failed" }), reply(404, {})]);
    await expect(h.request("/repos/test/repo/labels", { method: "POST", body: { name: "ops", color: "C5DEF5" }, okStatuses: [201, 422] }))
      .rejects.toMatchObject({ code: "request_rejected", status: 404 });
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });
  it("verifies an existing label after 422 without another mutation", async () => {
    const h = harness([reply(422, { message: "already exists" }), reply(200, { name: "ops", color: "C5DEF5" })]);
    expect(await h.request("/repos/test/repo/labels", { method: "POST", body: { name: "ops", color: "C5DEF5" }, okStatuses: [201, 422] })).toHaveProperty("name", "ops");
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });
  it.each([
    { html_url: "https://github.test/3" },
    { number: 3, title: "Signal", body: "wrong marker", html_url: "https://github.test/3" },
    { number: 3, title: "wrong title", body: markedBody, html_url: "https://github.test/3" },
    { number: 3, title: "Signal", body: markedBody, url: "https://api.example.test/repos/other/repo/issues/3", html_url: "https://github.test/3" },
  ])("does not accept incomplete or mismatched successful issue receipts: %j", async (receipt) => {
    const h = harness([reply(201, receipt), reply(200, [])]);
    await expect(h.request(issuePath, { method: "POST", body: { title: "Signal", body: "Signal" } }))
      .rejects.toMatchObject({ outcome: "unknown" });
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });
  it("requires a comment id, exact marker and matching target when supplied", async () => {
    for (const receipt of [
      { body: markedBody, html_url: "https://github.test/comment" },
      { id: 7, body: "wrong marker", html_url: "https://github.test/comment" },
      { id: 7, body: markedBody, html_url: "https://github.test/comment", issue_url: "https://api.example.test/repos/test/repo/issues/4" },
    ]) {
      const h = harness([reply(201, receipt), reply(200, [])]);
      await expect(h.request(`${issuePath}/3/comments`, { method: "POST", body: { body: "Signal" } })).rejects.toMatchObject({ outcome: "unknown" });
      expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    }
  });
  it("does not accept a successful PATCH or readback for another issue", async () => {
    const h = harness([reply(200, { number: 4, state: "closed" }), reply(200, { number: 4, state: "closed" })]);
    await expect(h.request(`${issuePath}/3`, { method: "PATCH", body: { state: "closed" } })).rejects.toMatchObject({ outcome: "unknown" });
    expect(h.calls.map((c) => c.method)).toEqual(["PATCH", "GET"]);
  });
  it("never retries an uncertain 429 mutation even if a retry delay is supplied", async () => {
    const h = harness([reply(429, {}, { "retry-after": "1" }), reply(200, [])]);
    await expect(h.request(issuePath, { method: "POST", body: { title: "Signal", body: "Signal" } })).rejects.toMatchObject({ outcome: "unknown" });
    expect(h.calls.map((call) => call.method)).toEqual(["POST"]);
    expect(h.waits).toEqual([]);
  });
});
