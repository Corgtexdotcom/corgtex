#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { healthPayloadMismatch, healthReleaseValidationMismatch } from "./railway-smoke.mjs";

export function azureOnlyObservationManifest(health, expectedReleaseSha) {
  if (!/^[a-f0-9]{40}$/.test(expectedReleaseSha)) {
    throw new Error("Expected release SHA must be a full lowercase Git SHA.");
  }

  const mismatch = healthPayloadMismatch({ ok: true }, health)
    ?? healthReleaseValidationMismatch(health, expectedReleaseSha, { requireConfiguredMatch: true });
  if (mismatch) throw new Error(mismatch);
  if (health.release?.runtime?.gitSha !== expectedReleaseSha || health.release.runtime.evidence !== "baked") {
    throw new Error("Azure self-serve health does not prove the expected baked runtime SHA.");
  }

  return {
    gitSha: expectedReleaseSha,
    targetManifests: [{
      target: "azure-selfserve",
      gitSha: expectedReleaseSha,
      imageTag: health.release.imageTag || `sha-${expectedReleaseSha}`,
      releaseVersion: health.release.version || `main-${expectedReleaseSha.slice(0, 12)}`,
    }],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const health = JSON.parse(readFileSync(0, "utf8"));
  console.log(JSON.stringify(azureOnlyObservationManifest(health, process.argv[2])));
}
