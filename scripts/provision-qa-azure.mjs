#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GROUP = "rg-corgtex-selfserve-production-wus3";
const JOB = "caj-corgtex-ss-prod-migrate";
const REGISTRY = "acrcorgtexssstgwus3.azurecr.io";
const VALIDATION_ADMIN_EMAIL = "qa-validation-admin@corgtex.test";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isTerminalExecution(status) {
  return ["Succeeded", "Failed", "Stopped", "Canceled"].includes(status);
}

export function executionTemplate(template, image, sha, mode, env) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !["preflight", "apply"].includes(mode)) throw new Error("Invalid release SHA or provisioning mode");
  const operation = env.QA_OPERATION || "fixtures";
  if (!["fixtures", "adopt-validation-owner"].includes(operation)) throw new Error("Invalid QA operation");
  const adoption = operation === "adopt-validation-owner";
  if (adoption && mode === "apply" && (!env.QA_EXPECTED_VALIDATION_WORKSPACE_ID?.trim() || !env.QA_EXPECTED_VALIDATION_ADMIN_USER_ID?.trim())) {
    throw new Error("Owner adoption apply requires reviewed validation workspace and admin user IDs");
  }
  if (!new RegExp(`^${REGISTRY.replaceAll(".", "\\.")}\/corgtex\/web@sha256:[a-f0-9]{64}$`).test(image)) throw new Error("Use the confirmed immutable selfserve image");
  if (template.containers?.length !== 1 || template.initContainers?.length) throw new Error("Unexpected provisioning job template");
  const result = structuredClone(template);
  const container = result.containers[0];
  container.image = image;
  container.command = ["node"];
  container.args = [adoption ? "scripts/adopt-validation-support-owner.mjs" : "scripts/provision-qa-workspaces.mjs", ...(mode === "apply" ? ["--apply"] : [])];
  container.env = [
    { name: "DATABASE_URL", secretRef: "database-url" },
    { name: "NODE_ENV", value: "production" },
    { name: "APP_URL", value: "https://selfserve.corgtex.com" },
    { name: "NEXT_PUBLIC_APP_URL", value: "https://selfserve.corgtex.com" },
    { name: "QA_EXPECTED_DATABASE_HOST", value: "corgtex-ss-prod-pg.postgres.database.azure.com" },
    { name: "QA_EXPECTED_DATABASE_NAME", value: "corgtex" },
    { name: "QA_EXPECTED_DATABASE_SCHEMA", value: "public" },
    { name: "QA_EXPECTED_RELEASE_SHA", value: sha },
  ];
  if (adoption || mode === "apply") container.env.push({ name: "VALIDATION_BOOTSTRAP_ADMIN_EMAIL", value: VALIDATION_ADMIN_EMAIL });
  if (!adoption && mode === "apply") {
    container.env.push(
      { name: "ADMIN_PASSWORD", secretRef: "qa-validation-admin-password" },
      { name: "QA_VALIDATION_MEMBER_EMAIL", value: "qa-validation-member@corgtex.test" },
      { name: "QA_VALIDATION_MEMBER_PASSWORD", secretRef: "qa-validation-member-password" },
    );
  }
  for (const name of adoption ? ["QA_EXPECTED_VALIDATION_WORKSPACE_ID", "QA_EXPECTED_VALIDATION_ADMIN_USER_ID"] : ["QA_EXPECTED_DEMO_WORKSPACE_ID", "QA_EXPECTED_VALIDATION_WORKSPACE_ID"]) {
    const value = env[name]?.trim();
    if (value) {
      if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid expected workspace ID");
      container.env.push({ name, value });
    }
  }
  if (adoption && mode === "apply") {
    for (const name of ["QA_EXECUTION_ACTOR", "QA_EXECUTION_INITIATOR", "QA_EXECUTION_REPOSITORY", "QA_EXECUTION_RUN_ID", "QA_EXECUTION_RUN_ATTEMPT", "QA_EXECUTION_WORKFLOW_REF"]) {
      const value = env[name]?.trim();
      if (!value) throw new Error(`Owner adoption requires ${name}`);
      container.env.push({ name, value });
    }
  }
  return result;
}

