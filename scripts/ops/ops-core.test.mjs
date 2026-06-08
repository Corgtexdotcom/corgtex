import { describe, expect, it } from "vitest";

import {
  buildControlPlaneIncidents,
  buildHealthTargets,
  checkHealthTarget,
  fetchControlPlaneCustomers,
  incidentLabels,
  incidentTitle,
  normalizeIncident,
  parseRailwayAllowlist,
  planRailwayAction,
  severityForHealthStatus,
} from "./ops-core.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ops-core incidents", () => {
  it("normalizes incident shape with stable routing fields", () => {
    const incident = normalizeIncident({
      service: "web",
      status: "down",
      summary: "App health failed",
      evidence: ["HTTP 503"],
    });

    expect(incident).toMatchObject({
      dedupeKey: "web:down:App health failed",
      severity: "P1",
      service: "web",
      status: "down",
      summary: "App health failed",
      recommendedAction: "investigate",
    });
    expect(new Date(incident.createdAt).toString()).not.toBe("Invalid Date");
    expect(incidentTitle(incident)).toContain("P1 web");
    expect(incidentLabels(incident)).toContain("ops-auto-fix");
    expect(incidentLabels(incident)).toContain("severity-p1");
  });

  it("maps health statuses to severity", () => {
    expect(severityForHealthStatus("down")).toBe("P1");
    expect(severityForHealthStatus("timeout")).toBe("P1");
    expect(severityForHealthStatus("degraded")).toBe("P2");
    expect(severityForHealthStatus("ok", "P3")).toBe("P3");
  });
});

describe("ops-core health targets", () => {
  it("builds default targets from environment URLs", () => {
    const targets = buildHealthTargets({
      NEXT_PUBLIC_SITE_URL: "https://corgtex.example",
      NEXT_PUBLIC_APP_URL: "https://app.example",
      OPS_PRIMARY_CLIENT_URL: "https://client.example",
      OPS_PRIMARY_CLIENT_SLUG: "primary",
    });

    expect(targets.map((target) => target.name)).toEqual([
      "site",
      "app",
      "demo",
      "primary-health",
    ]);
    expect(targets.find((target) => target.name === "app")).toMatchObject({
      service: "web",
      severity: "P1",
      url: "https://app.example/api/health",
      attempts: 2,
      retryDelayMs: 750,
    });
  });

  it("returns an incident when JSON health payload is stale", async () => {
    const [target] = buildHealthTargets({
      NEXT_PUBLIC_APP_URL: "https://app.example",
    }).filter((item) => item.name === "app");
    const result = await checkHealthTarget({ ...target, attempts: 1 }, async () => response({
      status: "degraded",
      database: "up",
      schema: "stale",
    }));

    expect(result.ok).toBe(false);
    expect(result.incident).toMatchObject({
      service: "web",
      severity: "P1",
      status: "degraded",
    });
  });

  it("retries transient fetch failures before returning success", async () => {
    const [target] = buildHealthTargets({
      NEXT_PUBLIC_APP_URL: "https://app.example",
    }).filter((item) => item.name === "app");
    let calls = 0;

    const result = await checkHealthTarget(
      { ...target, attempts: 2, retryDelayMs: 1 },
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("fetch failed");
        return response({
          status: "ok",
          database: "up",
          schema: "ready",
        });
      },
    );

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      ok: true,
      status: "ok",
      attempts: 2,
    });
    expect(result.incident).toBeUndefined();
  });

  it("returns an incident with attempt evidence after retry exhaustion", async () => {
    const [target] = buildHealthTargets({
      NEXT_PUBLIC_APP_URL: "https://app.example",
    }).filter((item) => item.name === "app");

    const result = await checkHealthTarget(
      { ...target, attempts: 2, retryDelayMs: 1 },
      async () => {
        throw new Error("fetch failed");
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: "unreachable",
      attempts: 2,
    });
    expect(result.incident.evidence).toEqual(expect.arrayContaining([
      "Attempts: 2",
      "Attempt 1: unreachable",
    ]));
  });
});

