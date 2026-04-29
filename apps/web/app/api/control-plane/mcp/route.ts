import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  fetchCustomerSupportSnapshot,
  getControlPlaneCustomer,
  listControlPlaneCustomers,
  requireControlPlaneAccess,
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

    const name = body.params?.name;
    const args = body.params?.arguments ?? {};

    if (name === "list_customers") {
      return rpcResult(id, textContent(await listControlPlaneCustomers(actor)));
    }
    if (name === "get_customer_status") {
      return rpcResult(id, textContent(await getControlPlaneCustomer(actor, String(args.instanceId ?? ""))));
    }
    if (name === "refresh_customer_snapshot") {
      return rpcResult(id, textContent(await fetchCustomerSupportSnapshot(actor, String(args.instanceId ?? ""))));
    }
    if (name === "run_customer_support_operation") {
      const operation = await runCustomerSupportOperation(actor, {
        instanceId: String(args.instanceId ?? ""),
        action: String(args.action ?? "") as SupportAction,
        reason: typeof args.reason === "string" ? args.reason : null,
        arguments: args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
          ? args.arguments as Record<string, unknown>
          : {},
      });
      return rpcResult(id, textContent(operation));
    }

    return rpcError(id, -32602, "Unknown control-plane tool.");
  } catch (error) {
    return handleRouteError(error);
  }
}
