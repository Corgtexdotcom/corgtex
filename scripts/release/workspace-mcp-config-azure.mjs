import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TARGET, FLAG, appName, assertIdentity, assertHealth, flagValue, configHash, requireProof, runConfig } from "./workspace-mcp-config.mjs";

const WORKSPACE_PATH = `/mcp/workspaces/${TARGET.workspace}`;
const METADATA_PATH = `/.well-known/oauth-protected-resource${WORKSPACE_PATH}`;
const COMPATIBILITY_PATHS = ["apps/worker", "packages/domain", "packages/shared", "packages/workflows", "packages/mcp",
  "apps/web/lib/mcp-handler.ts", "apps/web/app/mcp", "apps/web/app/api/mcp", "apps/web/app/api/oauth",
  "apps/web/app/.well-known", "apps/web/lib/mcp-consent.ts",
  ":(literal)apps/web/app/[locale]/oauth", ":(literal)apps/web/app/api/workspaces/[workspaceId]/mcp-connections",
  ":(literal)apps/web/app/api/workspaces/[workspaceId]/oauth-apps", "deploy", "prisma"];

export function runtimeProbeSource(role) {
  requireProof(["web", "worker"].includes(role), "ROLE_INVALID");
  // Fixed code only; no credential, customer data, raw environment or error output.
  return `(async()=>{try{
    const build=JSON.parse(require('fs').readFileSync('/app/release-build.json','utf8'));
    const role=${JSON.stringify(role)},port=Number(role==='worker'?(process.env.WORKER_HEALTH_PORT||process.env.PORT||9090):(process.env.PORT||3000));
    if(!Number.isInteger(port)||port<1||port>65535)throw Error();
    const response=await fetch('http://127.0.0.1:'+port+(role==='worker'?'/health':'/api/health'),{signal:AbortSignal.timeout(10000),redirect:'error'});
    const h=await response.json(),r=h.release;
    const release={gitSha:r?.gitSha,runtime:r?.runtime,drift:r?.drift?{gitSha:r.drift.gitSha,imageTag:r.drift.imageTag,version:r.drift.version,details:Array.isArray(r.drift.details)?r.drift.details.map(()=> 'drift'):null}:null};
    const origin=new URL(process.env.MCP_PUBLIC_URL||process.env.APP_URL).origin;
    const health={status:h.status,service:h.service,database:h.database,schema:h.schema,phase:h.phase,lastSuccessfulTickAt:h.lastSuccessfulTickAt,lastError:h.lastError===null?null:'present',release};
    console.log('MCP_CONFIG_PROBE:'+JSON.stringify({build,flag:process.env.${FLAG}==='true',origin:origin===${JSON.stringify(TARGET.origin)}?origin:null,status:response.status,health}));
  }catch{console.log('MCP_CONFIG_PROBE:'+JSON.stringify({failed:true}));process.exitCode=1;}})();`;
}
export function parseRuntimeOutput(output) {
  const lines = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").split(/\r?\n/).map(x => x.trim()).filter(x => x.startsWith("MCP_CONFIG_PROBE:"));
  requireProof(lines.length === 1, "RUNTIME_PROBE_AMBIGUOUS");
  try { return JSON.parse(lines[0].slice("MCP_CONFIG_PROBE:".length)); } catch { throw new Error("RUNTIME_PROBE_INVALID"); }
}
export async function acceptance(fetcher, enabled, sha) {
  const read = async path => {
    const r = await fetcher(TARGET.origin + path, { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000), headers: { "Cache-Control": "no-cache" } });
    const text = await r.text();
    requireProof(text.length <= 100000, "ACCEPTANCE_RESPONSE_UNBOUNDED");
    let body;
    try { body = JSON.parse(text); } catch { throw new Error("ACCEPTANCE_NON_JSON"); }
    return { status: r.status, body, authenticate: r.headers.get("www-authenticate") };
  };
  const health = await read("/api/health");
  requireProof(health.status === 200, "PUBLIC_HEALTH_FAILED"); assertHealth(health.body, "web", sha);
  const metadata = await read(METADATA_PATH), endpoint = await read(WORKSPACE_PATH);
  if (enabled) {
    requireProof(metadata.status === 200 && metadata.body.resource === TARGET.origin + WORKSPACE_PATH
      && JSON.stringify(metadata.body.authorization_servers) === JSON.stringify([TARGET.origin])
      && JSON.stringify(metadata.body.bearer_methods_supported) === '["header"]', "CANONICAL_DISCOVERY_FAILED");
    requireProof(endpoint.status === 401 && endpoint.body.error === "invalid_token"
      && endpoint.authenticate === `Bearer resource_metadata="${TARGET.origin + METADATA_PATH}"`, "CANONICAL_AUTH_BOUNDARY_FAILED");
  } else {
    for (const result of [metadata, endpoint]) requireProof(result.status === 503
      && result.body.error?.code === "MCP_WORKSPACE_CONNECTIONS_DISABLED", "CANONICAL_INGRESS_NOT_DISABLED");
  }
  for (const path of ["/mcp", "/api/mcp"]) {
    const result = await read(path);
    requireProof(result.status === 200 && result.body.name === "corgtex-mcp"
      && result.body.capabilities?.tools === true && result.body.capabilities?.resources === true, "LEGACY_DISCOVERY_REGRESSION");
  }
}

