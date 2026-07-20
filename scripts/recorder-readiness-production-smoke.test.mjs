import { describe, expect, it, vi } from "vitest";

import {
  deploymentMatchesRecorderReadinessTarget,
  normalizeBaseUrl,
  normalizeControlPlaneUrl,
  normalizeRecorderReadinessTargets,
  RecorderReadinessProductionSmoke,
  recorderReadinessHealthReleaseBlocker,
  recorderReadinessValidationOutcome,
  resolveRecorderReadinessTargets,
  sanitizeRecorderReadinessForArtifact,
} from "./recorder-readiness-production-smoke.mjs";

function recorderWithGates(overrides = {}) {
  return {
    gates: {
      controlPlane: {
        key: "control_plane",
        label: "Control Plane access",
        status: "pass",
        detail: "Managed workspace inspected.",
        checks: [],
      },
      tenantConfig: {
        key: "tenant_config",
        label: "Tenant configuration",
        status: "pass",
        detail: "Enabled.",
        checks: [],
      },
      vendor: {
        key: "vendor",
        label: "Vendor credentials",
        status: "pass",
        detail: "Configured.",
        checks: [],
      },
      calendar: {
        key: "calendar",
        label: "Calendar connection",
        status: "pass",
        detail: "Active.",
        checks: [],
      },
      meetingState: {
        key: "meeting_state",
        label: "Scheduled meetings",
        status: "warning",
        detail: "No upcoming scheduled meetings were found.",
        checks: [],
      },
      liveVendorProof: {
        key: "live_vendor_proof",
        label: "Live vendor proof",
        status: "pass",
        detail: "Recent proof observed.",
        checks: [],
      },
      ...overrides,
    },
  };
}

