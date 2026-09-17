import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { selfserveRecoveryAttribution, SELFSERVE_VALIDATION_TARGET, requireValidation } from "./lib/selfserve-validation-target.mjs";

export async function recoveryIntent(env = process.env, fetchImpl = fetch) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const receipt = event.workflow_run?.name === "CI" ? null
    : JSON.parse(await readFile(".artifacts/selfserve-recovery/outcome.json", "utf8"));
  const intent = selfserveRecoveryAttribution({ event, repository: env.GITHUB_REPOSITORY,
    receipt, acceptedSha: env.SELFSERVE_VALIDATION_ACCEPTED_SHA });
  if (intent.action !== "fleet-release") return intent;
  const response = await fetchImpl(`${SELFSERVE_VALIDATION_TARGET.origin}/api/health`, { redirect: "error", signal: AbortSignal.timeout(30000) });
  const health = await response.json();
  requireValidation(health?.app === "corgtex" && health?.service === "web" && health?.release?.gitSha === intent.failedSha,
    "RECOVERY_SERVING_VERSION_CHANGED_OR_UNKNOWN");
  return intent;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const intent = await recoveryIntent();
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      `action=${intent.action}\nrelease=${intent.release || ""}\nfailed_sha=${intent.failedSha || ""}\n`);
    console.log(JSON.stringify(intent));
  } catch {
    console.error("No automatic recovery authority: failed release attribution or current serving-version proof unavailable.");
    process.exitCode = 1;
  }
}
