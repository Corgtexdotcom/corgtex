import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  configureControlPlaneMeetingRecorderIntegration,
  createControlPlaneCustomerMember,
  deployLatestControlPlaneRelease,
  enqueueControlPlaneFleetSnapshots,
  enqueueControlPlaneDeployLatestRollout,
  fetchCustomerSupportSnapshot,
  getControlPlaneDeployLatestPreflight,
  getControlPlaneAiGovernanceStatus,
  getControlPlaneContextHealth,
  getControlPlaneDeployment,
  getControlPlaneIntegrationStatus,
  getControlPlaneReleaseStatus,
  listControlPlaneCustomerMembers,
  listControlPlaneDeployments,
  listControlPlaneFeatureFlags,
  listControlPlaneReleaseRolloutJobs,
  probeControlPlaneDeploymentHealth,
  requireControlPlaneAccess,
  requireControlPlaneScope,
  refreshControlPlaneFleetSnapshots,
  resendControlPlaneCustomerMemberAccessLink,
  runControlPlaneContextOperation,
  runControlPlaneReleaseOperation,
  runCustomerSupportOperation,
  setControlPlaneFeatureFlag,
  updateControlPlaneCustomerMemberStatus,
} from "@corgtex/domain";
import type { SupportAction } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

const tools = [
  {
    name: "list_customers",
    description: "List customer deployments registered in the Corgtex control plane.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_customer_deployment_status",
    description: "Get one customer deployment, recent support operations, and customer-deployment events.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "refresh_customer_deployment_snapshot",
    description: "Fetch a live support snapshot from the customer deployment through the support connector.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "list_customer_integrations",
    description: "Get customer integration entitlement and readiness status.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "get_context_health",
    description: "Get governed context and brain health for a customer deployment.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "get_ai_governance_status",
    description: "Get agent, model usage, approval, and failed-job governance status.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "get_release_status",
    description: "Get release, provisioning, health, and rollback-readiness status.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "get_deploy_latest_preflight",
    description: "Check whether one customer can deploy the configured latest release target.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "list_customer_members",
    description: "List all active and inactive members for a customer deployment.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "create_customer_member",
    description: "Create a customer member and email a setup link. Does not expose or set raw passwords.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        email: { type: "string" },
        displayName: { type: "string" },
        role: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "email", "role", "reason"],
    },
  },
  {
    name: "resend_customer_member_access_link",
    description: "Email a fresh setup/reset access link for a customer member.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        memberId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "memberId", "reason"],
    },
  },
  {
    name: "update_customer_member_status",
    description: "Deactivate or reactivate a customer member.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        memberId: { type: "string" },
        isActive: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "memberId", "isActive", "reason"],
    },
  },
  {
    name: "list_customer_feature_flags",
    description: "List customer workspace feature flags, defaults, sources, and audit context.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" } }, required: ["deploymentId"] },
  },
  {
    name: "set_customer_feature_flag",
    description: "Enable or disable a customer workspace feature flag.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        flag: { type: "string" },
        enabled: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "flag", "enabled", "reason"],
    },
  },
  {
    name: "configure_customer_integration",
    description: "Configure an audited customer integration entitlement. V1 supports meeting_recorders.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        integrationKey: { type: "string" },
        reason: { type: "string" },
        entitlementEnabled: { type: "boolean" },
        enabled: { type: "boolean" },
        autoRecordEnabled: { type: "boolean" },
        defaultProvider: { type: "string" },
        fallbackProvider: { type: "string" },
        monthlyMinuteCap: { type: "number" },
        botName: { type: "string" },
        entryMessage: { type: "string" },
      },
      required: ["deploymentId", "integrationKey", "reason"],
    },
  },
  {
    name: "run_context_sync",
    description: "Queue an audited context sync for all active sources or one source.",
    inputSchema: {
      type: "object",
      properties: { deploymentId: { type: "string" }, sourceId: { type: "string" }, reason: { type: "string" } },
      required: ["deploymentId", "reason"],
    },
  },
  {
    name: "probe_customer_deployment_health",
    description: "Probe customer runtime health and record central release/health evidence.",
    inputSchema: { type: "object", properties: { deploymentId: { type: "string" }, reason: { type: "string" } }, required: ["deploymentId", "reason"] },
  },
  {
    name: "refresh_fleet_snapshots",
    description: "Refresh cached fleet snapshots for one customer deployment without relying on list-page fanout.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        snapshotKinds: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
      },
      required: ["deploymentId", "reason"],
    },
  },
  {
    name: "enqueue_fleet_snapshot_jobs",
    description: "Queue bounded background fleet snapshot jobs for one deployment or the next due batch.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        snapshotKinds: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
  {
    name: "prepare_release_upgrade",
    description: "Record audited target release readiness evidence without deploying.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        targetReleaseImageTag: { type: "string" },
        targetReleaseVersion: { type: "string" },
        reason: { type: "string" },
      },
      required: ["deploymentId", "targetReleaseImageTag", "reason"],
    },
  },
  {
    name: "deploy_latest_release",
    description: "Deploy the configured latest release to one customer after preflight checks.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        reason: { type: "string" },
        force: { type: "boolean" },
      },
      required: ["deploymentId", "reason"],
    },
  },
  {
    name: "deploy_latest_release_bulk",
    description: "Queue deploy-latest rollout jobs for selected or eligible customer deployments.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentIds: { type: "array", items: { type: "string" } },
        allEligible: { type: "boolean" },
        includeUnhealthy: { type: "boolean" },
        reason: { type: "string" },
        limit: { type: "number" },
      },
      required: ["reason"],
    },
  },
  {
    name: "get_rollout_status",
    description: "List recent deploy-latest rollout jobs and statuses.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        take: { type: "number" },
      },
    },
  },
  {
    name: "run_customer_support_operation",
    description: "Run an audited support action against a customer deployment.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        action: { type: "string" },
        reason: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["deploymentId", "action"],
    },
  },
];

