import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function fleetReleaseSummary(env) {
  const dryRun = env.DRY_RUN_INPUT === "true";
  const verified = !dryRun && env.PROMOTION_VERIFIED === "true"
    && env.PROMOTION_OUTCOME === "success" && env.OBSERVATION_OUTCOME === "success";
  const status = dryRun
    ? env.PLAN_OUTCOME === "success" ? "DRY RUN ONLY" : "DRY RUN FAILED"
    : verified ? "RELEASE VERIFIED" : "RELEASE NOT VERIFIED";
  const detail = dryRun
    ? "No provider promotion occurred. A successful dry run is planning evidence only; image availability and live readiness remain unproven."
    : verified
      ? "Selected targets passed promotion and post-deploy observation. This does not prove release of unselected targets or customer acceptance."
      : "Promotion or observation did not complete successfully. Providers may already have changed; inspect current revision, image, traffic and health before retrying. Do not infer an outage or a rollback from this result.";
  const literal = (value) => String(value || "unavailable").replace(/[\r\n`]/g, " ");
  return {
    verified,
    summary: `## ${status}\n\n${detail}\n\n- Release: \`${literal(env.RELEASE_SHA)}\`\n- Selected targets: \`${literal(env.TARGETS_INPUT)}\`\n- ${dryRun ? "Plan" : "Preflight"}: ${literal(dryRun ? env.PLAN_OUTCOME : env.PREFLIGHT_OUTCOME)}\n- Promotion: ${literal(env.PROMOTION_OUTCOME)}\n- Observation: ${literal(env.OBSERVATION_OUTCOME)}\n`,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = fleetReleaseSummary(process.env);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary);
  if (process.env.DRY_RUN_INPUT !== "true" && !result.verified) process.exitCode = 1;
}
