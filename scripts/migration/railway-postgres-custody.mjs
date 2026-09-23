import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRailwayFenceTransport } from "./railway-source-fence.mjs";

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_RESPONSE = 64 * 1024;
const DATA_DIRECTORY = "/var/lib/postgresql/data/pgdata";
const SOURCE_IMAGE = "ghcr.io/railwayapp-templates/postgres-ssl:18";
const QUERY = `query PostgresCustody($projectId:String!,$environmentId:String!,$serviceId:String!) {
  environment(id:$environmentId,projectId:$projectId) { id projectId }
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId) {
    serviceId environmentId service { id projectId } source { image repo }
    startCommand preDeployCommand
    activeDeployments {
      id projectId environmentId serviceId status deploymentStopped
      instances { id status }
    }
  }
}`;
const SQL = `SELECT json_build_object(
  'user',current_user,'sessionUser',session_user,'database',current_database(),
  'serverVersionNum',current_setting('server_version_num')::integer,
  'dataDirectory',current_setting('data_directory'),
  'readOnly',current_setting('transaction_read_only'),'inRecovery',pg_is_in_recovery(),
  'passwordEncryption',current_setting('password_encryption'),
  'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
  'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
  'unixSocket',inet_client_addr() IS NULL);`;
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const quote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
class CustodyError extends Error {
  constructor(code) { super(code); this.name = "RailwayPostgresCustodyError"; this.code = code; }
}
const requireValue = (condition, code) => { if (!condition) throw new CustodyError(code); };
const checkSignal = signal => requireValue(!signal.aborted, "RAILWAY_PG_CUSTODY_ABORTED");
export const railwayPostgresCustodyDiagnostic = error => error instanceof CustodyError ? error.code : null;

function bind(value) {
  const fields = ["domain", "projectId", "environmentId", "serviceId", "deploymentId", "instanceId",
    "sourceImage", "startCommand", "preDeployCommand", "dataDirectory", "systemIdentifier", "files"];
  requireValue(exactKeys(value, fields) && ["core", "ops"].includes(value.domain)
    && ["projectId", "environmentId", "serviceId", "deploymentId", "instanceId"].every(key => ID.test(value[key]))
    && value.sourceImage === SOURCE_IMAGE && value.startCommand === null
    && Array.isArray(value.preDeployCommand) && value.preDeployCommand.length === 0
    && value.dataDirectory === DATA_DIRECTORY && /^[0-9]{1,20}$/.test(value.systemIdentifier)
    && Array.isArray(value.files) && value.files.length >= 4 && value.files.length <= 32,
  "RAILWAY_PG_BINDING_INVALID");
  requireValue(value.files.every(file => exactKeys(file, ["path", "sha256"])
    && typeof file.path === "string" && file.path.length <= 256
    && /^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(file.path)
    && !file.path.split("/").some(part => part === "." || part === "..") && HASH.test(file.sha256))
    && new Set(value.files.map(file => file.path)).size === value.files.length
    && value.files.some(file => file.path === "/usr/local/bin/docker-entrypoint.sh"),
  "RAILWAY_PG_FILES_INVALID");
  const result = structuredClone(value);
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  for (const file of result.files) Object.freeze(file);
  Object.freeze(result.files); Object.freeze(result.preDeployCommand);
  return Object.freeze(result);
}

function remoteScript(binding) {
  const marker = `${binding.dataDirectory}/PG_VERSION`;
  return [
    "set -eu",
    `test -s ${quote(marker)}`,
    "printf '%s\\n' 'RAILWAY_PG_CUSTODY_FILES_V1'",
    `sha256sum -- ${binding.files.map(file => quote(file.path)).join(" ")}`,
    "printf '%s\\n' 'RAILWAY_PG_CUSTODY_VERSION_V1'",
    `cat -- ${quote(marker)}`,
    "printf '\\n%s\\n' 'RAILWAY_PG_CUSTODY_IDENTITY_V1'",
    "env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "
      + "PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000' PGPASSFILE=/nonexistent "
      + `psql -X -w -h /var/run/postgresql -p 5432 -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c ${quote(SQL)}`,
  ].join("\n");
}

/** CLI 5.30.1 joins remote argv. Quote the entire script as the sh -c argument;
 * never rely on local execFile argument separation to quote the remote shell.
 * The injected executor is for local tests; production uses an explicit instance.
 */
export function createRailwayPostgresRemoteRead({ execFileImpl = execFile } = {}) {
  requireValue(typeof execFileImpl === "function", "RAILWAY_PG_EXECUTOR_INVALID");
  return async ({ binding: value, signal }) => {
    requireValue(signal instanceof AbortSignal, "RAILWAY_PG_SIGNAL_REQUIRED");
    const binding = bind(value);
    checkSignal(signal);
    const args = ["ssh", "-p", binding.projectId, "-e", binding.environmentId, "-s", binding.serviceId,
      "-d", binding.instanceId, "--", "sh", "-c", quote(remoteScript(binding))];
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFileImpl("railway", args, { encoding: "utf8", timeout: 30_000, maxBuffer: MAX_RESPONSE,
          signal, shell: false }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      checkSignal(signal);
      requireValue(typeof stdout === "string" && Buffer.byteLength(stdout) <= MAX_RESPONSE, "RAILWAY_PG_REMOTE_RESPONSE_INVALID");
      return stdout;
    } catch (error) {
      if (error instanceof CustodyError) throw error;
      throw new CustodyError("RAILWAY_PG_REMOTE_READ_FAILED");
    }
  };
}

