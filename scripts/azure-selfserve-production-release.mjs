#!/usr/bin/env node

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { parseBoolean } from "./release/fleet-release-core.mjs";

const DEFAULTS = {
  resourceGroup: "rg-corgtex-selfserve-production-wus3",
  acrName: "acrcorgtexssstgwus3",
  acrServer: "acrcorgtexssstgwus3.azurecr.io",
  webAppName: "ca-corgtex-ss-prod-web",
  workerAppName: "ca-corgtex-ss-prod-worker",
  webRepository: "corgtex/web",
  workerRepository: "corgtex/worker",
  appUrl: "https://selfserve.corgtex.com",
};

const args = parseArgs(process.argv.slice(2));
const releaseGitSha = required(args.sha ?? args.releaseGitSha ?? process.env.GITHUB_SHA, "release git SHA");
const imageTag = args.imageTag ?? `sha-${releaseGitSha}`;
const releaseVersion = args.version ?? args.releaseVersion ?? `main-${releaseGitSha.slice(0, 12)}`;
const resourceGroup = args.resourceGroup ?? DEFAULTS.resourceGroup;
const acrName = args.acrName ?? DEFAULTS.acrName;
const acrServer = args.acrServer ?? `${acrName}.azurecr.io`;
const webAppName = args.webAppName ?? DEFAULTS.webAppName;
const workerAppName = args.workerAppName ?? DEFAULTS.workerAppName;
const webRepository = args.webRepository ?? DEFAULTS.webRepository;
const workerRepository = args.workerRepository ?? DEFAULTS.workerRepository;
const appUrl = normalizeBaseUrl(args.appUrl ?? DEFAULTS.appUrl);
const sourceDir = args.sourceDir ?? ".";
const dryRun = Boolean(args.dryRun);
const skipBuild = Boolean(args.skipBuild);
const skipHealthSmoke = Boolean(args.skipHealthSmoke);
validateRuntimeObservabilityBooleans();
const nextServerActionsEncryptionKey = skipBuild
  ? null
  : dryRun
    ? "dry-run-next-server-actions-key"
    : requiredEnv(process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");

const webImage = `${acrServer}/${webRepository}:${imageTag}`;
const workerImage = `${acrServer}/${workerRepository}:${imageTag}`;
const AZURE_OBSERVABILITY_SECRET_NAMES = {
  APPLICATIONINSIGHTS_CONNECTION_STRING: "ai-conn-secret",
  POSTHOG_PROJECT_TOKEN: "posthog-token",
};

const summary = {
  resourceGroup,
  acrName,
  webAppName,
  workerAppName,
  release: {
    version: releaseVersion,
    imageTag,
    gitSha: releaseGitSha,
    webImage,
    workerImage,
  },
  dryRun,
  skipBuild,
  skipHealthSmoke,
};

console.log(JSON.stringify({ stage: "planned", ...summary }, null, 2));

if (!skipBuild) {
  await run("az", [
    "acr",
    "build",
    "--registry",
    acrName,
    "--image",
    `${webRepository}:${imageTag}`,
    "--file",
    "deploy/Dockerfile.web",
    "--build-arg",
    `CORGTEX_RELEASE_GIT_SHA=${releaseGitSha}`,
    "--build-arg",
    `GITHUB_SHA=${releaseGitSha}`,
    "--build-arg",
    "REQUIRE_NEXT_SERVER_ACTIONS_KEY=true",
    "--secret-build-arg",
    `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${nextServerActionsEncryptionKey}`,
    sourceDir,
  ]);
  await run("az", [
    "acr",
    "build",
    "--registry",
    acrName,
    "--image",
    `${workerRepository}:${imageTag}`,
    "--file",
    "deploy/Dockerfile.worker",
    sourceDir,
  ]);
}

await updateContainerApp(webAppName, webImage);
await updateContainerApp(workerAppName, workerImage);

if (!skipHealthSmoke && !dryRun) {
  await smokeHealth(`${appUrl}/api/health`, releaseGitSha);
}

console.log(JSON.stringify({ stage: "complete", ...summary }, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["dryRun", "skipBuild", "skipHealthSmoke"].includes(key)) {
      parsed[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`Missing ${label}. Pass --sha or run from GitHub Actions with GITHUB_SHA.`);
  }
  return normalized;
}

function requiredEnv(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`Missing ${name}. Set it in the release environment or pass --skip-build.`);
  }
  return normalized;
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/$/, "");
}

async function updateContainerApp(name, image) {
  const releaseSecrets = runtimeObservabilitySecretArgs();
  if (releaseSecrets.length) {
    await run("az", [
      "containerapp",
      "secret",
      "set",
      "--name",
      name,
      "--resource-group",
      resourceGroup,
      "--secrets",
      ...releaseSecrets,
      "--output",
      "none",
    ]);
  }

  await run("az", [
    "containerapp",
    "update",
    "--name",
    name,
    "--resource-group",
    resourceGroup,
    "--image",
    image,
    "--set-env-vars",
    `CORGTEX_RELEASE_VERSION=${releaseVersion}`,
    `CORGTEX_RELEASE_IMAGE_TAG=${imageTag}`,
    `CORGTEX_RELEASE_GIT_SHA=${releaseGitSha}`,
    "CORGTEX_STARTUP_MODE=migrate-and-web",
    "CORGTEX_AUTO_SEED_JNJ_DEMO=false",
    "SEED_SCRIPTS=",
    ...runtimeObservabilityEnvArgs(),
    "--output",
    "none",
  ]);
}

function optionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function booleanFromEnv(name, fallback = false) {
  return parseBoolean(process.env[name], fallback);
}

function canonicalBooleanFromEnv(name, fallback = false) {
  return booleanFromEnv(name, fallback) ? "true" : "false";
}

