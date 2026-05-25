import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Severity = "P1" | "P2" | "P3";

type OpsIncident = {
  dedupeKey: string;
  severity: Severity;
  service: string;
  status: string;
  summary: string;
  evidence: string[];
  recommendedAction: string;
  createdAt: string;
};

type GithubConfig = {
  baseUrl: string;
  owner: string;
  repo: string;
  token: string;
};

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (!verifySharedSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const incident = railwayIncident(payload);
  const slackSent = await postSlackNotification(payload, incident).catch((error: unknown) => {
    console.error("[railway-webhook] Slack notification failed.", error);
    return false;
  });
  const githubUrl = incident ? await upsertGithubIssue(incident) : null;

  return NextResponse.json({
    ok: true,
    actionable: Boolean(incident),
    githubUrl,
    slackSent,
  });
}

function verifySharedSecret(request: NextRequest) {
  const secret = process.env.RAILWAY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error("[railway-webhook] RAILWAY_WEBHOOK_SECRET is not configured. Rejecting webhook.");
    return false;
  }

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  const candidates = [
    bearer,
    request.headers.get("x-corgtex-webhook-secret"),
    request.headers.get("x-railway-webhook-secret"),
    request.nextUrl.searchParams.get("token"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return candidates.some((candidate) => safeEqual(candidate, secret));
}

function railwayIncident(payload: unknown): OpsIncident | null {
  const event = eventName(payload);
  const status = fieldText(payload, ["deployment", "status"])
    ?? fieldText(payload, ["status"])
    ?? fieldText(payload, ["deploymentStatus"])
    ?? event;
  const service = concreteServiceName(payload);
  const environment = fieldText(payload, ["environment", "name"])
    ?? fieldText(payload, ["environmentName"])
    ?? fieldText(payload, ["environment"]);
  const project = fieldText(payload, ["project", "name"])
    ?? fieldText(payload, ["projectName"])
    ?? fieldText(payload, ["project"]);
  const deploymentId = fieldText(payload, ["deployment", "id"])
    ?? fieldText(payload, ["deploymentId"]);
  const volume = fieldText(payload, ["volume", "name"])
    ?? fieldText(payload, ["volumeName"]);
  const signal = [event, status, service, environment, project, volume].filter(Boolean).join(" ").toLowerCase();
  const volumeAlert = signal.includes("volume");
  const failedDeployment = ["failed", "failure", "crashed", "crash", "error", "unhealthy"].some((term) => signal.includes(term));

  if (!volumeAlert && !failedDeployment) return null;
  if (!service) return null;

  const severity: Severity = failedDeployment ? "P1" : "P2";
  const evidence = [
    `Event: ${event}`,
    `Status: ${status}`,
    project ? `Project: ${project}` : null,
    environment ? `Environment: ${environment}` : null,
    deploymentId ? `Deployment: ${deploymentId}` : null,
    volume ? `Volume: ${volume}` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    dedupeKey: ["railway", service, environment, deploymentId ?? event, status].filter(Boolean).join(":"),
    severity,
    service,
    status,
    summary: volumeAlert
      ? `${service} Railway volume alert`
      : `${service} Railway deployment ${status.toLowerCase()}`,
    evidence,
    recommendedAction: failedDeployment
      ? "inspect Railway deployment; Codex may redeploy-current if no code fix is indicated"
      : "inspect Railway volume usage and open a capacity or cleanup fix",
    createdAt: new Date().toISOString(),
  };
}

async function postSlackNotification(payload: unknown, incident: OpsIncident | null) {
  const webhookUrl = process.env.OPS_SLACK_WEBHOOK_URL?.trim();
  if (!webhookUrl) return false;

  const text = incident
    ? `Corgtex Railway ${incident.severity}: ${incident.summary}`
    : `Corgtex Railway event: ${eventName(payload)}`;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook returned HTTP ${response.status}.`);
  }
  return true;
}

async function upsertGithubIssue(incident: OpsIncident) {
  const github = githubConfig();
  if (!github) return null;

  const labels = incidentLabels(incident);
  await ensureGithubLabels(github, labels);

  const searchToken = `ops:${shortHash(incident.dedupeKey, 10)}`;
  const existing = await findExistingIssue(github, searchToken);
  if (existing?.number) {
    const comment = await githubRequest<{ html_url: string }>(
      github,
      `/repos/${github.owner}/${github.repo}/issues/${existing.number}/comments`,
      {
        method: "POST",
        body: {
          body: [
            `Repeated Railway webhook signal at ${new Date().toISOString()}.`,
            "",
            incidentBody(incident),
          ].join("\n"),
        },
      },
    );
    return comment.html_url;
  }

  const issue = await githubRequest<{ html_url: string }>(
    github,
    `/repos/${github.owner}/${github.repo}/issues`,
    {
      method: "POST",
      body: {
        title: incidentTitle(incident),
        body: incidentBody(incident),
        labels,
      },
    },
  );
  return issue.html_url;
}

function githubConfig(): GithubConfig | null {
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

async function ensureGithubLabels(github: GithubConfig, labels: string[]) {
  for (const label of labels) {
    await githubRequest(
      github,
      `/repos/${github.owner}/${github.repo}/labels`,
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

async function findExistingIssue(github: GithubConfig, searchToken: string) {
  const issues = await githubRequest<Array<{ number: number; title: string; pull_request?: unknown }>>(
    github,
    `/repos/${github.owner}/${github.repo}/issues?state=open&labels=ops-auto-fix&per_page=100`,
  );
  return issues.find((issue) => !issue.pull_request && issue.title.includes(searchToken)) ?? null;
}

async function githubRequest<T>(github: GithubConfig, path: string, options: {
  method?: string;
  body?: unknown;
  okStatuses?: number[];
} = {}) {
  const response = await fetch(`${github.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${github.token}`,
      "Content-Type": "application/json",
      "User-Agent": "corgtex-railway-webhook",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) as T : null as T;
  const okStatuses = options.okStatuses ?? [200, 201];
  if (!okStatuses.includes(response.status)) {
    const message = asRecord(payload)?.message ?? response.statusText;
    throw new Error(`GitHub API ${options.method ?? "GET"} ${path} failed: ${message}`);
  }
  return payload;
}

function incidentTitle(incident: OpsIncident) {
  return `[ops:${shortHash(incident.dedupeKey, 10)}] ${incident.severity} ${incident.service}: ${incident.summary}`;
}

function incidentBody(incident: OpsIncident) {
  return [
    "## Summary",
    "",
    incident.summary,
    "",
    "## Routing",
    "",
    `- Severity: ${incident.severity}`,
    `- Service: ${incident.service}`,
    "- Client: n/a",
    `- Status: ${incident.status}`,
    `- Recommended action: ${incident.recommendedAction}`,
    `- Dedupe key: ${incident.dedupeKey}`,
    "",
    "## Evidence",
    "",
    ...incident.evidence.map((item) => `- ${item}`),
    "",
    "## Codex Handling",
    "",
    "Codex Builder may prepare a fix PR and enable auto-merge. Codex Reviewer must apply `.codex/review.md` before approval.",
    "",
  ].join("\n");
}

function incidentLabels(incident: OpsIncident) {
  return [
    "ops-auto-fix",
    "ops-incident",
    `severity-${incident.severity.toLowerCase()}`,
    `service-${labelSafe(incident.service)}`,
  ];
}

function eventName(payload: unknown) {
  return fieldText(payload, ["type"])
    ?? fieldText(payload, ["event"])
    ?? fieldText(payload, ["action"])
    ?? "railway";
}

function fieldText(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) return null;
    current = record[segment];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function concreteServiceName(payload: unknown) {
  const service = fieldText(payload, ["service", "name"])
    ?? fieldText(payload, ["deployment", "service", "name"])
    ?? fieldText(payload, ["resource", "service", "name"])
    ?? fieldText(payload, ["deployment", "serviceName"])
    ?? fieldText(payload, ["resource", "serviceName"])
    ?? fieldText(payload, ["serviceName"])
    ?? fieldText(payload, ["deployment", "service"])
    ?? fieldText(payload, ["resource", "service"])
    ?? fieldText(payload, ["service"]);
  return service;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function shortHash(value: string, length: number) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function labelSafe(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function labelColor(label: string) {
  if (label === "ops-auto-fix") return "D93F0B";
  if (label === "ops-incident") return "B60205";
  if (label === "severity-p1") return "B60205";
  if (label === "severity-p2") return "D93F0B";
  if (label === "severity-p3") return "FBCA04";
  if (label.startsWith("service-")) return "5319E7";
  return "C5DEF5";
}
