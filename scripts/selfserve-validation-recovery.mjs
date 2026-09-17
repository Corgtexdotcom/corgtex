import { readFile, appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { selfserveRecoveryAttribution, SELFSERVE_VALIDATION_TARGET, requireValidation } from "./lib/selfserve-validation-target.mjs";
import { healthPayloadMismatch, healthReleaseValidationMismatch } from "./railway-smoke.mjs";

export function failedCoreSmokeJob({ event, repository, jobs }) {
  const run = event?.workflow_run;
  if (repository !== "Corgtexdotcom/corgtex" || run?.head_repository?.full_name !== repository
    || run.head_branch !== "main" || run.name !== "CI" || run.conclusion !== "failure"
    || !/^[a-f0-9]{40}$/.test(run.head_sha || "") || !run.id || !run.run_attempt) return false;
  const matches = jobs.filter((job) => job.name === "Production Smoke Test");
  return matches.length === 1 && matches[0].conclusion === "failure" && matches[0].status === "completed"
    && matches[0].run_id === run.id && matches[0].run_attempt === run.run_attempt && matches[0].head_sha === run.head_sha;
}

export async function recoveryAttribution(env = process.env) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  let receipt = null;
  if (event.workflow_run?.name !== "CI") {
    try {
      receipt = JSON.parse(await readFile(".artifacts/selfserve-recovery/outcome.json", "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { action: "none", reason: "no-selfserve-outcome" };
      throw error;
    }
  }
  return selfserveRecoveryAttribution({ event, repository: env.GITHUB_REPOSITORY,
    receipt, acceptedSha: env.SELFSERVE_VALIDATION_ACCEPTED_SHA });
}

export async function recoveryIntent(env = process.env, fetchImpl = fetch) {
  const intent = await recoveryAttribution(env);
  if (intent.action !== "fleet-release") return intent;
  const response = await fetchImpl(`${SELFSERVE_VALIDATION_TARGET.origin}/api/health`, {
    redirect: "error", cache: "no-store", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30000),
  });
  const health = await response.json();
  requireValidation(!healthPayloadMismatch(response, health)
    && !healthReleaseValidationMismatch(health, intent.failedSha, { requireConfiguredMatch: true })
    && health?.release?.runtime?.gitSha === intent.failedSha && health.release.runtime.evidence === "baked",
    "RECOVERY_SERVING_VERSION_CHANGED_OR_UNKNOWN");
  return intent;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.includes("--core-smoke-failure")) {
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
      const pages = JSON.parse(readFileSync(0, "utf8"));
      const trigger = failedCoreSmokeJob({ event, repository: process.env.GITHUB_REPOSITORY,
        jobs: pages.flatMap((page) => page.jobs) });
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `trigger=${trigger}\n`);
      console.log(`Exact failed Core smoke in triggering attempt: ${trigger}`);
    } else {
      const intent = process.argv.includes("--attribute-only") ? await recoveryAttribution() : await recoveryIntent();
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
        `action=${intent.action}\nrelease=${intent.release || ""}\nfailed_sha=${intent.failedSha || ""}\n`);
      console.log(JSON.stringify(intent));
    }
  } catch {
    console.error("No automatic recovery authority: failed release attribution or current serving-version proof unavailable.");
    process.exitCode = 1;
  }
}
