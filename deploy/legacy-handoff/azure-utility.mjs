import { createHash } from "node:crypto";
import { legacyHandoffResponse, LEGACY_HOSTS, DESTINATION } from "./worker.mjs";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
export const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const need = (value, code) => { if (!value) throw new Error(`HANDOFF_${code}`); };

// Serialized as a Node -e program, following the existing sourceFreezeServer
// command override. It never loads the application, image entrypoint or queues.
export function frozenHandoffServer(decide, health, healthPaths) {
  const http = require("node:http");
  const frozen = JSON.stringify({ error: "source_frozen", applicationWrites: false });
  const server = http.createServer(async (incoming, outgoing) => {
    const method = incoming.method;
    const head = method === "HEAD";
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "Content-Type": "application/json" };
    const refuse = () => { outgoing.writeHead(503, { ...headers, "Retry-After": "3600" }); outgoing.end(head ? "" : frozen); };
    try {
      // Accept origin-form only; do not trust proxy host headers or absolute URLs.
      const raw = incoming.url;
      if (!raw?.startsWith("/") || raw.startsWith("//")) { refuse(); return; }
      const path = new URL(raw, "http://localhost").pathname;
      if ((method === "GET" || head) && healthPaths.includes(path)) {
        outgoing.writeHead(200, headers); outgoing.end(head ? "" : JSON.stringify(health)); return;
      }
      const host = incoming.headers.host;
      if (typeof host !== "string" || !/^[a-zA-Z0-9.-]+$/.test(host)) { refuse(); return; }
      const result = decide(new Request(`https://${host}${raw}`, {
        method, headers: { accept: incoming.headers.accept || "" },
      }));
      if (!result) { refuse(); return; }
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(head ? "" : await result.text());
    } catch { refuse(); }
  });
  server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
    console.log(`HANDOFF_LISTENING:${server.address().port}`);
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

// Offline only. Caller supplies the reviewed current Azure template and hashes.
// Hash equality binds evidence bytes; it is not authorization to deploy.
export function prepareAzureHandoff({ baseline, expectedTemplateSha256, expectedCommandSha256,
  health, healthPaths, hostname, resourceId, observedAt }) {
  need(LEGACY_HOSTS.includes(hostname), "HOST_NOT_REVIEWED");
  need(typeof resourceId === "string" && /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-zA-Z0-9_.()-]+\/providers\/Microsoft\.App\/containerApps\/ca-corgtex-chirone-prod-web$/.test(resourceId), "AZURE_RESOURCE_BINDING_REQUIRED");
  const age = Date.now() - Date.parse(observedAt);
  need(Number.isFinite(age) && age >= 0 && age <= 3600000, "FRESH_BASELINE_REQUIRED");
  need(/^[a-f0-9]{64}$/.test(expectedTemplateSha256 || "") && digest(baseline) === expectedTemplateSha256, "TEMPLATE_CHANGED");
  need(baseline?.containers?.length === 1, "SINGLE_CONTAINER_REQUIRED");
  need(!Object.hasOwn(baseline, "initContainers")
    || (Array.isArray(baseline.initContainers) && baseline.initContainers.length === 0), "INIT_CONTAINERS_FORBIDDEN");
  const original = baseline.containers[0];
  need(typeof original.name === "string" && /^[a-zA-Z0-9-]+$/.test(original.name), "CONTAINER_NAME");
  need(typeof original.image === "string" && /@sha256:[a-f0-9]{64}$/.test(original.image), "IMMUTABLE_IMAGE_REQUIRED");
  need(Array.isArray(original.command) && original.command.length > 0
    && original.command.every(x => typeof x === "string")
    && Array.isArray(original.args) && original.args.every(x => typeof x === "string"), "EXPLICIT_FROZEN_COMMAND_REQUIRED");
  need(/^[a-f0-9]{64}$/.test(expectedCommandSha256 || "")
    && digest({ command: original.command, args: original.args }) === expectedCommandSha256, "COMMAND_CHANGED");
  const fields = ["status", "mode", "applicationWrites", "businessWorker", "role", "proofSha256"];
  need(health && typeof health === "object" && !Array.isArray(health)
    && Object.keys(health).every(key => fields.includes(key))
    && ["ok", "maintenance"].includes(health.status) && health.mode === "source-freeze-utility"
    && health.applicationWrites === false && (!Object.hasOwn(health, "businessWorker") || health.businessWorker === false)
    && (!Object.hasOwn(health, "role") || health.role === "web")
    && (!Object.hasOwn(health, "proofSha256") || /^[a-f0-9]{64}$/.test(health.proofSha256)), "FROZEN_WEB_HEALTH_REQUIRED");
  need(Array.isArray(healthPaths) && healthPaths.length > 0 && new Set(healthPaths).size === healthPaths.length
    && healthPaths.every(path => ["/api/health", "/healthz"].includes(path)), "REVIEWED_HEALTH_PATHS_REQUIRED");
  need(!Object.hasOwn(original, "probes") || Array.isArray(original.probes), "RETAINED_PROBE_PATH_NOT_SERVED");
  for (const probe of original.probes ?? []) {
    // An omitted HTTP path defaults to root, which must remain frozen. Never
    // broaden reviewed health authorization or silently rewrite retained probes.
    if (probe && Object.hasOwn(probe, "httpGet")) {
      need(healthPaths.includes(probe.httpGet?.path), "RETAINED_PROBE_PATH_NOT_SERVED");
    }
  }
  const source = `const LEGACY_HOSTS=${JSON.stringify([hostname])};const DESTINATION=${JSON.stringify(DESTINATION)};`
    + `const decide=${legacyHandoffResponse.toString()};(${frozenHandoffServer.toString()})(decide,${JSON.stringify(health)},${JSON.stringify(healthPaths)});`;
  const candidate = structuredClone(baseline);
  // Azure command overrides the image ENTRYPOINT; no shell and no inherited
  // Node preload options. The retained image must prove this executable exists.
  candidate.containers[0].command = ["/usr/bin/env", "-u", "NODE_OPTIONS", "-u", "NODE_PATH", "/usr/local/bin/node"];
  candidate.containers[0].args = ["-e", source];
  return { candidate, summary: { kind: "azure-frozen-web-handoff-preparation", hostname, resourceId, observedAt,
    baselineTemplateSha256: expectedTemplateSha256, baselineCommandSha256: expectedCommandSha256,
    candidateTemplateSha256: digest(candidate), generatedSourceSha256: createHash("sha256").update(source).digest("hex"),
    changedFields: ["containers[0].command", "containers[0].args"],
    providerWrites: 0, applicationWrites: false, businessWorker: false } };
}
