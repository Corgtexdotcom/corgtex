import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { importCoreLeadTransfer, prepareCoreLeadTransfer, leadTlsOptions, type CoreLeadBundle, type CoreLeadTransferBinding } from "./core-lead-transfer";

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
function privatePath(path: string, exists = true) {
  const parent = realpathSync(dirname(resolve(path)));
  const within = relative(repo, parent);
  if (!(within === ".." || within.startsWith(`..${sep}`)) || statSync(parent).mode & 0o077) throw new Error("PRIVATE_DIRECTORY_OUTSIDE_REPOSITORY_REQUIRED");
  if (exists && (realpathSync(path) !== resolve(path) || statSync(path).mode & 0o077
    || !statSync(path).isFile() || statSync(path).size > 4 * 1024 * 1024)) throw new Error("PRIVATE_INPUT_REQUIRED");
  return resolve(path);
}
function readPrivate<T>(path: string): T { return JSON.parse(readFileSync(privatePath(path), "utf8")); }
type Configuration = {
  binding: CoreLeadTransferBinding;
  runtime: { source: { origin: string; sha: string }; target: { origin: string; sha: string } };
};
async function runtimeEvidence(config: Configuration) {
  if (!config.runtime || Object.keys(config.runtime).sort().join(",") !== "source,target"
    || !config.runtime.source || !config.runtime.target) throw new Error("EXACT_SOURCE_AND_TARGET_RUNTIME_REQUIRED");
  for (const side of ["source", "target"] as const) {
    const runtime = config.runtime[side];
    const origin = new URL(runtime.origin);
    if (origin.origin !== runtime.origin || origin.protocol !== "https:" || origin.username || origin.password
      || !/^[a-f0-9]{40}$/.test(runtime.sha)) throw new Error("EXACT_RUNTIME_REQUIRED");
    const response = await fetch(`${origin.origin}/api/health`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const health = await response.json();
    if (!response.ok || health.status !== "ok" || health.database !== "up" || health.schema !== "ready"
      || health.release?.gitSha !== runtime.sha || health.release?.runtime?.gitSha !== runtime.sha
      || health.release?.runtime?.evidence !== "baked" || health.release?.drift?.details?.length !== 0) {
      throw new Error(`EXACT_${side.toUpperCase()}_RUNTIME_UNPROVEN`);
    }
  }
}
async function main() {
  const [command, configPath, bundlePath, execute] = process.argv.slice(2);
  if (!["prepare", "import"].includes(command) || !configPath || !bundlePath
    || (command === "import" ? execute !== "--execute" : execute !== undefined)) {
    throw new Error("Usage: tsx scripts/migration/core-lead-transfer-cli.ts prepare|import /private/config.json /private/bundle.json [--execute]");
  }
  const config = readPrivate<Configuration>(configPath);
  privatePath(bundlePath, command === "import");
  const sourceUrl = process.env.TRANSFER_SOURCE_DATABASE_URL, targetUrl = process.env.TRANSFER_TARGET_DATABASE_URL;
  if (!sourceUrl || !targetUrl) throw new Error("EXPLICIT_DATABASE_ENV_REQUIRED");
  await runtimeEvidence(config);
  // Do not permit URL SSL settings to override certificate verification.
  const clients = [sourceUrl, targetUrl].map((input, index) => {
    const url = new URL(input);
    if ([...url.searchParams.keys()].some((key) => key.startsWith("ssl") || key === "uselibpqcompat")) throw new Error("USE_TLS_CA_ENV_NOT_URL_OVERRIDE");
    const binding = index === 0 ? config.binding.source : config.binding.target;
    if (index === 1 && binding.certificateIdentity) throw new Error("CORE_LEAD_TRANSFER_TARGET_CERTIFICATE_ALIAS_FORBIDDEN");
    const caPath = process.env[index === 0 ? "TRANSFER_SOURCE_TLS_CA_FILE" : "TRANSFER_TARGET_TLS_CA_FILE"] ?? process.env.TRANSFER_TLS_CA_FILE;
    const ca = caPath ? readFileSync(caPath) : undefined;
    return new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 15_000,
      ssl: leadTlsOptions(binding, ca) });
  });
  const [source, target] = clients;
  try {
    await Promise.all(clients.map((client) => client.connect()));
    if (command === "prepare") {
      const bundle = await prepareCoreLeadTransfer(source, target, config.binding);
      writeFileSync(privatePath(bundlePath, false), JSON.stringify(bundle), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ status: "PREPARED", sha256: bundle.sha256, leads: bundle.leads.length, deliveries: bundle.deliveries.length }));
    } else {
      console.log(JSON.stringify(await importCoreLeadTransfer(source, target, readPrivate<CoreLeadBundle>(bundlePath), config.binding, true)));
    }
  } finally { await Promise.allSettled(clients.map((client) => client.end())); }
}
main().catch((error) => {
  // Transport/SQL diagnostics may contain credentials or private bearer links.
  const message = error instanceof Error ? error.message : "";
  console.error(/^(CORE_LEAD_TRANSFER_|EXACT_|PRIVATE_|EXPLICIT_|USE_TLS_|Usage:)/.test(message) ? message : "CORE_LEAD_TRANSFER_EXECUTION_FAILED");
  process.exitCode = 1;
});
