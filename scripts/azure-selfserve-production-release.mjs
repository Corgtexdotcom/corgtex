#!/usr/bin/env node

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

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

const webImage = `${acrServer}/${webRepository}:${imageTag}`;
const workerImage = `${acrServer}/${workerRepository}:${imageTag}`;

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

function normalizeBaseUrl(value) {
  return String(value).replace(/\/$/, "");
}

async function updateContainerApp(name, image) {
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
    "--output",
    "none",
  ]);
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
  const rendered = [command, ...commandArgs].join(" ");
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
