#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function usage() {
  console.error([
    "Usage:",
    "  node scripts/set-railway-release-metadata.mjs --service <service> [--environment production] [--project <project-id>] [--sha <git-sha>] [--version <version>] [--skip-deploys]",
    "",
    "Examples:",
    "  node scripts/set-railway-release-metadata.mjs --service @corgtex/web --sha $(git rev-parse HEAD)",
    "  node scripts/set-railway-release-metadata.mjs --project 42d177e6-0f16-4878-9fb3-f65e6153ad2c --service web --sha $(git rev-parse HEAD)",
  ].join("\n"));
  process.exit(1);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value.trim() : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(stderr || `${command} ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function defaultSha() {
  return process.env.CORGTEX_RELEASE_GIT_SHA?.trim()
    || process.env.GITHUB_SHA?.trim()
    || commandOutput("git", ["rev-parse", "HEAD"]);
}

function defaultVersion() {
  return process.env.CORGTEX_RELEASE_VERSION?.trim()
    || `main-${new Date().toISOString().slice(0, 10)}`;
}

const service = readArg("--service");
if (!service) usage();

const environment = readArg("--environment") || "production";
const project = readArg("--project");
const sha = readArg("--sha") || defaultSha();
const version = readArg("--version") || defaultVersion();
const skipDeploys = hasFlag("--skip-deploys");

const args = [
  "variable",
  "set",
  "--service",
  service,
  "--environment",
  environment,
  ...(project ? ["--project", project] : []),
  ...(skipDeploys ? ["--skip-deploys"] : []),
  `CORGTEX_RELEASE_VERSION=${version}`,
  `CORGTEX_RELEASE_IMAGE_TAG=${sha}`,
  `CORGTEX_RELEASE_GIT_SHA=${sha}`,
];

const result = spawnSync("railway", args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.status !== 0) {
  const stderr = result.stderr?.trim();
  throw new Error(stderr || "Failed to set Railway release metadata.");
}

console.log(JSON.stringify({
  service,
  environment,
  project: project || undefined,
  version,
  gitSha: sha,
  imageTag: sha,
  deployTriggered: !skipDeploys,
}, null, 2));
