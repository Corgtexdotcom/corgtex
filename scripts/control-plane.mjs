#!/usr/bin/env node

const baseUrl = (process.env.CONTROL_PLANE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const token = process.env.CONTROL_PLANE_AGENT_API_KEY;

function usage() {
  console.error([
    "Usage:",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs tools",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs list-customers",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs create-client '<json-args>'",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs plan-client-migration '<json-args>'",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs migration-dry-run '<json-args>'",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs execute-client-migration '<json-args>'",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs get-client-migration <migrationRunId>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs finalize-client-migration <migrationRunId> <reason>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs rollback-client-migration <migrationRunId> <reason>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs get-deployment <deploymentId>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs integrations <deploymentId>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs context <deploymentId>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs ai-governance <deploymentId>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs release <deploymentId>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs snapshot <deploymentId>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs sync-context <deploymentId> <reason> [sourceId]",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs configure-recorder <deploymentId> <reason> '<json-config>'",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs prepare-release <deploymentId> <targetImageTag> <reason> [targetVersion]",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs probe-health <deploymentId> <reason>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs post-deploy-probe <deploymentId> <reason> [releaseImageTag] [releaseVersion]",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs record-release <deploymentId> <releaseImageTag> <reason> [releaseVersion]",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs set-feature <deploymentId> <flag> <enabled> <reason> [json-config]",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs run-support <deploymentId> <action> <reason> '<json-args>'",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs call <toolName> '<json-args>'",
  ].join("\n"));
  process.exit(1);
}

function requireValue(value, label) {
  if (!value?.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function parseJsonArg(raw) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON args must be an object.");
  }
  return parsed;
}

function parseBooleanArg(raw, label) {
  const value = requireValue(raw, label).toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false.`);
}

async function requestMcp(method, params = {}) {
  if (!token) {
    throw new Error("CONTROL_PLANE_AGENT_API_KEY is required.");
  }
  const response = await fetch(`${baseUrl}/api/control-plane/mcp`, {
    method: "POST",
    headers: {
      "authorization": `Bearer cp-${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `cli-${Date.now()}`,
      method,
      params,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    throw new Error(body?.error?.message || `MCP request failed with status ${response.status}.`);
  }
  return body.result;
}

async function callTool(name, args = {}) {
  return requestMcp("tools/call", { name, arguments: args });
}

function printable(result) {
  const text = result?.content?.find((item) => typeof item?.text === "string")?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function print(result) {
  console.log(JSON.stringify(printable(result), null, 2));
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "tools") {
    print(await requestMcp("tools/list"));
  } else if (command === "list-customers") {
    print(await callTool("list_customers"));
  } else if (command === "create-client") {
    print(await callTool("create_client", parseJsonArg(args[0])));
  } else if (command === "plan-client-migration") {
    print(await callTool("plan_client_migration", parseJsonArg(args[0])));
  } else if (command === "migration-dry-run") {
    print(await callTool("run_client_migration_dry_run", parseJsonArg(args[0])));
  } else if (command === "execute-client-migration") {
    print(await callTool("execute_client_migration", parseJsonArg(args[0])));
  } else if (command === "get-client-migration") {
    print(await callTool("get_client_migration_status", { migrationRunId: requireValue(args[0], "migrationRunId") }));
  } else if (command === "finalize-client-migration") {
    print(await callTool("finalize_client_migration", {
      migrationRunId: requireValue(args[0], "migrationRunId"),
      reason: requireValue(args[1], "reason"),
    }));
  } else if (command === "rollback-client-migration") {
    print(await callTool("rollback_client_migration", {
      migrationRunId: requireValue(args[0], "migrationRunId"),
      reason: requireValue(args[1], "reason"),
    }));
  } else if (command === "get-deployment") {
    print(await callTool("get_customer_deployment_status", { deploymentId: requireValue(args[0], "deploymentId") }));
  } else if (command === "integrations") {
    print(await callTool("list_customer_integrations", { deploymentId: requireValue(args[0], "deploymentId") }));
  } else if (command === "context") {
    print(await callTool("get_context_health", { deploymentId: requireValue(args[0], "deploymentId") }));
  } else if (command === "ai-governance") {
    print(await callTool("get_ai_governance_status", { deploymentId: requireValue(args[0], "deploymentId") }));
  } else if (command === "release") {
    print(await callTool("get_release_status", { deploymentId: requireValue(args[0], "deploymentId") }));
  } else if (command === "snapshot") {
    print(await callTool("refresh_customer_deployment_snapshot", { deploymentId: requireValue(args[0], "deploymentId") }));
  } else if (command === "sync-context") {
    print(await callTool("run_context_sync", {
      deploymentId: requireValue(args[0], "deploymentId"),
      reason: requireValue(args[1], "reason"),
      sourceId: args[2] || undefined,
    }));
  } else if (command === "configure-recorder") {
    print(await callTool("configure_customer_integration", {
      deploymentId: requireValue(args[0], "deploymentId"),
      reason: requireValue(args[1], "reason"),
      integrationKey: "meeting_recorders",
      ...parseJsonArg(args[2]),
    }));
  } else if (command === "prepare-release") {
    print(await callTool("prepare_release_upgrade", {
      deploymentId: requireValue(args[0], "deploymentId"),
      targetReleaseImageTag: requireValue(args[1], "targetImageTag"),
      reason: requireValue(args[2], "reason"),
      targetReleaseVersion: args[3] || undefined,
    }));
  } else if (command === "probe-health") {
    print(await callTool("probe_customer_deployment_health", {
      deploymentId: requireValue(args[0], "deploymentId"),
      reason: requireValue(args[1], "reason"),
    }));
  } else if (command === "post-deploy-probe") {
    print(await callTool("run_post_deploy_probe", {
      deploymentId: requireValue(args[0], "deploymentId"),
      reason: requireValue(args[1], "reason"),
      releaseImageTag: args[2] || undefined,
      releaseVersion: args[3] || undefined,
    }));
  } else if (command === "record-release") {
    print(await callTool("record_verified_release", {
      deploymentId: requireValue(args[0], "deploymentId"),
      releaseImageTag: requireValue(args[1], "releaseImageTag"),
      reason: requireValue(args[2], "reason"),
      releaseVersion: args[3] || undefined,
    }));
  } else if (command === "set-feature") {
    print(await callTool("set_customer_feature_flag", {
      deploymentId: requireValue(args[0], "deploymentId"),
      flag: requireValue(args[1], "flag"),
      enabled: parseBooleanArg(args[2], "enabled"),
      reason: requireValue(args[3], "reason"),
      ...(args[4] ? { config: parseJsonArg(args[4]) } : {}),
    }));
  } else if (command === "run-support") {
    print(await callTool("run_customer_support_operation", {
      deploymentId: requireValue(args[0], "deploymentId"),
      action: requireValue(args[1], "action"),
      reason: requireValue(args[2], "reason"),
      arguments: parseJsonArg(args[3]),
    }));
  } else if (command === "call") {
    print(await callTool(requireValue(args[0], "toolName"), parseJsonArg(args[1])));
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
