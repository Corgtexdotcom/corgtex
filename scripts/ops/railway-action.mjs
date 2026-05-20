#!/usr/bin/env node

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
  const plan = planRailwayAction(action, service, process.env);
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
    throw new Error(`No Railway deployment found for allowlisted service ${entry.service}.`);
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
  return {
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});