export function assertServingRelease(web, health, sha, image) {
  const configuredImage = web.properties.template.containers[0].image;
  if (![`${REGISTRY}/corgtex/web:sha-${sha}`, image].includes(configuredImage)
    || !web.properties.configuration.ingress.customDomains?.some((item) => item.name === "selfserve.corgtex.com")
    || health.runtime?.workspaceScopeValid !== true || health.runtime?.workspaceScopeSlug !== null
    || health.status !== "ok" || health.database !== "up" || health.release?.gitSha !== sha
    || Object.values(health.release?.drift ?? {}).some((value) => value === true)) {
    throw new Error("Selfserve is not healthy on the expected serving release");
  }
}

function az(args) {
  return JSON.parse(execFileSync("az", [...args, "--output", "json", "--only-show-errors"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
}

export async function main(env = process.env) {
  const sha = env.QA_EXPECTED_RELEASE_SHA;
  const mode = env.QA_PROVISION_MODE || "preflight";
  const operation = env.QA_OPERATION || "fixtures";
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Set the full QA_EXPECTED_RELEASE_SHA");
  if (!["preflight", "apply"].includes(mode) || !["fixtures", "adopt-validation-owner"].includes(operation)) throw new Error("Invalid QA operation or mode");
  const backup = az(["postgres", "flexible-server", "show", "--name", "corgtex-ss-prod-pg", "--resource-group", GROUP]);
  if (backup.state !== "Ready" || !Number.isInteger(backup.backup?.backupRetentionDays) || backup.backup?.backupRetentionDays < 7 || !backup.backup?.earliestRestoreDate) throw new Error("Verify selfserve database recovery before provisioning");
  const executions = az(["containerapp", "job", "execution", "list", "--name", JOB, "--resource-group", GROUP]);
  if (executions.some((item) => !isTerminalExecution(item.properties.status))) throw new Error("Another selfserve database execution is active; do not duplicate it");
  const digest = az(["acr", "repository", "show", "--name", "acrcorgtexssstgwus3", "--image", `corgtex/web:sha-${sha}`]).digest;
  const image = `${REGISTRY}/corgtex/web@${digest}`;
  const web = az(["containerapp", "show", "--name", "ca-corgtex-ss-prod-web", "--resource-group", GROUP]);
  const response = await fetch("https://selfserve.corgtex.com/api/health", { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Selfserve health request failed");
  assertServingRelease(web, await response.json(), sha, image);
  const job = az(["containerapp", "job", "show", "--name", JOB, "--resource-group", GROUP]);
  const names = new Set((job.properties.configuration.secrets ?? []).map((secret) => secret.name));
  if (!names.has("database-url") || (operation === "fixtures" && mode === "apply" && ["qa-validation-admin-password", "qa-validation-member-password"].some((name) => !names.has(name)))) {
    throw new Error("Set the required database and dedicated QA password secret references before apply");
  }
  const template = executionTemplate(job.properties.template, image, sha, mode, env);
  const file = path.join(tmpdir(), `corgtex-qa-execution-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(template), { mode: 0o600 });
  const execution = az(["containerapp", "job", "start", "--name", JOB, "--resource-group", GROUP, "--yaml", file]);
  console.log(JSON.stringify({ execution: execution.name, operation, mode, sha, image, databaseRecoveryAvailable: true }));
  let previous;
  for (let attempt = 0; attempt < 65; attempt++) {
    const state = az(["containerapp", "job", "execution", "show", "--name", JOB, "--resource-group", GROUP, "--job-execution-name", execution.name]).properties.status;
    if (state !== previous) console.log(JSON.stringify({ execution: execution.name, status: state }));
    previous = state;
    if (state === "Succeeded") return;
    if (isTerminalExecution(state)) throw new Error(`QA execution ${execution.name} ${state}; inspect it before any retry`);
    await sleep(30_000);
  }
  throw new Error(`QA execution ${execution.name} has no terminal proof; do not start another writer`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