const toolScopes: Record<string, string> = {
  list_customers: "control-plane:read",
  get_customer_deployment_status: "control-plane:read",
  list_customer_integrations: "control-plane:read",
  get_context_health: "control-plane:read",
  get_ai_governance_status: "control-plane:read",
  get_release_status: "control-plane:read",
  get_deploy_latest_preflight: "control-plane:read",
  list_customer_members: "control-plane:read",
  create_customer_member: "control-plane:access:write",
  resend_customer_member_access_link: "control-plane:access:write",
  update_customer_member_status: "control-plane:access:write",
  list_customer_feature_flags: "control-plane:read",
  set_customer_feature_flag: "control-plane:features:write",
  refresh_customer_deployment_snapshot: "control-plane:support:write",
  configure_customer_integration: "control-plane:integrations:write",
  run_context_sync: "control-plane:context:write",
  probe_customer_deployment_health: "control-plane:releases:write",
  refresh_fleet_snapshots: "control-plane:fleet:write",
  enqueue_fleet_snapshot_jobs: "control-plane:fleet:write",
  prepare_release_upgrade: "control-plane:releases:write",
  deploy_latest_release: "control-plane:releases:write",
  deploy_latest_release_bulk: "control-plane:releases:write",
  get_rollout_status: "control-plane:read",
  run_customer_support_operation: "control-plane:support:write",
};

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status: code < 0 ? 200 : code });
}

