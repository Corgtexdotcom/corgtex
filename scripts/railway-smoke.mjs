import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  healthConfiguredReleaseDrift,
  healthReleaseMismatch,
  healthReleaseValidationMismatch,
} from "./lib/release-health-validation.mjs";

export {
  healthConfiguredReleaseDrift,
  healthReleaseMismatch,
  healthReleaseValidationMismatch,
} from "./lib/release-health-validation.mjs";

const DEFAULT_RELEASE_MATCH_TIMEOUT_MS = 300_000;
const DEFAULT_RELEASE_MATCH_INTERVAL_MS = 10_000;
const DEFAULT_FETCH_ATTEMPTS = 3;
const DEFAULT_FETCH_RETRY_INTERVAL_MS = 2_000;

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`OK   ${message}`);
}

function warn(message) {
  console.warn(`WARN ${message}`);
}

export function expectedHealthGitSha(env = process.env) {
  if (releaseMatchDisabled(env)) {
    return null;
  }
  return env.CORGTEX_EXPECTED_RELEASE_GIT_SHA?.trim() || env.GITHUB_SHA?.trim() || null;
}

export function releaseMatchDisabled(env = process.env) {
  const value = env.CORGTEX_SKIP_RELEASE_MATCH?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function configuredReleaseMatchRequired(env = process.env) {
  const value = env.CORGTEX_REQUIRE_CONFIGURED_RELEASE_MATCH?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function positiveIntegerEnv(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function releaseMatchRetryConfig(env = process.env) {
  return {
    timeoutMs: positiveIntegerEnv(env, "CORGTEX_RELEASE_MATCH_TIMEOUT_MS", DEFAULT_RELEASE_MATCH_TIMEOUT_MS),
    intervalMs: positiveIntegerEnv(env, "CORGTEX_RELEASE_MATCH_INTERVAL_MS", DEFAULT_RELEASE_MATCH_INTERVAL_MS),
  };
}

export function smokeFetchRetryConfig(env = process.env) {
  return {
    attempts: positiveIntegerEnv(env, "CORGTEX_SMOKE_FETCH_ATTEMPTS", DEFAULT_FETCH_ATTEMPTS),
    intervalMs: positiveIntegerEnv(env, "CORGTEX_SMOKE_FETCH_RETRY_INTERVAL_MS", DEFAULT_FETCH_RETRY_INTERVAL_MS),
  };
}

function errorMessage(error) {
  return error?.message ?? String(error);
}

export function healthPayloadMismatch(healthResponse, health, parseError = null, fetchError = null) {
  if (fetchError) {
    return `/api/health fetch failed: ${errorMessage(fetchError)}`;
  }

  if (parseError) {
    return `/api/health returned a non-JSON payload: ${errorMessage(parseError)}`;
  }

  if (
    healthResponse?.ok &&
    health?.status === "ok" &&
    health.service === "web" &&
    health.database === "up" &&
    health.schema === "ready" &&
    health.app === "corgtex" &&
    health.auth === "password-session"
  ) {
    return null;
  }

  return `/api/health returned an unexpected payload: ${JSON.stringify(health)}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithRetry(url, init, label) {
  const { attempts, intervalMs } = smokeFetchRetryConfig();
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status < 500 || attempt === attempts) {
        return response;
      }

      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }

    await sleep(intervalMs);
  }

  throw new Error(`${label} failed after ${attempts} attempt(s): ${errorMessage(lastError)}`, { cause: lastError });
}

async function fetchHealth(baseUrl) {
  let healthResponse;
  try {
    healthResponse = await fetch(new URL("/api/health", baseUrl));
  } catch (error) {
    return { healthResponse: null, health: null, parseError: null, fetchError: error };
  }

  try {
    const health = await healthResponse.json();
    return { healthResponse, health, parseError: null, fetchError: null };
  } catch (error) {
    return { healthResponse, health: null, parseError: error, fetchError: null };
  }
}

async function waitForExpectedRelease(baseUrl, expectedGitSha, initialMismatch, { requireConfiguredReleaseMatch = false } = {}) {
  const { timeoutMs, intervalMs } = releaseMatchRetryConfig();
  const startTime = Date.now();
  let lastMismatch = initialMismatch;

  while (Date.now() - startTime < timeoutMs) {
    await sleep(Math.min(intervalMs, timeoutMs - (Date.now() - startTime)));

    const { healthResponse, health, parseError, fetchError } = await fetchHealth(baseUrl);
    lastMismatch = healthPayloadMismatch(healthResponse, health, parseError, fetchError)
      ?? healthReleaseValidationMismatch(health, expectedGitSha, { requireConfiguredMatch: requireConfiguredReleaseMatch });
    if (!lastMismatch) return health;
  }

  fail(`${lastMismatch}; expected release did not appear within ${timeoutMs}ms`);
}

function cookieHeaderFromSetCookie(setCookie) {
  if (!setCookie) {
    fail("missing session cookie from /api/auth/login");
  }

  const [cookie] = setCookie.split(";");
  if (!cookie) {
    fail("could not parse session cookie");
  }

  return cookie;
}

async function main() {
  const [rawBaseUrl, email, password] = process.argv.slice(2);
  const baseUrl = rawBaseUrl ?? process.env.APP_URL;

  if (!baseUrl || !email || !password) {
    fail("usage: npm run smoke:railway -- <base-url> <email> <password>");
  }

  const expectedGitSha = expectedHealthGitSha();
  const requireConfiguredReleaseMatch = configuredReleaseMatchRequired();
  let { healthResponse, health, parseError, fetchError } = await fetchHealth(baseUrl);
  const healthMismatch = healthPayloadMismatch(healthResponse, health, parseError, fetchError);
  if (healthMismatch && !expectedGitSha) {
    fail(healthMismatch);
  }

  const releaseMismatch = healthMismatch
    ?? healthReleaseValidationMismatch(health, expectedGitSha, { requireConfiguredMatch: requireConfiguredReleaseMatch });
  if (releaseMismatch && expectedGitSha) {
    health = await waitForExpectedRelease(baseUrl, expectedGitSha, releaseMismatch, { requireConfiguredReleaseMatch });
  }

  pass("/api/health reports the Corgtex fingerprint");
  if (expectedGitSha) {
    pass(`/api/health release.gitSha matches ${expectedGitSha.slice(0, 12)}`);
  }
  const configuredDrift = healthConfiguredReleaseDrift(health, expectedGitSha);
  if (configuredDrift) {
    if (requireConfiguredReleaseMatch) {
      fail(configuredDrift);
    }
    warn(configuredDrift);
  } else {
    pass("/api/health release configured metadata matches runtime metadata");
  }

  const loginResponse = await fetchWithRetry(new URL("/login", baseUrl), undefined, "/login");
  const loginHtml = await loginResponse.text();
  if (!loginResponse.ok || !loginHtml.includes("Welcome to Corgtex") || !loginHtml.includes("Corgtex")) {
    fail("/login did not return the Corgtex login page");
  }
  pass("/login serves the Corgtex login page");

  const apiLoginResponse = await fetchWithRetry(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  }, "/api/auth/login");
  const apiLoginPayload = await apiLoginResponse.json();
  if (!apiLoginResponse.ok) {
    fail(`/api/auth/login failed: ${JSON.stringify(apiLoginPayload)}`);
  }
  pass("/api/auth/login accepted the seeded admin credentials");

  const cookieHeader = cookieHeaderFromSetCookie(apiLoginResponse.headers.get("set-cookie"));

  const sessionResponse = await fetchWithRetry(new URL("/api/session", baseUrl), {
    headers: {
      cookie: cookieHeader,
    },
  }, "/api/session");
  const sessionPayload = await sessionResponse.json();
  if (
    !sessionResponse.ok ||
    sessionPayload.actor?.kind !== "user" ||
    !Array.isArray(sessionPayload.workspaces) ||
    sessionPayload.workspaces.length === 0
  ) {
    fail(`/api/session failed after login: ${JSON.stringify(sessionPayload)}`);
  }
  pass("/api/session resolves the logged-in actor and workspaces");

  const rootResponse = await fetchWithRetry(new URL("/", baseUrl), {
    headers: {
      cookie: cookieHeader,
    },
  }, "/");
  const rootHtml = await rootResponse.text();
  if (!rootResponse.ok || rootResponse.url.endsWith("/login") || rootHtml.includes("Company OS")) {
    fail("the authenticated root route does not look like the Corgtex workspace flow");
  }
  pass("/ resolves into the authenticated workspace flow");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
