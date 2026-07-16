#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./ops/ops-core.mjs";

const FAILURE_EVENTS = [
  "corgtex_route_error",
  "corgtex_app_route_error",
  "corgtex_server_action_error",
  "corgtex_render_error",
  "corgtex_worker_error",
];
const NON_STATUS_FAILURE_EVENTS = new Set([
  "corgtex_server_action_error",
  "corgtex_render_error",
  "corgtex_worker_error",
]);
const DEFAULT_WINDOW_MINUTES = 20;
const TARGET_GROUPS = Object.freeze([
  "railway-customers",
  "azure-selfserve",
  "ops",
  "backup-app",
]);
const DEFAULT_TARGET_GROUPS = Object.freeze([
  "railway-customers",
  "azure-selfserve",
  "ops",
]);
const POSTHOG_CAPTURE_HOSTS = new Map([
  ["https://us.i.posthog.com", "https://us.posthog.com"],
  ["https://eu.i.posthog.com", "https://eu.posthog.com"],
]);

export async function runObservationGate(options = {}) {
  const manifest = normalizeManifest(options.manifest ?? {});
  const now = options.now ? new Date(options.now) : new Date();
  const since = options.since ?? sinceFromWindow(options.windowMinutes ?? DEFAULT_WINDOW_MINUTES, now);
  const until = options.until ?? now;
  const rows = options.rows ?? await collectObservationRows({
    env: options.env ?? process.env,
    since,
    until,
    deps: options.deps ?? {},
  });
  const summary = buildObservationSummary({
    manifest,
    since,
    rows,
    targets: options.targets ?? null,
  });
  summary.advisoryPublish = {
    attempted: false,
    status: "skipped",
  };

  if (options.publishAdvisories && summary.advisoryIncidents.length > 0) {
    summary.advisoryPublish.attempted = true;
    try {
      publishAdvisoryIncidents(summary.advisoryIncidents, options.deps ?? {});
      summary.advisoryPublish.status = "published";
    } catch (error) {
      summary.advisoryPublish.status = "failed";
      summary.advisoryPublish.error = errorMessage(error);
      console.warn(`[observation] advisory publishing failed: ${summary.advisoryPublish.error}`);
    }
  }

  if (options.summaryFile) {
    await writeSummaryFile(options.summaryFile, summary);
  }

  if (options.githubStepSummary) {
    await appendGithubStepSummary(options.githubStepSummary, summary);
  }

  return summary;
}

export function buildObservationSummary({ manifest, since, rows, targets = null }) {
  const normalizedRows = rows.map(normalizeObservationRow).filter(Boolean);
  const failureRows = normalizedRows.filter(isBlockingClassFailure);
  const selectedTargets = normalizeObservationTargets(targets);
  const blockingFailures = [];
  const advisoryFailures = [];

  for (const row of failureRows) {
    if (rowMatchesRelease(row, manifest) && rowMatchesTargets(row, selectedTargets)) {
      blockingFailures.push(row);
    } else {
      advisoryFailures.push(row);
    }
  }

  return {
    status: blockingFailures.length > 0 ? "blocked" : "passed",
    release: {
      gitSha: manifest.gitSha,
      imageTag: manifest.imageTag,
      version: manifest.releaseVersion,
    },
    targets,
    since: since.toISOString(),
    sources: sourceSummaries(normalizedRows),
    checkedRows: normalizedRows.length,
    blockingFailures,
    advisoryFailures,
    advisoryIncidents: advisoryFailures.map((row) => advisoryIncidentForRow(row, manifest)),
  };
}

