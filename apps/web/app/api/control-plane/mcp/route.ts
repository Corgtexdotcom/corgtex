import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  configureControlPlaneMeetingRecorderIntegration,
  fetchCustomerSupportSnapshot,
  getControlPlaneAiGovernanceStatus,
  getControlPlaneContextHealth,
  getControlPlaneCustomer,
  getControlPlaneIntegrationStatus,
  getControlPlaneReleaseStatus,
  listControlPlaneCustomers,
  probeControlPlaneCustomerHealth,
  requireControlPlaneAccess,
  requireControlPlaneScope,
  runControlPlaneContextOperation,
  runControlPlaneReleaseOperation,
  runCustomerSupportOperation,
} from "@corgtex/domain";
import type { SupportAction } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

const tools = [
  {
    name: "list_customers",
    description: "List customer instances registered in the Corgtex control plane.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_customer_status",
    description: "Get one customer instance, recent support operations, and hosted-instance events.",
    inputSchema: { type: "object", properties: { instanceId: { type: "string" } }, required: ["instanceId"] },
  },
  {
    name: "refresh_customer_snapshot",
    description: "Fetch a live support snapshot from the customer instance through the support connector.",
    inputSchema: { type: "object", properties: { instanceId: { type: "string" } }, required: ["instanceId"] },
  },
  {
    name: "list_customer_integrations",
    description: "Get customer integration entitlement and readiness status.",
    inputSchema: { type: "object", properties: { instanceId: { type: "string" } }, required: ["instanceId"] },
  },
  {
    name: "get_context_health",
    description: "Get governed context and brain health for a customer instance.",
    inputSchema: { type: "object", properties: { instanceId: { type: "string" } }, required: ["instanceId"] },
  },
  {
    name: "get_ai_governance_status",
    description: "Get agent, model usage, approval, and failed-job governance status.",
    inputSchema: { type: "object", properties: { instanceId: { type: "string" } }, required: ["instanceId"] },
  },
  {
    name: "get_release_status",
    description: "Get release, provisioning, health, and rollback-readiness status.",
    inputSchema: { type: "object", properties: { instanceId: { type: "string" } }, required: ["instanceId"] },
  },
  {
    name: "configure_customer_integration",
    description: "Configure an audited customer integration entitlement. V1 supports meeting_recorders.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
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
      required: ["instanceId", "integrationKey", "reason"],
    },
  },
  {
    name: "run_context_sync",
    description: "Queue an audited context sync for all active sources or one source.",
    inputSchema: {
      type: "object",
      properties: { instanceId: { type: "string" }, sourceId: { type: "string" }, reason: { type: "string" } },
      required: ["instanceId", "reason"],
    },
  },
  {
    name: "probe_customer_health",
    description: "Probe customer runtime health and record central release/health evidence.",
    inputSchema: { type: "object", properties: { instanceId: { type: "string" }, reason: { type: "string" } }, required: ["instanceId", "reason"] },
  },
  {
    name: "prepare_release_upgrade",
    description: "Record audited target release readiness evidence without deploying.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        targetReleaseImageTag: { type: "string" },
        targetReleaseVersion: { type: "string" },
        reason: { type: "string" },
      },
      required: ["instanceId", "targetReleaseImageTag", "reason"],
    },
  },
  {
    name: "run_customer_support_operation",
    description: "Run an audited support action against a customer instance.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        action: { type: "string" },
        reason: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["instanceId", "action"],
    },
  },
];

const toolScopes: Record<string, string> = {
  list_customers: "control-plane:read",
  get_customer_status: "control-plane:read",
  list_customer_integrations: "control-plane:read",
  get_context_health: "control-plane:read",
  get_ai_governance_status: "control-plane:read",
  get_release_status: "control-plane:read",
  refresh_customer_snapshot: "control-plane:support:write",
  configure_customer_integration: "control-plane:integrations:write",
  run_context_sync: "control-plane:context:write",
  probe_customer_health: "control-plane:releases:write",
  prepare_release_upgrade: "control-plane:releases:write",
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

export async function GET() {
  return NextResponse.json({
    name: "corgtex-control-plane-mcp",
    version: "1.0.0",
    description: "Corgtex control-plane MCP endpoint for platform support operations.",
    capabilities: { tools: true },
  });
}

export async function POST(request: NextRequest) {
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
      return rpcResult(id, textContent(await listControlPlaneCustomers(actor)));
    }
    if (name === "get_customer_status") {
      return rpcResult(id, textContent(await getControlPlaneCustomer(actor, String(args.instanceId ?? ""))));
    }
    if (name === "refresh_customer_snapshot") {
      return rpcResult(id, textContent(await fetchCustomerSupportSnapshot(actor, String(args.instanceId ?? ""))));
    }
    if (name === "list_customer_integrations") {
      return rpcResult(id, textContent(await getControlPlaneIntegrationStatus(actor, String(args.instanceId ?? ""))));
    }
    if (name === "get_context_health") {
      return rpcResult(id, textContent(await getControlPlaneContextHealth(actor, String(args.instanceId ?? ""))));
    }
    if (name === "get_ai_governance_status") {
      return rpcResult(id, textContent(await getControlPlaneAiGovernanceStatus(actor, String(args.instanceId ?? ""))));
    }
    if (name === "get_release_status") {
      return rpcResult(id, textContent(await getControlPlaneReleaseStatus(actor, String(args.instanceId ?? ""))));
    }
    if (name === "configure_customer_integration") {
      if (argString(args, "integrationKey") !== "meeting_recorders") {
        return rpcError(id, -32602, "Unsupported integration key.");
      }
      return rpcResult(id, textContent(await configureControlPlaneMeetingRecorderIntegration(actor, {
        instanceId: argString(args, "instanceId"),
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
        instanceId: argString(args, "instanceId"),
        operation: sourceId ? "sync_source" : "sync_all",
        sourceId,
        reason: argString(args, "reason"),
      })));
    }
    if (name === "probe_customer_health") {
      return rpcResult(id, textContent(await probeControlPlaneCustomerHealth(actor, {
        instanceId: argString(args, "instanceId"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "prepare_release_upgrade") {
      return rpcResult(id, textContent(await runControlPlaneReleaseOperation(actor, {
        instanceId: argString(args, "instanceId"),
        operation: "prepare_upgrade",
        targetReleaseImageTag: argString(args, "targetReleaseImageTag"),
        targetReleaseVersion: argOptionalString(args, "targetReleaseVersion"),
        reason: argString(args, "reason"),
      })));
    }
    if (name === "run_customer_support_operation") {
      const operation = await runCustomerSupportOperation(actor, {
        instanceId: argString(args, "instanceId"),
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