function textContent(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function objectArgs(args: unknown) {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function argString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function argOptionalString(args: Record<string, unknown>, key: string) {
  const value = argString(args, key).trim();
  return value.length > 0 ? value : null;
}

function argBoolean(args: Record<string, unknown>, key: string, fallback: boolean) {
  return typeof args[key] === "boolean" ? args[key] as boolean : fallback;
}

function argNumber(args: Record<string, unknown>, key: string, fallback: number) {
  return typeof args[key] === "number" && Number.isFinite(args[key]) ? args[key] as number : fallback;
}

function argStringArray(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

export async function GET() {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  return NextResponse.json({
    name: "corgtex-control-plane-mcp",
    version: "1.0.0",
    description: "Corgtex control-plane MCP endpoint for platform support operations.",
    capabilities: { tools: true },
  });
}

export async function POST(request: NextRequest) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    await requireControlPlaneAccess(actor);
    const body = await request.json();
    const id = body?.id ?? null;

    if (body?.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "corgtex-control-plane", version: "1.0.0" },
        capabilities: { tools: {} },
      });
    }

    if (body?.method === "tools/list") {
      return rpcResult(id, { tools });
    }

    if (body?.method !== "tools/call") {
      return rpcError(id, -32601, "Unsupported MCP method.");
    }

    const name = String(body.params?.name ?? "");
    const args = objectArgs(body.params?.arguments);
    if (toolScopes[name]) {
      requireControlPlaneScope(actor, toolScopes[name]);
    }

    if (name === "list_customers") {
      return rpcResult(id, textContent(await listControlPlaneDeployments(actor)));
    }
    if (name === "get_customer_deployment_status") {
      return rpcResult(id, textContent(await getControlPlaneDeployment(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "refresh_customer_deployment_snapshot") {
      return rpcResult(id, textContent(await fetchCustomerSupportSnapshot(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "list_customer_integrations") {
      return rpcResult(id, textContent(await getControlPlaneIntegrationStatus(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "get_context_health") {
      return rpcResult(id, textContent(await getControlPlaneContextHealth(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "get_ai_governance_status") {
      return rpcResult(id, textContent(await getControlPlaneAiGovernanceStatus(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "get_release_status") {
      return rpcResult(id, textContent(await getControlPlaneReleaseStatus(actor, String(args.deploymentId ?? ""))));
    }
    if (name === "get_deploy_latest_preflight") {
      return rpcResult(id, textContent(await getControlPlaneDeployLatestPreflight(actor, argString(args, "deploymentId"))));
    }
    if (name === "list_customer_members") {
      return rpcResult(id, textContent(await listControlPlaneCustomerMembers(actor, argString(args, "deploymentId"))));
    }
    if (name === "create_customer_member") {
      return rpcResult(id, textContent(await createControlPlaneCustomerMember(actor, {
        deploymentId: argString(args, "deploymentId"),
        email: argString(args, "email"),
        displayName: argOptionalString(args, "displayName"),
        role: argString(args, "role") || "CONTRIBUTOR",
        reason: argString(args, "reason"),
      })));
    }
    if (name === "resend_customer_member_access_link") {
      return rpcResult(id, textContent(await resendControlPlaneCustomerMemberAccessLink(actor, {
        deploymentId: argString(args, "deploymentId"),
        memberId: argString(args, "memberId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "update_customer_member_status") {
      if (typeof args.isActive !== "boolean") {
        return rpcError(id, -32602, "isActive must be a boolean.");
      }
      return rpcResult(id, textContent(await updateControlPlaneCustomerMemberStatus(actor, {
        deploymentId: argString(args, "deploymentId"),
        memberId: argString(args, "memberId"),
        isActive: args.isActive,
        reason: argString(args, "reason"),
      })));
    }
    if (name === "list_customer_feature_flags") {
      return rpcResult(id, textContent(await listControlPlaneFeatureFlags(actor, argString(args, "deploymentId"))));
    }
    if (name === "set_customer_feature_flag") {
      if (typeof args.enabled !== "boolean") {
        return rpcError(id, -32602, "enabled must be a boolean.");
      }
      return rpcResult(id, textContent(await setControlPlaneFeatureFlag(actor, {
        deploymentId: argString(args, "deploymentId"),
        flag: argString(args, "flag"),
        enabled: args.enabled,
        reason: argString(args, "reason"),
      })));
    }
    if (name === "configure_customer_integration") {
      if (argString(args, "integrationKey") !== "meeting_recorders") {
        return rpcError(id, -32602, "Unsupported integration key.");
      }
      return rpcResult(id, textContent(await configureControlPlaneMeetingRecorderIntegration(actor, {
        deploymentId: argString(args, "deploymentId"),
        entitlementEnabled: argBoolean(args, "entitlementEnabled", true),
        enabled: argBoolean(args, "enabled", true),
        autoRecordEnabled: argBoolean(args, "autoRecordEnabled", false),
        defaultProvider: argString(args, "defaultProvider") || "RECALL_AI",
        fallbackProvider: argOptionalString(args, "fallbackProvider"),
        monthlyMinuteCap: argNumber(args, "monthlyMinuteCap", 6_000),
        botName: argOptionalString(args, "botName"),
        entryMessage: argOptionalString(args, "entryMessage"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "run_context_sync") {
      const sourceId = argOptionalString(args, "sourceId");
      return rpcResult(id, textContent(await runControlPlaneContextOperation(actor, {
        deploymentId: argString(args, "deploymentId"),
        operation: sourceId ? "sync_source" : "sync_all",
        sourceId,
        reason: argString(args, "reason"),
      })));
    }
    if (name === "probe_customer_deployment_health") {
      return rpcResult(id, textContent(await probeControlPlaneDeploymentHealth(actor, {
        deploymentId: argString(args, "deploymentId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "refresh_fleet_snapshots") {
      return rpcResult(id, textContent(await refreshControlPlaneFleetSnapshots(actor, {
        deploymentId: argString(args, "deploymentId"),
        snapshotKinds: argStringArray(args, "snapshotKinds"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "enqueue_fleet_snapshot_jobs") {
      return rpcResult(id, textContent(await enqueueControlPlaneFleetSnapshots(actor, {
        deploymentId: argOptionalString(args, "deploymentId"),
        snapshotKinds: argStringArray(args, "snapshotKinds"),
        limit: argNumber(args, "limit", 100),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "prepare_release_upgrade") {
      return rpcResult(id, textContent(await runControlPlaneReleaseOperation(actor, {
        deploymentId: argString(args, "deploymentId"),
        operation: "prepare_upgrade",
        targetReleaseImageTag: argString(args, "targetReleaseImageTag"),
        targetReleaseVersion: argOptionalString(args, "targetReleaseVersion"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "deploy_latest_release") {
      return rpcResult(id, textContent(await deployLatestControlPlaneRelease(actor, {
        deploymentId: argString(args, "deploymentId"),
        reason: argString(args, "reason"),
        force: argBoolean(args, "force", false),
      })));
    }
    if (name === "deploy_latest_release_bulk") {
      return rpcResult(id, textContent(await enqueueControlPlaneDeployLatestRollout(actor, {
        deploymentIds: argStringArray(args, "deploymentIds"),
        allEligible: argBoolean(args, "allEligible", false),
        includeUnhealthy: argBoolean(args, "includeUnhealthy", false),
        limit: argNumber(args, "limit", 100),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "get_rollout_status") {
      return rpcResult(id, textContent(await listControlPlaneReleaseRolloutJobs(actor, {
        deploymentId: argOptionalString(args, "deploymentId"),
        take: argNumber(args, "take", 50),
      })));
    }
    if (name === "run_customer_support_operation") {
      const operation = await runCustomerSupportOperation(actor, {
        deploymentId: argString(args, "deploymentId"),
        action: argString(args, "action") as SupportAction,
        reason: typeof args.reason === "string" ? args.reason : null,
        arguments: objectArgs(args.arguments),
      });
      return rpcResult(id, textContent(operation));
    }

    return rpcError(id, -32602, "Unknown control-plane tool.");
  } catch (error) {
    return handleRouteError(error);
  }
}
