import { createHash } from "node:crypto";

export const INCIDENT_SEVERITIES = ["P1", "P2", "P3"];
export const RAILWAY_ACTIONS = ["inspect", "restart", "redeploy-current"];

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
  return {
    name: requireText(input.name, "target.name"),
    service: requireText(input.service ?? input.name, "target.service"),
    clientSlug: optionalText(input.clientSlug),
    url: requireUrl(input.url, "target.url"),
    severity: normalizeSeverity(input.severity, "P3"),
    timeoutMs: positiveInt(input.timeoutMs, 10_000),
    expectedStatuses: statuses.map((status) => positiveInt(status, 200)),
    expectJson: input.expectJson && typeof input.expectJson === "object" ? input.expectJson : null,
    method: optionalText(input.method) ?? "GET",
  };
}

export async function checkHealthTarget(target, fetchImpl = fetch) {
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

function positiveInt(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${value}.`);
  }
  return parsed;
}
