import { setTimeout as delay } from "node:timers/promises";
import { createHealthJobTransport } from "./ops-core-health-job.mjs";
import { createManagedAzureSchedulerProofReader } from "../release/managed-azure-worker-demand.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function requireProof(value) { if (!value) throw Error("OPS_SCHEDULER_LOG_UNPROVEN"); }

// The retained health definition already pins the private environment and its Log
// Analytics workspace. Reuse that restricted transport; never log provider rows.
export function createOpsCoreSchedulerProofReader({ health, schedulerJobName, transport, exec, wait = delay }) {
  const send = transport ?? createHealthJobTransport(health);
  const root = health.environmentResourceId.split("/").slice(0, 7).join("/");
  const expectedJob = root + "/jobs/" + schedulerJobName;
  async function readRetained({ jobId, execution, template, signal: ownerSignal, maxWaitMs = 180_000 }) {
    requireProof(Number.isSafeInteger(maxWaitMs) && maxWaitMs > 0);
    const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(Math.min(180_000, maxWaitMs))]);
    const run = execution.name, name = template?.containers?.[0]?.name, image = template?.containers?.[0]?.image;
    requireProof(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(schedulerJobName) && jobId.toLowerCase() === expectedJob.toLowerCase()
      && execution.id.toLowerCase() === (jobId + "/executions/" + run).toLowerCase()
      && new RegExp("^" + schedulerJobName + "-[a-z0-9]{7}$").test(run) && execution.properties.status === "Succeeded"
      && template.containers.length === 1 && name === "scheduler" && /^[a-z0-9]+\.azurecr\.io\/corgtex\/worker@sha256:[a-f0-9]{64}$/.test(image)
      && execution.properties.template?.containers?.length === 1 && execution.properties.template.containers[0].name === name
      && execution.properties.template.containers[0].image === image && uuid.test(health.workspaceId));
    const start = Date.parse(execution.properties.startTime), end = Date.parse(execution.properties.endTime);
    requireProof(Number.isFinite(start) && end >= start && end - start <= 180_000);
    const lower = new Date(start).toISOString(), upper = new Date(end + (/T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(execution.properties.endTime) ? 999 : 0)).toISOString();
    const env = await send({ method: "GET", path: health.environmentResourceId + "?api-version=2025-07-01", signal });
    const properties = env.body?.properties, domain = properties?.defaultDomain, group = domain?.split(".")[0];
    requireProof(env.status === 200 && env.body.id?.toLowerCase() === health.environmentResourceId.toLowerCase()
      && properties.provisioningState === "Succeeded" && properties.appLogsConfiguration?.destination === "log-analytics"
      && properties.appLogsConfiguration.logAnalyticsConfiguration?.customerId === health.workspaceId
      && /^[a-z0-9][a-z0-9-]{0,62}$/.test(group) && domain === group + "." + health.location + ".azurecontainerapps.io"
      && new URL(health.worker.origin).hostname === health.worker.appId.split("/").at(-1) + ".internal." + domain);
    const query = [
      "ContainerAppConsoleLogs_CL",
      `| where TimeGenerated between (datetime(${lower}) .. datetime(${upper}))`,
      `| where TenantId == '${health.workspaceId}' and Category == 'ContainerAppConsoleLogs' and EnvironmentName_s == '${group}'`,
      `| where ContainerJobName_s == '${schedulerJobName}' and ContainerGroupName_s startswith_cs '${run}-' and ContainerName_s == 'scheduler'`,
      "| extend completion=Log_s contains_cs 'scheduler_complete'",
      "| summarize completions=countif(completion), frames=make_list_if(pack('stream', Stream_s, 'raw', Log_s), completion, 2) by ContainerGroupName_s, ContainerGroupId_g, ContainerName_s, ContainerId_g, ContainerImage_s",
      "| project ContainerGroupName_s, ContainerGroupId_g, ContainerName_s, ContainerId_g, ContainerImage_s, completions, frames",
      "| take 2",
    ].join("\n");
    const names = ["ContainerGroupName_s", "ContainerGroupId_g", "ContainerName_s", "ContainerId_g", "ContainerImage_s", "completions", "frames"];
    for (let attempt = 0; attempt < 36; attempt++) {
      const result = await send({ method: "POST", path: `/v1/workspaces/${health.workspaceId}/query`,
        body: { query, timespan: lower + "/" + upper }, signal });
      const table = result.body?.tables?.[0];
      requireProof(result.status === 200 && !result.body.error && result.body.tables?.length === 1 && table?.name === "PrimaryResult"
        && Array.isArray(table.columns) && table.columns.length === names.length && names.every((n, i) => table.columns[i].name === n)
        && Array.isArray(table.rows) && table.rows.length <= 1);
      if (table.rows.length) {
        const row = table.rows[0];
        requireProof(Array.isArray(row) && row.length === names.length);
        const [replica, groupId, container, containerId, observedImage, count, dynamicFrames] = row;
        let frames;
        try { frames = typeof dynamicFrames === "string" ? JSON.parse(dynamicFrames) : dynamicFrames; } catch { requireProof(false); }
        requireProof(new RegExp("^" + run + "-[a-z0-9]{5}$").test(replica) && uuid.test(groupId) && uuid.test(containerId)
          && container === "scheduler" && observedImage === image && [0, 1].includes(count) && Array.isArray(frames) && frames.length === count);
        if (count === 1) {
          requireProof(frames[0]?.stream === "stdout" && typeof frames[0].raw === "string" && Buffer.byteLength(frames[0].raw) <= 32768);
          let wrapper, receipt;
          try { wrapper = JSON.parse(frames[0].raw); receipt = JSON.parse(wrapper.msg); } catch { requireProof(false); }
          requireProof(wrapper.level === "info" && receipt?.event === "scheduler_complete");
          return { jobId, executionId: execution.id, replicaName: replica, containerName: container, receipt };
        }
      }
      if (attempt < 35) await wait(5_000, undefined, { signal });
    }
    throw Error("OPS_SCHEDULER_LOG_UNAVAILABLE");
  }
  return createManagedAzureSchedulerProofReader({ exec, readRetained });
}