export async function collectObservationRows({ env = process.env, since, until = new Date(), deps = {} }) {
  const rows = [];
  const sourceNotes = [];
  let queriedSources = 0;

  if (isAzureMonitorConfigured(env)) {
    queriedSources += 1;
    try {
      rows.push(...await queryAzureMonitorRows({ env, since, until, deps }));
    } catch (error) {
      throw new Error(`Azure Monitor observation query failed: ${errorMessage(error)}`);
    }
  } else {
    sourceNotes.push({
      source: "azure_monitor",
      status: "skipped",
      reason: "AZURE_APPLICATIONINSIGHTS_APP_NAME and AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP are required",
    });
  }

  if (isPostHogQueryConfigured(env)) {
    queriedSources += 1;
    try {
      rows.push(...await queryPostHogRows({ env, since, deps }));
    } catch (error) {
      throw new Error(`PostHog observation query failed: ${errorMessage(error)}`);
    }
  } else {
    sourceNotes.push({
      source: "posthog",
      status: "skipped",
      reason: "POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY or POSTHOG_QUERY_API_KEY are required",
    });
  }

  for (const note of sourceNotes) {
    if (typeof deps.onSourceNote === "function") {
      deps.onSourceNote(note);
    } else {
      console.warn(`[observation] skipped ${note.source}: ${note.reason}`);
    }
  }

  if (requiresObservationSource(env) && queriedSources === 0) {
    throw new Error("No observation query source configured; set Azure Monitor or PostHog query credentials before running the production observation gate");
  }

  return rows;
}

export async function queryAzureMonitorRows({ env = process.env, since, until = new Date(), deps = {} }) {
  const query = azureMonitorQuery(since, observationEnvironment(env));
  const app = requiredText(env.AZURE_APPLICATIONINSIGHTS_APP_NAME, "AZURE_APPLICATIONINSIGHTS_APP_NAME");
  const resourceGroup = requiredText(env.AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP, "AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP");
  const command = deps.runCommand ?? defaultRunCommand;
  const output = command("az", [
    "monitor",
    "app-insights",
    "query",
    "--app",
    app,
    "--resource-group",
    resourceGroup,
    "--analytics-query",
    query,
    "--start-time",
    since.toISOString(),
    "--end-time",
    new Date(until).toISOString(),
    "-o",
    "json",
  ]);
  return parseAzureMonitorRows(JSON.parse(output), env);
}

export async function queryPostHogRows({ env = process.env, since, deps = {} }) {
  const apiHost = postHogQueryHost(env);
  const projectId = requiredText(env.POSTHOG_PROJECT_ID, "POSTHOG_PROJECT_ID");
  const token = requiredText(env.POSTHOG_PERSONAL_API_KEY ?? env.POSTHOG_QUERY_API_KEY, "POSTHOG_PERSONAL_API_KEY or POSTHOG_QUERY_API_KEY");
  const environment = postHogEnvironment(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${apiHost}/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: postHogQuery(since, environment),
      },
    }),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`PostHog query HTTP ${response.status}: ${payload?.detail ?? payload?.error ?? response.statusText}`);
  }

  return parsePostHogRows(payload, env);
}

export function parseAzureMonitorRows(payload, env = process.env) {
  const table = payload?.tables?.[0];
  if (!table) return [];
  const columns = table.columns.map((column) => column.name);
  return table.rows.map((row) => rowObject(columns, row, {
    source: "azure_monitor",
    source_url: azurePortalUrl(env),
  }));
}

export function parsePostHogRows(payload, env = process.env) {
  const columns = payload?.columns?.map((column) => typeof column === "string" ? column : column.name)
    ?? payload?.results?.columns
    ?? [];
  const resultRows = Array.isArray(payload?.results) ? payload.results : payload?.results?.rows ?? [];
  return resultRows.map((row) => rowObject(columns, row, {
    source: "posthog",
    source_url: postHogProjectUrl(env),
  }));
}

export function normalizeObservationRow(input) {
  if (!input || typeof input !== "object") return null;
  return {
    source: safeText(input.source) ?? "unknown",
    source_url: safeText(input.source_url),
    event: safeText(input.event ?? input.name) ?? "unknown",
    instance_id: safeText(input.instance_id),
    provider: safeText(input.provider),
    release_git_sha: safeText(input.release_git_sha),
    release_image_tag: safeText(input.release_image_tag),
    release_version: safeText(input.release_version),
    surface: safeText(input.surface),
    route: safeText(input.route),
    action: safeText(input.action),
    status: numericStatus(input.status),
    code: safeText(input.code),
    count: positiveInteger(input.events ?? input.count ?? 1),
    first_seen: isoText(input.first_seen ?? input.firstSeen ?? input.timestamp),
    last_seen: isoText(input.last_seen ?? input.lastSeen ?? input.timestamp),
  };
}