function validateRuntimeObservabilityBooleans() {
  for (const name of ["POSTHOG_ENABLED", "POSTHOG_CAPTURE_KILL_SWITCH", "POSTHOG_CAPTURE_DEBUG"]) {
    if (!optionalText(process.env[name])) continue;
    try {
      parseBoolean(process.env[name], false);
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function runtimeObservabilityEnvArgs() {
  const variables = [];
  const applicationInsightsConnectionString = optionalText(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);
  if (applicationInsightsConnectionString) {
    variables.push(`APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:${AZURE_OBSERVABILITY_SECRET_NAMES.APPLICATIONINSIGHTS_CONNECTION_STRING}`);
  } else if (Object.hasOwn(process.env, "APPLICATIONINSIGHTS_CONNECTION_STRING")) {
    variables.push("APPLICATIONINSIGHTS_CONNECTION_STRING=");
  }

  const postHogProjectToken = optionalText(process.env.POSTHOG_PROJECT_TOKEN);
  if (booleanFromEnv("POSTHOG_ENABLED") && postHogProjectToken) {
    variables.push("POSTHOG_ENABLED=true");
    variables.push(`POSTHOG_CAPTURE_KILL_SWITCH=${canonicalBooleanFromEnv("POSTHOG_CAPTURE_KILL_SWITCH", false)}`);
    variables.push(`POSTHOG_PROJECT_TOKEN=secretref:${AZURE_OBSERVABILITY_SECRET_NAMES.POSTHOG_PROJECT_TOKEN}`);
    variables.push(`POSTHOG_API_HOST=${optionalText(process.env.POSTHOG_API_HOST) ?? "https://us.i.posthog.com"}`);
    variables.push(`POSTHOG_ENVIRONMENT=${optionalText(process.env.POSTHOG_ENVIRONMENT) ?? "production"}`);
    variables.push(`POSTHOG_EVENT_SAMPLE_RATE=${optionalText(process.env.POSTHOG_EVENT_SAMPLE_RATE) ?? "1"}`);
    variables.push(`POSTHOG_CAPTURE_TIMEOUT_MS=${optionalText(process.env.POSTHOG_CAPTURE_TIMEOUT_MS) ?? "1500"}`);
    variables.push(`POSTHOG_CAPTURE_DEBUG=${canonicalBooleanFromEnv("POSTHOG_CAPTURE_DEBUG", false)}`);
    if (Object.hasOwn(process.env, "POSTHOG_INSTANCE_ID")) {
      variables.push(`POSTHOG_INSTANCE_ID=${optionalText(process.env.POSTHOG_INSTANCE_ID) ?? ""}`);
    }
  } else if (optionalText(process.env.POSTHOG_ENABLED) || postHogProjectToken) {
    variables.push("POSTHOG_ENABLED=false");
    variables.push("POSTHOG_CAPTURE_KILL_SWITCH=true");
    variables.push("POSTHOG_PROJECT_TOKEN=");
    if (Object.hasOwn(process.env, "POSTHOG_INSTANCE_ID")) {
      variables.push("POSTHOG_INSTANCE_ID=");
    }
  }

  return variables;
}

function runtimeObservabilitySecretArgs() {
  const secrets = [];
  const applicationInsightsConnectionString = optionalText(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);
  if (applicationInsightsConnectionString) {
    secrets.push(`${AZURE_OBSERVABILITY_SECRET_NAMES.APPLICATIONINSIGHTS_CONNECTION_STRING}=${applicationInsightsConnectionString}`);
  }

  const postHogProjectToken = optionalText(process.env.POSTHOG_PROJECT_TOKEN);
  if (booleanFromEnv("POSTHOG_ENABLED") && postHogProjectToken) {
    secrets.push(`${AZURE_OBSERVABILITY_SECRET_NAMES.POSTHOG_PROJECT_TOKEN}=${postHogProjectToken}`);
  }

  return secrets;
}

async function smokeHealth(url, expectedGitSha) {
  let lastError = null;
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "cache-control": "no-cache" },
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (body?.status !== "ok" || body?.database !== "up" || body?.schema !== "ready") {
        throw new Error(`Unhealthy response: ${JSON.stringify({
          status: body?.status,
          database: body?.database,
          schema: body?.schema,
        })}`);
      }
      if (body?.release?.gitSha !== expectedGitSha) {
        throw new Error(`Release gitSha ${body?.release?.gitSha || "missing"} did not match ${expectedGitSha}`);
      }
      console.log(JSON.stringify({
        stage: "health-smoke",
        url,
        attempt,
        release: body.release,
      }, null, 2));
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await delay(10_000);
    }
  }
  throw lastError ?? new Error(`Health smoke failed for ${url}`);
}

async function run(command, commandArgs) {
  const rendered = renderCommand(command, commandArgs);
  if (dryRun) {
    console.log(`[dry-run] ${rendered}`);
    return;
  }
  console.log(`[run] ${rendered}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${rendered} failed with ${signal || code}`));
    });
  });
}

function renderCommand(command, commandArgs) {
  return [command, ...commandArgs.map((arg, index) => redactCommandArg(arg, index, commandArgs))].join(" ");
}

function redactCommandArg(arg, index, commandArgs) {
  const text = String(arg);
  if (index > 0 && isSensitiveCommandFlag(commandArgs[index - 1])) {
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

function isSensitiveCommandKey(value) {
  return /(token|secret|password|api[_-]?key|connection[_-]?string)/i.test(String(value));
}

function isSensitiveCommandFlag(value) {
  const text = String(value);
  if (/^--?secrets$/i.test(text)) return false;
  return /^--?.*(token|secret|password|api[_-]?key|connection[_-]?string)/i.test(text);
}
