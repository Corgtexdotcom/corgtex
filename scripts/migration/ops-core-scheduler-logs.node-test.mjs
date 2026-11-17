import assert from "node:assert/strict";
import test from "node:test";
import { createOpsCoreSchedulerProofReader } from "./ops-core-scheduler-logs.mjs";

const id = "00000000-0000-4000-8000-000000000001", root = `/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.App`;
const health = { environmentResourceId: root + "/managedEnvironments/env", workspaceId: id, location: "eastus",
  worker: { appId: root + "/containerApps/worker", origin: "https://worker.internal.cobalt.eastus.azurecontainerapps.io" } };
const job = "fixture-scheduler", jobId = root + "/jobs/" + job, run = job + "-abc1234", replica = run + "-a1b2c";
const image = "fixture.azurecr.io/corgtex/worker@sha256:" + "a".repeat(64);
const template = { containers: [{ name: "scheduler", image }] };
const input = { jobId, template, signal: new AbortController().signal, execution: { id: jobId + "/executions/" + run, name: run,
  properties: { template, status: "Succeeded", startTime: "2026-10-01T10:00:00Z", endTime: "2026-10-01T10:00:30Z" } } };
const receipt = { event: "scheduler_complete", proofNonce: "abc" };
const log = JSON.stringify({ level: "info", msg: JSON.stringify(receipt) });
const names = ["ContainerGroupName_s", "ContainerGroupId_g", "ContainerName_s", "ContainerId_g", "ContainerImage_s", "completions", "frames"];
function fixture({ change, changeEnv, direct, emptyFirst } = {}) {
  let queries = 0;
  const read = createOpsCoreSchedulerProofReader({ health, schedulerJobName: job, wait: async () => {},
    exec: async (_name, args) => {
      if (args.includes("replica")) return { stdout: JSON.stringify([{ name: replica }]) };
      if (direct) return { stdout: "2026-10-01T10:00:10Z stdout F " + log };
      throw Error("404: collected stream");
    },
    transport: async ({ method, path, body }) => {
      if (method === "GET") {
        assert.equal(path, health.environmentResourceId + "?api-version=2025-07-01");
        const env = { id: health.environmentResourceId, properties: { provisioningState: "Succeeded", defaultDomain: "cobalt.eastus.azurecontainerapps.io",
          appLogsConfiguration: { destination: "log-analytics", logAnalyticsConfiguration: { customerId: id } } } };
        changeEnv?.(env); return { status: 200, body: env };
      }
      assert.equal(path, "/v1/workspaces/" + id + "/query");
      assert.equal(body.timespan, "2026-10-01T10:00:00.000Z/2026-10-01T10:00:30.999Z");
      for (const part of ["ContainerAppConsoleLogs_CL", id, "EnvironmentName_s == 'cobalt'", "ContainerJobName_s == '" + job + "'",
        "startswith_cs '" + run + "-'", "ContainerName_s == 'scheduler'"]) assert.ok(body.query.includes(part));
      const row = [replica, id, "scheduler", id, image, 1, JSON.stringify([{ stream: "stdout", raw: log }])];
      const tables = [{ name: "PrimaryResult", columns: names.map(name => ({ name })), rows: emptyFirst && !queries ? [] : [row] }];
      queries++; change?.(tables); return { status: 200, body: { tables } };
    } });
  return { read, queries: () => queries };
}
test("collected stream falls back to the retained Azure REST dynamic column and exact replica, waiting for ingestion", async () => {
  const f = fixture({ emptyFirst: true });
  assert.deepEqual(await f.read(input), { jobId, executionId: input.execution.id, replicaName: replica, containerName: "scheduler", receipt });
  assert.equal(f.queries(), 2);
});
test("a direct genuine scheduler frame needs no retained query", async () => {
  const f = fixture({ direct: true }); assert.deepEqual((await f.read(input)).receipt, receipt); assert.equal(f.queries(), 0);
});
for (const [name, change] of [
  ["multiple replicas", t => t[0].rows.push(t[0].rows[0])], ["duplicate receipt", t => { t[0].rows[0][5] = 2; }],
  ["foreign container image", t => { t[0].rows[0][4] += "b"; }], ["foreign execution", t => { t[0].rows[0][0] = job + "-otherxx-a1b2c"; }],
  ["mismatched direct replica", t => { t[0].rows[0][0] = run + "-aaaaa"; }], ["malformed stdout", t => { t[0].rows[0][6] = "private fragment"; }],
  ["stderr", t => { t[0].rows[0][6] = JSON.stringify([{ stream: "stderr", raw: log }]); }],
]) test("retained proof rejects " + name, async () => { await assert.rejects(fixture({ change }).read(input), /UNPROVEN|INVALID/); });
test("the verified environment cannot point to another workspace", async () => {
  const f = fixture({ changeEnv: e => { e.properties.appLogsConfiguration.logAnalyticsConfiguration.customerId += "1"; } });
  await assert.rejects(f.read(input), /UNPROVEN/); assert.equal(f.queries(), 0);
});