export function isBlockingClassFailure(row) {
  if (NON_STATUS_FAILURE_EVENTS.has(row.event)) return true;
  return Number.isFinite(row.status) && row.status >= 500;
}

export function rowMatchesRelease(row, manifest) {
  const expected = [
    manifest.gitSha,
    manifest.imageTag,
    manifest.releaseVersion,
  ].filter(Boolean);
  if (expected.length === 0) return false;
  const observed = [
    row.release_git_sha,
    row.release_image_tag,
    row.release_version,
  ].filter(Boolean);
  return observed.some((value) => expected.includes(value));
}

export function rowMatchesTargets(row, selectedTargets) {
  if (!selectedTargets || selectedTargets.size === 0) return true;
  const rowTargets = observationTargetsForRow(row);
  if (rowTargets.length === 0) return true;
  return rowTargets.some((target) => selectedTargets.has(target));
}

export function observationTargetsForRow(row) {
  const provider = safeText(row.provider)?.toLowerCase();
  const text = [
    row.instance_id,
    row.surface,
    row.route,
    row.action,
  ].filter(Boolean).join(" ").toLowerCase();
  const targets = new Set();

  if (provider === "azure" || text.includes("azure-selfserve") || text.includes("selfserve") || text.includes("ca-corgtex-ss")) {
    targets.add("azure-selfserve");
  }

  if (text.includes("backup-app") || text.includes("app.corgtex.com")) {
    targets.add("backup-app");
  }

  if (text.includes("ops") || text.includes("control-plane") || text.includes("ops.corgtex.com")) {
    targets.add("ops");
  }

  if (provider === "railway" && targets.size === 0) {
    targets.add("railway-customers");
  }

  return [...targets];
}

export function normalizeObservationTargets(value) {
  const raw = safeText(value);
  if (!raw || raw === "main-production-smoke" || raw === "production") return null;
  if (raw === "all") return new Set(TARGET_GROUPS);
  if (raw === "default") return new Set(DEFAULT_TARGET_GROUPS);

  const selected = raw.split(",")
    .map((part) => part.trim())
    .filter((part) => TARGET_GROUPS.includes(part));
  return selected.length > 0 ? new Set(selected) : null;
}

export function advisoryIncidentForRow(row, manifest) {
  const route = row.route ?? row.action ?? row.surface ?? "unknown";
  const release = row.release_git_sha ?? row.release_image_tag ?? row.release_version ?? "unknown-release";
  return {
    dedupeKey: `observation:${row.source}:${row.event}:${row.instance_id ?? "unknown"}:${route}:${row.code ?? row.status ?? "failure"}:${release}`,
    severity: "P2",
    service: "post-deploy-observation",
    status: "advisory",
    summary: `Unrelated production ${row.event} on ${row.instance_id ?? row.provider ?? "unknown"} ${route}`,
    evidence: [
      `${row.source}: ${row.event} count=${row.count} status=${row.status ?? "n/a"} code=${row.code ?? "n/a"}`,
      `observedRelease=${release}; currentRelease=${manifest.gitSha ?? manifest.imageTag ?? manifest.releaseVersion ?? "unknown"}`,
      `firstSeen=${row.first_seen ?? "n/a"} lastSeen=${row.last_seen ?? "n/a"}`,
      row.source_url ? `source=${row.source_url}` : null,
    ].filter(Boolean),
    recommendedAction: "Open a follow-up investigation; do not blame the current release unless evidence changes.",
  };
}

