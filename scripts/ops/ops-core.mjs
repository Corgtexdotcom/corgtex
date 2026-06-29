import { createHash } from "node:crypto";

export const INCIDENT_SEVERITIES = ["P1", "P2", "P3"];
export const RAILWAY_ACTIONS = ["inspect", "restart", "redeploy-current"];
const ACTIVE_SUPPORT_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const NONTERMINAL_AGENT_RUN_STATUSES = new Set([
  "PENDING",
  "QUEUED",
  "RUNNING",
  "IN_PROGRESS",
  "STARTED",
  "SCHEDULED",
  "PROCESSING",
  "WAITING_APPROVAL",
]);
const RECOVERY_AGENT_RUN_STATUSES = new Set([
  "COMPLETED",
  "COMPLETE",
  "SUCCESS",
  "SUCCEEDED",
  "PASSED",
  "OK",
]);
const NEUTRAL_AGENT_RUN_STATUSES = new Set([
  ...NONTERMINAL_AGENT_RUN_STATUSES,
  "UNKNOWN",
  "CANCELLED",
  "CANCELED",
  "SKIPPED",
  "ABORTED",
]);

export function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export function shortHash(value, length = 12) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

export function normalizeSeverity(value, fallback = "P3") {
  const normalized = String(value || "").trim().toUpperCase();
  return INCIDENT_SEVERITIES.includes(normalized) ? normalized : fallback;
}

export function severityForHealthStatus(status, fallback = "P3") {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "down" || normalized === "unreachable" || normalized === "timeout") return "P1";
  if (normalized === "degraded" || normalized === "failed" || normalized === "stale") return "P2";
  return normalizeSeverity(fallback);
}

export function normalizeIncident(input) {
  const service = requireText(input?.service, "incident.service");
  const status = requireText(input?.status, "incident.status");
  const summary = requireText(input?.summary, "incident.summary");
  const clientSlug = optionalText(input?.clientSlug);
  const evidence = Array.isArray(input?.evidence) ? input.evidence.map(String) : [];
  const recommendedAction = optionalText(input?.recommendedAction) ?? "investigate";
  const baseDedupe = input?.dedupeKey
    ?? [service, clientSlug, status, summary].filter(Boolean).join(":");

  return {
    dedupeKey: sanitizeDedupeKey(baseDedupe),
    severity: normalizeSeverity(input?.severity, severityForHealthStatus(status)),
    service,
    clientSlug,
    status,
    summary,
    evidence,
    recommendedAction,
    createdAt: input?.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString(),
  };
}

export function incidentTitle(incident) {
  return `[ops:${shortHash(incident.dedupeKey, 10)}] ${incident.severity} ${incident.service}: ${incident.summary}`;
}

export function incidentBody(incident) {
  const lines = [
    "## Summary",
    "",
    incident.summary,
    "",
    "## Routing",
    "",
    `- Severity: ${incident.severity}`,
    `- Service: ${incident.service}`,
    `- Client: ${incident.clientSlug ?? "n/a"}`,
    `- Status: ${incident.status}`,
    `- Recommended action: ${incident.recommendedAction}`,
    `- Dedupe key: ${incident.dedupeKey}`,
    "",
    "## Evidence",
    "",
  ];

  if (incident.evidence.length === 0) {
    lines.push("- No additional evidence captured.");
  } else {
    for (const item of incident.evidence) {
      lines.push(`- ${item}`);
    }
  }

  lines.push(
    "",
    "## Codex Handling",
    "",
    "Codex Builder may prepare a fix PR and enable auto-merge. Codex Reviewer must apply `.codex/review.md` before approval.",
  );

  return `${lines.join("\n")}\n`;
}

export function incidentLabels(incident) {
  return [
    "ops-auto-fix",
    "ops-incident",
    `severity-${incident.severity.toLowerCase()}`,
    `service-${labelSafe(incident.service)}`,
  ];
}

