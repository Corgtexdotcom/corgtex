import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

// Include the standalone offline contracts in ordinary unit-test discovery.
test("E2E agent runner offline acceptance contracts", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      fileURLToPath(
        new URL("./e2e-agent-tests.node-test.mjs", import.meta.url),
      ),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
