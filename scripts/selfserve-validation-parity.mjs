import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WorkItemParitySmoke } from "./work-item-parity-production-smoke.mjs";
import { openSelfserveValidationSession } from "./selfserve-validation-smoke.mjs";
import { SELFSERVE_VALIDATION_TARGET as target, fullReleaseSha, requireValidation } from "./lib/selfserve-validation-target.mjs";

export function parityRequestAllowed(input, init = {}) {
  const url = new URL(input);
  if (url.origin !== target.origin || url.username || url.password) return false;
  const method = init.method || "GET";
  if (url.pathname === "/api/health") return method === "GET";
  if (url.pathname === "/api/mcp") return method === "POST";
  const prefix = `/api/workspaces/${target.workspaceId}/`;
  if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length);
  if (["members", "webhooks"].includes(path)) return method === "GET";
  if (path === "agent-credentials") return ["GET", "POST"].includes(method);
  if (/^agent-credentials\/[a-zA-Z0-9-]+\/revoke$/.test(path)) return method === "POST";
  return /^(actions|tensions|proposals|goals)(\/[a-zA-Z0-9-]+)?$/.test(path) && ["GET", "POST", "DELETE"].includes(method);
}

export class SelfserveParitySmoke extends WorkItemParitySmoke {
  constructor(env, fetchImpl = fetch) {
    requireValidation(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.SELFSERVE_PARITY_ENABLED === "true",
      "SELFSERVE_PARITY_EXPLICIT_DISPATCH_REQUIRED");
    const expectedGitSha = fullReleaseSha(env.SELFSERVE_VALIDATION_EXPECTED_SHA);
    super({ baseUrl: target.origin, outDir: env.SELFSERVE_PARITY_OUT_DIR || ".artifacts/selfserve-parity",
      expectedGitSha, authEmail: env.SELFSERVE_VALIDATION_EMAIL, authPassword: env.SELFSERVE_VALIDATION_PASSWORD,
      workspaceSelector: { workspaceId: target.workspaceId, workspaceSlug: target.workspaceSlug }, prNumbers: [],
      fetchImpl: async (input, init = {}) => {
        requireValidation(parityRequestAllowed(input, init), "SELFSERVE_PARITY_REQUEST_FORBIDDEN");
        const response = await fetchImpl(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
        requireValidation(response.status < 300 || response.status >= 400, "SELFSERVE_PARITY_REDIRECT_FORBIDDEN");
        return response;
      } });
    this.closedFetch = fetchImpl;
  }

  async login() {
    this.closedSession = await openSelfserveValidationSession({ origin: target.origin, expectedSha: this.expectedGitSha,
      email: this.authEmail, password: this.authPassword, fetchImpl: this.closedFetch });
    this.cookie = this.closedSession.cookie;
    this.workspaceId = target.workspaceId;
    this.validationRun.tenant = { id: target.workspaceId, slug: target.workspaceSlug, label: target.workspaceSlug };
  }
}

export async function runSelfserveParity(env = process.env) {
  const smoke = new SelfserveParitySmoke(env);
  const receipt = { schemaVersion: 1, target: target.name, lane: "work-item-parity-internal", scope: "live-internal-mutation",
    gitSha: smoke.expectedGitSha, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, status: "failed", cleanup: "pending" };
  await mkdir(smoke.outDir, { recursive: true });
  try {
    // Inherited run verifies webhook absence, scoped MCP credential, work-item
    // concurrency, archival and credential revocation. It makes no model calls.
    await smoke.run();
    receipt.status = "passed";
  } finally {
    try { await smoke.closedSession?.close(); receipt.cleanup = receipt.status === "passed" ? "completed" : "failed"; }
    catch { receipt.cleanup = "failed"; receipt.status = "failed"; }
    await writeFile(`${smoke.outDir}/parity.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  requireValidation(receipt.status === "passed", "SELFSERVE_PARITY_FAILED");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runSelfserveParity().catch(() => { console.error("Explicit internal-only parity failed; inspect scoped cleanup evidence."); process.exitCode = 1; });
}
