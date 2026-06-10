#!/usr/bin/env node
import { createHmac } from "node:crypto";
import process from "node:process";

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function required(value, label) {
  if (!value?.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function signature(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

async function main() {
  const secret = required(process.env.SELF_SERVE_REGISTRY_SYNC_SECRET, "SELF_SERVE_REGISTRY_SYNC_SECRET");
  const sourceBaseUrl = trimTrailingSlash(required(
    arg("source-url") || process.env.SELF_SERVE_REGISTRY_SYNC_SOURCE_URL || process.env.APP_URL,
    "source URL",
  ));
  const targetBaseUrl = trimTrailingSlash(required(
    arg("target-url") || process.env.SELF_SERVE_REGISTRY_SYNC_TARGET_URL || process.env.CONTROL_PLANE_URL,
    "target URL",
  ));
  const sourceId = arg("source-id") || process.env.SELF_SERVE_REGISTRY_SYNC_SOURCE_ID || "azure-selfserve";
  const sourceDeploymentId = arg("source-deployment-id") || process.env.SELF_SERVE_REGISTRY_SYNC_SOURCE_DEPLOYMENT_ID || "";
  const take = arg("take") || process.env.SELF_SERVE_REGISTRY_SYNC_TAKE || "100";

  const sourceUrl = new URL("/api/internal/self-serve/registry-sync", sourceBaseUrl);
  sourceUrl.searchParams.set("sourceId", sourceId);
  sourceUrl.searchParams.set("sourceUrl", sourceBaseUrl);
  sourceUrl.searchParams.set("take", take);
  if (sourceDeploymentId) sourceUrl.searchParams.set("sourceDeploymentId", sourceDeploymentId);

  const exportResponse = await fetch(sourceUrl, {
    headers: {
      authorization: `Bearer ${secret}`,
    },
  });
  const payload = await readJson(exportResponse);
  if (!exportResponse.ok) {
    throw new Error(`Registry export failed (${exportResponse.status}): ${JSON.stringify(payload)}`);
  }

  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const importResponse = await fetch(new URL("/api/internal/self-serve/registry-sync", targetBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corgtex-registry-sync-timestamp": timestamp,
      "x-corgtex-registry-sync-signature": `sha256=${signature(secret, timestamp, body)}`,
    },
    body,
  });
  const result = await readJson(importResponse);
  if (!importResponse.ok) {
    throw new Error(`Registry import failed (${importResponse.status}): ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify({
    sourceId,
    itemCount: result.result?.itemCount ?? payload.items?.length ?? 0,
    eventId: result.result?.eventId ?? null,
    syncedAt: result.result?.receivedAt ?? timestamp,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
