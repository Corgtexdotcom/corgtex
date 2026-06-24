import { createHash } from "node:crypto";

function shortHash(value, length = 10) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function failedResultLabels(results = []) {
  return results
    .filter((result) => result.status === "failed")
    .map((result) => result.target?.label ?? result.target?.id ?? "unknown-target");
}

function failedEvidence(results = []) {
  return results
    .filter((result) => result.status === "failed")
    .map((result) => `${result.target?.label ?? result.target?.id ?? "unknown"}: ${result.error ?? "failed"}`);
}

export function buildFleetReleaseIncident({ manifest, results = [], error, stage = "deploy" }) {
  const failedLabels = failedResultLabels(results);
  const errorMessage = error instanceof Error ? error.message : String(error ?? "Fleet release failed.");
  const failedSummary = failedLabels.length > 0 ? failedLabels.join(", ") : errorMessage;
  const dedupeKey = `fleet-release:${manifest?.gitSha ?? "unknown"}:${stage}:${failedSummary}`;
  return {
    dedupeKey,
    searchToken: `ops:${shortHash(dedupeKey)}`,
    severity: "P1",
    service: "fleet-release",
    status: "failed",
    summary: `Fleet release ${manifest?.imageTag ?? manifest?.gitSha ?? "unknown"} failed for ${failedSummary}`,
    evidence: [
      `Release: ${manifest?.imageTag ?? "unknown"}`,
      `Git SHA: ${manifest?.gitSha ?? "unknown"}`,
      `Stage: ${stage}`,
      ...failedEvidence(results),
      failedLabels.length === 0 ? `Error: ${errorMessage}` : null,
    ].filter(Boolean),
    recommendedAction: "Inspect the failed deployment target, health proof, post-deploy probe, and provider status before retrying.",
    createdAt: new Date().toISOString(),
  };
}

export function fleetReleaseSlackPayload(incident) {
  return {
    text: `Corgtex ${incident.severity}: ${incident.summary}`,
  };
}

function githubConfig(env) {
  const token = env.OPS_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  const repository = env.OPS_GITHUB_REPOSITORY ?? env.GITHUB_REPOSITORY;
  if (!token || !repository) return null;
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error("OPS_GITHUB_REPOSITORY or GITHUB_REPOSITORY must be formatted as owner/repo.");
  }
  return {
    baseUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
    owner,
    repo,
    token,
  };
}

async function githubRequest(github, path, options = {}, deps = {}) {
  const response = await (deps.fetchImpl ?? fetch)(`${github.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${github.token}`,
      "Content-Type": "application/json",
      "User-Agent": "corgtex-fleet-release",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  const okStatuses = options.okStatuses ?? [200, 201];
  if (!okStatuses.includes(response.status)) {
    throw new Error(`GitHub incident request failed with HTTP ${response.status}.`);
  }
  return payload;
}

function incidentBody(incident) {
  return [
    "## Summary",
    incident.summary,
    "",
    "## Evidence",
    ...incident.evidence.map((item) => `- ${item}`),
    "",
    "## Recommended action",
    incident.recommendedAction,
    "",
    `Generated: ${incident.createdAt}`,
  ].join("\n");
}

async function upsertGithubIncident(incident, env, deps) {
  const github = githubConfig(env);
  if (!github) return { channel: "none", sent: false, reason: "github_not_configured" };

  const issues = await githubRequest(
    github,
    `/repos/${github.owner}/${github.repo}/issues?state=open&per_page=100`,
    {},
    deps,
  );
  const existing = Array.isArray(issues)
    ? issues.find((issue) => !issue.pull_request && typeof issue.title === "string" && issue.title.includes(incident.searchToken))
    : null;

  if (existing?.number) {
    const comment = await githubRequest(github, `/repos/${github.owner}/${github.repo}/issues/${existing.number}/comments`, {
      method: "POST",
      body: { body: incidentBody(incident) },
    }, deps);
    return { channel: "github", sent: true, url: comment.html_url };
  }

  const issue = await githubRequest(github, `/repos/${github.owner}/${github.repo}/issues`, {
    method: "POST",
    body: {
      title: `[${incident.searchToken}] ${incident.severity} ${incident.service}: ${incident.summary}`,
      body: incidentBody(incident),
    },
  }, deps);
  return { channel: "github", sent: true, url: issue.html_url };
}

export async function notifyFleetReleaseFailure(params, deps = {}) {
  const env = deps.env ?? process.env;
  const incident = buildFleetReleaseIncident(params);
  const webhookUrl = env.OPS_SLACK_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    const response = await (deps.fetchImpl ?? fetch)(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fleetReleaseSlackPayload(incident)),
    });
    if (!response.ok) {
      throw new Error(`Slack alert returned HTTP ${response.status}.`);
    }
    return { channel: "slack", sent: true, incident };
  }
  const result = await upsertGithubIncident(incident, env, deps);
  return { ...result, incident };
}
