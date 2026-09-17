import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSelfserveEvidence, SELFSERVE_VALIDATION_TARGET as target } from "./lib/selfserve-validation-target.mjs";

export function boundLiveReceipt(receipts, { expectedSha, runId, runAttempt }) {
  const live = receipts.filter((receipt) => receipt?.lane === "selfserve-live-read-only");
  if (live.length !== 1 || !/^[a-f0-9]{40}$/.test(expectedSha || "") || !runId || !runAttempt) return null;
  const receipt = live[0];
  return receipt.schemaVersion === 1 && receipt.target === target.name && receipt.origin === target.origin
    && receipt.workspaceId === target.workspaceId && receipt.ownerUserId === target.ownerUserId
    && receipt.gitSha === expectedSha && receipt.runId === String(runId) && receipt.runAttempt === String(runAttempt)
    && receipt.scope === "live-read-only" && ["passed", "failed"].includes(receipt.status) ? receipt : null;
}

export async function loadSelfserveReceipts(directory) {
  const receipts = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) receipts.push(...await loadSelfserveReceipts(join(directory, entry.name)));
    else if (entry.name.endsWith(".receipt.json")) receipts.push(JSON.parse(await readFile(join(directory, entry.name), "utf8")));
  }
  return receipts;
}

export async function selfserveOutcome(env = process.env) {
  const receipts = await loadSelfserveReceipts(env.SELFSERVE_VALIDATION_COLLECTED_DIR || ".artifacts/selfserve-validation-collected");
  let status = "passed";
  let blocker;
  try {
    if (env.SELFSERVE_LIVE_RESULT !== "success" || env.SELFSERVE_ISOLATED_RESULT !== "success") {
      throw new Error("REQUIRED_VALIDATION_JOB_FAILED_OR_SKIPPED");
    }
    assertSelfserveEvidence(receipts, { expectedSha: env.SELFSERVE_VALIDATION_EXPECTED_SHA,
      runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, parityRequired: env.SELFSERVE_PARITY_ENABLED === "true" });
    if (env.SELFSERVE_PARITY_ENABLED === "true" && env.SELFSERVE_PARITY_RESULT !== "success") {
      throw new Error("REQUIRED_PARITY_JOB_FAILED_OR_SKIPPED");
    }
  } catch (error) { status = "failed"; blocker = error.message; }
  // Missing isolated/schema evidence is an infrastructure/coverage failure, not
  // proof of a broken deployed release. Only the live lane attributes recovery.
  const live = boundLiveReceipt(receipts, { expectedSha: env.SELFSERVE_VALIDATION_EXPECTED_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT });
  const liveFailure = live?.status === "failed" && live.identityVerified === true
    && live.servingSha === env.SELFSERVE_VALIDATION_EXPECTED_SHA && live.failureKind === "confirmed-route";
  const report = { schemaVersion: 1, target: target.name, origin: target.origin, workspaceId: target.workspaceId,
    status, blocker, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    expectedSha: env.SELFSERVE_VALIDATION_EXPECTED_SHA, servingSha: live?.servingSha,
    identityVerified: live?.identityVerified === true,
    validationKind: env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "explicit-release" : "accepted-serving",
    liveFailure, failureKind: status === "passed" ? null : liveFailure ? "attributed-live-release" : "infrastructure-unattributed",
    sourceRevert: false };
  const out = env.SELFSERVE_VALIDATION_OUT_DIR || ".artifacts/selfserve-validation-outcome";
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "outcome.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await selfserveOutcome();
    console.log(JSON.stringify(result));
    if (result.status !== "passed") process.exitCode = 1;
  } catch {
    console.error("Selfserve required outcome artifacts missing or unreadable.");
    process.exitCode = 1;
  }
}
