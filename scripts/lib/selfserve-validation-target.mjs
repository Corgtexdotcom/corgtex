// This is a closed internal pilot, not a configurable production tenant selector.
export const SELFSERVE_VALIDATION_TARGET = Object.freeze({
  name: "selfserve-validation",
  fleetTarget: "azure-selfserve",
  origin: "https://selfserve.corgtex.com",
  workspaceId: "b1702569-4f4f-4d37-a008-da4d0e8c5742",
  workspaceSlug: "corgtex-validation",
  ownerUserId: "ddfb5cf4-bf71-4013-acb6-3055dc7a3a58",
});

export function requireValidation(condition, code) {
  if (!condition) throw new Error(code);
}

export function validationTarget(value = "") {
  const mode = String(value || "core");
  requireValidation(["core", SELFSERVE_VALIDATION_TARGET.name].includes(mode), "VALIDATION_TARGET_UNKNOWN");
  return mode;
}

export function fullReleaseSha(value) {
  requireValidation(typeof value === "string" && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value), "VALIDATION_SHA_REQUIRED");
  return value;
}

export function validationRunTarget({ eventName, pinnedTarget, configuredTarget }) {
  requireValidation(eventName !== "push" || Boolean(pinnedTarget), "VALIDATION_PINNED_TARGET_REQUIRED");
  return validationTarget(pinnedTarget || configuredTarget);
}

export function assertSelfserveOrigin(value) {
  requireValidation(value === SELFSERVE_VALIDATION_TARGET.origin, "VALIDATION_ORIGIN_MISMATCH");
  return value;
}

export function assertSelfserveSession(session) {
  const target = SELFSERVE_VALIDATION_TARGET;
  requireValidation(session?.actor?.kind === "user" && session.actor.user?.id === target.ownerUserId
    && session.actor.user?.globalRole === "USER" && session.actor.user?.isSupportAccount !== true, "VALIDATION_IDENTITY_MISMATCH");
  requireValidation(Array.isArray(session.workspaces) && session.workspaces.length === 1
    && session.workspaces[0]?.id === target.workspaceId && session.workspaces[0]?.slug === target.workspaceSlug,
  "VALIDATION_WORKSPACE_MISMATCH");
}

export function selfserveExpectedRelease({ eventName, expectedSha, acceptedSha }) {
  // A source push is not a deployment. Only an explicit release dispatch may
  // select an incoming version; automatic runs stay on the accepted version.
  return fullReleaseSha(eventName === "workflow_dispatch" ? expectedSha : acceptedSha);
}

export function selfserveReadRequestAllowed(url, method = "GET") {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.origin !== SELFSERVE_VALIDATION_TARGET.origin || parsed.username || parsed.password) return false;
  if (!["GET", "HEAD"].includes(method)) return false;
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { return false; }
  if (pathname.startsWith("/_next/static/")) return !pathname.includes("\\")
    && !pathname.split("/").some((segment) => segment === "." || segment === "..");
  const workspace = pathname.match(/\/workspaces\/([^/]+)/);
  return !workspace || workspace[1] === SELFSERVE_VALIDATION_TARGET.workspaceId;
}

export const SELFSERVE_REQUIRED_EVIDENCE = Object.freeze([
  "selfserve-live-read-only", "selfserve-schema-read-only", "source-intake-isolated", "briefing-fixture-isolated",
]);

export function assertSelfserveEvidence(receipts, { expectedSha, runId, runAttempt, parityRequired = false }) {
  fullReleaseSha(expectedSha);
  for (const lane of [...SELFSERVE_REQUIRED_EVIDENCE, ...(parityRequired ? ["work-item-parity-internal"] : [])]) {
    const matching = receipts.filter((receipt) => receipt?.lane === lane);
    requireValidation(matching.length === 1, `REQUIRED_EVIDENCE_MISSING_OR_DUPLICATE:${lane}`);
    const receipt = matching[0];
    requireValidation(receipt.schemaVersion === 1 && receipt.target === SELFSERVE_VALIDATION_TARGET.name
      && receipt.gitSha === expectedSha && receipt.runId === String(runId) && receipt.runAttempt === String(runAttempt)
      && receipt.status === "passed" && receipt.cleanup === "completed", `REQUIRED_EVIDENCE_INVALID:${lane}`);
    const scope = lane === "work-item-parity-internal" ? "live-internal-mutation" : lane.endsWith("-isolated") ? "isolated-synthetic" : "live-read-only";
    requireValidation(receipt.scope === scope,
      `REQUIRED_EVIDENCE_SCOPE:${lane}`);
    if (lane === "selfserve-live-read-only") requireValidation(receipt.navigationPassed === true
      && receipt.identityVerified === true && receipt.servingSha === expectedSha
      && receipt.origin === SELFSERVE_VALIDATION_TARGET.origin && receipt.workspaceId === SELFSERVE_VALIDATION_TARGET.workspaceId
      && receipt.ownerUserId === SELFSERVE_VALIDATION_TARGET.ownerUserId, "REQUIRED_LIVE_NAVIGATION_EVIDENCE");
    if (lane === "selfserve-schema-read-only") requireValidation(receipt.exactLedgerMatch === true
      && receipt.supportedSchemaMatch === true && /^[a-f0-9]{64}$/.test(receipt.manifestSha256 || "")
      && /^[a-f0-9]{64}$/.test(receipt.datamodelSha256 || "") && receipt.catalogAlgorithm === "SELFSERVE_PUBLIC_PG16_V1"
      && /^[a-f0-9]{64}$/.test(receipt.expectedCatalogSha256 || "")
      && receipt.expectedCatalogSha256 === receipt.actualCatalogSha256, "REQUIRED_EXACT_SCHEMA_EVIDENCE");
  }
}

export function selfserveRecoveryAttribution({ event, repository, receipt, acceptedSha }) {
  const run = event?.workflow_run;
  requireValidation(repository === "Corgtexdotcom/corgtex" && run?.head_repository?.full_name === repository
    && run.head_branch === "main", "RECOVERY_UNTRUSTED_RUN");
  // Automatic CI failures never authorize source reverts or fleet operations.
  if (run.name === "CI") return { action: "none", reason: "source-ci-is-not-a-deployment" };
  requireValidation(run.name === "Production Validation" && run.event === "workflow_dispatch" && run.conclusion === "failure",
    "RECOVERY_NOT_EXPLICIT_RELEASE");
  requireValidation(receipt?.schemaVersion === 1 && receipt.target === SELFSERVE_VALIDATION_TARGET.name
    && receipt.origin === SELFSERVE_VALIDATION_TARGET.origin && receipt.workspaceId === SELFSERVE_VALIDATION_TARGET.workspaceId
    && receipt.runId === String(run.id) && receipt.runAttempt === String(run.run_attempt)
    && receipt.validationKind === "explicit-release" && receipt.status === "failed" && receipt.liveFailure === true
    && receipt.identityVerified === true && receipt.servingSha === receipt.expectedSha,
  "RECOVERY_RELEASE_NOT_ATTRIBUTED");
  fullReleaseSha(receipt.expectedSha);
  fullReleaseSha(acceptedSha);
  requireValidation(acceptedSha !== receipt.expectedSha, "RECOVERY_NO_DISTINCT_ACCEPTED_VERSION");
  return { action: "fleet-release", target: SELFSERVE_VALIDATION_TARGET.fleetTarget,
    failedSha: receipt.expectedSha, release: acceptedSha, sourceRevert: false };
}
