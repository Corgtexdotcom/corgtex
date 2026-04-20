import process from "node:process";

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`OK   ${message}`);
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

  const healthResponse = await fetch(new URL("/api/health", baseUrl));
  const health = await healthResponse.json();
  if (
    !healthResponse.ok ||
    health.status !== "ok" ||
    health.service !== "web" ||
    health.database !== "up" ||
    health.schema !== "ready" ||
    health.app !== "corgtex" ||
    health.auth !== "password-session"
  ) {
    fail(`/api/health returned an unexpected payload: ${JSON.stringify(health)}`);
  }
  pass("/api/health reports the Corgtex fingerprint");

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
