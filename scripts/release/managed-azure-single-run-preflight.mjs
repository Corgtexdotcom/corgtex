import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

export function selectInventory(receipt, expected, now = Date.now()) {
  if (receipt?.deploymentId !== expected.deploymentId
    || receipt?.workloadClass !== expected.workloadClass
    || !UUID.test(receipt?.inventoryRef ?? "")
    || !HASH.test(receipt?.inventorySha256 ?? "")
    || !Number.isFinite(Date.parse(receipt?.validUntil)) || Date.parse(receipt.validUntil) <= now) {
    throw new Error("SINGLE_RUN_INVENTORY_NOT_BOUND");
  }
  return { ref: receipt.inventoryRef, sha256: receipt.inventorySha256 };
}

export function verifyPreflight(receipt, expected) {
  if (receipt?.effects !== 0
    || !["DRY_RUN_READY", "ALREADY_CURRENT"].includes(receipt?.status)
    || receipt.deploymentId !== expected.deploymentId
    || receipt.workloadClass !== expected.workloadClass
    || receipt.inventoryRef !== expected.inventoryRef
    || receipt.inventorySha256 !== expected.inventorySha256
    || !UUID.test(expected.deploymentId ?? "") || !UUID.test(expected.inventoryRef ?? "")
    || !HASH.test(expected.inventorySha256 ?? "") || !SHA.test(expected.releaseSha ?? "")
    || receipt.releaseSha !== expected.releaseSha
    || receipt.executionAllowed !== true) {
    throw new Error("SINGLE_RUN_NO_EFFECT_PREFLIGHT_NOT_BOUND");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, path] = process.argv.slice(2);
  const env = process.env;
  const expected = {
    deploymentId: env.RELEASE_INPUT_DEPLOYMENT_ID, workloadClass: env.RELEASE_INPUT_WORKLOAD_CLASS,
    inventoryRef: env.RELEASE_INPUT_INVENTORY_REF, inventorySha256: env.RELEASE_INPUT_INVENTORY_SHA256,
    releaseSha: env.RELEASE_INPUT_RELEASE_SHA,
  };
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (mode === "inventory") {
    const { ref, sha256 } = selectInventory(receipt, expected);
    appendFileSync(env.GITHUB_OUTPUT, `ref=${ref}\nsha256=${sha256}\n`);
  } else if (mode === "preflight") {
    verifyPreflight(receipt, expected);
  } else {
    throw new Error("SINGLE_RUN_MODE_INVALID");
  }
}
