import assert from "node:assert/strict";
import { test } from "node:test";
import { safeDockerFixtureFailure } from "./docker-fixture-command-diagnostic.mjs";

test("reports a neutral timeout category without raw stderr or unsupported attribution", () => {
  const failure = safeDockerFixtureFailure("run", {
    status: 125,
    stderr: "private canary: context deadline exceeded while fetching https://example.invalid/private",
  });
  assert.equal(failure, "LOCAL_DOCKER_RUN_EXIT_125_COMMAND_TIMEOUT");
  assert.equal(failure.includes("private"), false);
  assert.equal(failure.includes("example.invalid"), false);
  assert.equal(safeDockerFixtureFailure("port", { status: 1, stderr: "i/o timeout" }),
    "LOCAL_DOCKER_PORT_EXIT_1_COMMAND_TIMEOUT");
});

test("distinguishes a port command failure from a container start failure", () => {
  assert.equal(safeDockerFixtureFailure("port", { status: 1, stderr: "address already in use" }),
    "LOCAL_DOCKER_PORT_EXIT_1_PORT_CONFLICT");
  assert.equal(safeDockerFixtureFailure("run", { status: 125, stderr: "address already in use" }),
    "LOCAL_DOCKER_RUN_EXIT_125_PORT_CONFLICT");
});

test("bounds unknown commands, spawn errors, statuses, and unrecognized private output", () => {
  assert.equal(safeDockerFixtureFailure("private-command", { status: 999, stderr: "secret canary" }),
    "LOCAL_DOCKER_OTHER_NO_EXIT_UNKNOWN_REDACTED");
  assert.equal(safeDockerFixtureFailure("run", { error: { code: "ETIMEDOUT", message: "secret canary" } }),
    "LOCAL_DOCKER_RUN_SPAWN_TIMEOUT");
  assert.equal(safeDockerFixtureFailure("run", { error: { code: "EPERM", message: "secret canary" } }),
    "LOCAL_DOCKER_RUN_SPAWN_FAILED");
});
