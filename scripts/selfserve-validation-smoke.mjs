import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { healthPayloadMismatch, healthReleaseValidationMismatch } from "./railway-smoke.mjs";
import {
  SELFSERVE_VALIDATION_TARGET as target, assertSelfserveOrigin, assertSelfserveSession,
  fullReleaseSha, requireValidation, selfserveReadRequestAllowed,
} from "./lib/selfserve-validation-target.mjs";

// Cookies stay in memory. No caller receives credentials or response bodies in
// artifacts. Only authentication/logout POSTs are allowed in this live lane.
export async function openSelfserveValidationSession({ origin, expectedSha, email, password, fetchImpl = fetch, onVerified = () => {} }) {
  assertSelfserveOrigin(origin);
  fullReleaseSha(expectedSha);
  requireValidation(Boolean(email?.trim() && password?.trim()), "VALIDATION_DEDICATED_CREDENTIALS_REQUIRED");
  let cookie;
  async function request(path, init = {}) {
    const url = new URL(path, origin);
    requireValidation(url.origin === origin && !url.username && !url.password, "VALIDATION_REQUEST_ORIGIN");
    const method = init.method || "GET";
    requireValidation(selfserveReadRequestAllowed(url.href, method)
      || (method === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(url.pathname)), "VALIDATION_REQUEST_FORBIDDEN");
    const response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { ...init.headers, ...(cookie ? { cookie } : {}) } });
    return response;
  }
  async function readPage(path) {
    let next = new URL(path, origin);
    for (let hops = 0; hops < 6; hops++) {
      requireValidation(selfserveReadRequestAllowed(next.href), "VALIDATION_REDIRECT_FORBIDDEN");
      const response = await request(next.href);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        requireValidation(Boolean(response.headers.get("location")), "VALIDATION_REDIRECT_MISSING");
        next = new URL(response.headers.get("location"), next);
        continue;
      }
      requireValidation(response.ok, "VALIDATION_PAGE_FAILED");
      return { html: await response.text(), url: next };
    }
    throw new Error("VALIDATION_REDIRECT_LIMIT");
  }
  async function close() {
    if (!cookie) return;
    try {
      const response = await request("/api/auth/logout", { method: "POST" });
      requireValidation(response.ok, "VALIDATION_LOGOUT_FAILED");
      cookie = undefined;
    } catch { throw new Error("VALIDATION_LOGOUT_FAILED"); }
  }
  try {
    const response = await request("/api/health");
    const health = await response.json().catch(() => null);
    requireValidation(!healthPayloadMismatch(response, health)
      && !healthReleaseValidationMismatch(health, expectedSha, { requireConfiguredMatch: true })
      && health?.release?.runtime?.gitSha === expectedSha && health.release.runtime.evidence === "baked", "VALIDATION_HEALTH_OR_SHA_MISMATCH");
    const loginPage = await readPage("/login");
    requireValidation(loginPage.html.includes("Welcome to Corgtex"), "VALIDATION_LOGIN_PAGE_MISMATCH");
    const login = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }) });
    cookie = login.headers.get("set-cookie")?.split(";")[0];
    requireValidation(login.ok && Boolean(cookie), "VALIDATION_LOGIN_FAILED");
    const session = await request("/api/session");
    requireValidation(session.ok, "VALIDATION_SESSION_FAILED");
    assertSelfserveSession(await session.json());
    // The normal GET requires supportOwnerUserId plus active HUMAN ADMIN. Never
    // read or retain the returned grant list, which contains named accounts.
    const owner = await request(`/api/workspaces/${target.workspaceId}/support-access`);
    requireValidation(owner.ok, "VALIDATION_OWNER_MISMATCH");
    await owner.body?.cancel();
    onVerified({ servingSha: expectedSha, identityVerified: true });
    const root = await readPage("/");
    requireValidation(root.url.pathname.match(new RegExp(`^/(?:en/)?workspaces/${target.workspaceId}(?:/|$)`))
      && !root.html.includes("Company OS"), "VALIDATION_NAVIGATION_MISMATCH");
    return { cookie, close, servingSha: expectedSha, identityVerified: true };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runSelfserveSmoke(env = process.env) {
  const outDir = env.SELFSERVE_VALIDATION_OUT_DIR || ".artifacts/selfserve-validation";
  const expectedSha = fullReleaseSha(env.SELFSERVE_VALIDATION_EXPECTED_SHA);
  const receipt = { schemaVersion: 1, lane: "selfserve-live-read-only", target: target.name, origin: target.origin,
    workspaceId: target.workspaceId, ownerUserId: target.ownerUserId, gitSha: expectedSha, expectedSha, runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT, validationKind: env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "explicit-release" : "accepted-serving",
    scope: "live-read-only", status: "failed", cleanup: "pending", identityVerified: false };
  await mkdir(outDir, { recursive: true });
  let session;
  try {
    session = await openSelfserveValidationSession({ origin: env.SELFSERVE_VALIDATION_ORIGIN || target.origin, expectedSha,
      email: env.SELFSERVE_VALIDATION_EMAIL, password: env.SELFSERVE_VALIDATION_PASSWORD,
      onVerified: (proof) => Object.assign(receipt, proof) });
    receipt.identityVerified = true;
    receipt.servingSha = session.servingSha;
    receipt.status = "passed";
  } catch (error) {
    receipt.blocker = /^VALIDATION_[A-Z_]+$/.test(error.message) ? error.message : "VALIDATION_REQUEST_FAILED";
    receipt.cleanup = error.message === "VALIDATION_LOGOUT_FAILED" ? "failed" : "completed";
    throw error;
  } finally {
    try { if (session) { await session.close(); receipt.cleanup = "completed"; } }
    catch { receipt.status = "failed"; receipt.cleanup = "failed"; }
    await writeFile(`${outDir}/live.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  requireValidation(receipt.status === "passed", "VALIDATION_LIVE_FAILED");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runSelfserveSmoke().catch(() => { console.error("Selfserve closed-target smoke failed; inspect sanitized receipt."); process.exitCode = 1; });
}
