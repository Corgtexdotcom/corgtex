import { describe, expect, it } from "vitest";

import {
  buildHealthTargets,
  checkHealthTarget,
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
    });
  });

  it("returns an incident when JSON health payload is stale", async () => {
    const [target] = buildHealthTargets({
      NEXT_PUBLIC_APP_URL: "https://app.example",
    }).filter((item) => item.name === "app");
    const result = await checkHealthTarget(target, async () => response({
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