describe("recorder readiness production smoke helpers", () => {
  it("normalizes base URL and target lists", () => {
    expect(normalizeBaseUrl("https://app.corgtex.com/")).toBe("https://app.corgtex.com");
    expect(normalizeControlPlaneUrl("https://ops.corgtex.com/")).toBe("https://ops.corgtex.com");
    expect(normalizeRecorderReadinessTargets("alpha, beta,alpha")).toEqual(["alpha", "beta"]);
  });

  it("matches deployment targets by deployment, workspace, and URL identifiers", () => {
    const deployments = [
      {
        id: "dep-1",
        label: "Alpha",
        customerSlug: "alpha",
        url: "https://alpha.corgtex.com",
        customDomain: "alpha.example.com",
        remoteWorkspaceSlug: "alpha-remote",
        managedWorkspaceId: "ws-1",
        managedWorkspace: { id: "ws-1", slug: "alpha-workspace", name: "Alpha Workspace" },
      },
    ];

    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "alpha-workspace")).toBe(true);
    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "alpha.corgtex.com")).toBe(true);
    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "https://alpha.corgtex.com")).toBe(true);
    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "alpha-remote")).toBe(true);
    expect(resolveRecorderReadinessTargets(deployments, ["Alpha", "missing"])).toEqual([
      { target: "Alpha", deployment: deployments[0] },
      { target: "missing", deployment: null },
    ]);
  });

  it("prefers the primary active production deployment for slug targets", () => {
    const deployments = [
      {
        id: "old-dep",
        label: "Alpha Legacy",
        customerSlug: "alpha",
        deploymentStatus: "RETIRED",
        environment: "production",
        customerAccount: { primaryDeploymentId: "active-dep" },
      },
      {
        id: "active-dep",
        label: "Alpha Production",
        customerSlug: "alpha",
        deploymentStatus: "ACTIVE",
        environment: "production",
        customerAccount: { primaryDeploymentId: "active-dep" },
      },
    ];

    expect(resolveRecorderReadinessTargets(deployments, ["alpha"])).toEqual([
      { target: "alpha", deployment: deployments[1] },
    ]);
  });

  it("loads deployment inventory from the configured control plane", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://ops.example/api/control-plane/mcp");
      expect(init.headers.authorization).toBe("Bearer cp-token");
      return new Response(JSON.stringify({
        result: {
          content: [{
            type: "text",
            text: JSON.stringify([{ id: "dep-1", label: "Alpha", customerSlug: "alpha" }]),
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const smoke = new RecorderReadinessProductionSmoke({
        baseUrl: "https://app.corgtex.com",
        controlPlaneUrl: "https://ops.example/",
        outDir: ".artifacts/test-recorder-inventory",
        targets: ["alpha"],
        controlPlaneToken: "token",
      });

      await expect(smoke.loadDeployments()).resolves.toEqual([
        { id: "dep-1", label: "Alpha", customerSlug: "alpha" },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("blocks release drift before control-plane readiness", () => {
    expect(recorderReadinessHealthReleaseBlocker({
      release: { gitSha: "old-sha" },
    }, "current-sha")).toContain("release.gitSha old-sha");

    expect(recorderReadinessHealthReleaseBlocker({
      release: {
        gitSha: "current-sha",
        configured: { gitSha: "current-sha" },
        drift: {
          gitSha: false,
          imageTag: false,
          version: false,
          details: [],
        },
      },
    }, "current-sha")).toBeNull();
  });

  it("passes when hard gates and live vendor proof pass", () => {
    expect(recorderReadinessValidationOutcome(recorderWithGates())).toMatchObject({
      result: "pass",
      blocker: null,
    });
  });

  it("blocks missing vendor credentials as a hard readiness blocker", () => {
    expect(recorderReadinessValidationOutcome(recorderWithGates({
      vendor: {
        key: "vendor",
        label: "Vendor credentials",
        status: "blocked",
        detail: "RECALL_API_KEY is missing.",
        checks: [{ key: "recall_api_key", label: "Recall API key", status: "blocked", detail: "RECALL_API_KEY is missing." }],
      },
    }))).toMatchObject({
      result: "blocked",
      blocker: expect.stringContaining("RECALL_API_KEY is missing"),
    });
  });

  it("marks missing live vendor proof as partial, not a false pass", () => {
    expect(recorderReadinessValidationOutcome(recorderWithGates({
      liveVendorProof: {
        key: "live_vendor_proof",
        label: "Live vendor proof",
        status: "blocked",
        detail: "No recent successful recorder smoke or real recording in the last 30 days.",
        checks: [],
      },
    }))).toMatchObject({
      result: "partial",
      blocker: expect.stringContaining("No recent successful recorder smoke"),
    });
  });

  it("blocks missing control-plane connector access explicitly", () => {
    expect(recorderReadinessValidationOutcome(recorderWithGates({
      controlPlane: {
        key: "control_plane",
        label: "Control Plane access",
        status: "blocked",
        detail: "Support connector readiness check failed.",
        checks: [{ key: "support_connector", label: "Support connector", status: "blocked", detail: "Support connector readiness check failed." }],
      },
    }))).toMatchObject({
      result: "blocked",
      blocker: expect.stringContaining("Support connector readiness check failed"),
    });
  });

  it("strips meeting metadata from persisted readiness artifacts", () => {
    const sanitized = sanitizeRecorderReadinessForArtifact({
      deploymentId: "dep-1",
      managedWorkspaceId: "ws-1",
      accessMode: "managed_workspace",
      agenda: {
        status: "ready",
        ready: true,
        detail: "Agenda ready.",
        nextMeeting: {
          id: "meeting-1",
          title: "Private customer meeting",
        },
      },
      recorder: {
        status: "ready",
        ready: true,
        gates: recorderWithGates().gates,
        upcomingCoverage: {
          counts: { total: 1, eligible: 1, blockers: {} },
          meetings: [{ meetingId: "meeting-1", recordedAt: "2026-07-17T12:00:00.000Z" }],
        },
        lastSuccessfulRecording: {
          id: "recording-1",
          provider: "RECALL_AI",
          status: "COMPLETED",
          observedAt: "2026-07-17T12:00:00.000Z",
        },
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("Private customer meeting");
    expect(JSON.stringify(sanitized)).not.toContain("meeting-1");
    expect(JSON.stringify(sanitized)).not.toContain("recording-1");
    expect(sanitized.recorder.upcomingCoverage).toEqual({
      window: null,
      counts: { total: 1, eligible: 1, blockers: {} },
    });
  });

  it("records one matrix result per requested PR number", () => {
    const smoke = new RecorderReadinessProductionSmoke({
      baseUrl: "https://app.corgtex.com",
      outDir: ".artifacts/test-recorder-readiness",
      targets: ["alpha"],
      prNumbers: [725, 726],
      controlPlaneToken: "token",
    });

    smoke.recordResult({
      target: "alpha",
      result: "partial",
      blocker: "Live vendor proof: no recent proof.",
      readiness: { recorder: recorderWithGates() },
    });

    expect(smoke.validationRun.results.map((result) => result.prNumber)).toEqual([725, 726]);
  });

  it("fails the command after writing artifacts when release metadata drifts", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      release: { gitSha: "old-sha" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    try {
      const smoke = new RecorderReadinessProductionSmoke({
        baseUrl: "https://app.corgtex.com",
        outDir: ".artifacts/test-recorder-release-drift",
        targets: ["alpha"],
        expectedGitSha: "current-sha",
        controlPlaneToken: "token",
      });

      await expect(smoke.run()).rejects.toThrow("release.gitSha old-sha");
      expect(smoke.validationRun.status).toBe("blocked");
      expect(smoke.validationRun.results[0]).toMatchObject({
        result: "blocked",
        blocker: expect.stringContaining("release.gitSha old-sha"),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
