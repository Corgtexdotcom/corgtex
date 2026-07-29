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
const DEFAULT_RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const DEFAULT_RAILWAY_LOG_LIMIT = 100;
const TARGET_GROUPS = Object.freeze([
  "railway-customers",
  "azure-managed-customers",
  "azure-selfserve",
  "ops",
  "backup-app",
]);
const RAILWAY_TARGET_GROUPS = Object.freeze([
  "railway-customers",
  "ops",
  "backup-app",
]);
const DEFAULT_TARGET_GROUPS = Object.freeze([
  "railway-customers",
  "azure-managed-customers",
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
  const collected = options.rows
    ? { rows: options.rows, sourceChecks: options.sourceChecks ?? [], missingRequiredSources: [] }
    : await collectObservationData({
      env: options.env ?? process.env,
      manifest,
      since,
      until,
      targets: options.targets ?? null,
      deps: options.deps ?? {},
    });
  const summary = buildObservationSummary({
    manifest,
    since,
    rows: collected.rows,
    sourceChecks: collected.sourceChecks,
    missingRequiredSources: collected.missingRequiredSources ?? [],
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

export function buildObservationSummary({ manifest, since, rows, sourceChecks = [], missingRequiredSources = [], targets = null }) {
  const normalizedRows = rows.map(normalizeObservationRow).filter(Boolean);
  const failureRows = normalizedRows.filter(isBlockingClassFailure);
  const releaseMatchers = observationReleaseMatchers(manifest, targets);
  const blockingFailures = [];
  const advisoryFailures = [];
  const normalizedMissingRequiredSources = missingRequiredSources.map(safeText).filter(Boolean);

  for (const row of failureRows) {
    if (releaseMatchers.some((matcher) => matcher.currentRelease && rowMatchesRelease(row, matcher.manifest) && rowMatchesTargets(row, matcher.selectedTargets))) {
      blockingFailures.push(row);
    } else {
      advisoryFailures.push(row);
    }
  }

  return {
    status: blockingFailures.length > 0 || normalizedMissingRequiredSources.length > 0 ? "blocked" : "passed",
    blockerReason: normalizedMissingRequiredSources.length > 0
      ? `missing_observation_sources: ${normalizedMissingRequiredSources.join(", ")}`
      : null,
    release: {
      gitSha: manifest.gitSha,
      imageTag: manifest.imageTag,
      version: manifest.releaseVersion,
    },
    targetReleases: releaseMatchers
      .filter((matcher) => matcher.target)
      .map((matcher) => ({
        target: matcher.target,
        gitSha: matcher.manifest.gitSha,
        imageTag: matcher.manifest.imageTag,
        version: matcher.manifest.releaseVersion,
        currentRelease: matcher.currentRelease,
      })),
    targets,
    since: since.toISOString(),
    sources: sourceSummaries(normalizedRows),
    sourceChecks: normalizeSourceChecks(sourceChecks),
    missingRequiredSources: normalizedMissingRequiredSources,
    checkedRows: normalizedRows.length,
    blockingFailures,
    advisoryFailures,
    advisoryIncidents: advisoryFailures.map((row) => advisoryIncidentForRow(row, manifest)),
  };
}

export async function collectObservationRows(options = {}) {
  const result = await collectObservationData(options);
  return result.rows;
}

async function collectObservationData({ env = process.env, manifest = {}, since, until = new Date(), targets = null, deps = {} }) {
  const rows = [];
  const sourceNotes = [];
  const sourceChecks = [];
  const queriedSources = new Set();
  const sourceErrors = new Map();
  const addSourceNote = (note) => {
    sourceNotes.push(note);
    sourceChecks.push(note);
  };

  if (isAzureMonitorConfigured(env)) {
    try {
      const azureRows = await queryAzureMonitorRows({ env, since, until, deps });
      rows.push(...azureRows);
      queriedSources.add("azure_monitor");
      sourceChecks.push({
        source: "azure_monitor",
        status: "queried",
        rowCount: azureRows.length,
      });
    } catch (error) {
      throw new Error(`Azure Monitor observation query failed: ${errorMessage(error)}`);
    }
  } else {
    addSourceNote({
      source: "azure_monitor",
      status: "skipped",
      reason: "AZURE_APPLICATIONINSIGHTS_APP_NAME and AZURE_APPLICATIONINSIGHTS_RESOURCE_GROUP are required",
    });
  }

  const railwayTargets = railwayTargetsFromEnv(env, targets);
  if (safeText(env.RAILWAY_API_TOKEN) && railwayTargets.length > 0) {
    try {
      const railwayRows = await queryRailwayRows({ env, manifest, since, until, targets, deps });
      rows.push(...railwayRows);
      for (const group of new Set(railwayTargets.map((target) => target.group).filter(Boolean))) {
        queriedSources.add(`railway:${group}`);
        sourceChecks.push({
          source: "railway",
          group,
          status: "queried",
          rowCount: railwayRows.filter((row) => row?.surface === group).length,
          targetCount: railwayTargets.filter((target) => target.group === group).length,
        });
      }
    } catch (error) {
      sourceErrors.set("railway", error);
    }
  } else if (railwayTargets.length > 0 || selectedRailwayTargetGroups(targets).size > 0) {
    addSourceNote({
      source: "railway",
      status: "skipped",
      reason: "RAILWAY_API_TOKEN and Railway target metadata are required",
    });
  }

  if (isPostHogQueryConfigured(env)) {
    try {
      const postHogRows = await queryPostHogRows({ env, since, deps });
      rows.push(...postHogRows);
      queriedSources.add("posthog");
      sourceChecks.push({
        source: "posthog",
        status: "queried",
        rowCount: postHogRows.length,
      });
    } catch (error) {
      sourceErrors.set("posthog", error);
    }
  } else {
    addSourceNote({
      source: "posthog",
      status: "skipped",
      reason: "POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY or POSTHOG_QUERY_API_KEY are required",
    });
  }

  const missingSourceGroups = requiredObservationSourceGroupsForTargets(targets)
    .filter((group) => !group.sources.some((source) => queriedSources.has(source)));

  for (const [source, error] of sourceErrors) {
    const isSatisfiedAlternative = missingSourceGroups.every((group) => !sourceMatchesRequiredGroup(source, group));
    if (requiresObservationSource(env) && isSatisfiedAlternative) {
      addSourceNote({
        source,
        status: "failed",
        reason: errorMessage(error),
      });
      continue;
    }
    throw new Error(`${sourceLabel(source)} observation query failed: ${errorMessage(error)}`);
  }

  for (const note of sourceNotes) {
    if (typeof deps.onSourceNote === "function") {
      deps.onSourceNote(note);
    } else {
      console.warn(`[observation] skipped ${note.source}: ${note.reason}`);
    }
  }

  const missingRequiredSources = requiresObservationSource(env)
    ? missingSourceGroups.map((group) => group.label)
    : [];
  if (missingRequiredSources.length > 0) {
    sourceChecks.push({
      source: "observation_requirements",
      status: "blocked",
      reason: `Missing required observation query source(s) for targets ${targets ?? "production"}: ${missingRequiredSources.join(", ")}`,
    });
  }

  return { rows, sourceChecks, missingRequiredSources };
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
  const token = requiredText(postHogQueryToken(env), "POSTHOG_PERSONAL_API_KEY or POSTHOG_QUERY_API_KEY");
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

export async function queryRailwayRows({ env = process.env, manifest = {}, since, until = new Date(), targets = null, deps = {} }) {
  const railwayTargets = railwayTargetsFromEnv(env, targets);
  if (railwayTargets.length === 0) return [];

  const rows = [];
  for (const target of railwayTargets) {
    const deployment = await latestRailwayDeployment(target, { env, deps });
    const httpLogs = await queryRailwayHttpLogs({
      env,
      deploymentId: deployment.id,
      since,
      until,
      deps,
    });
    rows.push(...parseRailwayHttpLogRows(httpLogs, {
      target,
      deployment,
      manifest,
      source_url: railwayDeploymentUrl(target, deployment.id),
    }));
  }

  return rows;
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

export function parseRailwayHttpLogRows(payload, { target, deployment, manifest = {}, source_url = null }) {
  const logs = Array.isArray(payload) ? payload : payload?.httpLogs ?? [];
  const release = railwayTargetRelease(target, manifest);
  return logs
    .map((log) => {
      const status = numericStatus(log?.httpStatus);
      if (!Number.isFinite(status) || status < 500) return null;
      return {
        source: "railway",
        source_url,
        event: "corgtex_route_error",
        instance_id: safeText(target.id ?? target.label),
        provider: "railway",
        release_git_sha: release.gitSha,
        release_image_tag: release.imageTag,
        release_version: release.releaseVersion,
        surface: safeText(target.group ?? "railway"),
        route: safeText(log.path ?? log.requestPath ?? log.host),
        status,
        code: safeText(log.responseDetails ?? "RAILWAY_HTTP_5XX"),
        events: 1,
        first_seen: isoText(log.timestamp),
        last_seen: isoText(log.timestamp),
        deployment_id: safeText(deployment?.id),
      };
    })
    .filter(Boolean);
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
  const expected = releaseIdentities(manifest);
  if (expected.length === 0) return false;
  const observed = releaseIdentities({
    gitSha: row.release_git_sha,
    imageTag: row.release_image_tag,
    releaseVersion: row.release_version,
  });
  return releaseIdentitySetsIntersect(expected, observed);
}

function releaseIdentities(manifest) {
  const gitSha = safeText(manifest.gitSha);
  const imageTag = safeText(manifest.imageTag);
  const releaseVersion = safeText(manifest.releaseVersion);
  const identities = [];

  if (gitSha) identities.push(gitSha);
  if (imageTag && releaseMetadataBelongsToGitSha(imageTag, gitSha)) identities.push(imageTag);
  if (releaseVersion && releaseMetadataBelongsToGitSha(releaseVersion, gitSha)) identities.push(releaseVersion);

  return [...new Set(identities)];
}

function releaseIdentitySetsIntersect(left, right) {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((identity) => rightSet.has(identity));
}

function releaseMetadataBelongsToGitSha(value, gitSha) {
  if (!gitSha) return true;
  const normalized = safeText(value);
  if (!normalized) return false;
  const shortSha = gitSha.slice(0, 12);
  if (/^[0-9a-f]{7,40}$/i.test(normalized)) {
    return gitSha.startsWith(normalized) || normalized === shortSha;
  }
  if (/^sha-[0-9a-f]{7,40}$/i.test(normalized)) {
    return normalized.includes(gitSha) || normalized.includes(shortSha);
  }
  if (/^main-[0-9a-f]{7,40}$/i.test(normalized)) {
    return normalized.includes(gitSha) || normalized.includes(shortSha);
  }
  return false;
}

export function rowMatchesTargets(row, selectedTargets) {
  if (!selectedTargets || selectedTargets.size === 0) return true;
  const rowTargets = observationTargetsForRow(row);
  if (rowTargets.length === 0) return rowMatchesUnknownTargetProvider(row, selectedTargets);
  return rowTargets.some((target) => selectedTargets.has(target));
}

function rowMatchesUnknownTargetProvider(row, selectedTargets) {
  const provider = safeText(row.provider)?.toLowerCase();
  if (provider === "azure") return selectedTargets.has("azure-managed-customers") || selectedTargets.has("azure-selfserve");
  if (provider === "railway") {
    return ["railway-customers", "ops", "backup-app"].some((target) => selectedTargets.has(target));
  }
  return true;
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

  if (text.includes("azure-selfserve") || text.includes("selfserve") || text.includes("ca-corgtex-ss")) {
    targets.add("azure-selfserve");
  }
  if (text.includes("azure-managed-customers")) {
    targets.add("azure-managed-customers");
  }
  if (provider === "azure" && !targets.has("azure-selfserve")) {
    targets.add("azure-managed-customers");
  }

  if (text.includes("railway-customers")) {
    targets.add("railway-customers");
  }

  if (text.includes("backup-app") || text.includes("app.corgtex.com")) {
    targets.add("backup-app");
  }

  if (text.includes("ops") || text.includes("control-plane") || text.includes("ops.corgtex.com")) {
    targets.add("ops");
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

function observationReleaseMatchers(manifest, targets) {
  const primaryIdentities = releaseIdentities(manifest);
  const hasPrimaryRelease = primaryIdentities.length > 0;
  const rootMatcher = hasPrimaryRelease
    ? [{
      target: null,
      manifest,
      selectedTargets: normalizeObservationTargets(targets),
      currentRelease: true,
    }]
    : [];

  if (Array.isArray(manifest.targetManifests) && manifest.targetManifests.length > 0) {
    return [
      ...rootMatcher,
      ...manifest.targetManifests.map((targetManifest) => ({
        target: targetManifest.target,
        manifest: targetManifest,
        selectedTargets: normalizeObservationTargets(targetManifest.target ?? targets),
        currentRelease: !hasPrimaryRelease || releaseIdentitySetsIntersect(primaryIdentities, releaseIdentities(targetManifest)),
      })),
    ];
  }

  return rootMatcher.length > 0 ? rootMatcher : [{
    target: null,
    manifest,
    selectedTargets: normalizeObservationTargets(targets),
    currentRelease: true,
  }];
}

function currentReleaseLabel(manifest) {
  const release = manifest.gitSha ?? manifest.imageTag ?? manifest.releaseVersion;
  if (release) return release;
  if (Array.isArray(manifest.targetManifests) && manifest.targetManifests.length > 0) {
    return manifest.targetManifests
      .map((targetManifest) => `${targetManifest.target ?? "target"}:${targetManifest.gitSha ?? targetManifest.imageTag ?? targetManifest.releaseVersion ?? "unknown"}`)
      .join(",");
  }
  return "unknown";
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
      `observedRelease=${release}; currentRelease=${currentReleaseLabel(manifest)}`,
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

  if (summary.missingRequiredSources?.length > 0) {
    lines.push("", "### Missing observation sources", "");
    for (const source of summary.missingRequiredSources) {
      lines.push(`- ${source}`);
    }
  }

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
    `WHERE timestamp >= ${hogQlUtcDateTime(since)}`,
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

function hogQlUtcDateTime(value) {
  return `toDateTime64('${hogQlString(value.toISOString().replace("T", " ").replace("Z", ""))}', 3, 'UTC')`;
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

function normalizeSourceChecks(sourceChecks) {
  if (!Array.isArray(sourceChecks)) return [];
  return sourceChecks.map((sourceCheck) => {
    const source = safeText(sourceCheck?.source);
    const status = safeText(sourceCheck?.status);
    if (!source || !status) return null;

    const normalized = { source, status };
    const group = safeText(sourceCheck.group);
    const reason = safeText(sourceCheck.reason);
    const rowCount = nonNegativeInteger(sourceCheck.rowCount);
    const targetCount = nonNegativeInteger(sourceCheck.targetCount);

    if (group) normalized.group = group;
    if (rowCount !== null) normalized.rowCount = rowCount;
    if (targetCount !== null) normalized.targetCount = targetCount;
    if (reason) normalized.reason = reason;
    return normalized;
  }).filter(Boolean);
}

function normalizeManifest(manifest) {
  const normalized = normalizeReleaseManifest(manifest);
  const targetManifests = Array.isArray(manifest.targetManifests)
    ? manifest.targetManifests
      .map((targetManifest) => ({
        target: safeText(targetManifest.target ?? targetManifest.targets),
        ...normalizeReleaseManifest(targetManifest),
      }))
      .filter((targetManifest) => targetManifest.gitSha || targetManifest.imageTag || targetManifest.releaseVersion)
    : [];
  if (targetManifests.length > 0) {
    normalized.targetManifests = targetManifests;
  }
  return normalized;
}

function normalizeReleaseManifest(manifest) {
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
  return Boolean(safeText(env.POSTHOG_PROJECT_ID) && postHogQueryToken(env));
}

function postHogQueryToken(env) {
  return safeText(env.POSTHOG_PERSONAL_API_KEY) ?? safeText(env.POSTHOG_QUERY_API_KEY);
}

function requiresObservationSource(env) {
  return /^(1|true|yes)$/i.test(String(env.OBSERVATION_REQUIRE_SOURCE ?? ""));
}

function requiredObservationSourceGroupsForTargets(targets) {
  const selectedTargets = normalizeObservationTargets(targets);
  const targetList = selectedTargets ? [...selectedTargets] : TARGET_GROUPS;
  const groups = [];
  if (targetList.includes("azure-selfserve") || targetList.includes("azure-managed-customers")) {
    groups.push({ label: "azure_monitor", sources: ["azure_monitor"] });
  }
  for (const target of targetList.filter((target) => RAILWAY_TARGET_GROUPS.includes(target))) {
    groups.push({ label: `${target}: railway or posthog`, sources: [`railway:${target}`, "posthog"] });
  }
  return groups;
}

function selectedRailwayTargetGroups(targets) {
  const selectedTargets = normalizeObservationTargets(targets);
  const targetList = selectedTargets ? [...selectedTargets] : TARGET_GROUPS;
  return new Set(targetList.filter((target) => RAILWAY_TARGET_GROUPS.includes(target)));
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

function railwayTargetsFromEnv(env, targets) {
  const selectedTargets = normalizeObservationTargets(targets);
  const targetList = selectedTargets ? [...selectedTargets] : TARGET_GROUPS;
  const entries = [];

  if (targetList.includes("railway-customers")) {
    for (const target of parseJsonArray(env.FLEET_RELEASE_TARGETS_JSON)) {
      if (target?.provider === "railway" && target?.railway?.webServiceId && target?.railway?.environmentId) {
        entries.push({
          id: safeText(target.id ?? target.deploymentId ?? target.label),
          label: safeText(target.label ?? target.id),
          group: "railway-customers",
          projectId: safeText(target.railway.projectId),
          environmentId: safeText(target.railway.environmentId),
          webServiceId: safeText(target.railway.webServiceId),
        });
      }
    }
  }

  if (targetList.includes("ops")) {
    const target = parseJsonObjectOrSingleItemArray(env.FLEET_RELEASE_OPS_TARGET_JSON);
    if (target?.provider === "railway" && target?.railway?.webServiceId && target?.railway?.environmentId) {
      entries.push({
        id: "ops",
        label: safeText(target.label ?? "Ops"),
        group: "ops",
        projectId: safeText(target.railway.projectId),
        environmentId: safeText(target.railway.environmentId),
        webServiceId: safeText(target.railway.webServiceId),
      });
    }
  }

  if (targetList.includes("backup-app")) {
    const target = parseJsonObjectOrSingleItemArray(env.FLEET_RELEASE_BACKUP_APP_TARGET_JSON);
    if (target?.provider === "railway" && target?.railway?.webServiceId && target?.railway?.environmentId) {
      entries.push({
        id: "backup-app",
        label: safeText(target.label ?? "Backup App"),
        group: "backup-app",
        projectId: safeText(target.railway.projectId),
        environmentId: safeText(target.railway.environmentId),
        webServiceId: safeText(target.railway.webServiceId),
      });
    }
  }

  return entries.filter((entry) => entry.environmentId && entry.webServiceId);
}

async function latestRailwayDeployment(target, { env = process.env, deps = {} }) {
  const data = await railwayGraphql({
    env,
    deps,
    query: `query LatestDeployment($serviceId: String!, $environmentId: String!) {
      deployments(first: 1, input: { serviceId: $serviceId, environmentId: $environmentId }) {
        edges {
          node {
            id
            status
            createdAt
            meta
          }
        }
      }
    }`,
    variables: {
      serviceId: target.webServiceId,
      environmentId: target.environmentId,
    },
  });
  const deployment = data?.deployments?.edges?.[0]?.node;
  if (!deployment?.id) {
    throw new Error(`No Railway deployment found for ${target.label ?? target.id ?? target.webServiceId}.`);
  }
  return deployment;
}

async function queryRailwayHttpLogs({ env = process.env, deploymentId, since, until = new Date(), deps = {} }) {
  const data = await railwayGraphql({
    env,
    deps,
    query: `query HttpLogs($deploymentId: String!, $filter: String, $limit: Int!) {
      httpLogs(
        deploymentId: $deploymentId
        filter: $filter
        limit: $limit
      ) {
        timestamp
        method
        path
        httpStatus
        requestId
        host
        responseDetails
        deploymentId
        deploymentInstanceId
      }
    }`,
    variables: {
      deploymentId,
      filter: "@httpStatus:500..599",
      limit: railwayLogLimit(env),
    },
  });
  const sinceDate = new Date(since);
  const untilDate = new Date(until);
  return (data?.httpLogs ?? []).filter((log) => {
    const timestamp = new Date(log?.timestamp ?? "");
    return !Number.isNaN(timestamp.getTime()) && timestamp >= sinceDate && timestamp <= untilDate;
  });
}

async function railwayGraphql({ env = process.env, deps = {}, query, variables }) {
  const token = requiredText(env.RAILWAY_API_TOKEN, "RAILWAY_API_TOKEN");
  const endpoint = safeText(env.RAILWAY_GRAPHQL_ENDPOINT) ?? DEFAULT_RAILWAY_GRAPHQL_ENDPOINT;
  const response = await (deps.fetchImpl ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok || body?.errors?.length) {
    throw new Error(body?.errors?.map((error) => error.message).filter(Boolean).join("; ") || `Railway API failed with ${response.status}`);
  }
  return body?.data ?? {};
}

function railwayTargetRelease(target, manifest) {
  const normalized = normalizeManifest(manifest);
  const targetManifests = normalized.targetManifests ?? [];
  const exact = targetManifests.find((targetManifest) => targetManifest.target === target.group || targetManifest.target === target.id);
  return exact ?? normalized;
}

function railwayDeploymentUrl(target, deploymentId) {
  if (!target?.projectId || !target?.webServiceId || !target?.environmentId || !deploymentId) return null;
  return `https://railway.com/project/${encodeURIComponent(target.projectId)}/service/${encodeURIComponent(target.webServiceId)}?environmentId=${encodeURIComponent(target.environmentId)}&deploymentId=${encodeURIComponent(deploymentId)}`;
}

function railwayLogLimit(env) {
  const parsed = Number.parseInt(String(env.RAILWAY_OBSERVATION_LOG_LIMIT ?? DEFAULT_RAILWAY_LOG_LIMIT), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : DEFAULT_RAILWAY_LOG_LIMIT;
}

function parseJsonArray(value) {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJsonObjectOrSingleItemArray(value) {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    const [first] = parsed;
    return first && typeof first === "object" && !Array.isArray(first) ? first : null;
  }
  return parsed && typeof parsed === "object" ? parsed : null;
}

function parseJsonValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sourceLabel(source) {
  if (source === "posthog") return "PostHog";
  if (source === "railway") return "Railway";
  if (source === "azure_monitor") return "Azure Monitor";
  return source;
}

function sourceMatchesRequiredGroup(source, group) {
  if (source === "railway") {
    return group.sources.some((requiredSource) => requiredSource.startsWith("railway:"));
  }
  return group.sources.includes(source);
}

function numericStatus(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function nonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
    ? manifestJsonWithRuntimeDefaults(JSON.parse(String(args["manifest-json"])), process.env)
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
  if (summary.blockingFailures.length > 0) {
    process.exitCode = 1;
  }
}

function manifestJsonWithRuntimeDefaults(manifest, env) {
  const explicitRelease = normalizeReleaseManifest(manifest);
  if (explicitRelease.gitSha || explicitRelease.imageTag || explicitRelease.releaseVersion) {
    return manifest;
  }
  if (Array.isArray(manifest?.targetManifests) && manifest.targetManifests.length > 0) {
    return manifest;
  }
  return {
    gitSha: env.GITHUB_SHA,
    imageTag: env.RELEASE_IMAGE_TAG,
    releaseVersion: env.RELEASE_VERSION,
    ...manifest,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
