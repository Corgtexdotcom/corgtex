import { test } from "vitest";
import assert from "node:assert/strict";
import { selectInventory, verifyPreflight } from "./managed-azure-single-run-preflight.mjs";

const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const inventoryRef = "123e4567-e89b-42d3-a456-426614174002";
const inventorySha256 = "a".repeat(64);
const releaseSha = "c".repeat(39) + "d";
const binding = { deploymentId, workloadClass: "ACTIVE_CLIENT_PRIMARY", inventoryRef, inventorySha256, releaseSha };
const freeze = { ...binding, validUntil: "2027-01-01T00:00:00Z" };
const dry = { ...binding, status: "DRY_RUN_READY", effects: 0, executionAllowed: true };

test("requires a fresh inventory for the exact target and workload", () => {
  const now = Date.parse("2026-11-24");
  assert.deepEqual(selectInventory(freeze, binding, now), { ref: inventoryRef, sha256: inventorySha256 });
  for (const bad of [
    { deploymentId: inventoryRef }, { workloadClass: "SYNTHETIC_CANARY" },
    { inventoryRef: "fake" }, { inventorySha256: "bad" }, { validUntil: "2026-11-23" },
  ]) assert.throws(() => selectInventory({ ...freeze, ...bad }, binding, now));
});

test("execution requires no effects and exact target, inventory and release SHA", () => {
  assert.doesNotThrow(() => verifyPreflight(dry, binding));
  assert.doesNotThrow(() => verifyPreflight({ ...dry, status: "ALREADY_CURRENT" }, binding));
  for (const bad of [
    { effects: 1 }, { effects: undefined }, { executionAllowed: false }, { status: "SUCCEEDED" },
    { deploymentId: inventoryRef }, { workloadClass: "SYNTHETIC_CANARY" },
    { inventoryRef: deploymentId }, { inventorySha256: "b".repeat(64) }, { releaseSha: "c".repeat(40) },
  ]) assert.throws(() => verifyPreflight({ ...dry, ...bad }, binding));
});
