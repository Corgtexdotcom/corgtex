#!/usr/bin/env node

const baseUrl = (process.env.CONTROL_PLANE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const token = process.env.CONTROL_PLANE_AGENT_API_KEY;

function usage() {
  console.error([
    "Usage:",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs list-customers",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs get-customer <instanceId>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs snapshot <instanceId>",
    "  CONTROL_PLANE_AGENT_API_KEY=... node scripts/control-plane.mjs run <instanceId> <action> <reason> '<json-args>'",
  ].join("\n"));
  process.exit(1);
}

async function request(path, options = {}) {
  if (!token) {
    throw new Error("CONTROL_PLANE_AGENT_API_KEY is required.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "authorization": `Bearer cp-${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `Request failed with status ${response.status}.`);
  }
  return body;
}

function parseJsonArg(raw) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON args must be an object.");
  }
  return parsed;
}

const [command, instanceId, action, reason, jsonArgs] = process.argv.slice(2);

try {
  if (command === "list-customers") {
    console.log(JSON.stringify(await request("/api/control-plane/customers"), null, 2));
  } else if (command === "get-customer" && instanceId) {
    console.log(JSON.stringify(await request(`/api/control-plane/customers/${instanceId}`), null, 2));
  } else if (command === "snapshot" && instanceId) {
    console.log(JSON.stringify(await request(`/api/control-plane/customers/${instanceId}/snapshot`, { method: "POST" }), null, 2));
  } else if (command === "run" && instanceId && action) {
    console.log(JSON.stringify(await request(`/api/control-plane/customers/${instanceId}/operations`, {
      method: "POST",
      body: JSON.stringify({
        action,
        reason,
        arguments: parseJsonArg(jsonArgs),
      }),
    }), null, 2));
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
