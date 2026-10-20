import { isIP } from "node:net";
import { resolve } from "node:path";
import { domainToASCII, pathToFileURL } from "node:url";

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const URL_NAME = /(?:^|_)(?:URL|URI|ORIGIN|ENDPOINT|HOST|HOSTNAME)$/;
const HOST_NAME = /(?:^|_)(?:HOST|HOSTNAME)$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:", "postgres:", "postgresql:",
  "redis:", "rediss:", "mongodb:", "mongodb+srv:", "amqp:", "amqps:", "smtp:", "smtps:", "ftp:", "ftps:", "s3:"]);
const RAILWAY_HOSTS = ["railway.app", "railway.internal", "railway.com", "rlwy.net"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

function hostname(value) {
  const host = domainToASCII(value).toLowerCase().replace(/\.$/, "");
  const ip = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(ip)) return host;
  if (!host || host.length > 253 || !host.split(".").every(label => label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw new Error();
  return host;
}

function endpoint(value, hostOnly = false) {
  if (typeof value !== "string") throw new Error();
  const text = value.trim();
  if (!text || /[\s\u0000-\u001f\u007f\\]/u.test(text)) throw new Error();
  const bareHost = hostOnly && !SCHEME.test(text);
  if (!bareHost && !SCHEME.test(text)) throw new Error();
  const parsed = new URL(bareHost ? `https://${text}` : text);
  if (!PROTOCOLS.has(parsed.protocol) || !parsed.hostname
    || parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) > 65535)
    || bareHost && (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)) throw new Error();
  return { parsed, host: hostname(parsed.hostname) };
}

/** Offline host policy, not an inventory or cloud-provider attestation. Values
 * never leave this function. Custom origins match their exact normalized host
 * on every port; operators must list any legacy subdomains separately.
 */
export function validateAzureOnlyConfiguration(values, policy) {
  const invalid = code => ({ enabled: true, valid: false, findings: [{ code }] });
  if (policy === undefined) return { enabled: false, valid: true, findings: [] };
  if (!record(policy) || typeof policy.enabled !== "boolean"
    || Object.keys(policy).some(key => !["enabled", "legacyOrigins", "urlNames"].includes(key))) return invalid("POLICY_INVALID");
  if (!policy.enabled) return { enabled: false, valid: true, findings: [] };
  const { legacyOrigins = [], urlNames = [] } = policy;
  if (!Array.isArray(legacyOrigins) || !Array.isArray(urlNames)
    || !urlNames.every(name => typeof name === "string" && ENV_NAME.test(name))) return invalid("POLICY_INVALID");
  const legacyHosts = new Set();
  try {
    for (const origin of legacyOrigins) {
      const { parsed, host } = endpoint(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.pathname !== "/" || parsed.search || parsed.hash) return invalid("POLICY_INVALID");
      legacyHosts.add(host);
    }
  } catch { return invalid("POLICY_INVALID"); }
  if (!record(values) || Object.keys(values).some(name => !ENV_NAME.test(name))) return invalid("CONFIG_INVALID");
  const explicitNames = new Set(urlNames), findings = [];
  for (const [setting, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
    const relevant = URL_NAME.test(setting) || explicitNames.has(setting)
      || typeof value === "string" && SCHEME.test(value.trim());
    // Optional settings may be absent or empty. Nonempty relevant values must
    // parse as network URLs (HOST/HOSTNAME also accept a bare host and port).
    if (!relevant || value === undefined || value === null || value === "") continue;
    try {
      const { host } = endpoint(value, HOST_NAME.test(setting));
      if (RAILWAY_HOSTS.some(root => host === root || host.endsWith(`.${root}`))) findings.push({ setting, code: "RAILWAY_HOST" });
      else if (legacyHosts.has(host)) findings.push({ setting, code: "LEGACY_ORIGIN" });
    } catch { findings.push({ setting, code: "INVALID_ENDPOINT" }); }
  }
  return { enabled: true, valid: findings.length === 0, findings };
}

// Read only explicitly supplied JSON from stdin; never load process.env, files,
// credentials, SDKs, or provider clients. Diagnostics contain codes/names only.
async function main() {
  try {
    if (process.argv.length !== 2) throw new Error();
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(input) || !Object.hasOwn(input, "values") || !Object.hasOwn(input, "policy")
      || Object.keys(input).some(key => !["values", "policy"].includes(key))) throw new Error();
    const report = validateAzureOnlyConfiguration(input.values, input.policy);
    console.log(JSON.stringify(report));
    if (!report.valid) process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ enabled: true, valid: false, findings: [{ code: "INPUT_INVALID" }] }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