function verifyProvider(data, binding) {
  const service = data?.serviceInstance;
  requireValue(data?.environment?.id === binding.environmentId && data.environment.projectId === binding.projectId
    && service?.serviceId === binding.serviceId && service.environmentId === binding.environmentId
    && service.service?.id === binding.serviceId && service.service.projectId === binding.projectId,
  "RAILWAY_PG_PROVIDER_BINDING_CHANGED");
  requireValue(service.source?.image === binding.sourceImage && service.source.repo === null
    && service.startCommand === null
    && (service.preDeployCommand === null || (Array.isArray(service.preDeployCommand) && service.preDeployCommand.length === 0)),
  "RAILWAY_PG_STARTUP_CHANGED");
  requireValue(Array.isArray(service.activeDeployments) && service.activeDeployments.length === 1,
    "RAILWAY_PG_ACTIVE_DEPLOYMENT_CHANGED");
  const deployment = service.activeDeployments[0];
  requireValue(deployment.id === binding.deploymentId && deployment.projectId === binding.projectId
    && deployment.environmentId === binding.environmentId && deployment.serviceId === binding.serviceId
    && deployment.status === "SUCCESS" && deployment.deploymentStopped === false,
  "RAILWAY_PG_DEPLOYMENT_CHANGED");
  const instances = deployment.instances;
  requireValue(Array.isArray(instances) && instances.length > 0 && instances.length <= 1000
    && instances.every(instance => ID.test(instance.id)
      && ["RUNNING", "CRASHED", "EXITED", "REMOVED", "SKIPPED", "STOPPED"].includes(instance.status))
    && new Set(instances.map(instance => instance.id)).size === instances.length
    && instances.filter(instance => instance.status === "RUNNING").length === 1
    && instances.find(instance => instance.status === "RUNNING").id === binding.instanceId,
  "RAILWAY_PG_INSTANCE_CHANGED");
}

function verifyRemote(stdout, binding) {
  requireValue(typeof stdout === "string" && Buffer.byteLength(stdout) <= MAX_RESPONSE, "RAILWAY_PG_REMOTE_RESPONSE_INVALID");
  const parts = stdout.trim().split("\nRAILWAY_PG_CUSTODY_VERSION_V1\n");
  requireValue(parts.length === 2 && parts[0].startsWith("RAILWAY_PG_CUSTODY_FILES_V1\n"), "RAILWAY_PG_REMOTE_RESPONSE_INVALID");
  const lines = parts[0].split("\n").slice(1);
  requireValue(lines.length === binding.files.length, "RAILWAY_PG_FILE_CUSTODY_CHANGED");
  const observed = lines.map(line => {
    const match = /^([a-f0-9]{64})  (\/[a-zA-Z0-9_./-]+)$/.exec(line);
    requireValue(match, "RAILWAY_PG_FILE_CUSTODY_CHANGED");
    return { path: match[2], sha256: match[1] };
  }).sort((a, b) => a.path.localeCompare(b.path));
  requireValue(canonical(observed) === canonical(binding.files), "RAILWAY_PG_FILE_CUSTODY_CHANGED");
  const tail = parts[1].split("\nRAILWAY_PG_CUSTODY_IDENTITY_V1\n");
  requireValue(tail.length === 2 && tail[0].trim() === "18", "RAILWAY_PG_INITIALIZED_MARKER_CHANGED");
  let identity;
  try { identity = JSON.parse(tail[1]); } catch { throw new CustodyError("RAILWAY_PG_LOCAL_IDENTITY_INVALID"); }
  requireValue(identity?.user === "postgres" && identity.sessionUser === "postgres" && identity.database === "postgres"
    && Number.isInteger(identity.serverVersionNum) && identity.serverVersionNum >= 180000 && identity.serverVersionNum < 190000
    && identity.dataDirectory === binding.dataDirectory && identity.readOnly === "on" && identity.inRecovery === false
    && identity.superuser === true && identity.unixSocket === true && identity.passwordEncryption === "scram-sha-256"
    && identity.systemIdentifier === binding.systemIdentifier, "RAILWAY_PG_LOCAL_IDENTITY_CHANGED");
}

/** Read-only operator recovery proof for the inspected initialized PG18 profile.
 * Callers must durably retain the complete binding, including every inspected
 * startup/helper hash. A mutable image tag alone is insufficient. This verifies
 * current custody; it neither restarts the service nor proves post-restart state.
 */
export function createRailwayPostgresCustody({ binding: value, transport, token,
  runRemoteRead = createRailwayPostgresRemoteRead(), signal }) {
  const binding = bind(value);
  const bindingSha256 = hash(binding);
  requireValue(signal instanceof AbortSignal, "RAILWAY_PG_SIGNAL_REQUIRED");
  const request = transport ?? createRailwayFenceTransport({ token });
  requireValue(typeof request === "function" && typeof runRemoteRead === "function", "RAILWAY_PG_TRANSPORT_INVALID");
  async function providerRead() {
    checkSignal(signal);
    const data = await request({ query: QUERY, variables: { projectId: binding.projectId,
      environmentId: binding.environmentId, serviceId: binding.serviceId }, signal });
    checkSignal(signal);
    verifyProvider(data, binding);
  }
  return Object.freeze({ binding, bindingSha256, async assertHeld() {
    try {
      await providerRead();
      checkSignal(signal);
      const stdout = await runRemoteRead({ binding, signal });
      checkSignal(signal);
      verifyRemote(stdout, binding);
      await providerRead();
      return { status: "RAILWAY_POSTGRES_CUSTODY_HELD", domain: binding.domain,
        systemIdentifier: binding.systemIdentifier, bindingSha256,
        deploymentId: binding.deploymentId, instanceId: binding.instanceId,
        localReadOnlyRecoveryVerified: true, initializedMajor: 18 };
    } catch (error) {
      if (error instanceof CustodyError) throw error;
      throw new CustodyError("RAILWAY_PG_CUSTODY_READ_FAILED");
    }
  } });
}
