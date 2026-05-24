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
  it("fetches customers from the Control Plane MCP endpoint", async () => {
    const customers = [{ id: "deployment-1", label: "Acme Production" }];
    const result = await fetchControlPlaneCustomers({
      CONTROL_PLANE_URL: "https://ops.example",
      CONTROL_PLANE_AGENT_API_KEY: "test-token",
    }, async (url, init) => {
      expect(url).toBe("https://ops.example/api/control-plane/mcp");
      expect(init.headers.authorization).toBe("Bearer cp-test-token");
      return response({
        result: {
          content: [{ text: JSON.stringify(customers) }],
        },
      });
    });

    expect(result).toEqual(customers);
  });

  it("builds sanitized incidents from cached support and release snapshots", () => {
    const incidents = buildControlPlaneIncidents([
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
