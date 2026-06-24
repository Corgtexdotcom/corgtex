#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
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
  normalizeTargets,
  parseBoolean,
  parseKeyValueArgs,
  parseManifestJson,
  parsePositiveInteger,
  targetFromControlPlaneRow,
  TERMINAL_RAILWAY_FAILURES,
} from "./fleet-release-core.mjs";

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
    const validation = validateReleaseEnvironment(args, deps.env ?? process.env);
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

  const manifest = await resolveManifest(args, deps);
  const selectedGroups = normalizeTargets(args.targets ?? process.env.FLEET_RELEASE_TARGETS ?? "all");
  const dryRun = parseBoolean(args.dryRun ?? process.env.FLEET_RELEASE_DRY_RUN, false);
  const failOnBlockers = parseBoolean(args.failOnBlockers ?? process.env.FLEET_RELEASE_FAIL_ON_BLOCKERS, false);
  const forceAfterFailure = parseBoolean(args.forceAfterFailure ?? process.env.FLEET_RELEASE_FORCE_AFTER_FAILURE, false);
  const concurrency = parsePositiveInteger(args.concurrency ?? process.env.FLEET_RELEASE_CONCURRENCY, 2);
  const reason = args.reason ?? process.env.FLEET_RELEASE_REASON ?? "";
  if (!reason.trim()) {
    throw new Error("A release reason is required.");
  }

  const allTargets = await discoverTargets(deps);
  const targets = filterTargetsByGroups(allTargets, selectedGroups);
  if (targets.length === 0) {
    throw new Error(`No release targets matched: ${selectedGroups.join(", ")}`);
  }

  const preflight = targets.map((target) => ({
    target,
    blockers: preflightTarget(target, deps.env ?? process.env),
  }));
  const blockers = preflight.filter((item) => item.blockers.length > 0);
  const plan = formatReleasePlan({ manifest, targets, dryRun, concurrency });
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
  for (const ring of groupTargetsByRing(targets)) {
    console.log(JSON.stringify({ stage: "ring-started", ring: ring.ring, targetCount: ring.targets.length }));
    const ringResults = await runWithConcurrency(ring.targets, concurrency, async (target) => {
      try {
        const result = await deployTarget(target, manifest, reason, deps);
        return { target, status: "succeeded", result };
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

function validateReleaseEnvironment(args, env) {
  const release = normalizeReleaseInput(args.release ?? env.FLEET_RELEASE_INPUT ?? "latest-stable");
  const selectedGroups = normalizeTargets(args.targets ?? env.FLEET_RELEASE_TARGETS ?? "all");
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

  if (selectedGroups.includes("railway-customers") && !env.FLEET_RELEASE_TARGETS_JSON?.trim() && !env.CONTROL_PLANE_AGENT_API_KEY?.trim()) {
    missing.push("FLEET_RELEASE_TARGETS_JSON or CONTROL_PLANE_AGENT_API_KEY");
  }
  if (selectedGroups.includes("ops") && !env.FLEET_RELEASE_OPS_TARGET_JSON?.trim()) {
    missing.push("FLEET_RELEASE_OPS_TARGET_JSON");
  }
  if (selectedGroups.includes("backup-app") && !env.FLEET_RELEASE_BACKUP_APP_TARGET_JSON?.trim()) {
    missing.push("FLEET_RELEASE_BACKUP_APP_TARGET_JSON");
  }
  if (selectedGroups.includes("azure-selfserve") && !env.FLEET_RELEASE_AZURE_TARGET_JSON?.trim()) {
    missing.push("FLEET_RELEASE_AZURE_TARGET_JSON");
  }

  if (!dryRun) {
    if (!env.CONTROL_PLANE_AGENT_API_KEY?.trim()) missing.push("CONTROL_PLANE_AGENT_API_KEY");
    const includesRailwayTarget = selectedGroups.some((group) => group !== "azure-selfserve");
    if (includesRailwayTarget && !env.RAILWAY_API_TOKEN?.trim()) {
      missing.push("RAILWAY_API_TOKEN");
    }
    if (includesRailwayTarget && !env.GHCR_IMPORT_TOKEN?.trim() && !env.GITHUB_TOKEN?.trim()) {
      missing.push("GHCR_IMPORT_TOKEN or GITHUB_TOKEN");
    }
    if (selectedGroups.includes("azure-selfserve")) {
      if (!env.AZURE_CLIENT_ID?.trim()) missing.push("AZURE_CLIENT_ID");
      if (!env.AZURE_TENANT_ID?.trim()) missing.push("AZURE_TENANT_ID");
      if (!env.AZURE_SUBSCRIPTION_ID?.trim()) missing.push("AZURE_SUBSCRIPTION_ID");
      if (!env.GHCR_IMPORT_TOKEN?.trim() && !env.GITHUB_TOKEN?.trim()) {
        missing.push("GHCR_IMPORT_TOKEN or GITHUB_TOKEN");
      }
    }
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

function validateConfiguredTargetJson(name, raw, invalid) {
  if (!raw?.trim()) return;
  try {
    const parsed = parseTargetJson(raw);
    if (parsed.length === 0) {
      invalid.push({ name, reason: "must contain at least one target" });
    }
  } catch (error) {
    invalid.push({
      name,
      reason: error instanceof Error ? error.message : String(error),
    });
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
  const configured = parseTargetJson(env.FLEET_RELEASE_TARGETS_JSON);
  const discovered = configured.length > 0 ? configured : await discoverControlPlaneTargets(deps);
  const extras = [
    ...parseTargetJson(env.FLEET_RELEASE_OPS_TARGET_JSON).map((target) => ({ ...target, group: "ops" })),
    ...parseTargetJson(env.FLEET_RELEASE_BACKUP_APP_TARGET_JSON).map((target) => ({ ...target, group: "backup-app" })),
    ...parseTargetJson(env.FLEET_RELEASE_AZURE_TARGET_JSON).map((target) => ({ ...target, group: "azure-selfserve", provider: "azure" })),
  ];
  return dedupeTargets([...discovered, ...extras].map(normalizeTarget));
}

function parseTargetJson(raw) {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function discoverControlPlaneTargets(deps) {
  const env = deps.env ?? process.env;
  if (!env.CONTROL_PLANE_AGENT_API_KEY) return [];
  const rows = await callControlPlaneTool("list_customers", {}, deps);
  if (!Array.isArray(rows)) {
    throw new Error("Control-plane list_customers did not return an array.");
  }
  return rows.map(targetFromControlPlaneRow);
}

function normalizeTarget(target) {
  const hasDeploymentId = Object.prototype.hasOwnProperty.call(target, "deploymentId");
  const normalized = {
    id: target.id ?? target.deploymentId ?? target.label,
    deploymentId: hasDeploymentId ? target.deploymentId : target.id ?? null,
    label: target.label ?? target.id ?? target.deploymentId,
    url: target.url,
    group: target.group,
    provider: target.provider ?? (target.group === "azure-selfserve" ? "azure" : "railway"),
    railway: target.railway ?? {},
    azure: { ...DEFAULT_AZURE, ...(target.azure ?? {}) },
  };
  if (normalized.provider === "azure") {
    normalized.azure.acrServer ??= `${normalized.azure.acrName}.azurecr.io`;
  }
  return normalized;
}

function dedupeTargets(targets) {
  const seen = new Set();
  const deduped = [];
  for (const target of targets) {
    const key = `${target.group}:${target.id ?? target.deploymentId ?? target.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

function preflightTarget(target, env) {
  const blockers = [];
  if (!target.url) blockers.push("runtime URL is missing");
  if (target.deploymentId && !env.CONTROL_PLANE_AGENT_API_KEY) {
    blockers.push("CONTROL_PLANE_AGENT_API_KEY is missing for verified inventory recording");
  }
  if (target.provider === "railway") {
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
    ? await deployAzureTarget(target, manifest, deps)
    : await deployRailwayTarget(target, manifest, deps);
  const health = await pollHealth(target.url, manifest, deps);
  assertHealthProof(health, manifest, target.label);
  if (target.deploymentId) {
    await callControlPlaneTool("record_verified_release", {
      deploymentId: target.deploymentId,
      releaseImageTag: manifest.imageTag,
      releaseVersion: manifest.releaseVersion,
      reason,
    }, deps);
  }
  return { providerResult, release: health.release };
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
      variables: releaseVariables(manifest),
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

export function releaseVariables(manifest) {
  return {
    CORGTEX_RELEASE_VERSION: manifest.releaseVersion,
    CORGTEX_RELEASE_IMAGE_TAG: manifest.imageTag,
    CORGTEX_RELEASE_GIT_SHA: manifest.gitSha,
    CORGTEX_STARTUP_MODE: "combined",
    CORGTEX_AUTO_SEED_JNJ_DEMO: "false",
    SEED_SCRIPTS: "",
  };
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
    `CORGTEX_RELEASE_VERSION=${manifest.releaseVersion}`,
    `CORGTEX_RELEASE_IMAGE_TAG=${manifest.imageTag}`,
    `CORGTEX_RELEASE_GIT_SHA=${manifest.gitSha}`,
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
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `${command} ${args.join(" ")} failed.`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
