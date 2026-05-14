#!/usr/bin/env node

import { performance } from "node:perf_hooks";

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function positiveInt(value, fallback, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("A base URL is required. Pass --base-url or set NIGHTLY_LOAD_BASE_URL.");
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function pathsFromEnvOrArgs(args) {
  if (args.paths) {
    return String(args.paths).split(",").map((path) => path.trim()).filter(Boolean);
  }
  if (process.env.NIGHTLY_LOAD_PATHS_JSON) {
    const parsed = JSON.parse(process.env.NIGHTLY_LOAD_PATHS_JSON);
    if (!Array.isArray(parsed)) throw new Error("NIGHTLY_LOAD_PATHS_JSON must be an array.");
    return parsed.map(String);
  }
  return ["/api/health"];
}

async function fetchOnce(baseUrl, path) {
  const startedAt = performance.now();
  const url = new URL(path, baseUrl);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "corgtex-nightly-load-smoke/1.0" },
    });
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      path,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      path,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runLoadSmoke(options) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < options.requests) {
      const requestIndex = cursor;
      cursor += 1;
      const path = options.paths[requestIndex % options.paths.length];
      results.push(await fetchOnce(options.baseUrl, path));
    }
  }
  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = {
    baseUrl: normalizeBaseUrl(args["base-url"] || process.env.NIGHTLY_LOAD_BASE_URL || process.env.APP_URL),
    requests: positiveInt(args.requests || process.env.NIGHTLY_LOAD_REQUESTS, 60, "requests"),
    concurrency: positiveInt(args.concurrency || process.env.NIGHTLY_LOAD_CONCURRENCY, 6, "concurrency"),
    p95Ms: positiveInt(args["p95-ms"] || process.env.NIGHTLY_LOAD_P95_MS, 2000, "p95-ms"),
    paths: pathsFromEnvOrArgs(args),
  };

  const results = await runLoadSmoke(options);
  const failures = results.filter((result) => !result.ok);
  const elapsed = results.map((result) => result.elapsedMs);
  const summary = {
    checkedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    paths: options.paths,
    requests: options.requests,
    concurrency: options.concurrency,
    failures: failures.length,
    minMs: Math.min(...elapsed),
    p50Ms: percentile(elapsed, 50),
    p95Ms: percentile(elapsed, 95),
    maxMs: Math.max(...elapsed),
  };

  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) {
    console.error(JSON.stringify({ failures: failures.slice(0, 10) }, null, 2));
    process.exit(1);
  }
  if (summary.p95Ms > options.p95Ms) {
    console.error(`p95 latency ${summary.p95Ms}ms exceeded ${options.p95Ms}ms.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