export function renderMarkdownSummary(summary) {
  const lines = [
    "## Post-deploy observation gate",
    "",
    `Status: ${summary.status}`,
    `Release: ${summary.release.gitSha ?? summary.release.imageTag ?? summary.release.version ?? "unknown"}`,
    `Window start: ${summary.since}`,
    `Rows checked: ${summary.checkedRows}`,
    "",
    `Blocking failures: ${summary.blockingFailures.length}`,
    `Advisory failures: ${summary.advisoryFailures.length}`,
  ];

  if (summary.blockingFailures.length > 0) {
    lines.push("", "### Blocking evidence", "");
    for (const row of summary.blockingFailures) {
      lines.push(`- ${evidenceLine(row)}`);
    }
  }

  if (summary.advisoryFailures.length > 0) {
    lines.push("", "### Advisory evidence", "");
    for (const row of summary.advisoryFailures) {
      lines.push(`- ${evidenceLine(row)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function azureMonitorQuery(since, environment) {
  const events = FAILURE_EVENTS.map((event) => `'${event}'`).join(",");
  const nonStatusEvents = [...NON_STATUS_FAILURE_EVENTS].map((event) => `'${event}'`).join(",");
  return [
    "customEvents",
    `| where timestamp >= datetime(${since.toISOString()})`,
    `| where tostring(customDimensions.environment) == '${kustoString(environment)}'`,
    `| where name in (${events})`,
    "| extend statusInt=toint(customDimensions.status)",
    `| where name in (${nonStatusEvents}) or statusInt >= 500`,
    "| summarize events=count(), first_seen=min(timestamp), last_seen=max(timestamp) by name, instance_id=tostring(customDimensions.instance_id), provider=tostring(customDimensions.provider), release_git_sha=tostring(customDimensions.release_git_sha), release_image_tag=tostring(customDimensions.release_image_tag), release_version=tostring(customDimensions.release_version), surface=tostring(customDimensions.surface), route=tostring(customDimensions.route), action=tostring(customDimensions.action), status=tostring(customDimensions.status), code=tostring(customDimensions.code)",
    "| order by events desc",
  ].join(" ");
}

function postHogQuery(since, environment) {
  const events = FAILURE_EVENTS.map((event) => `'${event}'`).join(",");
  const nonStatusEvents = [...NON_STATUS_FAILURE_EVENTS].map((event) => `'${event}'`).join(",");
  return [
    "SELECT event AS name, properties['instance_id'] AS instance_id, properties['provider'] AS provider, properties['release_git_sha'] AS release_git_sha, properties['release_image_tag'] AS release_image_tag, properties['release_version'] AS release_version, properties['surface'] AS surface, properties['route'] AS route, properties['action'] AS action, properties['status'] AS status, properties['code'] AS code, count() AS events, min(timestamp) AS first_seen, max(timestamp) AS last_seen",
    "FROM events",
    `WHERE timestamp >= toDateTime('${since.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")}')`,
    `AND properties['environment'] = '${hogQlString(environment)}'`,
    `AND event IN (${events})`,
    `AND (event IN (${nonStatusEvents}) OR toInt(coalesce(properties['status'], 0)) >= 500)`,
    "GROUP BY name, instance_id, provider, release_git_sha, release_image_tag, release_version, surface, route, action, status, code",
    "ORDER BY events DESC",
  ].join(" ");
}

function postHogEnvironment(env) {
  return observationEnvironment(env);
}

function hogQlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function kustoString(value) {
  return String(value).replace(/'/g, "''");
}

function observationEnvironment(env) {
  return safeText(env.OBSERVATION_ENVIRONMENT ?? env.POSTHOG_ENVIRONMENT ?? env.AZURE_MONITOR_ENVIRONMENT) ?? "production";
}

function rowObject(columns, row, extra) {
  const object = { ...extra };
  columns.forEach((column, index) => {
    object[column] = row[index];
  });
  return object;
}

function sourceSummaries(rows) {
  const grouped = new Map();
  for (const row of rows) {
    grouped.set(row.source, (grouped.get(row.source) ?? 0) + 1);
  }
  return [...grouped.entries()].map(([source, rows]) => ({ source, rows }));
}

function normalizeManifest(manifest) {
  return {
    gitSha: safeText(manifest.gitSha ?? manifest.release_git_sha),
    imageTag: safeText(manifest.imageTag ?? manifest.release_image_tag),
    releaseVersion: safeText(manifest.releaseVersion ?? manifest.version ?? manifest.release_version),
  };
}

function sinceFromWindow(windowMinutes, now = new Date()) {
  const minutes = Number.parseInt(String(windowMinutes), 10);
  const effectiveMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_WINDOW_MINUTES;
  return new Date(new Date(now).getTime() - effectiveMinutes * 60_000);
}

function publishAdvisoryIncidents(incidents, deps = {}) {
  const spawn = deps.spawnSync ?? spawnSync;
  const result = spawn(process.execPath, ["scripts/ops/github-incident.mjs"], {
    input: JSON.stringify({ incidents }),
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Advisory GitHub issue publishing failed with exit ${result.status}`);
  }
}

async function writeSummaryFile(file, summary) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);
}