export function createAzureIO(input, env = process.env, deps = {}) {
  const execute = deps.execFileSync || execFileSync, fetcher = deps.fetch || fetch;
  const deadline = Date.now() + 22 * 60 * 1000;
  const timeout = () => { requireProof(Date.now() < deadline, "OPERATION_DEADLINE"); return Math.min(90000, deadline - Date.now()); };
  const command = (exe, args, options = {}) => {
    try { return execute(exe, args, { encoding: "utf8", timeout: timeout(), maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options }); }
    catch { throw new Error("PROVIDER_COMMAND_FAILED_RECONCILE"); }
  };
  const az = args => {
    const raw = command("az", [...args, "--only-show-errors", "-o", "json"]);
    try { return JSON.parse(raw); } catch { throw new Error("PROVIDER_RESPONSE_INVALID"); }
  };
  const targetArgs = role => ["--subscription", TARGET.subscription, "--resource-group", TARGET.group, "--name", appName(role)];
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const output = deps.output || ".artifacts/workspace-mcp-config";
  mkdirSync(output, { recursive: true, mode: 0o700 });
  requireProof(!existsSync(`${output}/receipt.json`), "LOCAL_RECEIPT_ALREADY_EXISTS");
  return {
    save(receipt) {
      // Values/secret refs from provider configuration are never written to evidence.
      writeFileSync(`${output}/receipt.json`, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    },
    async identity() {
      requireProof(env.AZURE_TENANT_ID === TARGET.tenant && env.AZURE_SUBSCRIPTION_ID === TARGET.subscription, "AZURE_TARGET_ENV_MISMATCH");
      assertIdentity(az(["account", "show"]), env.AZURE_CLIENT_ID);
    },
    async source(sha, workflowSha) {
      requireProof(command("git", ["rev-parse", "HEAD"]).trim() === workflowSha, "TOOLING_CHECKOUT_MISMATCH");
      command("git", ["merge-base", "--is-ancestor", sha, workflowSha]);
      try { command("git", ["diff", "--exit-code", sha, workflowSha, "--", ...COMPATIBILITY_PATHS]); }
      catch { throw new Error("SOURCE_COMPATIBILITY_REVIEW_REQUIRED"); }
      const feature = command("git", ["show", `${sha}:packages/domain/src/mcp-resource.ts`]);
      requireProof(feature.includes("MCP_WORKSPACE_CONNECTIONS_ENABLED"), "ACCEPTED_SOURCE_LACKS_GATE");
    },
    async app(role) { return az(["containerapp", "show", ...targetArgs(role)]); },
    async digest(role, image) {
      const name = image.slice(`${TARGET.server}/`.length);
      return az(["acr", "manifest", "show-metadata", "--subscription", TARGET.subscription, "--registry", TARGET.registry, "--name", name, "--query", "digest"]);
    },
    async revisions(role) { return az(["containerapp", "revision", "list", ...targetArgs(role), "--all"]); },
    async revision(role, revision) { return az(["containerapp", "revision", "show", ...targetArgs(role), "--revision", revision]); },
    async replicas(role, revision) { return az(["containerapp", "replica", "list", ...targetArgs(role), "--revision", revision]); },
    async runtime(role, revision, replica) {
      const code = Buffer.from(runtimeProbeSource(role)).toString("base64");
      const node = `node -e "eval(Buffer.from('${code}','base64').toString())"`;
      const args = ["az", "containerapp", "exec", ...targetArgs(role), "--revision", revision, "--replica", replica, "--container", role, "--command", node, "--only-show-errors"];
      // Linux util-linux script supplies the TTY required by az exec. Captured text is never logged.
      const raw = command("script", ["-q", "-e", "-c", args.map(quote).join(" "), "/dev/null"]);
      return parseRuntimeOutput(raw);
    },
    async update(role, suffix, image, enabled) {
      requireProof(["web", "worker"].includes(role) && (input.operation === "activate" && enabled === true
        || input.operation === "complete-activation" && role === "web" && enabled === true
        || input.operation === "disable-ingress" && role === "web" && enabled === false), "WRITE_OUTSIDE_OPERATION");
      requireProof(image === input.images[role] && suffix === `mcp-${input.runId}-${input.attempt}-${role}`, "WRITE_INTENT_MISMATCH");
      return az(["containerapp", "update", ...targetArgs(role), "--container-name", role, "--revision-suffix", suffix,
        "--image", image, "--set-env-vars", `${FLAG}=${enabled}`, "--query", "{revision:properties.latestRevisionName,image:properties.template.containers[0].image}"]);
    },
    async wait(role, revision, image) {
      const until = Math.min(deadline, Date.now() + 8 * 60 * 1000);
      while (Date.now() < until) {
        const app = az(["containerapp", "show", ...targetArgs(role)]), p = app.properties;
        requireProof(p.latestRevisionName === revision && p.template.containers[0].image === image, "POST_WRITE_REVISION_DRIFT");
        requireProof(p.provisioningState !== "Failed", "REVISION_PROVISION_FAILED");
        if (p.latestReadyRevisionName === revision && p.provisioningState === "Succeeded") return;
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      throw new Error("READINESS_TIMEOUT_RECONCILE");
    },
    async reconcile(role, revision) {
      const app = az(["containerapp", "show", ...targetArgs(role)]);
      const revisions = az(["containerapp", "revision", "list", ...targetArgs(role), "--all"]);
      const intended = revisions.find(r => r.name === revision);
      const current = app.properties.latestRevisionName;
      return { observedLatestRevision: current, observedReadyRevision: app.properties.latestReadyRevisionName,
        intendedRevisionPresent: Boolean(intended), intendedRunningState: intended?.properties?.runningState || "unknown",
        observedImage: app.properties.template.containers[0].image, observedFlag: flagValue(app.properties.template.containers[0]),
        observedConfigHash: configHash(app), oldRevisionsStopped: revisions.some(r => r.name === current) && revisions.filter(r => r.name !== current).every(r =>
          r.properties.active === false && r.properties.runningState === "Stopped" && r.properties.replicas === 0),
        terminalOperationProved: false };
    },
    async settle(prove) {
      const until = Math.min(deadline, Date.now() + 5 * 60 * 1000);
      const transient = new Set(["REVISION_NOT_READY", "OLD_REVISION_NOT_STOPPED", "REPLICA_NOT_READY", "REPLICA_INVENTORY_INVALID", "WORKER_HEALTH_INVALID", "RUNTIME_HEALTH_FAILED"]);
      while (true) {
        try { await prove(); return; }
        catch (error) {
          if (!transient.has(error.message) || Date.now() >= until) throw error;
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }
    },
    acceptance: (enabled, sha) => acceptance(fetcher, enabled, sha),
  };
}

export function inputsFromEnv(env) {
  requireProof(env.GITHUB_REPOSITORY === "Corgtexdotcom/corgtex" && env.GITHUB_REF === "refs/heads/main"
    && env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_ACTIONS === "true", "PROTECTED_MAIN_DISPATCH_REQUIRED");
  return { operation: env.MCP_OPERATION, acceptedSha: env.MCP_ACCEPTED_SHA,
    images: { web: env.MCP_WEB_IMAGE, worker: env.MCP_WORKER_IMAGE },
    baselines: { web: env.MCP_WEB_BASELINE, worker: env.MCP_WORKER_BASELINE },
    workflowSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
    writerAcknowledged: env.MCP_EXCLUSIVE_WRITER_ACK };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = inputsFromEnv(process.env);
    const result = await runConfig(input, createAzureIO(input));
    console.log(JSON.stringify({ status: result.status, runId: result.runId }));
  } catch (error) {
    console.error(JSON.stringify({ status: "STOPPED", code: /^[A-Z][A-Z0-9_]+$/.test(error.message || "") ? error.message : "CONFIG_OPERATION_FAILED" }));
    process.exitCode = 1;
  }
}
