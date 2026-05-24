#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  incidentBody,
  incidentLabels,
  incidentTitle,
  normalizeIncident,
  parseArgs,
  shortHash,
} from "./ops-core.mjs";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const syncResolved = Boolean(args["sync-resolved"]);
const RESOLUTION_BLOCKING_LABELS = new Set(["halt-agents", "needs-replan"]);

async function main() {
  const incidents = await readIncidents();
  const plans = incidents.map((incident) => ({
    incident,
    title: incidentTitle(incident),
    body: incidentBody(incident),
    labels: incidentLabels(incident),
    searchToken: `ops:${shortHash(incident.dedupeKey, 10)}`,
  }));

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, syncResolved, issues: plans }, null, 2));
    return;
  }

  const api = githubApiConfig();
  if (api) {
    await publishWithGitHubApi(api, plans, { syncResolved });
    return;
  }

  publishWithGh(plans, { syncResolved });
}

async function readIncidents() {
  const raw = args.file
    ? await readFile(args.file, "utf8")
    : await readStdin();
  const parsed = raw.trim() ? JSON.parse(raw) : sampleIncident();
  const list = Array.isArray(parsed) ? parsed : parsed.incidents ?? [parsed];
  return list.map(normalizeIncident);
}

function sampleIncident() {
  return {
    dedupeKey: "dry-run:sample",
    severity: "P3",
    service: "ops",
    status: "dry-run",
    summary: "Sample incident. Pipe real health-sweep output into this script.",
    evidence: [],
    recommendedAction: "none",
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function publishWithGitHubApi(api, plans, options = {}) {
  for (const plan of plans) {
    await ensureLabelsWithApi(api, plan.labels);
    const existing = await findExistingIssueWithApi(api, plan.searchToken);
    if (existing?.number) {
      const comment = await githubRequest(
        api,
        `/repos/${api.owner}/${api.repo}/issues/${existing.number}/comments`,
        {
          method: "POST",
          body: { body: updateBody(plan) },
        },
      );
      console.log(comment.html_url);
      continue;
    }

    const issue = await githubRequest(api, `/repos/${api.owner}/${api.repo}/issues`, {
      method: "POST",
      body: {
        title: plan.title,
        body: plan.body,
        labels: plan.labels,
      },
    });
    console.log(issue.html_url);
  }

  if (options.syncResolved) {
    await closeResolvedIssuesWithApi(api, activeSearchTokens(plans));
  }
}

async function ensureLabelsWithApi(api, labels) {
  for (const label of labels) {
    await githubRequest(
      api,
      `/repos/${api.owner}/${api.repo}/labels`,
      {
        method: "POST",
        body: {
          name: label,
          color: labelColor(label),
        },
        okStatuses: [201, 422],
      },
    );
  }
}

async function findExistingIssueWithApi(api, searchToken) {
  const issues = await githubRequest(
    api,
    `/repos/${api.owner}/${api.repo}/issues?state=open&labels=ops-auto-fix&per_page=100`,
  );
  return issues.find((issue) => !issue.pull_request && issue.title.includes(searchToken)) ?? null;
}

function githubApiConfig() {
  const token = process.env.OPS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const repository = process.env.OPS_GITHUB_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return null;

  const parts = repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("OPS_GITHUB_REPOSITORY or GITHUB_REPOSITORY must be formatted as owner/repo.");
  }

  return {
    baseUrl: (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
    owner: parts[0],
    repo: parts[1],
    token,
  };
}

async function githubRequest(api, path, options = {}) {
  const response = await fetch(`${api.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${api.token}`,
      "Content-Type": "application/json",
      "User-Agent": "corgtex-ops-monitor",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  const okStatuses = options.okStatuses ?? [200, 201];
  if (!okStatuses.includes(response.status)) {
    const message = payload?.message ?? response.statusText;
    throw new Error(`GitHub API ${options.method ?? "GET"} ${path} failed: ${message}`);
  }
  return payload;
}

async function closeResolvedIssuesWithApi(api, activeTokens) {
  const issues = await githubRequest(
    api,
    `/repos/${api.owner}/${api.repo}/issues?state=open&labels=ops-auto-fix&per_page=100`,
  );
  for (const issue of issues) {
    if (issue.pull_request || !shouldCloseIssue(issue, activeTokens)) continue;
    const body = resolvedCommentBody();
    const comment = await githubRequest(
      api,
      `/repos/${api.owner}/${api.repo}/issues/${issue.number}/comments`,
      {
        method: "POST",
        body: { body },
      },
    );
    const closed = await githubRequest(
      api,
      `/repos/${api.owner}/${api.repo}/issues/${issue.number}`,
      {
        method: "PATCH",
        body: { state: "closed", state_reason: "completed" },
      },
    );
    console.log(comment.html_url);
    console.log(closed.html_url);
  }
}

function publishWithGh(plans, options = {}) {
  for (const plan of plans) {
    ensureLabels(plan.labels);
    const existing = findExistingIssue(plan.searchToken);
    if (existing?.number) {
      runGh(["issue", "comment", String(existing.number), "--body", updateBody(plan)]);
      continue;
    }

    runGh([
      "issue",
      "create",
      "--title",
      plan.title,
      "--body",
      plan.body,
      "--label",
      plan.labels.join(","),
    ]);
  }

  if (options.syncResolved) {
    closeResolvedIssuesWithGh(activeSearchTokens(plans));
  }
}

function ensureLabels(labels) {
  for (const label of labels) {
    runGh(["label", "create", label, "--force"]);
  }
}

function findExistingIssue(searchToken) {
  const output = runGh([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    "ops-auto-fix",
    "--search",
    `${searchToken} in:title`,
    "--json",
    "number,title",
  ]);
  const list = JSON.parse(output || "[]");
  return list[0] ?? null;
}

function closeResolvedIssuesWithGh(activeTokens) {
  const output = runGh([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    "ops-auto-fix",
    "--json",
    "number,title,labels",
    "--limit",
    "100",
  ]);
  const issues = JSON.parse(output || "[]");
  for (const issue of issues) {
    if (!shouldCloseIssue(issue, activeTokens)) continue;
    runGh([
      "issue",
      "close",
      String(issue.number),
      "--reason",
      "completed",
      "--comment",
      resolvedCommentBody(),
    ]);
  }
}

function activeSearchTokens(plans) {
  return new Set(plans.map((plan) => plan.searchToken));
}

function shouldCloseIssue(issue, activeTokens) {
  const token = issueSearchToken(issue);
  if (!token || activeTokens.has(token)) return false;
  const labels = issueLabelNames(issue);
  for (const label of labels) {
    if (RESOLUTION_BLOCKING_LABELS.has(label)) return false;
  }
  return true;
}

function issueSearchToken(issue) {
  const match = optionalString(issue?.title).match(/\[?(ops:[a-f0-9]{10})\]?/i);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function issueLabelNames(issue) {
  return Array.isArray(issue?.labels)
    ? issue.labels.map((label) => optionalString(label?.name ?? label).toLowerCase()).filter(Boolean)
    : [];
}

function resolvedCommentBody() {
  return [
    `Resolved by clean ops sweep at ${new Date().toISOString()}.`,
    "",
    "The latest sweep did not report a matching active incident for this dedupe key. Closing so future builder runs focus on current signals.",
  ].join("\n");
}

function optionalString(value) {
  return typeof value === "string" ? value : "";
}

function updateBody(plan) {
  return [
    `Repeated signal at ${new Date().toISOString()}.`,
    "",
    plan.body,
  ].join("\n");
}

function labelColor(label) {
  if (label === "ops-auto-fix") return "D93F0B";
  if (label === "ops-incident") return "B60205";
  if (label === "severity-p1") return "B60205";
  if (label === "severity-p2") return "D93F0B";
  if (label === "severity-p3") return "FBCA04";
  if (label.startsWith("service-")) return "5319E7";
  return "C5DEF5";
}

function runGh(argv) {
  const gh = process.env.GH_BIN || "gh";
  const result = spawnSync(gh, argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: ghEnv(),
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    throw new Error(`gh ${argv.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function ghEnv() {
  const env = { ...process.env };
  if (!env.GH_CONFIG_DIR) {
    const builderConfig = env.CODEX_BUILDER_GH_CONFIG_DIR
      ?? (env.HOME ? `${env.HOME}/.config/gh-codex-builder` : null);
    if (builderConfig) env.GH_CONFIG_DIR = builderConfig;
  }
  return env;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