async function appendGithubStepSummary(file, summary) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderMarkdownSummary(summary), { flag: "a" });
}

function evidenceLine(row) {
  const location = row.route ?? row.action ?? row.surface ?? "unknown";
  const release = row.release_git_sha ?? row.release_image_tag ?? row.release_version ?? "unknown-release";
  return `${row.source} ${row.event} ${location} count=${row.count} status=${row.status ?? "n/a"} code=${row.code ?? "n/a"} release=${release}`;
}

function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed with ${result.status}`);
  }
  return result.stdout;
}

function isAzureMonitorConfigured(env) {
  return Boolean(safeText(env.AZURE_APPLICATIONINSIGHTS_APP_NAME) && safeText(env.AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP));
}

function isPostHogQueryConfigured(env) {
  return Boolean(safeText(env.POSTHOG_PROJECT_ID) && safeText(env.POSTHOG_PERSONAL_API_KEY ?? env.POSTHOG_QUERY_API_KEY));
}

function requiresObservationSource(env) {
  return /^(1|true|yes)$/i.test(String(env.OBSERVATION_REQUIRE_SOURCE ?? ""));
}

function postHogQueryHost(env) {
  const explicit = safeText(env.POSTHOG_QUERY_API_HOST);
  if (explicit) return explicit.replace(/\/+$/, "");
  const captureHost = safeText(env.POSTHOG_API_HOST)?.replace(/\/+$/, "");
  return POSTHOG_CAPTURE_HOSTS.get(captureHost) ?? captureHost ?? "https://us.posthog.com";
}

function postHogProjectUrl(env) {
  const projectId = safeText(env.POSTHOG_PROJECT_ID);
  if (!projectId) return null;
  return `${postHogQueryHost(env)}/project/${encodeURIComponent(projectId)}`;
}

function azurePortalUrl(env) {
  const app = safeText(env.AZURE_APPLICATIONINSIGHTS_APP_NAME);
  const resourceGroup = safeText(env.AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP);
  if (!app || !resourceGroup) return null;
  return `Azure Monitor Application Insights ${resourceGroup}/${app}`;
}

function numericStatus(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function isoText(value) {
  const normalized = safeText(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? normalized : date.toISOString();
}

function safeText(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "null" || normalized === "undefined") return null;
  return normalized.slice(0, 500);
}

function requiredText(value, label) {
  const normalized = safeText(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = args["manifest-json"]
    ? JSON.parse(String(args["manifest-json"]))
    : {
      gitSha: args["release-git-sha"] ?? process.env.RELEASE_GIT_SHA ?? process.env.GITHUB_SHA,
      imageTag: args["release-image-tag"] ?? process.env.RELEASE_IMAGE_TAG,
      releaseVersion: args["release-version"] ?? process.env.RELEASE_VERSION,
    };
  const since = args.since ? new Date(String(args.since)) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    throw new Error(`Invalid --since value: ${args.since}`);
  }

  const summary = await runObservationGate({
    manifest,
    targets: args.targets ?? process.env.OBSERVATION_TARGETS ?? null,
    since,
    windowMinutes: args["window-minutes"] ?? process.env.OBSERVATION_WINDOW_MINUTES ?? DEFAULT_WINDOW_MINUTES,
    summaryFile: args["summary-file"] ?? process.env.OBSERVATION_SUMMARY_FILE,
    githubStepSummary: process.env.GITHUB_STEP_SUMMARY,
    publishAdvisories: Boolean(args["publish-advisories"]),
  });

  console.log(JSON.stringify(summary, null, 2));
  if (summary.status !== "passed") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
