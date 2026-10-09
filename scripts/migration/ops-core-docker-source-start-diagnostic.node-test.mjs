import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { runDockerSourceStart } from "./docker-source-start-diagnostic.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

async function failedStart(chunks, exitStatus = 1) {
  const child = fakeChild();
  const reports = [];
  const promise = runDockerSourceStart(
    ["run", "--env", "POSTGRES_PASSWORD=never-print-this", "public-image@sha256:example"],
    {
      spawnCommand(command, args, options) {
        assert.equal(command, "docker");
        assert.equal(args[0], "run");
        assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
        return child;
      },
      report: (value) => reports.push(value),
    },
  );
  for (const chunk of chunks) child.stderr.write(chunk);
  child.emit("close", exitStatus);
  await assert.rejects(promise, { code: "SOURCE_CONTAINER_START_FAILED" });
  assert.equal(reports.length, 1);
  return { child, report: reports[0] };
}

test("reports a bounded safe Docker Hub rate-limit clue without command arguments or secrets", async () => {
  const secret = "postgresql://admin:private-password@db.example.invalid/db";
  const prefix = `POSTGRES_PASSWORD=never-print-this TOKEN=private-token ${secret} `.repeat(100);
  const stderr = "Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit.";
  const { report } = await failedStart([prefix, stderr]);

  assert.equal(report.error, "SOURCE_CONTAINER_START_FAILED");
  assert.equal(report.command, "RUN");
  assert.equal(report.category, "DOCKER_HUB_RATE_LIMIT");
  assert.equal(report.exitStatus, 1);
  assert.deepEqual(Object.keys(report).sort(), ["category", "command", "error", "event", "exitStatus"]);
  const serialized = JSON.stringify(report);
  for (const privateValue of ["never-print-this", "private-token", "private-password", "db.example.invalid", "POSTGRES_PASSWORD"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("classifies generic timeouts neutrally and host failures using fixed categories", async () => {
  const cases = [
    ["Get https://auth.docker.io/token?account=user&token=private: context deadline exceeded", "COMMAND_TIMEOUT"],
    ["Docker engine i/o timeout; password=private", "COMMAND_TIMEOUT"],
    ["Error response from daemon: no space left on device; password=private", "NO_SPACE"],
    ["Bind for 127.0.0.1:1234 failed: port is already allocated; password=private", "PORT_CONFLICT"],
    ["Cannot connect to the Docker daemon; password=private", "DAEMON_UNAVAILABLE"],
    ["manifest unknown: image reference private", "MANIFEST_UNAVAILABLE"],
  ];
  for (const [stderr, expectedCategory] of cases) {
    const { report } = await failedStart([stderr]);
    assert.equal(report.category, expectedCategory);
    assert.equal(JSON.stringify(report).includes("private"), false);
  }
});

test("unknown stderr and spawn errors stay redacted, and only one diagnostic is reported", async () => {
  const { report } = await failedStart(["credential=super-secret; unexpected failure"]);
  assert.equal(report.category, "UNKNOWN_REDACTED");
  assert.equal(JSON.stringify(report).includes("super-secret"), false);
  const authFailure = await failedStart(["Get https://auth.docker.io/token: unauthorized; token=super-secret"]);
  assert.equal(authFailure.report.category, "UNKNOWN_REDACTED");
  assert.equal(JSON.stringify(authFailure.report).includes("super-secret"), false);

  const child = fakeChild();
  const reports = [];
  const promise = runDockerSourceStart(["run"], {
    spawnCommand: () => child,
    report: (value) => reports.push(value),
  });
  child.emit("error", new Error("token=super-secret"));
  child.emit("close", 1);
  await assert.rejects(promise, { code: "SOURCE_CONTAINER_START_FAILED" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].category, "SPAWN_FAILED");
  assert.equal(JSON.stringify(reports[0]).includes("super-secret"), false);
});

test("keeps the existing excessive-stderr kill boundary and emits nothing on success", async () => {
  const { child, report } = await failedStart([Buffer.alloc(1024 * 1024 + 1, "x")], null);
  assert.deepEqual(child.kills, ["SIGKILL"]);
  assert.equal(report.category, "UNKNOWN_REDACTED");
  assert.deepEqual(Object.keys(report).sort(), ["category", "command", "error", "event", "exitStatus"]);

  const successfulChild = fakeChild();
  const reports = [];
  const promise = runDockerSourceStart(["run"], {
    spawnCommand: () => successfulChild,
    report: (value) => reports.push(value),
  });
  successfulChild.emit("close", 0);
  await promise;
  assert.deepEqual(reports, []);
});
