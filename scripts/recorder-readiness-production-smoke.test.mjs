import { describe, expect, it, vi } from "vitest";

import {
  deploymentMatchesRecorderReadinessTarget,
  normalizeBaseUrl,
  normalizeControlPlaneUrl,
  normalizeRecorderReadinessTargets,
  normalizeTempMeetingSetup,
  RecorderReadinessProductionSmoke,
  recorderReadinessCanUseTempMeetingSetup,
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
        label: "Recording schedule",
        status: "pass",
        detail: "Corgtex scheduled meetings are ready.",
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

function controlPlaneToolResponse(value) {
  return new Response(JSON.stringify({
    result: {
      content: [{
        type: "text",
        text: JSON.stringify(value),
      }],
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("recorder readiness production smoke helpers", () => {
  it("normalizes base URL and target lists", () => {
    expect(normalizeBaseUrl("https://app.corgtex.com/")).toBe("https://app.corgtex.com");
    expect(normalizeControlPlaneUrl("https://ops.corgtex.com/")).toBe("https://ops.corgtex.com");
    expect(normalizeRecorderReadinessTargets("alpha, beta,alpha")).toEqual(["alpha", "beta"]);
    expect(normalizeRecorderReadinessTargets("")).toEqual([]);
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
        managedWorkspaceSlug: "alpha-flat-workspace",
        managedWorkspaceName: "Alpha Flat Workspace",
        managedWorkspace: { id: "ws-1", slug: "alpha-workspace", name: "Alpha Workspace" },
      },
    ];

    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "alpha-workspace")).toBe(true);
    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "alpha-flat-workspace")).toBe(true);
    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "Alpha Flat Workspace")).toBe(true);
    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "alpha.corgtex.com")).toBe(true);
    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "https://alpha.corgtex.com")).toBe(true);
    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "https://alpha.corgtex.com/")).toBe(true);
    expect(deploymentMatchesRecorderReadinessTarget(deployments[0], "alpha.example.com/")).toBe(true);
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
        primaryDeploymentId: "active-dep",
        customerAccount: { primaryDeploymentId: "active-dep" },
      },
      {
        id: "active-dep",
        label: "Alpha Production",
        customerSlug: "alpha",
        deploymentStatus: "ACTIVE",
        environment: "production",
        primaryDeploymentId: "active-dep",
        customerAccount: { primaryDeploymentId: "active-dep" },
      },
    ];

    expect(resolveRecorderReadinessTargets(deployments, ["alpha"])).toEqual([
      { target: "alpha", deployment: deployments[1] },
    ]);
  });

  it("prefers an active production customer slug over an archived managed-workspace slug", () => {
    const archivedSharedWorkspace = {
      id: "archived-dep",
      label: "Chirone Production (archived shared workspace)",
      customerSlug: "chirone-shared-archived-20260607",
      url: "https://ops.corgtex.com/archived/chirone-shared-workspace-archived-dep",
      managedWorkspaceId: "archived-workspace",
      managedWorkspaceSlug: "chirone",
      managedWorkspaceName: "Chirone",
      deploymentStatus: "SUSPENDED",
      provisioningStatus: "archived",
      environment: "production",
      supportConnectorStatus: "not_configured",
    };
    const activeProductionDeployment = {
      id: "active-dep",
      label: "Chirone Production",
      customerSlug: "chirone",
      url: "https://deploy-chirone-production.up.railway.app",
      customDomain: "chirone.corgtex.com",
      managedWorkspaceId: null,
      managedWorkspaceSlug: null,
      deploymentStatus: "ACTIVE",
      provisioningStatus: "provisioned",
      environment: "production",
      lastHealthStatus: "healthy",
      supportConnectorStatus: "connected",
    };

    expect(resolveRecorderReadinessTargets([
      archivedSharedWorkspace,
      activeProductionDeployment,
    ], ["chirone"])).toEqual([
      { target: "chirone", deployment: activeProductionDeployment },
    ]);
    expect(resolveRecorderReadinessTargets([
      activeProductionDeployment,
      archivedSharedWorkspace,
    ], ["Chirone Production (archived shared workspace)"])).toEqual([
      { target: "Chirone Production (archived shared workspace)", deployment: archivedSharedWorkspace },
    ]);
  });

  it("does not resolve account-only summaries as readiness deployments", () => {
    const accountOnlySummary = {
      id: "account-1",
      label: "Alpha Account",
      customerSlug: "alpha",
      hasDeployment: false,
      deploymentStatus: null,
      provisioningStatus: "draft",
    };
    const archivedDeployment = {
      id: "archived-dep",
      label: "Alpha Archived",
      customerSlug: "alpha",
      hasDeployment: true,
      deploymentStatus: "SUSPENDED",
      provisioningStatus: "archived",
      environment: "production",
    };

    expect(deploymentMatchesRecorderReadinessTarget(accountOnlySummary, "alpha")).toBe(false);
    expect(resolveRecorderReadinessTargets([accountOnlySummary], ["alpha"])).toEqual([
      { target: "alpha", deployment: null },
    ]);
    expect(resolveRecorderReadinessTargets([accountOnlySummary, archivedDeployment], ["alpha"])).toEqual([
      { target: "alpha", deployment: archivedDeployment },
    ]);
  });

  it("loads deployment inventory from the configured control plane", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://ops.example/api/control-plane/mcp");
      expect(init.headers.authorization).toBe("Bearer cp-token");
      expect(JSON.parse(init.body)).toMatchObject({
        method: "tools/call",
        params: {
          name: "list_customers",
          arguments: { includeAllDeployments: true, uncapped: true },
        },
      });
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

  it("blocks only when the Corgtex recording schedule gate is blocked", () => {
    const outcome = recorderReadinessValidationOutcome(recorderWithGates({
      calendar: {
        key: "calendar",
        label: "Recording schedule",
        status: "blocked",
        detail: "No upcoming Corgtex scheduled meetings are ready for recording.",
        checks: [{ key: "recording_schedule", label: "Corgtex recorder schedule", status: "blocked", detail: "Add the meeting to Corgtex before recording." }],
      },
    }));

    expect(outcome).toMatchObject({
      result: "blocked",
      blocker: expect.stringContaining("No upcoming Corgtex scheduled meetings"),
    });
    expect(recorderReadinessCanUseTempMeetingSetup(outcome)).toBe(true);
  });

  it("marks missing live vendor proof as partial, not a false pass", () => {
    const outcome = recorderReadinessValidationOutcome(recorderWithGates({
      liveVendorProof: {
        key: "live_vendor_proof",
        label: "Live vendor proof",
        status: "blocked",
        detail: "No recent successful recorder smoke or real recording in the last 30 days.",
        checks: [],
      },
    }));

    expect(outcome).toMatchObject({
      result: "partial",
      blocker: expect.stringContaining("No recent successful recorder smoke"),
    });
    expect(recorderReadinessCanUseTempMeetingSetup(outcome)).toBe(true);
  });

  it("blocks missing control-plane connector access explicitly", () => {
    const outcome = recorderReadinessValidationOutcome(recorderWithGates({
      controlPlane: {
        key: "control_plane",
        label: "Control Plane access",
        status: "blocked",
        detail: "Support connector readiness check failed.",
        checks: [{ key: "support_connector", label: "Support connector", status: "blocked", detail: "Support connector readiness check failed." }],
      },
    }));

    expect(outcome).toMatchObject({
      result: "blocked",
      blocker: expect.stringContaining("Support connector readiness check failed"),
    });
    expect(recorderReadinessCanUseTempMeetingSetup(outcome)).toBe(false);
  });

  it("normalizes temporary meeting setup only when explicitly enabled", () => {
    expect(normalizeTempMeetingSetup({}, new Date("2026-07-20T20:00:00.000Z"))).toMatchObject({
      enabled: false,
      meetingUrl: "",
      joinAt: null,
      scheduledEndAt: null,
      durationMinutes: null,
      provider: null,
    });
    expect(normalizeTempMeetingSetup({
      enabled: "true",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      joinAt: "2099-07-20T06:30:00.000Z",
      durationMinutes: "45",
      provider: "RECALL_AI",
    })).toMatchObject({
      enabled: true,
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      joinAt: new Date("2099-07-20T06:30:00.000Z"),
      scheduledEndAt: new Date("2099-07-20T07:15:00.000Z"),
      durationMinutes: 45,
      provider: "RECALL_AI",
    });
    expect(normalizeTempMeetingSetup({
      enabled: true,
      joinAt: "2099-07-20T06:30:00.000Z",
    })).toMatchObject({
      enabled: true,
      meetingUrl: "",
      joinAt: new Date("2099-07-20T06:30:00.000Z"),
      scheduledEndAt: new Date("2099-07-20T07:00:00.000Z"),
      durationMinutes: 30,
      provider: null,
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

  it("blocks clearly when recorder deployments are not configured", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: "ok",
      release: { gitSha: "current-sha" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    try {
      const smoke = new RecorderReadinessProductionSmoke({
        baseUrl: "https://app.corgtex.com",
        outDir: ".artifacts/test-recorder-missing-targets",
        targets: [],
        expectedGitSha: "current-sha",
        prNumbers: [725],
        controlPlaneToken: "token",
      });

      await smoke.run();

      expect(smoke.validationRun.status).toBe("blocked");
      expect(smoke.validationRun.results).toHaveLength(1);
      expect(smoke.validationRun.results[0]).toMatchObject({
        prNumber: 725,
        result: "blocked",
        blocker: "RECORDER_READINESS_SMOKE_DEPLOYMENTS or PRODUCTION_VALIDATION_RECORDER_DEPLOYMENTS must identify at least one recorder readiness deployment.",
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("can create, verify, cancel, and archive a temporary Corgtex scheduled meeting when enabled", async () => {
    const originalFetch = global.fetch;
    const initialReadiness = {
      recorder: recorderWithGates({
        calendar: {
          key: "calendar",
          label: "Recording schedule",
          status: "blocked",
          detail: "No upcoming Corgtex scheduled meetings found.",
          checks: [{ key: "recording_schedule", label: "Corgtex recorder schedule", status: "blocked", detail: "Add the meeting to Corgtex." }],
        },
        liveVendorProof: {
          key: "live_vendor_proof",
          label: "Live vendor proof",
          status: "blocked",
          detail: "No recent successful recorder smoke, scheduled provider bot, or real recording in the last 30 days.",
          checks: [],
        },
      }),
    };
    const finalReadiness = {
      recorder: recorderWithGates({
        meetingState: {
          key: "meeting_state",
          label: "Scheduled meetings",
          status: "pass",
          detail: "1 upcoming scheduled meeting is covered.",
          checks: [],
        },
      }),
    };
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      if (String(url) === "https://app.corgtex.com/api/health") {
        return new Response(JSON.stringify({
          release: {
            gitSha: "current-sha",
            drift: { gitSha: false, imageTag: false, version: false, details: [] },
            configured: { gitSha: "current-sha" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init.body));
      const toolName = body.params.name;
      calls.push({ toolName, args: body.params.arguments });
      if (toolName === "list_customers") {
        return controlPlaneToolResponse([{
          id: "dep-1",
          label: "Chirone Production",
          customerSlug: "chirone",
          customDomain: "chirone.corgtex.com",
          supportConnectorStatus: "connected",
        }]);
      }
      if (toolName === "check_meeting_operations_readiness") {
        const checks = calls.filter((call) => call.toolName === "check_meeting_operations_readiness").length;
        return controlPlaneToolResponse(checks === 1 ? initialReadiness : finalReadiness);
      }
      if (toolName === "run_customer_support_operation") {
        const action = body.params.arguments.action;
        if (action === "meetings.schedule") {
          return controlPlaneToolResponse({
            id: "op-schedule",
            status: "COMPLETED",
            resultSummary: {
              seriesId: "series-1",
              meetingIds: ["meeting-1"],
              firstMeetingId: "meeting-1",
              createdMeetingCount: 1,
              hasMeetingUrl: true,
            },
          });
        }
        if (action === "meeting_recorders.schedule_meeting") {
          return controlPlaneToolResponse({
            id: "op-recorder",
            status: "COMPLETED",
            resultSummary: {
              meetingId: "meeting-1",
              recording: { id: "recording-1", provider: "RECALL_AI", status: "SCHEDULED", hasExternalBot: true },
            },
          });
        }
        if (action === "meeting_recorders.cancel") {
          return controlPlaneToolResponse({
            id: "op-cancel",
            status: "COMPLETED",
            resultSummary: { recording: { id: "recording-1", status: "CANCELLED" } },
          });
        }
        if (action === "meetings.archive") {
          return controlPlaneToolResponse({
            id: "op-archive",
            status: "COMPLETED",
            resultSummary: { id: "meeting-1", archived: true },
          });
        }
      }
      throw new Error(`Unexpected fetch ${toolName}`);
    });

    try {
      const smoke = new RecorderReadinessProductionSmoke({
        baseUrl: "https://app.corgtex.com",
        controlPlaneUrl: "https://ops.example",
        outDir: ".artifacts/test-recorder-temp-setup",
        targets: ["chirone.corgtex.com"],
        expectedGitSha: "current-sha",
        prNumbers: [753],
        controlPlaneToken: "token",
        tempMeetingSetup: normalizeTempMeetingSetup({
          enabled: true,
          meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
          joinAt: "2099-07-20T06:30:00.000Z",
          provider: "RECALL_AI",
        }),
      });

      await smoke.run();

      expect(smoke.validationRun.status).toBe("pass");
      expect(smoke.validationRun.results).toHaveLength(1);
      expect(smoke.validationRun.results[0]).toMatchObject({
        result: "pass",
        createdRecordIds: ["meeting-1"],
        cleanupActionIds: [
          "archive-temporary-meeting:Meeting:meeting-1",
          "cancel-temporary-recorder:MeetingRecording:meeting-1",
        ],
      });
      expect(smoke.validationRun.cleanupActions).toEqual([
        expect.objectContaining({ id: "archive-temporary-meeting:Meeting:meeting-1", status: "completed" }),
        expect.objectContaining({ id: "cancel-temporary-recorder:MeetingRecording:meeting-1", status: "completed" }),
      ]);
      expect(calls.map((call) => call.toolName)).toEqual([
        "list_customers",
        "check_meeting_operations_readiness",
        "run_customer_support_operation",
        "run_customer_support_operation",
        "check_meeting_operations_readiness",
        "run_customer_support_operation",
        "run_customer_support_operation",
      ]);
      expect(calls.filter((call) => call.toolName === "run_customer_support_operation").map((call) => call.args.action)).toEqual([
        "meetings.schedule",
        "meeting_recorders.schedule_meeting",
        "meeting_recorders.cancel",
        "meetings.archive",
      ]);
      expect(JSON.stringify(smoke.validationRun)).not.toContain("teams.microsoft.com");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("keeps read-only target proof when temp setup is enabled without a meeting URL", async () => {
    const originalFetch = global.fetch;
    const readyReadiness = {
      recorder: recorderWithGates(),
    };
    const setupNeededReadiness = {
      recorder: recorderWithGates({
        calendar: {
          key: "calendar",
          label: "Recording schedule",
          status: "blocked",
          detail: "No upcoming Corgtex scheduled meetings found.",
          checks: [{ key: "recording_schedule", label: "Corgtex recorder schedule", status: "blocked", detail: "Add the meeting to Corgtex." }],
        },
      }),
    };
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      if (String(url) === "https://app.corgtex.com/api/health") {
        return new Response(JSON.stringify({
          release: {
            gitSha: "current-sha",
            drift: { gitSha: false, imageTag: false, version: false, details: [] },
            configured: { gitSha: "current-sha" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init.body));
      const toolName = body.params.name;
      calls.push({ toolName, args: body.params.arguments });
      if (toolName === "list_customers") {
        return controlPlaneToolResponse([
          {
            id: "dep-ready",
            label: "Ready Test Deployment",
            customerSlug: "ready-recorder-test",
            customDomain: "ready-recorder.example.test",
            supportConnectorStatus: "connected",
          },
          {
            id: "dep-needs-setup",
            label: "Setup Needed Test Deployment",
            customerSlug: "setup-recorder-test",
            customDomain: "setup-recorder.example.test",
            supportConnectorStatus: "connected",
          },
        ]);
      }
      if (toolName === "check_meeting_operations_readiness") {
        return controlPlaneToolResponse(
          body.params.arguments.deploymentId === "dep-ready"
            ? readyReadiness
            : setupNeededReadiness,
        );
      }
      throw new Error(`Unexpected fetch ${toolName}`);
    });

    try {
      const smoke = new RecorderReadinessProductionSmoke({
        baseUrl: "https://app.corgtex.com",
        controlPlaneUrl: "https://ops.example",
        outDir: ".artifacts/test-recorder-lazy-temp-url",
        targets: ["ready-recorder.example.test", "setup-recorder.example.test"],
        expectedGitSha: "current-sha",
        prNumbers: [757],
        controlPlaneToken: "token",
        tempMeetingSetup: normalizeTempMeetingSetup({
          enabled: true,
          joinAt: "2099-07-20T06:30:00.000Z",
        }),
      });

      await smoke.run();

      expect(smoke.validationRun.status).toBe("blocked");
      expect(smoke.validationRun.results).toEqual([
        expect.objectContaining({
          tenant: expect.objectContaining({ label: "Ready Test Deployment" }),
          result: "pass",
          blocker: null,
        }),
        expect.objectContaining({
          tenant: expect.objectContaining({ label: "Setup Needed Test Deployment" }),
          result: "blocked",
          blocker: "RECORDER_READINESS_SMOKE_TEMP_MEETING_URL is required when temporary recorder setup is needed.",
        }),
      ]);
      expect(smoke.details[1]).toMatchObject({
        target: "setup-recorder.example.test",
        result: "blocked",
        blocker: "RECORDER_READINESS_SMOKE_TEMP_MEETING_URL is required when temporary recorder setup is needed.",
        readiness: {
          recorder: {
            gates: {
              calendar: {
                status: "blocked",
                detail: "No upcoming Corgtex scheduled meetings found.",
              },
            },
          },
        },
      });
      expect(smoke.validationRun.results[1].evidence.map((item) => item.type)).toEqual([
        "deployment",
        "readiness-gates",
        "runtime-error",
      ]);
      expect(calls.map((call) => call.toolName)).toEqual([
        "list_customers",
        "check_meeting_operations_readiness",
        "check_meeting_operations_readiness",
      ]);
      expect(calls.some((call) => call.toolName === "run_customer_support_operation")).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
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