export function parseJsonEnv(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function buildHealthTargets(env = process.env) {
  const configured = parseJsonEnv(env, "OPS_HEALTH_TARGETS_JSON", null);
  if (configured) {
    if (!Array.isArray(configured)) {
      throw new Error("OPS_HEALTH_TARGETS_JSON must be an array.");
    }
    return configured.map(normalizeHealthTarget);
  }

  const targets = [];
  const siteUrl = firstUrl(env.NEXT_PUBLIC_SITE_URL, env.SITE_URL);
  const appUrl = firstUrl(env.NEXT_PUBLIC_APP_URL, env.APP_URL);
  const demoUrl = firstUrl(env.NEXT_PUBLIC_DEMO_URL);
  const primaryClientUrl = firstUrl(env.OPS_PRIMARY_CLIENT_URL);
  const primaryClientSlug = optionalText(env.OPS_PRIMARY_CLIENT_SLUG);

  if (siteUrl) {
    targets.push(normalizeHealthTarget({
      name: "site",
      service: "site",
      url: appendPath(siteUrl, "/api/health"),
      severity: "P2",
      expectJson: { status: "ok" },
    }));
  }

  if (appUrl) {
    targets.push(normalizeHealthTarget({
      name: "app",
      service: "web",
      url: appendPath(appUrl, "/api/health"),
      severity: "P1",
      expectJson: { status: "ok", database: "up", schema: "ready" },
    }));
    targets.push(normalizeHealthTarget({
      name: "demo",
      service: "demo",
      url: appendPath(demoUrl ?? appUrl, "/demo"),
      severity: "P2",
      expectedStatuses: [200, 301, 302, 307, 308],
    }));
  }

  if (primaryClientUrl) {
    targets.push(normalizeHealthTarget({
      name: primaryClientSlug ? `${primaryClientSlug}-health` : "primary-client-health",
      service: "client",
      clientSlug: primaryClientSlug,
      url: appendPath(primaryClientUrl, "/api/health"),
      severity: "P1",
      expectJson: { status: "ok" },
    }));
  }

  return targets;
}

export function normalizeHealthTarget(input) {
  const expectedStatuses = input.expectedStatuses ?? input.expectedStatus ?? [200];
  const statuses = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  const attempts = input.attempts ?? input.retryAttempts;
  return {
    name: requireText(input.name, "target.name"),
    service: requireText(input.service ?? input.name, "target.service"),
    clientSlug: optionalText(input.clientSlug),
    url: requireUrl(input.url, "target.url"),
    severity: normalizeSeverity(input.severity, "P3"),
    timeoutMs: positiveInt(input.timeoutMs, 10_000),
    attempts: positiveInt(attempts, 2),
    retryDelayMs: positiveInt(input.retryDelayMs, 750),
    expectedStatuses: statuses.map((status) => positiveInt(status, 200)),
    expectJson: input.expectJson && typeof input.expectJson === "object" ? input.expectJson : null,
    method: optionalText(input.method) ?? "GET",
  };
}

export async function checkHealthTarget(target, fetchImpl = fetch) {
  const attempts = positiveInt(target.attempts, 1);
  const retryDelayMs = positiveInt(target.retryDelayMs, 0);
  const failures = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await checkHealthTargetOnce(target, fetchImpl);
    if (result.ok) {
      return {
        ...result,
        attempts: attempt,
      };
    }

    failures.push(result);
    if (attempt < attempts) {
      await sleep(retryDelayMs);
    }
  }

  return withRetryEvidence(failures.at(-1), failures);
}

