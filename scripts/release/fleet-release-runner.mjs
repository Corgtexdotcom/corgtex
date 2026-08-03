#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  assertHealthProof,
  buildReleaseManifest,
  filterTargetsByGroups,
  formatReleasePlan,
  groupTargetsByRing,
  normalizeGitSha,
  normalizeReleaseInput,
  normalizeTargetGroup,
  normalizeTargets,
  parseBoolean,
  parseKeyValueArgs,
  parseManifestJson,
  parsePositiveInteger,
  providerBoundaryErrors,
  targetEligibilityErrors,
  targetFromControlPlaneRow,
  targetSelectionDeprecations,
  TERMINAL_RAILWAY_FAILURES,
} from "./fleet-release-core.mjs";
import { notifyFleetReleaseFailure } from "./fleet-release-alerts.mjs";
import { runPostDeployProbe } from "./fleet-release-probes.mjs";

const DEFAULT_CONTROL_PLANE_URL = "https://ops.corgtex.com";
const DEFAULT_RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const DEFAULT_AZURE = {
  resourceGroup: "rg-corgtex-selfserve-production-wus3",
  acrName: "acrcorgtexssstgwus3",
  acrServer: "acrcorgtexssstgwus3.azurecr.io",
  webAppName: "ca-corgtex-ss-prod-web",
  workerAppName: "ca-corgtex-ss-prod-worker",
};