describe("ops-core control-plane incidents", () => {
  const now = "2026-05-24T00:30:00.000Z";
  const buildTestControlPlaneIncidents = (customers, options = {}) => buildControlPlaneIncidents(customers, {
    now,
    ...options,
  });

  it("fetches customers from the Control Plane MCP endpoint", async () => {
    const customers = [{ id: "deployment-1", label: "Acme Production" }];
    const urls = [];
    const result = await fetchControlPlaneCustomers({
      CONTROL_PLANE_URL: "https://ops.example",
      CONTROL_PLANE_AGENT_API_KEY: "test-token",
    }, async (url, init) => {
      urls.push(url);
      expect(init.headers.authorization).toBe("Bearer cp-test-token");
      if (url === "https://ops.example/api/control-plane/deployments/deployment-1/operations") {
        return response({ operations: [] });
      }
      expect(url).toBe("https://ops.example/api/control-plane/mcp");
      return response({
        result: {
          content: [{ text: JSON.stringify(customers) }],
        },
      });
    });

    expect(result).toEqual(customers);
    expect(urls).toEqual([
      "https://ops.example/api/control-plane/mcp",
      "https://ops.example/api/control-plane/deployments/deployment-1/operations",
    ]);
  });

  it("enriches fetched customers with a wider support-operation window", async () => {
    const result = await fetchControlPlaneCustomers({
      CONTROL_PLANE_URL: "https://ops.example",
      CONTROL_PLANE_AGENT_API_KEY: "test-token",
    }, async (url) => {
      if (url === "https://ops.example/api/control-plane/deployments/deployment-1/operations") {
        return response({
          operations: [
            {
              id: "operation-recovery",
              action: "agents.list_runs",
              status: "COMPLETED",
              completedAt: "2026-05-24T00:15:00.000Z",
              resultSummary: {
                items: [
                  {
                    id: "run-recovered",
                    agentKey: "meeting-summary",
                    status: "COMPLETED",
                    completedAt: "2026-05-24T00:12:00.000Z",
                  },
                ],
              },
            },
          ],
        });
      }

      return response({
        result: {
          content: [{
            text: JSON.stringify([
              {
                id: "deployment-1",
                label: "Acme Production",
                customerSlug: "acme",
                hasSupportCredential: true,
                supportOperations: [
                  { id: "operation-newer-noise", action: "runtime.list_jobs", status: "COMPLETED" },
                  { id: "operation-newer-noise-2", action: "members.list", status: "COMPLETED" },
                  { id: "operation-newer-noise-3", action: "integrations.list", status: "COMPLETED" },
                ],
                fleetSnapshots: [
                  {
                    snapshotKind: "SUPPORT_READY",
                    observedAt: "2026-05-24T00:00:00.000Z",
                    summary: {
                      agentRuns: {
                        items: [
                          { id: "run-failed-3", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:55:00.000Z" },
                          { id: "run-failed-2", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:50:00.000Z" },
                          { id: "run-failed-1", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:45:00.000Z" },
                        ],
                      },
                    },
                  },
                ],
              },
            ]),
          }],
        },
      });
    });

    expect(result[0].supportOperations.map((operation) => operation.id)).toEqual([
      "operation-newer-noise",
      "operation-newer-noise-2",
      "operation-newer-noise-3",
      "operation-recovery",
    ]);
    expect(buildTestControlPlaneIncidents(result).some((incident) => incident.status === "agentFailureStreak")).toBe(false);
  });

  it("builds sanitized incidents from cached support and release snapshots", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        releaseImageTag: "old-release",
        lastHealthError: "Release drift: expected old-release, got new-release",
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:00:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-23T23:00:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-23T22:00:00.000Z" },
                ],
              },
              failedJobs: {
                items: [
                  { type: "communication.slack.proactive-scan", error: "An API error occurred: invalid_auth" },
                ],
              },
            },
          },
          {
            snapshotKind: "RELEASE",
            observedAt: "2026-05-24T00:00:00.000Z",
            error: "Release drift: expected old-release, got new-release",
            summary: {
              expectedReleaseImageTag: "old-release",
              observedRelease: { gitSha: "new-release" },
            },
          },
        ],
      },
      {
        id: "deployment-internal",
        label: "Corgtex Internal",
        customerSlug: "corgtex-internal",
        hasSupportCredential: false,
        supportConnectorStatus: "not_configured",
      },
    ]);

    expect(incidents.map((incident) => incident.status).sort()).toEqual([
      "agentFailureStreak",
      "missingSupportConnector",
      "releaseMetadataDrift",
      "slackInvalidAuth",
    ].sort());
    expect(incidents.find((incident) => incident.status === "slackInvalidAuth").evidence.join("\n")).not.toContain("secret");
  });

  it("keeps recent Slack invalid-auth incidents", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              failedJobs: {
                items: [
                  {
                    type: "communication.slack.proactive-scan",
                    error: "An API error occurred: invalid_auth",
                    updatedAt: "2026-05-23T23:30:00.000Z",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "slackInvalidAuth");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Latest failed job signal: 2026-05-23T23:30:00.000Z");
  });

  it("suppresses stale Slack invalid-auth incidents", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              failedJobs: {
                items: [
                  {
                    type: "communication.slack.proactive-scan",
                    error: "An API error occurred: invalid_auth",
                    updatedAt: "2026-05-22T23:00:00.000Z",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "slackInvalidAuth")).toBe(false);
  });

  it("ages undated Slack invalid-auth jobs from the snapshot timestamp", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-22T23:00:00.000Z",
            summary: {
              failedJobs: {
                items: [
                  {
                    type: "communication.slack.proactive-scan",
                    error: "An API error occurred: invalid_auth",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "slackInvalidAuth")).toBe(false);
  });

  it("requires consecutive agent failures for failure-streak incidents", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:00:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-23T23:55:00.000Z" },
                  { agentKey: "inbox-triage", status: "COMPLETED", createdAt: "2026-05-23T23:50:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-23T23:45:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-23T23:40:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "agentFailureStreak")).toBe(false);
  });

  it("keeps recent agent failure-streak incidents when a failed run lacks a timestamp", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:15:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", status: "FAILED" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:10:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:05:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "agentFailureStreak");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Failed runs in latest snapshot: 3");
  });

  it("keeps agent failure-streak incidents while a newer retry is in flight", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:20:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", status: "PENDING", createdAt: "2026-05-24T00:20:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:10:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:05:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:00:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "agentFailureStreak");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Failed runs in latest snapshot: 3");
  });

  it("keeps agent failure-streak incidents past unknown run statuses", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:20:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", createdAt: "2026-05-24T00:20:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:10:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:05:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:00:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "agentFailureStreak");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Failed runs in latest snapshot: 3");
  });

  it("keeps agent failure-streak incidents past cancelled runs", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:20:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", status: "CANCELLED", createdAt: "2026-05-24T00:20:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:10:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:05:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:00:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "agentFailureStreak");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Failed runs in latest snapshot: 3");
  });

  it("preserves unknown-timestamp failures ahead of older successful runs", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:15:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", status: "FAILED" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:10:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-24T00:05:00.000Z" },
                  { agentKey: "inbox-triage", status: "COMPLETED", createdAt: "2026-05-24T00:00:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "agentFailureStreak");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Failed runs in latest snapshot: 3");
  });

  it("uses the snapshot time when the newest failed run is undated", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:15:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", status: "FAILED" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-20T00:10:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-20T00:05:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "agentFailureStreak");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Latest failed run: unknown");
  });

  it("uses failure lifecycle timestamps for failure-streak freshness", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:25:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  {
                    agentKey: "inbox-triage",
                    status: "FAILED",
                    createdAt: "2026-05-22T00:00:00.000Z",
                    failedAt: "2026-05-24T00:20:00.000Z",
                  },
                  {
                    agentKey: "inbox-triage",
                    status: "FAILED",
                    createdAt: "2026-05-21T23:55:00.000Z",
                    completedAt: "2026-05-24T00:15:00.000Z",
                  },
                  {
                    agentKey: "inbox-triage",
                    status: "FAILED",
                    createdAt: "2026-05-21T23:50:00.000Z",
                    updatedAt: "2026-05-24T00:10:00.000Z",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "agentFailureStreak");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Latest failed run: 2026-05-24T00:20:00.000Z");
  });

  it("orders failure-streak recovery by terminal timestamps", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:30:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  {
                    agentKey: "inbox-triage",
                    status: "COMPLETED",
                    createdAt: "2026-05-24T00:20:00.000Z",
                    completedAt: "2026-05-24T00:21:00.000Z",
                  },
                  {
                    agentKey: "inbox-triage",
                    status: "FAILED",
                    createdAt: "2026-05-24T00:10:00.000Z",
                    failedAt: "2026-05-24T00:25:00.000Z",
                  },
                  {
                    agentKey: "inbox-triage",
                    status: "FAILED",
                    createdAt: "2026-05-24T00:05:00.000Z",
                    failedAt: "2026-05-24T00:24:00.000Z",
                  },
                  {
                    agentKey: "inbox-triage",
                    status: "FAILED",
                    createdAt: "2026-05-24T00:00:00.000Z",
                    failedAt: "2026-05-24T00:23:00.000Z",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "agentFailureStreak");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Latest failed run: 2026-05-24T00:25:00.000Z");
  });

  it("suppresses undated support signals from timestamp-less snapshots", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", status: "FAILED" },
                  { agentKey: "inbox-triage", status: "FAILED" },
                  { agentKey: "inbox-triage", status: "FAILED" },
                ],
              },
              failedJobs: {
                items: [
                  {
                    type: "communication.slack.proactive-scan",
                    error: "An API error occurred: invalid_auth",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "agentFailureStreak")).toBe(false);
    expect(incidents.some((incident) => incident.status === "slackInvalidAuth")).toBe(false);
  });

  it("suppresses recovered agent failure-streak incidents", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "inbox-triage", status: "COMPLETED", createdAt: "2026-05-24T00:00:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-23T23:55:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-23T23:50:00.000Z" },
                  { agentKey: "inbox-triage", status: "FAILED", createdAt: "2026-05-23T23:45:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "agentFailureStreak")).toBe(false);
  });

  it("suppresses cached failure-streak incidents when newer support inspection shows recovery", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        supportOperations: [
          {
            action: "agents.list_runs",
            status: "COMPLETED",
            completedAt: "2026-05-24T00:15:00.000Z",
            resultSummary: {
              items: [
                {
                  id: "run-recovered",
                  agentKey: "meeting-summary",
                  status: "COMPLETED",
                  createdAt: "2026-05-24T00:10:00.000Z",
                  completedAt: "2026-05-24T00:12:00.000Z",
                },
              ],
            },
          },
        ],
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { id: "run-failed-3", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:55:00.000Z" },
                  { id: "run-failed-2", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:50:00.000Z" },
                  { id: "run-failed-1", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:45:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "agentFailureStreak")).toBe(false);
  });

  it("suppresses cached failure-streak incidents when cached failures lack timestamps", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        supportOperations: [
          {
            action: "agents.list_runs",
            status: "COMPLETED",
            completedAt: "2026-05-24T00:15:00.000Z",
            resultSummary: {
              items: [
                {
                  agentKey: "meeting-summary",
                  status: "COMPLETED",
                  completedAt: "2026-05-24T00:12:00.000Z",
                },
              ],
            },
          },
        ],
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "meeting-summary", status: "FAILED" },
                  { agentKey: "meeting-summary", status: "FAILED" },
                  { agentKey: "meeting-summary", status: "FAILED" },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "agentFailureStreak")).toBe(false);
  });

  it("uses newer support inspection status when a cached run id is repeated", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        supportOperations: [
          {
            action: "agents.list_runs",
            status: "COMPLETED",
            completedAt: "2026-05-24T00:15:00.000Z",
            resultSummary: {
              items: [
                {
                  id: "run-failed-3",
                  agentKey: "meeting-summary",
                  status: "COMPLETED",
                  createdAt: "2026-05-23T23:55:00.000Z",
                  completedAt: "2026-05-24T00:12:00.000Z",
                },
              ],
            },
          },
        ],
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { id: "run-failed-3", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:55:00.000Z" },
                  { id: "run-failed-2", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:50:00.000Z" },
                  { id: "run-failed-1", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:45:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "agentFailureStreak")).toBe(false);
  });

  it("keeps cached failure-streak incidents when support inspection predates the snapshot", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        supportOperations: [
          {
            action: "agents.list_runs",
            status: "COMPLETED",
            completedAt: "2026-05-23T23:30:00.000Z",
            resultSummary: {
              items: [
                {
                  id: "run-recovered-too-old",
                  agentKey: "meeting-summary",
                  status: "COMPLETED",
                  createdAt: "2026-05-23T23:25:00.000Z",
                  completedAt: "2026-05-23T23:28:00.000Z",
                },
              ],
            },
          },
        ],
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { id: "run-failed-3", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:55:00.000Z" },
                  { id: "run-failed-2", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:50:00.000Z" },
                  { id: "run-failed-1", agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-23T23:45:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    const incident = incidents.find((item) => item.status === "agentFailureStreak");
    expect(incident).toBeDefined();
    expect(incident.evidence).toContain("Failed runs in latest snapshot: 3");
  });

  it("suppresses support incidents from stale cached snapshots", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-20T00:00:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-19T23:55:00.000Z" },
                  { agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-19T23:50:00.000Z" },
                  { agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-19T23:45:00.000Z" },
                ],
              },
              failedJobs: {
                items: [
                  {
                    type: "communication.slack.proactive-scan",
                    error: "An API error occurred: invalid_auth",
                    updatedAt: "2026-05-19T23:55:00.000Z",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "agentFailureStreak")).toBe(false);
    expect(incidents.some((incident) => incident.status === "slackInvalidAuth")).toBe(false);
  });

  it("suppresses stale agent failure-streak incidents", () => {
    const incidents = buildTestControlPlaneIncidents([
      {
        id: "deployment-acme",
        label: "Acme Production",
        customerSlug: "acme",
        hasSupportCredential: true,
        fleetSnapshots: [
          {
            snapshotKind: "SUPPORT_READY",
            observedAt: "2026-05-24T00:00:00.000Z",
            summary: {
              agentRuns: {
                items: [
                  { agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-20T00:00:00.000Z" },
                  { agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-19T23:55:00.000Z" },
                  { agentKey: "meeting-summary", status: "FAILED", createdAt: "2026-05-19T23:50:00.000Z" },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(incidents.some((incident) => incident.status === "agentFailureStreak")).toBe(false);
  });
});

describe("ops-core Railway allowlist", () => {
  const env = {
    RAILWAY_OPS_ALLOWLIST_JSON: JSON.stringify([
      {
        service: "web",
        serviceId: "svc-web",
        environmentId: "env-prod",
        deploymentId: "deploy-current",
      },
      {
        service: "worker",
        serviceId: "svc-worker",
        environmentId: "env-prod",
      },
    ]),
  };

  it("parses allowlisted services", () => {
    expect(parseRailwayAllowlist(env)).toEqual([
      {
        service: "web",
        serviceId: "svc-web",
        environmentId: "env-prod",
        deploymentId: "deploy-current",
        projectId: null,
      },
      {
        service: "worker",
        serviceId: "svc-worker",
        environmentId: "env-prod",
        deploymentId: null,
        projectId: null,
      },
    ]);
  });

  it("plans only supported Railway actions against allowlisted services", () => {
    expect(planRailwayAction("restart", "web", env)).toMatchObject({
      action: "restart",
      service: "web",
      deploymentId: "deploy-current",
      mutation: "deploymentRestart",
    });
    expect(planRailwayAction("redeploy-current", "worker", env)).toMatchObject({
      action: "redeploy-current",
      service: "worker",
      mutation: "serviceInstanceDeployV2",
    });
  });

  it("rejects rollback and unlisted services", () => {
    expect(() => planRailwayAction("rollback", "web", env)).toThrow("Unsupported Railway action");
    expect(() => planRailwayAction("restart", "db", env)).toThrow("not allowlisted");
  });
});
