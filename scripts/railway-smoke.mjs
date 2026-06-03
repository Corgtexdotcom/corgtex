import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_RELEASE_MATCH_TIMEOUT_MS = 300_000;
const DEFAULT_RELEASE_MATCH_INTERVAL_MS = 10_000;

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`OK   ${message}`);
}

export function expectedHealthGitSha(env = process.env) {
  return env.CORGTEX_EXPECTED_RELEASE_GIT_SHA?.trim() || env.GITHUB_SHA?.trim() || null;
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

export function healthReleaseMismatch(health, expectedGitSha) {
  if (!expectedGitSha) return null;

  const actualGitSha = typeof health?.release?.gitSha === "string" ? health.release.gitSha : null;
  if (actualGitSha === expectedGitSha) return null;

  return `/api/health release.gitSha ${actualGitSha ?? "missing"} did not match expected ${expectedGitSha}`;
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

async function waitForExpectedRelease(baseUrl, expectedGitSha, initialMismatch) {
  const { timeoutMs, intervalMs } = releaseMatchRetryConfig();
  const startTime = Date.now();
  let lastMismatch = initialMismatch;

  while (Date.now() - startTime < timeoutMs) {
    await sleep(Math.min(intervalMs, timeoutMs - (Date.now() - startTime)));

    const { healthResponse, health, parseError, fetchError } = await fetchHealth(baseUrl);
    lastMismatch = healthPayloadMismatch(healthResponse, health, parseError, fetchError) ?? healthReleaseMismatch(health, expectedGitSha);
    if (!lastMismatch) return;
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

  const loginResponse = await fetch(new URL("/login", baseUrl));
  const loginHtml = await loginResponse.text();
  if (!loginResponse.ok || !loginHtml.includes("Welcome to Corgtex") || !loginHtml.includes("Corgtex")) {
    fail("/login did not return the Corgtex login page");
  }
  pass("/login serves the Corgtex login page");

  const expectedGitSha = expectedHealthGitSha();
  const { healthResponse, health, parseError, fetchError } = await fetchHealth(baseUrl);
  const healthMismatch = healthPayloadMismatch(healthResponse, health, parseError, fetchError);
  if (healthMismatch && !expectedGitSha) {
    fail(healthMismatch);
  }

  const releaseMismatch = healthMismatch ?? healthReleaseMismatch(health, expectedGitSha);
  if (releaseMismatch && expectedGitSha) {
    await waitForExpectedRelease(baseUrl, expectedGitSha, releaseMismatch);
  }

  pass("/api/health reports the Corgtex fingerprint");
  if (expectedGitSha) {
    pass(`/api/health release.gitSha matches ${expectedGitSha.slice(0, 12)}`);
  }

  const apiLoginResponse = await fetch(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  const apiLoginPayload = await apiLoginResponse.json();
  if (!apiLoginResponse.ok) {
    fail(`/api/auth/login failed: ${JSON.stringify(apiLoginPayload)}`);
  }
  pass("/api/auth/login accepted the seeded admin credentials");

  const cookieHeader = cookieHeaderFromSetCookie(apiLoginResponse.headers.get("set-cookie"));

  const sessionResponse = await fetch(new URL("/api/session", baseUrl), {
    headers: {
      cookie: cookieHeader,
    },
  });
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

  const rootResponse = await fetch(new URL("/", baseUrl), {
    headers: {
      cookie: cookieHeader,
    },
  });
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