export async function runFleetRelease(argv = process.argv.slice(2), deps = {}) {
  const args = parseKeyValueArgs(argv);
  const command = args._[0] ?? "deploy";
  if (command === "validate-config") {
    const validation = await validateReleaseEnvironment(args, deps.env ?? process.env, deps);
    console.log(JSON.stringify({ stage: "config-validation", ...validation }, null, 2));
    if (!validation.ok) {
      throw new Error(formatConfigValidationFailure(validation));
    }
    return validation;
  }
  if (command === "resolve") {
    const manifest = await resolveManifest(args, deps);
    emitGithubOutput("git_sha", manifest.gitSha, deps);
    emitGithubOutput("release_version", manifest.releaseVersion, deps);
    emitGithubOutput("image_tag", manifest.imageTag, deps);
    emitGithubOutput("ghcr_web_image", manifest.ghcrWebImage, deps);
    emitGithubOutput("ghcr_worker_image", manifest.ghcrWorkerImage, deps);
    emitGithubOutput("manifest_json", JSON.stringify(manifest), deps);
    console.log(JSON.stringify({ manifest }, null, 2));
    return { manifest };
  }
  if (command === "check-images") {
    const manifest = await resolveManifest(args, deps);
    const result = checkReleaseImages(manifest, deps);
    console.log(JSON.stringify({ stage: "image-check", ...result }, null, 2));
    return result;
  }
  if (command !== "deploy") {
    throw new Error(`Unsupported fleet release command: ${command}`);
  }

  const env = deps.env ?? process.env;
  validateRuntimeObservabilityEnvironment(env);
  const manifest = await resolveManifest(args, deps);
  const targetSelection = args.targets ?? env.FLEET_RELEASE_TARGETS ?? "default"; const selectedGroups = normalizeTargets(targetSelection);
  const dryRun = parseBoolean(args.dryRun ?? env.FLEET_RELEASE_DRY_RUN, false);
  const failOnBlockers = parseBoolean(args.failOnBlockers ?? env.FLEET_RELEASE_FAIL_ON_BLOCKERS, false);
  const forceAfterFailure = parseBoolean(args.forceAfterFailure ?? env.FLEET_RELEASE_FORCE_AFTER_FAILURE, false);
  const concurrency = parsePositiveInteger(args.concurrency ?? env.FLEET_RELEASE_CONCURRENCY, 2);
  const reason = args.reason ?? env.FLEET_RELEASE_REASON ?? "";
  if (!reason.trim()) {
    throw new Error("A release reason is required.");
  }

  const allTargets = await discoverTargets(deps);
  const broadSelection = ["", "default", "all"].includes(String(targetSelection).trim().toLowerCase()) || [normalizeTargets("default"), normalizeTargets("all")].some((groups) => groups.length === selectedGroups.length && groups.every((group) => selectedGroups.includes(group)));
  let targets = filterTargetsByGroups(allTargets, selectedGroups, { excludeIneligible: broadSelection }); if (env.FLEET_RELEASE_TARGETS_FILE && !existsSync(env.FLEET_RELEASE_TARGETS_FILE)) targets = await revalidateTargets(targets, deps);
  if (targets.length === 0) {
    throw new Error(`No release targets matched: ${selectedGroups.join(", ")}`);
  }

  emitTargetInventory(targets, env, deps);
  const preflight = targets.map((target) => ({
    target,
    blockers: preflightTarget(target, deps.env ?? process.env, { requireObservability: !dryRun }),
  }));
  const blockers = preflight.filter((item) => item.blockers.length > 0);
  const planTargets = preflight.map(({ target, blockers: targetBlockers }) => ({ ...target, blockers: targetBlockers })); const deprecations = [...targetSelectionDeprecations(targetSelection), ...targets.flatMap((target) => target.deprecations ?? [])];
  const plan = formatReleasePlan({ manifest, targets: planTargets, dryRun, concurrency, deprecations: [...new Set(deprecations)] });
  console.log(JSON.stringify({ stage: "plan", plan, blockers: blockers.map(publicBlocker) }, null, 2));
  if (dryRun) {
    if (failOnBlockers && blockers.length > 0) {
      throw new Error(formatPreflightFailure(blockers));
    }
    return { dryRun: true, manifest, targets, blockers: blockers.map(publicBlocker) };
  }
  if (blockers.length > 0) {
    throw new Error(formatPreflightFailure(blockers));
  }

  const results = [];
  const retainedTargets = new WeakSet();
  try {
    for (const ring of groupTargetsByRing(targets)) {
      console.log(JSON.stringify({ stage: "ring-started", ring: ring.ring, targetCount: ring.targets.length }));
      const ringResults = await runWithConcurrency(ring.targets, concurrency, async (target) => {
        try {
          const currentTarget = env.FLEET_RELEASE_TARGETS_FILE ? await revalidateSnapshotTarget(target, deps, true) : target; retainedTargets.add(target); const result = await deployTarget(currentTarget, manifest, reason, deps);
          return { target: currentTarget, status: "succeeded", result };
        } catch (error) {
          return { target, status: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      });
      results.push(...ringResults);
      console.log(JSON.stringify({ stage: "ring-completed", ring: ring.ring, results: ringResults.map(publicResult) }, null, 2));
      if (ringResults.some((result) => result.status === "failed") && !forceAfterFailure) {
        throw new Error(`Ring ${ring.ring} failed; later rings were stopped.`);
      }
    }
  } catch (error) {
    await notifyFleetReleaseFailure({ manifest, results, error, stage: "deploy" }, deps)
      .then((alertResult) => {
        console.log(JSON.stringify({
          stage: "fleet-release-alert",
          channel: alertResult.channel,
          sent: alertResult.sent,
          url: alertResult.url ?? null,
          reason: alertResult.reason ?? null,
          incident: {
            searchToken: alertResult.incident?.searchToken,
            severity: alertResult.incident?.severity,
            service: alertResult.incident?.service,
            status: alertResult.incident?.status,
            summary: alertResult.incident?.summary,
          },
        }, null, 2));
      })
      .catch((alertError) => {
        console.error(`Fleet release alert failed: ${alertError instanceof Error ? alertError.message : String(alertError)}`);
      });
    throw error;
  }

  if (env.FLEET_RELEASE_TARGETS_FILE) emitTargetInventory(results.filter((result) => result.status === "succeeded" || retainedTargets.has(result.target)).map((result) => result.target), env, deps);
  return { manifest, results };
}

async function resolveManifest(args, deps) {
  const manifest = parseManifestJson(args.manifestJson ?? process.env.FLEET_RELEASE_MANIFEST_JSON);
  if (manifest) {
    return buildReleaseManifest({
      ...manifest,
      webDigest: args.webDigest ?? manifest.webDigest,
      workerDigest: args.workerDigest ?? manifest.workerDigest,
      stabilityStatus: args.stabilityStatus ?? manifest.stabilityStatus,
    });
  }

  const release = normalizeReleaseInput(args.release ?? process.env.FLEET_RELEASE_INPUT ?? "latest-stable");
  const gitSha = release === "latest-stable"
    ? await resolveLatestStableSha(deps)
    : normalizeGitSha(release);
  return buildReleaseManifest({
    gitSha,
    repository: deps.env?.GITHUB_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "Corgtexdotcom/corgtex",
    acrServer: deps.env?.FLEET_RELEASE_ACR_SERVER ?? process.env.FLEET_RELEASE_ACR_SERVER ?? DEFAULT_AZURE.acrServer,
    sourceWorkflowRunId: deps.env?.GITHUB_RUN_ID ?? process.env.GITHUB_RUN_ID ?? null,
    stabilityStatus: release === "latest-stable" ? "stable" : "candidate",
  });
}

async function validateReleaseEnvironment(args, env, deps = {}) {
  const release = normalizeReleaseInput(args.release ?? env.FLEET_RELEASE_INPUT ?? "latest-stable");
  const selectedGroups = normalizeTargets(args.targets ?? env.FLEET_RELEASE_TARGETS);
  const dryRun = parseBoolean(args.dryRun ?? env.FLEET_RELEASE_DRY_RUN, false);
  const missing = [];
  const invalid = [];

  if (release === "latest-stable") {
    const stableMarker = env.FLEET_RELEASE_STABLE_GIT_SHA || env.CONTROL_PLANE_STABLE_RELEASE_GIT_SHA;
    if (!stableMarker?.trim()) {
      missing.push("FLEET_RELEASE_STABLE_GIT_SHA");
    } else {
      try {
        normalizeGitSha(stableMarker);
      } catch (error) {
        invalid.push({
          name: env.FLEET_RELEASE_STABLE_GIT_SHA ? "FLEET_RELEASE_STABLE_GIT_SHA" : "CONTROL_PLANE_STABLE_RELEASE_GIT_SHA",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  validateConfiguredTargetJson("FLEET_RELEASE_TARGETS_JSON", env.FLEET_RELEASE_TARGETS_JSON, invalid);
  validateConfiguredTargetJson("FLEET_RELEASE_OPS_TARGET_JSON", env.FLEET_RELEASE_OPS_TARGET_JSON, invalid);
  validateConfiguredTargetJson("FLEET_RELEASE_BACKUP_APP_TARGET_JSON", env.FLEET_RELEASE_BACKUP_APP_TARGET_JSON, invalid);
  validateConfiguredTargetJson("FLEET_RELEASE_AZURE_TARGET_JSON", env.FLEET_RELEASE_AZURE_TARGET_JSON, invalid);
  if (env.CORGTEX_AUTO_SEED_JNJ_DEMO?.trim()) {
    invalid.push({
      name: "CORGTEX_AUTO_SEED_JNJ_DEMO",
      reason: "demo seeds must not be coupled to web startup; run explicit seed jobs instead",
    });
  }
  if (env.SEED_SCRIPTS?.trim()) {
    invalid.push({
      name: "SEED_SCRIPTS",
      reason: "extra seed scripts must run through explicit DB release or fixture jobs, not web startup",
    });
  }
  validateOptionalBoolean("POSTHOG_ENABLED", env, invalid);
  validateOptionalBoolean("POSTHOG_CAPTURE_KILL_SWITCH", env, invalid);
  validateOptionalBoolean("POSTHOG_CAPTURE_DEBUG", env, invalid);

  if (selectedGroups.includes("managed-customers") && !env.FLEET_RELEASE_TARGETS_JSON?.trim() && !env.CONTROL_PLANE_AGENT_API_KEY?.trim()) {
    missing.push("FLEET_RELEASE_TARGETS_JSON or CONTROL_PLANE_AGENT_API_KEY");
  }
  if (selectedGroups.includes("ops") && !env.FLEET_RELEASE_OPS_TARGET_JSON?.trim()) {
    missing.push("FLEET_RELEASE_OPS_TARGET_JSON");
  }
  if (selectedGroups.includes("backup-app") && !env.FLEET_RELEASE_BACKUP_APP_TARGET_JSON?.trim()) {
    missing.push("FLEET_RELEASE_BACKUP_APP_TARGET_JSON");
  }
  if (selectedGroups.includes("selfserve") && !env.FLEET_RELEASE_AZURE_TARGET_JSON?.trim()) {
    missing.push("FLEET_RELEASE_AZURE_TARGET_JSON");
  }

  if (!dryRun) {
    if (!env.CONTROL_PLANE_AGENT_API_KEY?.trim()) missing.push("CONTROL_PLANE_AGENT_API_KEY");
    const providerInventory = selectedGroups.includes("managed-customers") && !env.FLEET_RELEASE_TARGETS_JSON?.trim() && env.CONTROL_PLANE_AGENT_API_KEY?.trim() ? await discoverTargets({ ...deps, env }) : configuredTargets(env).map(normalizeTarget); const selectedProviders = new Set(providerInventory.filter((target) => selectedGroups.includes(target.group) && targetEligibilityErrors(target).length === 0).map((target) => target.provider));
    const includesRailwayTarget = selectedProviders.has("railway");
    const includesAzureTarget = selectedProviders.has("azure");
    if (includesRailwayTarget && !env.RAILWAY_API_TOKEN?.trim()) {
      missing.push("RAILWAY_API_TOKEN");
    }
    if (includesRailwayTarget && !env.GHCR_IMPORT_TOKEN?.trim() && !env.GITHUB_TOKEN?.trim()) {
      missing.push("GHCR_IMPORT_TOKEN or GITHUB_TOKEN");
    }
    if (includesAzureTarget) {
      if (!env.AZURE_CLIENT_ID?.trim()) missing.push("AZURE_CLIENT_ID");
      if (!env.AZURE_TENANT_ID?.trim()) missing.push("AZURE_TENANT_ID");
      if (!env.AZURE_SUBSCRIPTION_ID?.trim()) missing.push("AZURE_SUBSCRIPTION_ID");
      if (!env.GHCR_IMPORT_TOKEN?.trim() && !env.GITHUB_TOKEN?.trim()) {
        missing.push("GHCR_IMPORT_TOKEN or GITHUB_TOKEN");
      }
    }
    requireProductionObservability(selectedProviders, env, missing, invalid);
  }

  return {
    ok: missing.length === 0 && invalid.length === 0,
    release,
    dryRun,
    targetGroups: selectedGroups,
    missing: [...new Set(missing)],
    invalid,
  };
}

function observationTargetsFor(targets) { const selected = new Set(targets.map((target) => target.provider === "azure" ? "azure-selfserve" : target.provider === "railway" ? (target.group === "selfserve" ? "railway-selfserve" : (["ops", "backup-app"].includes(target.group) ? target.group : "railway-customers")) : null).filter(Boolean)); return ["railway-customers", "railway-selfserve", "azure-selfserve", "ops", "backup-app"].filter((target) => selected.has(target)); } function emitTargetInventory(targets, env, deps) { const providers = new Set(targets.map((target) => target.provider)); emitGithubOutput("uses_azure", providers.has("azure"), deps); emitGithubOutput("uses_railway", providers.has("railway"), deps); emitGithubOutput("observation_targets", observationTargetsFor(targets).join(","), deps); if (env.FLEET_RELEASE_TARGETS_FILE) writeFileSync(env.FLEET_RELEASE_TARGETS_FILE, JSON.stringify(targets)); }

function validateConfiguredTargetJson(name, raw, invalid) {
  if (!raw?.trim()) return;
  try {
    const parsed = parseTargetJson(raw);
    if (parsed.length === 0) {
      invalid.push({ name, reason: "must contain at least one target" });
    }
    for (const target of parsed) {
      const provider = String(target.provider ?? "").trim().toLowerCase();
      if (!provider) invalid.push({ name, reason: `${target.label ?? target.id ?? "target"} must explicitly declare provider` });
      else if (!["azure", "railway"].includes(provider)) invalid.push({ name, reason: `${target.label ?? target.id ?? "target"} has unsupported provider ${provider}` });
    }
  } catch (error) {
    invalid.push({
      name,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateOptionalBoolean(name, env, invalid) {
  if (!optionalText(env[name])) return;
  try {
    parseBoolean(env[name], false);
  } catch (error) {
    invalid.push({
      name,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function optionalBoolean(name, env) {
  if (!optionalText(env[name])) return null;
  try {
    return parseBoolean(env[name], false);
  } catch {
    return null;
  }
}

function requireProductionObservability(selectedProviders, env, missing, invalid) {
  const includesRailwayTarget = selectedProviders.has("railway");
  if (includesRailwayTarget) {
    const postHogEnabled = optionalBoolean("POSTHOG_ENABLED", env);
    if (!optionalText(env.POSTHOG_ENABLED)) {
      missing.push("POSTHOG_ENABLED");
    } else if (postHogEnabled === false) {
      invalid.push({
        name: "POSTHOG_ENABLED",
        reason: "must be true for non-dry-run Railway release observability",
      });
    }
    const postHogKillSwitch = optionalBoolean("POSTHOG_CAPTURE_KILL_SWITCH", env);
    if (postHogKillSwitch === true) {
      invalid.push({
        name: "POSTHOG_CAPTURE_KILL_SWITCH",
        reason: "must be false for non-dry-run Railway release observability",
      });
    }
    if (!env.POSTHOG_PROJECT_TOKEN?.trim()) {
      missing.push("POSTHOG_PROJECT_TOKEN");
    }
  }

  if (selectedProviders.has("azure") && !env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim()) {
    missing.push("APPLICATIONINSIGHTS_CONNECTION_STRING");
  }
}

function validateRuntimeObservabilityEnvironment(env) {
  const invalid = [];
  validateOptionalBoolean("POSTHOG_ENABLED", env, invalid);
  validateOptionalBoolean("POSTHOG_CAPTURE_KILL_SWITCH", env, invalid);
  validateOptionalBoolean("POSTHOG_CAPTURE_DEBUG", env, invalid);
  if (invalid.length > 0) {
    throw new Error(formatConfigValidationFailure({ missing: [], invalid }));
  }
}

function formatConfigValidationFailure(validation) {
  const parts = [];
  if (validation.missing.length > 0) {
    parts.push(`missing ${validation.missing.join(", ")}`);
  }
  for (const item of validation.invalid) {
    parts.push(`${item.name}: ${item.reason}`);
  }
  return `Fleet release configuration is incomplete: ${parts.join("; ")}`;
}

async function resolveLatestStableSha(deps) {
  const env = deps.env ?? process.env;
  const explicit = env.FLEET_RELEASE_STABLE_GIT_SHA || env.CONTROL_PLANE_STABLE_RELEASE_GIT_SHA;
  if (explicit) return normalizeGitSha(explicit);
  throw new Error("latest-stable could not be resolved. Set FLEET_RELEASE_STABLE_GIT_SHA to a canary-proven release SHA, or pass --release <full-sha> explicitly.");
}

async function discoverTargets(deps) {
  const env = deps.env ?? process.env;
  const snapshot = env.FLEET_RELEASE_TARGETS_FILE && existsSync(env.FLEET_RELEASE_TARGETS_FILE);
  const configured = parseTargetJson(snapshot ? readFileSync(env.FLEET_RELEASE_TARGETS_FILE, "utf8") : env.FLEET_RELEASE_TARGETS_JSON);
  if (snapshot) return revalidateTargets(dedupeTargets(configured.map(normalizeTarget)), deps);
  const discovered = configured.length > 0 ? [] : await discoverControlPlaneTargets(deps);
  const ineligibleDiscoveredIds = new Set((configured.length > 0 ? [] : discovered).filter((target) => targetEligibilityErrors(target).length > 0).map((target) => target.deploymentId ?? target.id));
  const targets = dedupeTargets([...configured, ...configuredTargets(env).filter((target) => !ineligibleDiscoveredIds.has(target.deploymentId ?? target.id)), ...discovered].map(normalizeTarget));
  return targets;
}

function configuredTargets(env) { return [...parseTargetJson(env.FLEET_RELEASE_TARGETS_JSON), ...parseTargetJson(env.FLEET_RELEASE_OPS_TARGET_JSON).map((target) => ({ ...target, group: "ops" })), ...parseTargetJson(env.FLEET_RELEASE_BACKUP_APP_TARGET_JSON).map((target) => ({ ...target, group: "backup-app" })), ...parseTargetJson(env.FLEET_RELEASE_AZURE_TARGET_JSON).map((target) => ({ ...target, group: "selfserve" }))]; }

function parseTargetJson(raw) {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function discoverControlPlaneTargets(deps) {
  const env = deps.env ?? process.env;
  if (!env.CONTROL_PLANE_AGENT_API_KEY) return [];
  const rows = await callControlPlaneTool("list_customers", { includeAllDeployments: true, uncapped: true }, deps);
  if (!Array.isArray(rows)) {
    throw new Error("Control-plane list_customers did not return an array.");
  }
  return rows.filter((row) => String(row.environment ?? "").trim().toLowerCase() === "production" && row.deploymentKind !== "SHARED_WORKSPACE" && ["AZURE", "RAILWAY"].includes(row.cloudProvider)).map(targetFromControlPlaneRow);
}

async function revalidateTargets(targets, deps) { const revalidated = []; for (let index = 0; index < targets.length; index += 8) revalidated.push(...await Promise.all(targets.slice(index, index + 8).map((target) => revalidateSnapshotTarget(target, deps)))); return revalidated; } async function revalidateSnapshotTarget(target, deps, requireEligible = false) { if (!target.deploymentId) return target; const current = await callControlPlaneTool("get_customer_deployment_status", { deploymentId: target.deploymentId }, deps), currentTarget = normalizeTarget(targetFromControlPlaneRow(current)); if (mutationIdentity(target) !== mutationIdentity(currentTarget)) throw new Error(`${target.label} authoritative provider or resource identity changed after preflight`); const classificationDrift = ["environment", "deploymentKind"].some((key) => target[key] && current[key] && target[key] !== current[key]); if (classificationDrift || (current.environment && String(current.environment).toLowerCase() !== "production")) throw new Error(`${target.label} authoritative workload or environment changed after preflight`); const revalidated = { ...target, environment: current.environment ?? target.environment, deploymentKind: current.deploymentKind ?? target.deploymentKind, deploymentStatus: current.deploymentStatus, provisioningStatus: current.provisioningStatus, releaseEligible: current.releaseEligible ?? target.releaseEligible }, errors = requireEligible ? targetEligibilityErrors(revalidated) : []; if (errors.length) throw new Error(`${target.label}: ${errors.join("; ")}`); return revalidated; }
function mutationIdentity(target) { const resource = target.provider === "azure" ? [target.azure?.resourceGroup, target.azure?.webAppName, target.azure?.workerAppName] : [target.railway?.projectId, target.railway?.environmentId, target.railway?.webServiceId, target.railway?.workerServiceId]; return JSON.stringify([target.provider, ...resource]); }

function normalizeTarget(target) {
  const hasDeploymentId = Object.prototype.hasOwnProperty.call(target, "deploymentId");
  const originalGroup = target.workload ?? target.group;
  const group = normalizeTargetGroup(originalGroup);
  const provider = String(target.provider ?? "").trim().toLowerCase() || null;
  const normalized = {
    id: target.id ?? target.deploymentId ?? target.label,
    deploymentId: hasDeploymentId ? target.deploymentId : target.id ?? null,
    label: target.label ?? target.id ?? target.deploymentId,
    url: target.url,
    group,
    workload: group,
    ring: target.ring,
    provider,
    environment: target.environment, deploymentKind: target.deploymentKind,
    deploymentStatus: target.deploymentStatus ?? null,
    provisioningStatus: target.provisioningStatus ?? null,
    releaseEligible: target.releaseEligible !== false,
    deprecations: target.deprecations ?? (group !== originalGroup ? [`${originalGroup} workload alias normalized to ${group}`] : []),
    railway: target.railway ?? {},
    azure: { ...(group === "selfserve" && provider === "azure" ? DEFAULT_AZURE : {}), ...(target.azure ?? {}) },
  };
  if (normalized.provider === "azure" && normalized.azure.acrName) {
    normalized.azure.acrServer = target.azure?.acrServer ?? `${normalized.azure.acrName}.azurecr.io`;
  }
  return normalized;
}

function dedupeTargets(targets) {
  const seen = new Set();
  const deduped = [];
  for (const target of targets) {
    const key = target.deploymentId ? `deployment:${target.deploymentId}` : `${target.group}:${target.id ?? target.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

function preflightTarget(target, env, options = {}) {
  const blockers = [...providerBoundaryErrors(target), ...targetEligibilityErrors(target)];
  const requireObservability = options.requireObservability === true;
  if (!target.url) blockers.push("runtime URL is missing");
  if (target.group === "selfserve" && !target.deploymentId) blockers.push("Self-serve deploymentId is missing for readiness checks");
  if (target.deploymentId && !env.CONTROL_PLANE_AGENT_API_KEY) {
    blockers.push("CONTROL_PLANE_AGENT_API_KEY is missing for verified inventory recording");
  }
  if (target.provider === "railway") {
    if (requireObservability) {
      const postHogEnabled = optionalBoolean("POSTHOG_ENABLED", env);
      const postHogKillSwitch = optionalBoolean("POSTHOG_CAPTURE_KILL_SWITCH", env);
      if (!optionalText(env.POSTHOG_ENABLED)) {
        blockers.push("POSTHOG_ENABLED is missing for Railway observability");
      } else if (postHogEnabled === false) {
        blockers.push("POSTHOG_ENABLED must be true for Railway observability");
      }
      if (postHogKillSwitch === true) {
        blockers.push("POSTHOG_CAPTURE_KILL_SWITCH must be false for Railway observability");
      }
      if (!optionalText(env.POSTHOG_PROJECT_TOKEN)) blockers.push("POSTHOG_PROJECT_TOKEN is missing for Railway observability");
    }
    if (!env.RAILWAY_API_TOKEN) blockers.push("RAILWAY_API_TOKEN is missing");
    if (!env.GHCR_IMPORT_TOKEN && !env.GITHUB_TOKEN) {
      blockers.push("GHCR import token is missing for Railway image pull");
    }
    for (const key of ["projectId", "environmentId", "webServiceId", "workerServiceId"]) {
      if (!target.railway?.[key]) {
        blockers.push(`Railway ${key} is missing`);
      }
    }
  } else if (target.provider === "azure") {
    if (target.group !== "selfserve") blockers.push("Managed Azure targets are non-mutable until the generic Azure executor is implemented in PR3");
    if (requireObservability && !optionalText(env.APPLICATIONINSIGHTS_CONNECTION_STRING)) {
      blockers.push("APPLICATIONINSIGHTS_CONNECTION_STRING is missing for Azure observability");
    }
    if (!env.AZURE_CLIENT_ID) blockers.push("AZURE_CLIENT_ID is missing");
    if (!env.AZURE_TENANT_ID) blockers.push("AZURE_TENANT_ID is missing");
    if (!env.AZURE_SUBSCRIPTION_ID) blockers.push("AZURE_SUBSCRIPTION_ID is missing");
    if (!target.azure.resourceGroup) blockers.push("Azure resource group is missing");
    if (!target.azure.acrName) blockers.push("Azure ACR name is missing");
    if (!target.azure.webAppName) blockers.push("Azure web Container App name is missing");
    if (!target.azure.workerAppName) blockers.push("Azure worker Container App name is missing");
    if (!env.GHCR_IMPORT_TOKEN && !env.GITHUB_TOKEN) blockers.push("GHCR import token is missing");
  } else {
    blockers.push(`Unsupported provider: ${target.provider}`);
  }
  return blockers;
}

function formatPreflightFailure(blockers) {
  return `Fleet release preflight failed: ${blockers.map((item) => `${item.target.label}: ${item.blockers.join("; ")}`).join(" | ")}`;
}

export function checkReleaseImages(manifest, deps) {
  const images = [manifest.ghcrWebImage, manifest.ghcrWorkerImage];
  const missing = [];
  for (const image of images) {
    try {
      runCommand("docker", ["manifest", "inspect", image], deps);
    } catch (error) {
      missing.push({
        image,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (missing.length > 0) {
    throw new Error(`Release image check failed for ${missing.map((item) => item.image).join(", ")}. Publish the ${manifest.imageTag} web and worker images with the Release Images workflow before fleet promotion.`);
  }
  return { ok: true, images };
}

async function deployTarget(target, manifest, reason, deps) {
  const providerResult = target.provider === "azure"
    ? await deployAzureTarget(target, { ...manifest, acrWebImage: `${target.azure.acrServer}/corgtex/web:${manifest.imageTag}`, acrWorkerImage: `${target.azure.acrServer}/corgtex/worker:${manifest.imageTag}` }, deps)
    : await deployRailwayTarget(target, manifest, deps);
  const health = await pollHealth(target.url, manifest, deps);
  assertHealthProof(health, manifest, target.label);
  const usesSelfServeReadiness = target.group === "selfserve";
  let verifiedRelease = null;
  if (target.deploymentId && usesSelfServeReadiness) {
    verifiedRelease = await recordVerifiedRelease(target, manifest, reason, deps);
  }
  const providerReadiness = await runProviderReadiness(target, manifest, deps, {
    health,
    verifiedRelease,
  });
  const postDeployProbe = usesSelfServeReadiness
    ? { status: "skipped", reason: "selfserve_provider_readiness" }
    : await runPostDeployProbe(target, manifest, reason, deps, callControlPlaneTool);
  const postDeploySnapshots = usesSelfServeReadiness
    ? { status: "skipped", reason: "selfserve_provider_readiness" }
    : target.deploymentId
      ? await refreshPostDeploySnapshots(target, reason, deps)
      : { status: "skipped", reason: "deployment_id_missing" };
  if (target.deploymentId && !usesSelfServeReadiness) {
    verifiedRelease = await recordVerifiedRelease(target, manifest, reason, deps);
  }
  return { providerResult, release: health.release, providerReadiness, postDeployProbe, postDeploySnapshots, verifiedRelease };
}

async function recordVerifiedRelease(target, manifest, reason, deps) {
  return callControlPlaneTool("record_verified_release", {
    deploymentId: target.deploymentId,
    releaseImageTag: manifest.imageTag,
    releaseVersion: manifest.releaseVersion,
    reason,
  }, deps);
}

async function runProviderReadiness(target, manifest, deps, proof = {}) {
  if (target.group !== "selfserve") {
    return { status: "skipped", reason: "not_selfserve" };
  }
  const providerStatus = target.provider === "azure" ? await callControlPlaneTool("get_azure_provider_status", { deploymentId: target.deploymentId }, deps) : null;
  const registry = await callControlPlaneTool("list_self_serve_customers", {
    take: 25,
  }, deps);
  const registryUnavailable = !Array.isArray(registry?.items) || !registry?.summary || typeof registry.summary !== "object";
  if (target.provider !== "azure") {
    if (registryUnavailable) throw new Error(`${target.label} self-serve readiness failed: selfServeRegistry=unavailable`);
    return { status: "ok", provider: target.provider, deploymentId: target.deploymentId, registrySummary: registry.summary };
  }

  const blockers = [];
  if (providerStatus?.provider?.cloudProvider !== "AZURE") {
    blockers.push(`provider=${providerStatus?.provider?.cloudProvider ?? "missing"}`);
  }
  const releaseProof = azureReleaseProof(manifest, proof);
  const providerReleaseMatches = providerStatus?.release?.releaseImageTag === manifest.imageTag
    && !providerStatus?.release?.releaseDrift;
  const providerStatusLagging = releaseProof.ok && !providerReleaseMatches;

  if (providerStatus?.health?.status !== "ok" && !providerStatusLagging) {
    blockers.push(`health=${providerStatus?.health?.status ?? "missing"}`);
  }
  if (!releaseProof.ok && providerStatus?.release?.releaseImageTag !== manifest.imageTag) {
    blockers.push(`releaseImageTag=${providerStatus?.release?.releaseImageTag ?? "missing"}`);
  }
  if (!releaseProof.ok && providerStatus?.release?.releaseDrift) {
    blockers.push("releaseDrift=open");
  }
  if (registryUnavailable) {
    blockers.push("selfServeRegistry=unavailable");
  }
  if (blockers.length > 0) {
    throw new Error(`${target.label} Azure provider readiness failed: ${blockers.join("; ")}`);
  }

  return {
    status: "ok",
    provider: "azure",
    deploymentId: target.deploymentId,
    healthStatus: providerStatus?.health?.status ?? null,
    releaseImageTag: releaseProof.releaseImageTag ?? providerStatus?.release?.releaseImageTag ?? null,
    releaseProofSource: releaseProof.source,
    providerStatusLagging,
    providerStatusReleaseImageTag: providerStatus?.release?.releaseImageTag ?? null,
    providerStatusReleaseDrift: providerStatus?.release?.releaseDrift ?? null,
    registrySummary: registry.summary,
  };
}

function azureReleaseProof(manifest, proof) {
  const healthRelease = proof.health?.release;
  if (healthRelease && (healthRelease.imageTag === manifest.imageTag || healthRelease.gitSha === manifest.gitSha)) {
    return { ok: true, source: "runtime_health", releaseImageTag: manifest.imageTag };
  }
  const verifiedRelease = proof.verifiedRelease;
  const observedRelease = verifiedRelease?.observedRelease;
  if (observedRelease && (observedRelease.imageTag === manifest.imageTag || observedRelease.gitSha === manifest.gitSha)) {
    return { ok: true, source: "record_verified_release", releaseImageTag: manifest.imageTag };
  }
  const recordedRelease = verifiedRelease?.release?.current;
  if (recordedRelease?.releaseImageTag === manifest.imageTag) {
    return { ok: true, source: "record_verified_release_status", releaseImageTag: manifest.imageTag };
  }
  if (verifiedRelease?.recorded === true) {
    return { ok: true, source: "record_verified_release_ack", releaseImageTag: manifest.imageTag };
  }
  return { ok: false, source: "provider_status", releaseImageTag: null };
}

async function refreshPostDeploySnapshots(target, reason, deps) {
  const snapshotRefresh = await callControlPlaneTool("refresh_fleet_snapshots", {
    deploymentId: target.deploymentId,
    snapshotKinds: ["CONTEXT", "INTEGRATION"],
    reason,
  }, deps);
  const failed = Array.isArray(snapshotRefresh?.results)
    ? snapshotRefresh.results.filter((result) => result.status === "failed")
    : [];
  if (failed.length > 0) {
    throw new Error(`${target.label} post-deploy snapshot refresh failed: ${failed.map((result) => `${result.snapshotKind}:${result.error ?? result.status}`).join(", ")}`);
  }
  return snapshotRefresh;
}

async function deployRailwayTarget(target, manifest, deps) {
  const services = [
    { key: "web", serviceId: target.railway.webServiceId, image: manifest.ghcrWebImage },
    { key: "worker", serviceId: target.railway.workerServiceId, image: manifest.ghcrWorkerImage },
  ].filter((service) => service.serviceId);
  for (const service of services) {
    await railwayGraphql(`
      mutation UpdateSource($environmentId: String!, $serviceId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }
    `, {
      environmentId: target.railway.environmentId,
      serviceId: service.serviceId,
      input: railwayServiceUpdateInput(service.image, deps),
    }, deps);
    await railwayGraphql(`
      mutation UpsertVariables($projectId: String!, $environmentId: String!, $serviceId: String!, $variables: EnvironmentVariables!) {
        variableCollectionUpsert(input: {
          projectId: $projectId
          environmentId: $environmentId
          serviceId: $serviceId
          variables: $variables
          replace: false
        })
      }
    `, {
      projectId: target.railway.projectId,
      environmentId: target.railway.environmentId,
      serviceId: service.serviceId,
      variables: releaseVariables(manifest, deps.env ?? process.env, {
        includePostHogInstanceId: target.group !== "managed-customers",
      }),
    }, deps);
  }
  const deployments = [];
  for (const service of services) {
    const result = await railwayGraphql(`
      mutation DeployService($serviceId: String!, $environmentId: String!) {
        deploymentId: serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
      }
    `, {
      serviceId: service.serviceId,
      environmentId: target.railway.environmentId,
    }, deps);
    const deployment = { ...service, deploymentId: result.deploymentId };
    deployments.push(deployment);
    await waitForRailwayDeployment(target, deployment, deps);
  }
  return { deployments };
}

function optionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

const AZURE_OBSERVABILITY_SECRET_NAMES = {
  APPLICATIONINSIGHTS_CONNECTION_STRING: "ai-conn-secret",
  POSTHOG_PROJECT_TOKEN: "posthog-token",
};

function optionalRuntimeObservabilityVariables(env, options = {}) {
  const variables = {};
  const applicationInsightsConnectionString = optionalText(env.APPLICATIONINSIGHTS_CONNECTION_STRING);
  if (applicationInsightsConnectionString) {
    variables.APPLICATIONINSIGHTS_CONNECTION_STRING = options.azureSecretRefs
      ? `secretref:${AZURE_OBSERVABILITY_SECRET_NAMES.APPLICATIONINSIGHTS_CONNECTION_STRING}`
      : applicationInsightsConnectionString;
  } else if (Object.hasOwn(env, "APPLICATIONINSIGHTS_CONNECTION_STRING")) {
    variables.APPLICATIONINSIGHTS_CONNECTION_STRING = "";
  }

  const postHogProjectToken = optionalText(env.POSTHOG_PROJECT_TOKEN);
  const postHogEnabled = parseBoolean(env.POSTHOG_ENABLED, false);
  if (postHogEnabled && postHogProjectToken) {
    variables.POSTHOG_ENABLED = "true";
    variables.POSTHOG_CAPTURE_KILL_SWITCH = canonicalBoolean(env.POSTHOG_CAPTURE_KILL_SWITCH, false);
    variables.POSTHOG_PROJECT_TOKEN = options.azureSecretRefs
      ? `secretref:${AZURE_OBSERVABILITY_SECRET_NAMES.POSTHOG_PROJECT_TOKEN}`
      : postHogProjectToken;
    variables.POSTHOG_API_HOST = optionalText(env.POSTHOG_API_HOST) ?? "https://us.i.posthog.com";
    variables.POSTHOG_ENVIRONMENT = optionalText(env.POSTHOG_ENVIRONMENT) ?? "production";
    variables.POSTHOG_EVENT_SAMPLE_RATE = optionalText(env.POSTHOG_EVENT_SAMPLE_RATE) ?? "1";
    variables.POSTHOG_CAPTURE_TIMEOUT_MS = optionalText(env.POSTHOG_CAPTURE_TIMEOUT_MS) ?? "1500";
    variables.POSTHOG_CAPTURE_DEBUG = canonicalBoolean(env.POSTHOG_CAPTURE_DEBUG, false);
    assignPostHogInstanceId(variables, env, options);
  } else if (optionalText(env.POSTHOG_ENABLED)) {
    variables.POSTHOG_ENABLED = "false";
    variables.POSTHOG_CAPTURE_KILL_SWITCH = "true";
    variables.POSTHOG_PROJECT_TOKEN = "";
    clearPostHogInstanceId(variables, env, options);
  }

  return variables;
}

function assignPostHogInstanceId(variables, env, options) {
  if (options.includePostHogInstanceId === false || !Object.hasOwn(env, "POSTHOG_INSTANCE_ID")) {
    return;
  }
  variables.POSTHOG_INSTANCE_ID = optionalText(env.POSTHOG_INSTANCE_ID) ?? "";
}

function canonicalBoolean(value, fallback) {
  return parseBoolean(value, fallback) ? "true" : "false";
}

function clearPostHogInstanceId(variables, env, options) {
  if (options.includePostHogInstanceId === false || !Object.hasOwn(env, "POSTHOG_INSTANCE_ID")) {
    return;
  }
  variables.POSTHOG_INSTANCE_ID = "";
}

export function releaseVariables(manifest, env = process.env, options = {}) {
  return {
    CORGTEX_RELEASE_VERSION: manifest.releaseVersion,
    CORGTEX_RELEASE_IMAGE_TAG: manifest.imageTag,
    CORGTEX_RELEASE_GIT_SHA: manifest.gitSha,
    CORGTEX_STARTUP_MODE: "combined",
    CORGTEX_AUTO_SEED_JNJ_DEMO: "false",
    CORGTEX_AUTO_SEED_INTERNAL_VALIDATION: "false",
    SEED_SCRIPTS: "",
    ...optionalRuntimeObservabilityVariables(env, options),
  };
}

export function azureReleaseVariables(manifest, env = process.env) {
  return {
    ...releaseVariables(manifest, env),
    CORGTEX_STARTUP_MODE: "migrate-and-web",
    CORGTEX_AUTO_SEED_INTERNAL_VALIDATION: "false",
    ...optionalRuntimeObservabilityVariables(env, { azureSecretRefs: true }),
  };
}

function azureObservabilitySecrets(env = process.env) {
  const secrets = {};
  const applicationInsightsConnectionString = optionalText(env.APPLICATIONINSIGHTS_CONNECTION_STRING);
  if (applicationInsightsConnectionString) {
    secrets[AZURE_OBSERVABILITY_SECRET_NAMES.APPLICATIONINSIGHTS_CONNECTION_STRING] = applicationInsightsConnectionString;
  }

  const postHogProjectToken = optionalText(env.POSTHOG_PROJECT_TOKEN);
  const postHogEnabled = parseBoolean(env.POSTHOG_ENABLED, false);
  if (postHogEnabled && postHogProjectToken) {
    secrets[AZURE_OBSERVABILITY_SECRET_NAMES.POSTHOG_PROJECT_TOKEN] = postHogProjectToken;
  }

  return secrets;
}

function railwayServiceUpdateInput(image, deps) {
  const input = { source: { image } };
  if (!image.startsWith("ghcr.io/")) return input;

  const env = deps.env ?? process.env;
  const password = env.GHCR_IMPORT_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  const username = env.GHCR_IMPORT_USERNAME?.trim() || env.GITHUB_ACTOR?.trim();
  if (!password || !username) {
    throw new Error("GHCR_IMPORT_TOKEN or GITHUB_TOKEN is required for Railway to pull private GHCR images.");
  }
  return {
    ...input,
    registryCredentials: {
      username,
      password,
    },
  };
}

async function waitForRailwayDeployment(target, deployment, deps) {
  const timeoutMs = Number((deps.env ?? process.env).FLEET_RELEASE_RAILWAY_TIMEOUT_MS ?? 900_000);
  const intervalMs = Number((deps.env ?? process.env).FLEET_RELEASE_RAILWAY_INTERVAL_MS ?? 10_000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await latestRailwayStatus(target, deployment, deps);
    if (status === "SUCCESS") return;
    if (TERMINAL_RAILWAY_FAILURES.has(status)) {
      throw new Error(`${target.label} ${deployment.key} Railway deployment ${deployment.deploymentId} ended ${status}`);
    }
    await sleep(intervalMs, deps);
  }
  throw new Error(`${target.label} ${deployment.key} Railway deployment ${deployment.deploymentId} timed out`);
}

export async function latestRailwayStatus(target, deployment, deps) {
  const result = await railwayGraphql(`
    query LatestDeployments($serviceId: String!, $environmentId: String!) {
      deployments(first: 10, input: { serviceId: $serviceId, environmentId: $environmentId }) {
        edges { node { id status } }
      }
    }
  `, {
    serviceId: deployment.serviceId,
    environmentId: target.railway.environmentId,
  }, deps);
  const nodes = result.deployments?.edges?.map((edge) => edge.node).filter(Boolean) ?? [];
  const match = nodes.find((node) => node.id === deployment.deploymentId);
  return match?.status ?? "UNKNOWN";
}

async function deployAzureTarget(target, manifest, deps) {
  const env = deps.env ?? process.env;
  const username = env.GHCR_IMPORT_USERNAME || env.GITHUB_ACTOR;
  const token = env.GHCR_IMPORT_TOKEN || env.GITHUB_TOKEN;
  const webSource = manifest.ghcrWebImage.replace(/^ghcr\.io\//, "");
  const workerSource = manifest.ghcrWorkerImage.replace(/^ghcr\.io\//, "");
  for (const [source, image] of [[webSource, `corgtex/web:${manifest.imageTag}`], [workerSource, `corgtex/worker:${manifest.imageTag}`]]) {
    runCommand("az", [
      "acr",
      "import",
      "--name",
      target.azure.acrName,
      "--source",
      `ghcr.io/${source}`,
      "--image",
      image,
      "--username",
      username,
      "--password",
      token,
      "--force",
    ], deps);
  }
  updateAzureContainerApp(target.azure.webAppName, manifest.acrWebImage, target, manifest, deps);
  updateAzureContainerApp(target.azure.workerAppName, manifest.acrWorkerImage, target, manifest, deps);
  return {
    webRevision: showAzureRevision(target.azure.webAppName, target, deps),
    workerRevision: showAzureRevision(target.azure.workerAppName, target, deps),
  };
}

function updateAzureContainerApp(name, image, target, manifest, deps) {
  const releaseSecrets = Object.entries(azureObservabilitySecrets(deps.env ?? process.env))
    .map(([key, value]) => `${key}=${value}`);
  if (releaseSecrets.length) {
    runCommand("az", [
      "containerapp",
      "secret",
      "set",
      "--name",
      name,
      "--resource-group",
      target.azure.resourceGroup,
      "--secrets",
      ...releaseSecrets,
      "--output",
      "none",
    ], deps);
  }

  const releaseEnv = Object.entries(azureReleaseVariables(manifest, deps.env ?? process.env)).map(([key, value]) => `${key}=${value}`);
  runCommand("az", [
    "containerapp",
    "update",
    "--name",
    name,
    "--resource-group",
    target.azure.resourceGroup,
    "--image",
    image,
    "--set-env-vars",
    ...releaseEnv,
    "--output",
    "none",
  ], deps);
}

function showAzureRevision(name, target, deps) {
  const result = runCommand("az", [
    "containerapp",
    "show",
    "--name",
    name,
    "--resource-group",
    target.azure.resourceGroup,
    "--query",
    "properties.latestRevisionName",
    "-o",
    "tsv",
  ], deps);
  return result.stdout.trim();
}

async function pollHealth(url, manifest, deps) {
  const timeoutMs = Number((deps.env ?? process.env).FLEET_RELEASE_HEALTH_TIMEOUT_MS ?? 600_000);
  const intervalMs = Number((deps.env ?? process.env).FLEET_RELEASE_HEALTH_INTERVAL_MS ?? 10_000);
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await (deps.fetchImpl ?? fetch)(new URL("/api/health", url), {
        headers: { "cache-control": "no-cache" },
      });
      const body = await response.json();
      assertHealthProof(body, manifest, url);
      return body;
    } catch (error) {
      lastError = error;
      await sleep(intervalMs, deps);
    }
  }
  throw lastError ?? new Error(`${url} health proof timed out`);
}

async function callControlPlaneTool(name, args, deps) {
  const env = deps.env ?? process.env;
  const token = env.CONTROL_PLANE_AGENT_API_KEY?.trim();
  if (!token) {
    throw new Error("CONTROL_PLANE_AGENT_API_KEY is required for control-plane release operations.");
  }
  const baseUrl = (env.CONTROL_PLANE_URL || DEFAULT_CONTROL_PLANE_URL).replace(/\/$/, "");
  const response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/api/control-plane/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer cp-${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `fleet-release-${Date.now()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    throw new Error(body?.error?.message || `Control-plane tool ${name} failed with status ${response.status}`);
  }
  const text = body?.result?.content?.find((item) => typeof item?.text === "string")?.text;
  return text ? JSON.parse(text) : body?.result;
}

async function railwayGraphql(query, variables, deps) {
  const env = deps.env ?? process.env;
  const token = env.RAILWAY_API_TOKEN?.trim();
  if (!token) throw new Error("RAILWAY_API_TOKEN is required.");
  const response = await (deps.fetchImpl ?? fetch)(env.RAILWAY_GRAPHQL_ENDPOINT || DEFAULT_RAILWAY_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors?.length) {
    throw new Error(body?.errors?.map((error) => error.message).filter(Boolean).join("; ") || `Railway API failed with ${response.status}`);
  }
  return body?.data ?? {};
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      results.push(await worker(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

function runCommand(command, args, deps) {
  if (deps.runCommand) return deps.runCommand(command, args);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: deps.env ?? process.env,
  });
  if (result.status !== 0) {
    const rendered = renderCommand(command, args);
    throw new Error(redactCommandText(result.stderr?.trim(), args) || `${rendered} failed.`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function renderCommand(command, args) {
  return [command, ...args.map((arg, index) => redactCommandArg(arg, index, args))].join(" ");
}

function redactCommandArg(arg, index, args) {
  const text = String(arg);
  if (index > 0 && isSensitiveCommandFlag(args[index - 1])) {
    return "<redacted>";
  }

  const separatorIndex = text.indexOf("=");
  if (separatorIndex <= 0) return text;

  const key = text.slice(0, separatorIndex);
  if (!isSensitiveCommandKey(key)) {
    return text;
  }
  return `${key}=<redacted>`;
}

function redactCommandText(text, args) {
  if (!text) return "";
  let redacted = text;
  for (const [index, arg] of args.entries()) {
    const raw = String(arg);
    if (index > 0 && isSensitiveCommandFlag(args[index - 1])) {
      redacted = redacted.split(raw).join("<redacted>");
      continue;
    }

    const separatorIndex = raw.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = raw.slice(0, separatorIndex);
    const value = raw.slice(separatorIndex + 1);
    if (!value || !isSensitiveCommandKey(key)) continue;

    redacted = redacted.split(value).join("<redacted>");
  }
  return redacted;
}

function isSensitiveCommandKey(value) {
  return /(token|secret|password|api[_-]?key|connection[_-]?string)/i.test(String(value));
}

function isSensitiveCommandFlag(value) {
  const text = String(value);
  if (/^--?secrets$/i.test(text)) return false;
  return /^--?.*(token|secret|password|api[_-]?key|connection[_-]?string)/i.test(text);
}

function emitGithubOutput(key, value, deps) {
  if (deps.emitGithubOutput) deps.emitGithubOutput(key, value);
  const outputPath = (deps.env ?? process.env).GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `${key}=${String(value).replace(/\n/g, "%0A")}\n`);
  }
}

function publicBlocker(item) {
  return {
    id: item.target.id,
    label: item.target.label,
    group: item.target.group,
    blockers: item.blockers,
  };
}

function publicResult(result) {
  return {
    id: result.target.id,
    label: result.target.label,
    status: result.status,
    error: result.error,
  };
}

async function sleep(ms, deps) {
  if (deps.sleep) return deps.sleep(ms);
  return delay(ms);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runFleetRelease().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