export async function fetchControlPlaneCustomers(env = process.env, fetchImpl = fetch) {
  const configured = parseJsonEnv(env, "OPS_CONTROL_PLANE_CUSTOMERS_JSON", null);
  if (configured) {
    if (!Array.isArray(configured)) {
      throw new Error("OPS_CONTROL_PLANE_CUSTOMERS_JSON must be an array.");
    }
    return configured;
  }

  const token = optionalText(env.CONTROL_PLANE_AGENT_API_KEY);
  const baseUrl = firstUrl(env.CONTROL_PLANE_URL, env.APP_URL, env.OPS_CONTROL_PLANE_URL);
  if (!token || !baseUrl) {
    return [];
  }

  const response = await fetchImpl(`${baseUrl}/api/control-plane/mcp`, {
    method: "POST",
    headers: {
      "authorization": `Bearer cp-${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `ops-monitor-${Date.now()}`,
      method: "tools/call",
      params: {
        name: "list_customers",
        arguments: {},
      },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    throw new Error(body?.error?.message || `Control Plane list_customers failed with status ${response.status}.`);
  }
  const text = body?.result?.content?.find((item) => typeof item?.text === "string")?.text;
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Control Plane list_customers response must be an array.");
  }
  return enrichControlPlaneSupportOperations(parsed, baseUrl, token, fetchImpl);
}

async function enrichControlPlaneSupportOperations(customers, baseUrl, token, fetchImpl) {
  return Promise.all(customers.map(async (customer) => {
    const deploymentId = optionalText(customer?.id);
    if (!deploymentId) return customer;

    const operations = await fetchControlPlaneDeploymentOperations(baseUrl, token, deploymentId, fetchImpl);
    if (!operations || operations.length === 0) return customer;

    return {
      ...customer,
      supportOperations: mergeSupportOperations(customer.supportOperations, operations),
    };
  }));
}

async function fetchControlPlaneDeploymentOperations(baseUrl, token, deploymentId, fetchImpl) {
  const url = new URL(`/api/control-plane/deployments/${encodeURIComponent(deploymentId)}/operations`, baseUrl);
  const response = await fetchImpl(url.href, {
    method: "GET",
    headers: {
      "authorization": `Bearer cp-${token}`,
    },
  });
  if (!response.ok) return null;

  const body = await response.json().catch(() => null);
  return Array.isArray(body?.operations) ? body.operations : null;
}

function mergeSupportOperations(primary, additional) {
  const operations = [
    ...(Array.isArray(primary) ? primary : []),
    ...(Array.isArray(additional) ? additional : []),
  ];
  const seen = new Set();
  return operations.filter((operation, index) => {
    const key = optionalText(operation?.id)
      ?? [
        optionalText(operation?.action) ?? "unknown",
        optionalText(operation?.status) ?? "UNKNOWN",
        optionalText(operation?.completedAt)
          ?? optionalText(operation?.updatedAt)
          ?? optionalText(operation?.createdAt)
          ?? String(index),
      ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildControlPlaneIncidents(customers, options = {}) {
  const rows = Array.isArray(customers) ? customers : [];
  const sweepNowMs = referenceTimeMs(options.now);
  return rows.flatMap((row) => [
    missingSupportConnectorIncident(row),
    agentFailureStreakIncident(row, sweepNowMs),
    slackInvalidAuthIncident(row, sweepNowMs),
    releaseMetadataDriftIncident(row),
    ...newspaperHealthIncidents(row),
  ].filter(Boolean).map(normalizeIncident));
}

async function checkHealthTargetOnce(target, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(target.url, {
      method: target.method,
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "corgtex-ops-monitor/1.0" },
    });
    const elapsedMs = Date.now() - startedAt;
    const expectedStatus = target.expectedStatuses.includes(response.status);
    let payload = null;
    let jsonMatches = true;

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => null);
      if (target.expectJson) {
        jsonMatches = objectContains(payload, target.expectJson);
      }
    }

    if (expectedStatus && jsonMatches) {
      return {
        ok: true,
        status: "ok",
        target,
        elapsedMs,
        httpStatus: response.status,
        payload,
      };
    }

    const status = response.ok ? "degraded" : "down";
    return {
      ok: false,
      status,
      target,
      elapsedMs,
      httpStatus: response.status,
      payload,
      incident: normalizeIncident({
        dedupeKey: `${target.name}:${target.url}:${status}`,
        severity: target.severity,
        service: target.service,
        clientSlug: target.clientSlug,
        status,
        summary: `${target.name} returned unexpected health result`,
        evidence: [
          `URL: ${target.url}`,
          `HTTP status: ${response.status}`,
          `Expected statuses: ${target.expectedStatuses.join(", ")}`,
          target.expectJson ? `Expected JSON fields: ${JSON.stringify(target.expectJson)}` : null,
          payload ? `Response JSON: ${JSON.stringify(payload).slice(0, 1000)}` : null,
        ].filter(Boolean),
        recommendedAction: "run Codex Builder Loop",
      }),
    };
  } catch (error) {
    const status = error?.name === "AbortError" ? "timeout" : "unreachable";
    return {
      ok: false,
      status,
      target,
      elapsedMs: Date.now() - startedAt,
      incident: normalizeIncident({
        dedupeKey: `${target.name}:${target.url}:${status}`,
        severity: severityForHealthStatus(status, target.severity),
        service: target.service,
        clientSlug: target.clientSlug,
        status,
        summary: `${target.name} is ${status}`,
        evidence: [
          `URL: ${target.url}`,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        ],
        recommendedAction: "inspect Railway deployment and run smoke checks",
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}

function missingSupportConnectorIncident(row) {
  if (!row || typeof row !== "object") return null;
  if (row.managedWorkspaceId || row.hasSupportCredential) return null;
  const status = optionalText(row.supportConnectorStatus) ?? "not_configured";
  if (!["not_configured", "missing", "unconfigured"].includes(status)) return null;
  const label = deploymentLabel(row);
  return {
    dedupeKey: `control-plane:${row.id}:missingSupportConnector`,
    severity: "P2",
    service: "control-plane",
    clientSlug: clientSlug(row),
    status: "missingSupportConnector",
    summary: `${label} support connector is not configured`,
    evidence: [
      `Deployment: ${label}`,
      `Deployment ID: ${optionalText(row.id) ?? "unknown"}`,
      `Support connector status: ${status}`,
      `Managed workspace: ${row.managedWorkspaceId ? "yes" : "no"}`,
    ],
    recommendedAction: "configure a support connector or managed workspace mapping before remote diagnostics",
  };
}

function agentFailureStreakIncident(row, sweepNowMs) {
  const snapshot = latestSnapshot(row, "SUPPORT_READY");
  const snapshotObservedAtMs = timestampMs(optionalText(snapshot?.observedAt) ?? optionalText(snapshot?.createdAt));
  const summary = record(snapshot?.summary);
  const runs = dedupeAgentRuns([
    ...itemsFrom(summary?.agentRuns, ["items", "runs"]).map((run) => ({
      ...run,
      observedAt: snapshotObservedAtMs ? new Date(snapshotObservedAtMs).toISOString() : optionalText(run?.observedAt),
    })),
    ...supportInspectionAgentRuns(row, snapshotObservedAtMs),
  ].map(normalizeAgentRun));
  const runsByAgent = new Map();
  for (const run of runs) {
    const current = runsByAgent.get(run.agentKey) ?? [];
    current.push(run);
    runsByAgent.set(run.agentKey, current);
  }
  const [agentKey, failures] = [...runsByAgent.entries()]
    .map(([key, items]) => [key, activeFailureStreak(items, snapshotObservedAtMs, sweepNowMs)])
    .find(([, items]) => items.length >= 3) ?? [];
  if (!agentKey) return null;
  const label = deploymentLabel(row);
  return {
    dedupeKey: `control-plane:${row.id}:agentFailureStreak:${agentKey}`,
    severity: "P2",
    service: "agents",
    clientSlug: clientSlug(row),
    status: "agentFailureStreak",
    summary: `${label} has repeated ${agentKey} agent failures`,
    evidence: [
      `Deployment ID: ${optionalText(row.id) ?? "unknown"}`,
      `Agent: ${agentKey}`,
      `Failed runs in latest snapshot: ${failures.length}`,
      `Latest failed run: ${agentRunFailureTimestamp(failures[0]) ?? "unknown"}`,
    ],
    recommendedAction: "inspect failed agent traces through the support connector and repair the root cause before retrying",
  };
}

function normalizeAgentRun(run) {
  return {
    id: optionalText(run.id),
    agentKey: optionalText(run.agentKey) ?? optionalText(run.key) ?? optionalText(run.name) ?? "unknown",
    status: optionalText(run.status) ?? "UNKNOWN",
    createdAt: optionalText(run.createdAt),
    failedAt: optionalText(run.failedAt),
    completedAt: optionalText(run.completedAt),
    finishedAt: optionalText(run.finishedAt),
    endedAt: optionalText(run.endedAt),
    updatedAt: optionalText(run.updatedAt),
    observedAt: optionalText(run.observedAt),
  };
}

function dedupeAgentRuns(runs) {
  const seen = new Map();
  const deduped = [];
  runs.forEach((run, index) => {
    const key = run.id
      ?? `${run.agentKey}:${run.status}:${agentRunOrderTimestamp(run) ?? "unknown"}:${index}`;
    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, deduped.length);
      deduped.push(run);
      return;
    }
    if (isNewerAgentRunObservation(run, deduped[existingIndex])) {
      deduped[existingIndex] = run;
    }
  });
  return deduped;
}

function isNewerAgentRunObservation(candidate, existing) {
  const candidateAtMs = timestampMs(agentRunOrderTimestamp(candidate));
  const existingAtMs = timestampMs(agentRunOrderTimestamp(existing));
  if (candidateAtMs !== null && existingAtMs !== null) return candidateAtMs >= existingAtMs;
  if (candidateAtMs !== null) return true;
  if (existingAtMs !== null) return false;
  return true;
}

function supportInspectionAgentRuns(row, snapshotObservedAtMs) {
  const operations = Array.isArray(row?.supportOperations) ? row.supportOperations : [];
  return operations.flatMap((operation) => {
    if (optionalText(operation?.action) !== "agents.list_runs") return [];
    if (normalizeAgentRunStatus(operation?.status) !== "COMPLETED") return [];
    const operationObservedAtMs = timestampMs(
      optionalText(operation?.completedAt)
        ?? optionalText(operation?.updatedAt)
        ?? optionalText(operation?.createdAt),
    );
    if (snapshotObservedAtMs && (!operationObservedAtMs || operationObservedAtMs <= snapshotObservedAtMs)) {
      return [];
    }

    const resultSummary = record(operation?.resultSummary)
      ?? record(operation?.resultJson)
      ?? record(operation?.outputJson);
    const observedAt = operationObservedAtMs ? new Date(operationObservedAtMs).toISOString() : null;
    return itemsFrom(resultSummary, ["items", "runs"]).map((run) => ({
      ...run,
      observedAt: optionalText(run?.observedAt) ?? observedAt,
    }));
  });
}

function activeFailureStreak(runs, snapshotObservedAtMs, sweepNowMs) {
  const indexedRuns = runs.map((run, index) => ({ run, index, orderAtMs: timestampMs(agentRunOrderTimestamp(run)) }));
  const sortedRuns = indexedRuns.every((item) => item.orderAtMs !== null)
    ? [...indexedRuns].sort((a, b) => b.orderAtMs - a.orderAtMs).map((item) => item.run)
    : indexedRuns.map((item) => item.run);
  const failures = [];
  for (const run of sortedRuns) {
    const status = normalizeAgentRunStatus(run.status);
    if (status === "FAILED") {
      failures.push(run);
      continue;
    }
    if (NEUTRAL_AGENT_RUN_STATUSES.has(status)) continue;
    if (RECOVERY_AGENT_RUN_STATUSES.has(status)) break;
    continue;
  }
  if (failures.length < 3) return [];
  const latestFailureAtMs = timestampMs(agentRunFailureTimestamp(failures[0]))
    ?? snapshotObservedAtMs
    ?? newestTimestampMs(failures.map(agentRunFailureTimestamp));
  if (!latestFailureAtMs || sweepNowMs - latestFailureAtMs > ACTIVE_SUPPORT_SIGNAL_WINDOW_MS) {
    return [];
  }
  return failures;
}

function agentRunOrderTimestamp(run) {
  return agentRunTerminalTimestamp(run) ?? optionalText(run?.createdAt) ?? optionalText(run?.observedAt);
}

function agentRunFailureTimestamp(run) {
  return agentRunTerminalTimestamp(run) ?? optionalText(run?.createdAt);
}

function agentRunTerminalTimestamp(run) {
  return optionalText(run?.failedAt)
    ?? optionalText(run?.completedAt)
    ?? optionalText(run?.finishedAt)
    ?? optionalText(run?.endedAt)
    ?? optionalText(run?.updatedAt);
}

function normalizeAgentRunStatus(value) {
  return optionalText(value)?.toUpperCase() ?? "UNKNOWN";
}

function slackInvalidAuthIncident(row, sweepNowMs) {
  const snapshot = latestSnapshot(row, "SUPPORT_READY");
  const snapshotObservedAtMs = timestampMs(optionalText(snapshot?.observedAt) ?? optionalText(snapshot?.createdAt));
  const summary = record(snapshot?.summary);
  const failedJobs = itemsFrom(summary?.failedJobs, ["items", "jobs"]);
  const matches = failedJobs.filter((job) => {
    const type = optionalText(job.type) ?? optionalText(job.name) ?? "";
    const error = optionalText(job.error) ?? "";
    if (!/slack/i.test(type) || !/invalid_auth/i.test(error)) return false;
    return isActiveSupportSignal(job, snapshotObservedAtMs, sweepNowMs);
  });
  if (matches.length === 0) return null;
  const label = deploymentLabel(row);
  return {
    dedupeKey: `control-plane:${row.id}:slackInvalidAuth`,
    severity: "P2",
    service: "slack",
    clientSlug: clientSlug(row),
    status: "slackInvalidAuth",
    summary: `${label} Slack installation requires reauthorization`,
    evidence: [
      `Deployment ID: ${optionalText(row.id) ?? "unknown"}`,
      `Failed Slack jobs in latest snapshot: ${matches.length}`,
      `Latest job type: ${optionalText(matches[0].type) ?? optionalText(matches[0].name) ?? "unknown"}`,
      `Latest failed job signal: ${supportSignalTimestamp(matches[0]) ?? "unknown"}`,
      "Slack API error: invalid_auth",
    ],
    recommendedAction: "mark the Slack installation reauth-required and stop proactive scans until Slack is reconnected",
  };
}

function isActiveSupportSignal(item, snapshotObservedAtMs, sweepNowMs) {
  const signalAtMs = timestampMs(supportSignalTimestamp(item)) ?? snapshotObservedAtMs;
  return Boolean(signalAtMs) && sweepNowMs - signalAtMs <= ACTIVE_SUPPORT_SIGNAL_WINDOW_MS;
}

function supportSignalTimestamp(item) {
  return optionalText(item?.failedAt)
    ?? optionalText(item?.updatedAt)
    ?? optionalText(item?.completedAt)
    ?? optionalText(item?.createdAt);
}

function referenceTimeMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return timestampMs(value) ?? Date.now();
}

function newestTimestampMs(values) {
  return values.reduce((newest, value) => {
    const current = timestampMs(value);
    if (!current) return newest;
    return newest === null || current > newest ? current : newest;
  }, null);
}

function releaseMetadataDriftIncident(row) {
  const snapshot = latestSnapshot(row, "RELEASE");
  const summary = record(snapshot?.summary);
  const observed = record(summary?.observedRelease);
  const expected = optionalText(summary?.expectedReleaseImageTag) ?? optionalText(row?.releaseImageTag);
  const observedRelease = optionalText(observed?.imageTag) ?? optionalText(observed?.gitSha);
  const driftError = optionalText(snapshot?.error) ?? optionalText(row?.lastHealthError);
  if (!driftError?.includes("Release drift:") && (!expected || !observedRelease || expected === observedRelease)) {
    return null;
  }
  const label = deploymentLabel(row);
  return {
    dedupeKey: `control-plane:${row.id}:releaseMetadataDrift`,
    severity: "P2",
    service: "control-plane-release",
    clientSlug: clientSlug(row),
    status: "releaseMetadataDrift",
    summary: `${label} control-plane release metadata is stale`,
    evidence: [
      `Deployment ID: ${optionalText(row.id) ?? "unknown"}`,
      `Expected release: ${expected ?? "unknown"}`,
      `Observed release: ${observedRelease ?? "unknown"}`,
      driftError ? `Drift detail: ${driftError}` : null,
    ].filter(Boolean),
    recommendedAction: "record the verified live release after health proof",
  };
}

function newspaperHealthIncidents(row) {
  const diagnostics = latestNewspaperDiagnostics(row);
  if (!diagnostics) return [];
  const label = deploymentLabel(row);
  const deploymentId = optionalText(row?.id) ?? "unknown";
  const incidents = [];
  const readiness = record(diagnostics.providerEmailReadiness);
  const readinessStatus = optionalText(readiness?.status);
  if (readinessStatus && ["invalid", "missing"].includes(readinessStatus)) {
    incidents.push({
      dedupeKey: `control-plane:${row.id}:newspaperEmailReadiness:${readinessStatus}`,
      severity: "P2",
      service: "newspaper",
      clientSlug: clientSlug(row),
      status: "newspaperEmailReadiness",
      summary: `${label} newspaper email readiness is ${readinessStatus}`,
      evidence: [
        `Deployment ID: ${deploymentId}`,
        `Provider readiness: ${readinessStatus}`,
        `Web key present: ${record(readiness?.web)?.keyPresent === true ? "yes" : "no"}`,
        `Worker key present: ${record(readiness?.worker)?.keyPresent === true ? "yes" : "no"}`,
        `Web auth probe: ${optionalText(record(readiness?.web)?.authProbe) ?? "unknown"}`,
        `Worker auth probe: ${optionalText(record(readiness?.worker)?.authProbe) ?? "unknown"}`,
      ],
      recommendedAction: "repair provider config through the control plane, then use selected-customer service redeploy for the affected services",
    });
  }

  const expectedRuns = Array.isArray(diagnostics.expectedRuns) ? diagnostics.expectedRuns : [];
  const missedRuns = expectedRuns.filter((run) => optionalText(run?.state) === "missed");
  if (missedRuns.length > 0) {
    incidents.push({
      dedupeKey: `control-plane:${row.id}:newspaperExpectedRunMissed`,
      severity: "P2",
      service: "newspaper",
      clientSlug: clientSlug(row),
      status: "newspaperExpectedRunMissed",
      summary: `${label} missed an expected newspaper run`,
      evidence: [
        `Deployment ID: ${deploymentId}`,
        `Missed runs: ${missedRuns.map((run) => `${optionalText(run?.cadence) ?? "unknown"} ${optionalText(run?.localDateKey) ?? "unknown"}`).join(", ")}`,
      ],
      recommendedAction: "run newspaper diagnostics, inspect scheduler dedupe state, and avoid generic replay unless no snapshot retry is possible",
    });
  }

  const retriableFailures = record(diagnostics.retriableFailures);
  const eligibleCount = numberValue(retriableFailures?.eligibleCount);
  if (eligibleCount > 0) {
    incidents.push({
      dedupeKey: `control-plane:${row.id}:newspaperUnrecoveredFailures`,
      severity: "P2",
      service: "newspaper",
      clientSlug: clientSlug(row),
      status: "newspaperUnrecoveredFailures",
      summary: `${label} has unrecovered newspaper delivery failures`,
      evidence: [
        `Deployment ID: ${deploymentId}`,
        `Retryable failed/skipped delivery rows: ${eligibleCount}`,
        `Missing snapshots: ${numberValue(retriableFailures?.missingSnapshotCount) ?? 0}`,
      ],
      recommendedAction: "use newspaper.retry_failed_deliveries before considering runtime.retry_failed_job",
    });
  }

  const failureBuckets = Array.isArray(diagnostics.failureBuckets) ? diagnostics.failureBuckets : [];
  const bounceBuckets = failureBuckets.filter((bucket) => ["bounced", "complained"].includes(optionalText(bucket?.bucket) ?? ""));
  if (bounceBuckets.length > 0) {
    incidents.push({
      dedupeKey: `control-plane:${row.id}:newspaperBounceComplaint`,
      severity: "P2",
      service: "newspaper",
      clientSlug: clientSlug(row),
      status: "newspaperBounceComplaint",
      summary: `${label} has newspaper bounce or complaint events`,
      evidence: [
        `Deployment ID: ${deploymentId}`,
        `Buckets: ${bounceBuckets.map((bucket) => `${optionalText(bucket?.bucket)}=${numberValue(bucket?.count) ?? 0}`).join(", ")}`,
      ],
      recommendedAction: "inspect recipient status and provider events before retrying affected addresses",
    });
  }

  return incidents;
}

function latestNewspaperDiagnostics(row) {
  const operations = Array.isArray(row?.supportOperations) ? row.supportOperations : [];
  const operation = operations
    .filter((item) => optionalText(item?.action) === "newspaper.diagnostics" && normalizeAgentRunStatus(item?.status) === "COMPLETED")
    .sort((a, b) => Date.parse(optionalText(b?.completedAt) ?? optionalText(b?.createdAt) ?? 0) - Date.parse(optionalText(a?.completedAt) ?? optionalText(a?.createdAt) ?? 0))[0];
  const summary = record(operation?.resultSummary) ?? record(operation?.resultJson) ?? record(operation?.outputJson);
  const operationDiagnostics = record(summary?.diagnostics);
  if (operationDiagnostics) return operationDiagnostics;
  const snapshot = latestSnapshot(row, "SUPPORT_READY");
  const snapshotSummary = record(snapshot?.summary);
  const snapshotNewspaper = record(snapshotSummary?.newspaperDiagnostics);
  return record(snapshotNewspaper?.diagnostics);
}

function latestSupportItems(row, key, nestedKeys) {
  const snapshot = latestSnapshot(row, "SUPPORT_READY");
  const summary = record(snapshot?.summary);
  return itemsFrom(summary?.[key], nestedKeys);
}

function latestSnapshot(row, kind) {
  const snapshots = Array.isArray(row?.fleetSnapshots) ? row.fleetSnapshots : [];
  return snapshots
    .filter((snapshot) => snapshot?.snapshotKind === kind)
    .sort((a, b) => Date.parse(b.observedAt ?? b.createdAt ?? 0) - Date.parse(a.observedAt ?? a.createdAt ?? 0))[0] ?? null;
}

function itemsFrom(value, nestedKeys) {
  if (Array.isArray(value)) return value.map(record).filter(Boolean);
  const source = record(value);
  if (!source) return [];
  for (const key of nestedKeys) {
    const candidate = source[key];
    if (Array.isArray(candidate)) return candidate.map(record).filter(Boolean);
  }
  return [];
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function deploymentLabel(row) {
  return optionalText(row?.label)
    ?? optionalText(row?.customerSlug)
    ?? optionalText(row?.customerAccount?.displayName)
    ?? optionalText(row?.customerAccount?.slug)
    ?? "customer deployment";
}

function clientSlug(row) {
  return optionalText(row?.customerSlug) ?? optionalText(row?.customerAccount?.slug);
}

function withRetryEvidence(result, failures) {
  if (!result) return result;
  const attempts = failures.length;
  if (attempts <= 1 || !result.incident) {
    return {
      ...result,
      attempts,
    };
  }

  return {
    ...result,
    attempts,
    incident: {
      ...result.incident,
      evidence: [
        ...result.incident.evidence,
        `Attempts: ${attempts}`,
        ...failures.slice(0, -1).map((failure, index) => retryFailureSummary(failure, index + 1)),
      ],
    },
  };
}

function retryFailureSummary(failure, attempt) {
  const parts = [`Attempt ${attempt}: ${failure.status}`];
  if (failure.httpStatus) parts.push(`HTTP ${failure.httpStatus}`);
  return parts.join("; ");
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function parseRailwayAllowlist(env = process.env) {
  const configured = parseJsonEnv(env, "RAILWAY_OPS_ALLOWLIST_JSON", []);
  if (!Array.isArray(configured)) {
    throw new Error("RAILWAY_OPS_ALLOWLIST_JSON must be an array.");
  }
  return configured.map((entry) => ({
    service: requireText(entry.service, "allowlist.service"),
    serviceId: requireText(entry.serviceId, "allowlist.serviceId"),
    environmentId: requireText(entry.environmentId, "allowlist.environmentId"),
    deploymentId: optionalText(entry.deploymentId),
    projectId: optionalText(entry.projectId),
  }));
}

export function planRailwayAction(action, service, env = process.env) {
  if (!RAILWAY_ACTIONS.includes(action)) {
    throw new Error(`Unsupported Railway action: ${action}. Allowed actions: ${RAILWAY_ACTIONS.join(", ")}`);
  }
  const allowlist = parseRailwayAllowlist(env);
  const match = allowlist.find((entry) => entry.service === service);
  if (!match) {
    throw new Error(`Railway service is not allowlisted: ${service}`);
  }
  if (action === "restart" && !match.deploymentId) {
    return {
      action,
      service,
      entry: match,
      requiresLatestDeploymentLookup: true,
      mutation: "deploymentRestart",
    };
  }
  if (action === "restart") {
    return {
      action,
      service,
      entry: match,
      deploymentId: match.deploymentId,
      mutation: "deploymentRestart",
    };
  }
  if (action === "redeploy-current") {
    return {
      action,
      service,
      entry: match,
      mutation: "serviceInstanceDeployV2",
    };
  }
  return {
    action,
    service,
    entry: match,
    mutation: "deployments",
  };
}

function objectContains(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return objectContains(actual[key], value);
    }
    return actual[key] === value;
  });
}

function sanitizeDedupeKey(value) {
  return String(value).trim().replace(/\s+/g, " ").slice(0, 200);
}

function labelSafe(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "unknown";
}

function appendPath(base, path) {
  return `${base.replace(/\/$/, "")}${path}`;
}

function firstUrl(...values) {
  for (const value of values) {
    const text = optionalText(value);
    if (text && /^https?:\/\//i.test(text)) return text.replace(/\/$/, "");
  }
  return null;
}

function requireUrl(value, label) {
  const text = requireText(value, label);
  if (!/^https?:\/\//i.test(text)) {
    throw new Error(`${label} must be an HTTP(S) URL.`);
  }
  return text;
}

function requireText(value, label) {
  const text = optionalText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampMs(value) {
  const text = optionalText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInt(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${value}.`);
  }
  return parsed;
}
