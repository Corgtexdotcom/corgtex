import { randomUUID } from "node:crypto";

export class GitHubSyncError extends Error {
  constructor(code, { method, status = null, attempts = 0, outcome = "failed" } = {}) {
    super(`GitHub sync ${code} (${method ?? "GET"}, attempts=${attempts}).`);
    Object.assign(this, { code, method, status, attempts, outcome });
  }
}

// Only reads are retried. Every mutation is sent once, even after a timeout or
// malformed success response. Readback can prove success, never safe absence.
export function createGitHubClient(api, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  requestTimeoutMs = 10_000,
  budgetMs = 120_000,
  operationId = randomUUID,
} = {}) {
  const deadline = now() + budgetMs;
  const stats = { requests: 0, readRetries: 0, reconciledWrites: 0 };
  const fail = (code, method, extra = {}) => new GitHubSyncError(code, { method, ...extra });

  async function once(path, options, timeoutMs) {
    const controller = new AbortController();
    let timer;
    let receivedResponse;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(fail("timeout", options.method));
      }, timeoutMs);
    });
    try {
      return await Promise.race([expired, (async () => {
        stats.requests += 1;
        const response = await fetchImpl(`${api.baseUrl}${path}`, {
          method: options.method,
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${api.token}`,
            "Content-Type": "application/json",
            "User-Agent": "corgtex-ops-monitor",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
        });
        receivedResponse = response;
        // The same deadline covers headers AND the entire response body.
        const text = await response.text();
        let payload = null;
        let malformed = text.length > 2_000_000;
        try { payload = text && !malformed ? JSON.parse(text) : null; } catch { malformed = true; }
        return { response, payload, malformed };
      })()]);
    } catch (error) {
      // Header evidence survives a truncated or timed-out body. In particular,
      // never turn an already received auth/rate response into a generic retry.
      if (receivedResponse) return { response: receivedResponse, payload: null, malformed: true,
        bodyFailure: error instanceof GitHubSyncError ? error.code : "transport_failed" };
      throw error;
    } finally { clearTimeout(timer); }
  }

  function rateDelay(response, payload) {
    if (response.status !== 429 && !(response.status === 403 && (
      response.headers.get("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"
      || /rate limit|abuse detection/i.test(payload?.message ?? "")
    ))) return null;
    const after = response.headers.get("retry-after");
    const reset = response.headers.get("x-ratelimit-reset");
    const delays = [];
    if (after) {
      const seconds = Number(after);
      const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - now();
      if (!Number.isFinite(ms)) return Infinity;
      delays.push(Math.max(0, ms));
    }
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      if (!reset || !Number.isFinite(Number(reset))) return Infinity;
      delays.push(Math.max(0, Number(reset) * 1000 - now()));
    }
    return delays.length ? Math.max(...delays) : 60_000;
  }

  async function raw(path, options = {}) {
    const method = options.method ?? "GET";
    const read = method === "GET";
    const attemptsLimit = read ? 3 : 1;
    for (let attempts = 1; attempts <= attemptsLimit; attempts += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) throw fail("budget_exhausted", method, { attempts: attempts - 1 });
      let result;
      let code = "transport_failed";
      let waitMs = 250 * 2 ** (attempts - 1);
      try { result = await once(path, { ...options, method }, Math.min(requestTimeoutMs, remaining)); }
      catch (error) { code = error instanceof GitHubSyncError ? error.code : "transport_failed"; }
      if (result) {
        const { response, payload, malformed } = result;
        const status = response.status;
        let valid = !malformed && payload !== null;
        try { if (valid && options.validate) valid = options.validate(payload, status); }
        catch { valid = false; }
        if ((options.okStatuses ?? [200, 201]).includes(status) && valid) return payload;
        const delay = rateDelay(response, payload);
        if (status === 401 || (status === 403 && delay === null)) {
          throw fail("authorization_failed", method, { status, attempts });
        }
        if (delay !== null) { code = "rate_limited"; waitMs = Math.max(waitMs, delay); }
        else if (status >= 200 && status < 300) code = result.bodyFailure ?? "invalid_response";
        else if (status === 408 || status >= 500) code = "server_failed";
        else throw fail("request_rejected", method, { status, attempts });
        if (!read) throw fail(code, method, { status, attempts, outcome: "unknown" });
      }
      if (!read) throw fail(code, method, { attempts, outcome: "unknown" });
      if (attempts === attemptsLimit || waitMs + requestTimeoutMs > deadline - now()) {
        throw fail(code, method, { attempts, status: result?.response.status });
      }
      stats.readRetries += 1;
      await sleep(waitMs);
    }
  }

  async function listAll(path) {
    const items = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await raw(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw fail("invalid_response", "GET");
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw fail("reconciliation_incomplete", "GET");
  }

  async function request(path, options = {}) {
    const method = options.method ?? "GET";
    if (method === "GET") return raw(path, options);
    const body = { ...options.body };
    const marked = method === "POST" && /\/issues(?:\/\d+\/comments)?$/.test(path);
    const marker = marked ? `<!-- corgtex-ops-operation:${operationId()} -->` : null;
    if (marker) body.body = `${body.body}\n\n${marker}`;
    const issueNumber = Number(path.match(/\/issues\/(\d+)$/)?.[1]);
    const intendedStateMatches = (issue) => issue && typeof issue === "object" && !Array.isArray(issue)
      && issue.number === issueNumber
      && Object.entries(body).every(([key, value]) => key === "labels"
        ? Array.isArray(issue.labels) && JSON.stringify(issue.labels.map((label) => label?.name ?? label).sort()) === JSON.stringify([...value].sort())
        : issue[key] === value);
    const markedReceiptMatches = (payload) => {
      if (!payload || payload.body !== body.body || !payload.html_url || payload.pull_request) return false;
      if (path.endsWith("/issues")) return Number.isSafeInteger(payload.number) && payload.number > 0
        && payload.title === body.title && (!payload.url || payload.url === `${api.baseUrl}${path}/${payload.number}`);
      return Number.isSafeInteger(payload.id) && payload.id > 0
        && (!payload.issue_url || payload.issue_url === `${api.baseUrl}${path.replace(/\/comments$/, "")}`);
    };
    const validate = (payload, status) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      if (marker) return markedReceiptMatches(payload);
      if (method === "PATCH" && /\/issues\/\d+$/.test(path)) return intendedStateMatches(payload);
      return status !== 422 && Object.entries(body).every(([key, value]) => payload[key]?.toLowerCase?.() === value?.toLowerCase?.());
    };
    try { return await raw(path, { ...options, method, body, validate }); }
    catch (error) {
      if (error instanceof GitHubSyncError && error.status === 422 && method === "POST" && path.endsWith("/labels")) {
        // 422 can mean either an existing label or invalid configuration. Verify
        // existence rather than treating every validation error as success.
        const label = await raw(`${path}/${encodeURIComponent(body.name)}`);
        if (label?.name === body.name) return label;
        throw error;
      }
      if (!(error instanceof GitHubSyncError) || error.outcome !== "unknown") throw error;
      // A rate-limit response forbids immediately making even reconciliation reads.
      // Defer to the next observation, without resending this uncertain operation.
      if (error.code === "rate_limited") throw error;
      try {
        let result;
        if (marker) {
          const items = await listAll(path.endsWith("/issues") ? `${path}?state=all` : path);
          const matches = items.filter(markedReceiptMatches);
          if (matches.length === 1) result = matches[0];
        } else if (method === "POST" && path.endsWith("/labels")) {
          const label = await raw(`${path}/${encodeURIComponent(body.name)}`);
          if (label.name === body.name && label.color?.toLowerCase() === body.color?.toLowerCase()) result = label;
        } else if (method === "PATCH" && /\/issues\/\d+$/.test(path)) {
          const issue = await raw(path);
          if (intendedStateMatches(issue)) result = issue;
        }
        if (result) { stats.reconciledWrites += 1; return result; }
      } catch { /* Failed or incomplete readback cannot establish the write outcome. */ }
      throw fail("mutation_outcome_unknown", method, { status: error.status, attempts: 1, outcome: "unknown" });
    }
  }
  return { request, stats };
}
