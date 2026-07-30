#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  parseArgs,
  planRailwayAction,
} from "./ops-core.mjs";

const DEFAULT_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const args = parseArgs(process.argv.slice(2));
const action = args._[0] ?? "inspect";
const service = args.service ?? args._[1] ?? "web";
const dryRun = Boolean(args["dry-run"]);
const confirm = Boolean(args.confirm);

async function main() {
  const plan = buildRailwayActionPlan(action, service, process.env);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, plan: publicPlan(plan) }, null, 2));
    return;
  }

  if (action !== "inspect" && !confirm) {
    throw new Error("Railway mutations require --confirm.");
  }

  const result = await executeRailwayAction(plan);
  console.log(JSON.stringify({ ok: true, result }, null, 2));
}

async function executeRailwayAction(plan) {
  if (plan.action === "inspect") {
    return latestDeployment(plan.entry);
  }
  if (plan.action === "restart") {
    const deploymentId = plan.deploymentId ?? (await latestDeployment(plan.entry)).id;
    return railwayGraphql(
      `mutation RestartDeployment($deploymentId: String!) {
        deploymentRestart(id: $deploymentId)
      }`,
      { deploymentId },
    );
  }
  if (plan.action === "redeploy-current") {
    return railwayGraphql(
      `mutation RedeployCurrent($serviceId: String!, $environmentId: String!) {
        deploymentId: serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
      }`,
      {
        serviceId: plan.entry.serviceId,
        environmentId: plan.entry.environmentId,
      },
    );
  }
  throw new Error(`Unsupported action: ${plan.action}`);
}

function buildRailwayActionPlan(action, service, env) {
  try {
    return planRailwayAction(action, service, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (action === "inspect" && message.startsWith("Railway service is not allowlisted:")) {
      const controlPlanePlan = planCustomerRailwayInspect(service, env);
      if (controlPlanePlan) return controlPlanePlan;
    }
    throw error;
  }
}

function planCustomerRailwayInspect(service, env) {
  const customer = findCustomerDeployment(service, env);
  if (!customer) return null;

  const cloudProvider = optionalText(customer.cloudProvider)?.toUpperCase();
  if (cloudProvider !== "RAILWAY") {
    throw new Error(`Customer deployment is not Railway-backed: ${service}`);
  }

  if (!isMonitorableCustomerStatus(customer.provisioningStatus, customer.deploymentStatus)) {
    throw new Error(`Customer deployment is not active or degraded: ${service}`);
  }

  const serviceId = optionalText(customer.providerWebServiceId);
  const environmentId = optionalText(customer.providerEnvironmentId);
  if (!serviceId || !environmentId) {
    throw new Error(`Railway customer inspect requires provider web service and environment IDs: ${service}`);
  }

  return {
    action: "inspect",
    service,
    entry: {
      service,
      serviceId,
      environmentId,
      deploymentId: optionalText(customer.providerDeploymentId),
      projectId: optionalText(customer.providerProjectId),
    },
    mutation: "deployments",
    source: "control-plane",
  };
}

function findCustomerDeployment(service, env) {
  const requested = slugSafe(service);
  return loadCustomerDeployments(env).find((customer) => {
    const candidates = [
      customer.customerSlug,
      customer.slug,
      customer.id,
      customer.label,
      customer.customDomain,
    ];
    return candidates.some((candidate) => slugSafe(candidate) === requested);
  }) ?? null;
}

function loadCustomerDeployments(env) {
  const configured = optionalText(env.RAILWAY_OPS_CUSTOMERS_JSON);
  if (configured) {
    const parsed = JSON.parse(configured);
    if (!Array.isArray(parsed)) {
      throw new Error("RAILWAY_OPS_CUSTOMERS_JSON must be an array.");
    }
    return parsed;
  }

  const result = spawnSync(process.execPath, ["scripts/control-plane.mjs", "list-customers"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Control-plane customer discovery failed with exit code ${result.status ?? 1}.`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("Control-plane customer discovery did not return an array.");
  }
  return parsed;
}

function isMonitorableCustomerStatus(provisioningStatus, deploymentStatus) {
  const provisioning = optionalText(provisioningStatus)?.toLowerCase();
  const deployment = optionalText(deploymentStatus)?.toUpperCase();
  if (deployment && !["ACTIVE", "DEGRADED"].includes(deployment)) return false;
  if (!provisioning) return true;
  return provisioning === "active" || provisioning === "degraded";
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function slugSafe(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function latestDeployment(entry) {
  const result = await railwayGraphql(
    `query LatestDeployment($serviceId: String!, $environmentId: String!) {
      deployments(first: 1, input: { serviceId: $serviceId, environmentId: $environmentId }) {
        edges {
          node {
            id
            status
            createdAt
          }
        }
      }
    }`,
    {
      serviceId: entry.serviceId,
      environmentId: entry.environmentId,
    },
  );
  const deployment = result.deployments?.edges?.[0]?.node;
  if (!deployment?.id) {
    throw new Error(`No Railway deployment found for service ${entry.service}.`);
  }
  return deployment;
}

async function railwayGraphql(query, variables) {
  const token = process.env.RAILWAY_API_TOKEN?.trim();
  if (!token) throw new Error("RAILWAY_API_TOKEN is required.");
  const response = await fetch(process.env.RAILWAY_GRAPHQL_ENDPOINT || DEFAULT_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const responseText = await response.text();
  const body = parseJsonResponse(responseText);
  if (!body) {
    throw new Error(formatRailwayHttpError(response, responseText));
  }
  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.map((error) => error.message).join("; ") || `Railway API failed: ${response.status}`);
  }
  return body.data;
}

function parseJsonResponse(responseText) {
  try {
    return JSON.parse(responseText);
  } catch {
    return null;
  }
}

function formatRailwayHttpError(response, responseText) {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return `Railway API returned non-JSON response: HTTP ${response.status}${statusText}; body: ${summarizeResponse(responseText)}`;
}

function summarizeResponse(responseText) {
  const normalized = String(responseText || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "<empty>";
  return normalized.slice(0, 240);
}

function publicPlan(plan) {
  const output = {
    action: plan.action,
    service: plan.service,
    mutation: plan.mutation,
    requiresLatestDeploymentLookup: Boolean(plan.requiresLatestDeploymentLookup),
    entry: {
      service: plan.entry.service,
      serviceId: plan.entry.serviceId,
      environmentId: plan.entry.environmentId,
      hasDeploymentId: Boolean(plan.entry.deploymentId),
      hasProjectId: Boolean(plan.entry.projectId),
    },
  };
  if (plan.source) {
    output.source = plan.source;
  }
  return output;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
