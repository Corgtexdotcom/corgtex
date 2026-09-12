#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { buildHostingImageReceipt } from "./migration/hosting-image-receipt.mjs";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,89}$/;
const fail = (code) => { throw new ReleaseError(code); };
class ReleaseError extends Error {}
const sameId = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const canonical = (value) => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === "object"
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fingerprint = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const copy = (value) => structuredClone(value);

export function validateTarget(input) {
  if (!input || input.purpose !== "corgtex-public-site" || !UUID.test(input.subscriptionId ?? "")
    || !NAME.test(input.resourceGroup ?? "") || !/^[a-z][a-z0-9-]{0,30}$/.test(input.appName ?? "")
    || input.containerName !== "site" || !/^[a-z0-9]{5,50}\.azurecr\.io$/.test(input.registryServer ?? "")) fail("INVALID_SITE_TARGET");
  const resourceId = `/subscriptions/${input.subscriptionId}/resourceGroups/${input.resourceGroup}/providers/Microsoft.App/containerApps/${input.appName}`;
  const registry = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft.ContainerRegistry\/registries\/([a-zA-Z0-9]+)$/i.exec(input.registryResourceId ?? "");
  if (!sameId(input.resourceId, resourceId) || !registry || !sameId(registry[1], input.subscriptionId)
    || !NAME.test(registry[2]) || `${registry[3].toLowerCase()}.azurecr.io` !== input.registryServer) fail("TARGET_ID_MISMATCH");
  if (!Array.isArray(input.domains) || input.domains.length === 0 || input.domains.some((domain) =>
    typeof domain !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))
    || new Set(input.domains).size !== input.domains.length) fail("EXPLICIT_DOMAINS_REQUIRED");
  return {
    purpose: input.purpose, subscriptionId: input.subscriptionId, resourceGroup: input.resourceGroup,
    appName: input.appName, containerName: input.containerName, resourceId,
    registryResourceId: input.registryResourceId, registryServer: input.registryServer,
    domains: [...input.domains].sort(),
  };
}

function validateImage(image, target) {
  const prefix = `${target.registryServer}/corgtex/site@`;
  if (typeof image !== "string" || !image.startsWith(prefix) || !DIGEST.test(image.slice(prefix.length))) fail("IMMUTABLE_SITE_IMAGE_REQUIRED");
  return image;
}

function publication(receipt, image) {
  let expected;
  try {
    expected = buildHostingImageReceipt({ repository: "Corgtexdotcom/corgtex", gitSha: receipt?.sourceCommit,
      runId: receipt?.workflowRun?.id, runAttempt: receipt?.workflowRun?.attempt,
      siteDigest: receipt?.images?.site?.digest, monitorDigest: receipt?.images?.monitor?.digest });
  } catch { fail("INVALID_HOSTING_RECEIPT"); }
  if (receipt.schemaVersion !== 1 || receipt.images.site.reference !== expected.images.site.reference
    || receipt.workflowRun.url !== expected.workflowRun.url || !image.endsWith(`@${expected.images.site.digest}`)) fail("RECEIPT_IMAGE_MISMATCH");
  return expected;
}

// Compare complete configuration in memory. Secret payloads are never requested;
// only names, Key Vault references and identity metadata belong to this proof.
function invariants(app) {
  const template = copy(app.properties.template);
  delete template.revisionSuffix;
  template.containers[0].image = "<image-only>";
  const configuration = copy(app.properties.configuration);
  for (const secret of configuration.secrets ?? []) delete secret.value;
  return {
    identity: app.identity ?? null, tags: app.tags ?? {}, location: app.location,
    managedBy: app.managedBy ?? null, extendedLocation: app.extendedLocation ?? null,
    properties: Object.fromEntries(Object.entries(app.properties).filter(([key]) => ![
      "configuration", "template", "provisioningState", "runningStatus", "latestRevisionName", "latestReadyRevisionName",
      "latestRevisionFqdn", "outboundIpAddresses", "customDomainVerificationId", "eventStreamEndpoint",
    ].includes(key))),
    configuration, template,
  };
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return typeof value === "string" ? "[REDACTED]" : value;
}

export function inspectApp(app, target) {
  const p = app?.properties;
  if (!sameId(app?.id, target.resourceId) || app.name !== target.appName
    || !sameId(app.type, "Microsoft.App/containerApps") || app.resourceGroup !== target.resourceGroup) fail("LIVE_TARGET_MISMATCH");
  if (!p?.configuration || !p.template || p.template.containers?.length !== 1
    || p.template.containers[0].name !== target.containerName || p.template.initContainers?.length
    || p.configuration.activeRevisionsMode !== "Single" || p.workloadProfileName !== "Consumption") fail("UNSUPPORTED_SITE_SHAPE");
  const ingress = p.configuration.ingress;
  if (!ingress?.external || ingress.targetPort !== 3000 || ingress.allowInsecure !== false
    || canonical((ingress.customDomains ?? []).map((d) => d.name).sort()) !== canonical(target.domains)
    || ingress.customDomains.some((d) => d.bindingType !== "SniEnabled" || !/^\/subscriptions\/.+\/providers\/Microsoft.App\/managedEnvironments\/.+\/(?:managedCertificates|certificates)\/[^/]+$/i.test(d.certificateId ?? ""))) fail("DOMAIN_BINDINGS_MISMATCH");
  if (!p.configuration.registries?.some((registry) => registry.server === target.registryServer)) fail("REGISTRY_BINDING_MISSING");
  const container = p.template.containers[0];
  const image = validateImage(container.image, target);
  const secretNames = new Set((p.configuration.secrets ?? []).map((secret) => secret.name));
  if ((container.env ?? []).some((env) => env.secretRef && (!secretNames.has(env.secretRef) || env.value != null))) fail("INVALID_SECRET_REFERENCE");
  const invariant = invariants(app);
  return {
    image, revision: p.latestRevisionName, readyRevision: p.latestReadyRevisionName,
    configurationFingerprint: fingerprint(invariant), templateFingerprint: fingerprint(invariant.template),
    // No raw env, headers, args, registry passwords, scale metadata or secret values.
    redactedConfiguration: redact(invariant),
    bindings: ingress.customDomains.map(({ name, bindingType, certificateId }) => ({ name, bindingType, certificateId })),
    environment: (container.env ?? []).map((env) => ({ name: env.name,
      ...(env.secretRef ? { secretRef: env.secretRef } : { value: "[REDACTED]" }) })),
    secrets: (p.configuration.secrets ?? []).map((secret) => ({ name: secret.name })),
  };
}

export function azureCommand(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolveCommand, reject) => {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      reject(new ReleaseError("AZURE_COMMAND_DEADLINE_EXPIRED"));
      return;
    }
    execFile("az", [...args, "--only-show-errors"], {
      timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: "false", AZURE_LOGGING_ENABLE_LOG_FILE: "false",
        AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no" },
    }, (error, stdout) => {
      // Child errors can contain stdout/stderr and credentials. Never propagate them.
      if (error) { reject(new ReleaseError("AZURE_COMMAND_FAILED_OR_TIMED_OUT")); return; }
      try { resolveCommand(stdout.trim() ? JSON.parse(stdout) : null); }
      catch { reject(new ReleaseError("INVALID_AZURE_JSON")); }
    });
  });
}

function revisionTemplate(template) {
  const result = copy(template);
  delete result.revisionSuffix;
  result.containers[0].image = "<image-only>";
  if (result.customMetricsSettings == null) delete result.customMetricsSettings;
  if (result.scale) {
    result.scale.cooldownPeriod ??= 300;
    result.scale.pollingInterval ??= 30;
  }
  return result;
}

function inspectRevision(revision, target, revisionName, image, appTemplate) {
  if (!sameId(revision?.id, `${target.resourceId}/revisions/${revisionName}`) || revision.name !== revisionName) fail("REVISION_TARGET_MISMATCH");
  const properties = revision.properties;
  const template = copy(properties?.template ?? {});
  if (template.containers?.length !== 1 || template.containers[0].name !== target.containerName
    || template.containers[0].image !== image) fail("REVISION_IMAGE_MISMATCH");
  const actual = revisionTemplate(template);
  const expected = revisionTemplate(appTemplate);
  // The revision endpoint omits these app response fields. Compare explicit
  // revision values when present; the full app fingerprint always retains them.
  if (!Object.hasOwn(actual.containers[0], "imageType") && typeof expected.containers[0].imageType === "string") {
    delete expected.containers[0].imageType;
  }
  if (!Object.hasOwn(actual.containers[0].resources ?? {}, "ephemeralStorage")
    && typeof expected.containers[0].resources?.ephemeralStorage === "string") {
    delete expected.containers[0].resources.ephemeralStorage;
  }
  if (fingerprint(actual) !== fingerprint(expected)) fail("REVISION_CONFIGURATION_DRIFT");
  return properties;
}

function savedIntent(value, target) {
  if (value?.schemaVersion !== 1 || canonical(validateTarget(value.target)) !== canonical(target)
    || !/^[a-f0-9]{64}$/.test(value.before?.configurationFingerprint ?? "")
    || !/^[a-f0-9]{64}$/.test(value.before?.templateFingerprint ?? "")) fail("INVALID_SAVED_INTENT");
  return {
    target, image: validateImage(value.image, target),
    before: { image: validateImage(value.before.image, target),
      configurationFingerprint: value.before.configurationFingerprint, templateFingerprint: value.before.templateFingerprint },
  };
}

export async function releaseSite(options, dependencies = {}) {
  const az = dependencies.az ?? azureCommand;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const save = dependencies.save;
  if (typeof save !== "function") fail("EVIDENCE_WRITER_REQUIRED");
  const target = validateTarget(options.target);
  const reconcile = Boolean(options.reconcile);
  if ((reconcile && (options.execute || options.rollback || options.receipt || options.image || options.expectedCurrentImage))
    || (options.rollback && (options.receipt || options.image))
    || (options.execute && options.confirmTarget !== target.resourceId)
    || (!options.execute && options.confirmTarget)) fail("INVALID_MODE_OR_TARGET_CONFIRMATION");
  const waitSeconds = options.waitSeconds ?? 300;
  const pollSeconds = options.pollSeconds ?? 5;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 1800
    || !Number.isInteger(pollSeconds) || pollSeconds < 1 || pollSeconds > 30) fail("INVALID_POLL_BOUNDS");
  const prior = options.reconcile || options.rollback;
  const saved = prior ? savedIntent(prior, target) : null;
  const image = validateImage(reconcile ? saved.image : options.rollback ? saved.before.image : options.image, target);
  const expectedImage = reconcile ? null : validateImage(options.expectedCurrentImage, target);
  const receipt = !prior ? publication(options.receipt, image) : null;
  if (options.rollback && expectedImage !== saved.image) fail("ROLLBACK_CURRENT_IMAGE_MISMATCH");
  const scope = ["--subscription", target.subscriptionId, "--resource-group", target.resourceGroup, "--name", target.appName];
  const show = (timeoutMs = 30_000) => az(["containerapp", "show", ...scope, "--output", "json"], { timeoutMs });
  const showRevision = (name, timeoutMs = 30_000) => az(["containerapp", "revision", "show", ...scope,
    "--revision", name, "--output", "json"], { timeoutMs });
  const account = await az(["account", "show", "--subscription", target.subscriptionId, "--output", "json"]);
  if (!sameId(account?.id, target.subscriptionId) || account.state !== "Enabled") fail("SUBSCRIPTION_MISMATCH");
  const registryParts = target.registryResourceId.split("/");
  const registry = await az(["acr", "show", "--subscription", target.subscriptionId, "--resource-group", registryParts[4],
    "--name", registryParts[8], "--query", "{id:id,loginServer:loginServer}", "--output", "json"]);
  if (!sameId(registry?.id, target.registryResourceId) || registry.loginServer !== target.registryServer) fail("ACR_TARGET_MISMATCH");
  const manifest = await az(["acr", "manifest", "show-metadata", "--subscription", target.subscriptionId,
    "--registry", registryParts[8], "--name", image.slice(target.registryServer.length + 1),
    "--query", "{digest:digest}", "--output", "json"]);
  if (manifest?.digest !== image.split("@")[1]) fail("IMPORTED_DIGEST_MISMATCH");
  const beforeApp = await show();
  const current = inspectApp(beforeApp, target);
  const before = reconcile ? saved.before : current;
  if (saved && current.configurationFingerprint !== saved.before.configurationFingerprint) fail("CONFIGURATION_DRIFT");
  // Saved evidence need not contain plaintext configuration: only use this live
  // template after the complete app fingerprint has matched the saved baseline.
  const appTemplate = beforeApp.properties.template;
  if (!reconcile && current.image !== expectedImage) fail("CURRENT_IMAGE_MISMATCH");
  let rollbackFailedRevision = false;
  if (options.rollback && current.revision && ["Succeeded", "Failed"].includes(beforeApp.properties.provisioningState)) {
    // Reconcile the original attempted digest before authorizing a new image write.
    const rp = inspectRevision(await showRevision(current.revision), target, current.revision, saved.image, appTemplate);
    rollbackFailedRevision = rp.provisioningState === "Failed" && ["Failed", "ActivationFailed"].includes(rp.runningState);
    if (!rollbackFailedRevision && !(rp.active === true && rp.provisioningState === "Provisioned" && rp.healthState === "Healthy"
      && ["Running", "RunningAtMaxScale", "ScaleToZero"].includes(rp.runningState))) fail("ROLLBACK_TARGET_NOT_RECONCILED");
  }
  if (!reconcile && !rollbackFailedRevision && (beforeApp.properties.provisioningState !== "Succeeded"
    || !current.revision || current.revision !== current.readyRevision)) fail("BASELINE_NOT_READY_RECONCILE_FIRST");
  const command = ["containerapp", "update", ...scope, "--container-name", target.containerName, "--image", image,
    "--no-wait", "--output", "none"];
  const intent = { schemaVersion: 1, target, image, before, publication: receipt,
    mode: reconcile ? "reconcile" : options.rollback ? "rollback" : "release", command: ["az", ...command, "--only-show-errors"] };
  await save("intent.json", intent);
  const finish = async (status) => {
    const result = { schemaVersion: 1, status, resourceId: target.resourceId, image, runtimeHealth: "UNPROVEN", publicHealth: "UNPROVEN" };
    await save(status === "READY" ? "ready.json" : "result.json", result);
    return result;
  };
  if (!options.execute && !reconcile) return finish("PLANNED");
  let ambiguous = false;
  if (options.execute && current.image !== image) {
    // The coordinator owns serialization. Re-read immediately before the sole write.
    const freshApp = await show();
    const fresh = inspectApp(freshApp, target);
    if (fresh.configurationFingerprint !== before.configurationFingerprint || fresh.image !== before.image
      || fresh.revision !== current.revision || fresh.readyRevision !== current.readyRevision
      || freshApp.properties.provisioningState !== beforeApp.properties.provisioningState) return finish("PREWRITE_DRIFT_NO_UPDATE");
    await save("submitted.json", { image, status: "SUBMITTING_RECONCILE_IF_INTERRUPTED" });
    try { await az(command, { timeoutMs: 30_000 }); }
    catch { ambiguous = true; }
  }
  const deadline = now() + waitSeconds * 1000;
  try {
    while (now() < deadline) {
      const app = await show(Math.min(30_000, deadline - now()));
      const state = inspectApp(app, target);
      if (state.configurationFingerprint !== before.configurationFingerprint) return finish("CONFIGURATION_DRIFT_RECONCILE_REQUIRED");
      if (![before.image, image].includes(state.image)) return finish("UNEXPECTED_IMAGE_RECONCILE_REQUIRED");
      const p = app.properties;
      if (p.provisioningState === "Failed") return finish("PROVISIONING_FAILED_RECONCILE_REQUIRED");
      if (state.image === image && p.provisioningState === "Succeeded" && state.revision && state.revision === state.readyRevision && now() < deadline) {
        const revision = await showRevision(state.revision, Math.min(30_000, deadline - now()));
        const rp = inspectRevision(revision, target, state.revision, image, appTemplate);
        if (rp.active === true && rp.provisioningState === "Provisioned" && rp.healthState === "Healthy"
          && ["Running", "RunningAtMaxScale", "ScaleToZero"].includes(rp.runningState) && now() < deadline) {
          // Close the two-read window before claiming readiness for this target.
          const finalApp = await show(Math.min(30_000, deadline - now()));
          const finalState = inspectApp(finalApp, target);
          if (finalState.configurationFingerprint === before.configurationFingerprint && finalState.image === image
            && finalState.revision === state.revision && finalState.readyRevision === state.revision
            && finalApp.properties.provisioningState === "Succeeded" && now() < deadline) {
            await save("after.json", finalState);
            return finish("READY");
          }
          return finish("FINAL_READBACK_DRIFT_RECONCILE_REQUIRED");
        }
      }
      await sleep(Math.max(0, Math.min(pollSeconds * 1000, deadline - now())));
    }
  } catch (error) {
    return finish(error instanceof ReleaseError && ["REVISION_TARGET_MISMATCH", "REVISION_IMAGE_MISMATCH", "REVISION_CONFIGURATION_DRIFT"].includes(error.message)
      ? error.message : "READBACK_FAILED_RECONCILE_REQUIRED");
  }
  return finish(ambiguous ? "UPDATE_AMBIGUOUS_RECONCILE_REQUIRED" : "READINESS_TIMEOUT_RECONCILE_REQUIRED");
}

const HELP = `Azure public-site image-only release (read-only by default)
  node scripts/azure-site-image-release.mjs --target target.json --receipt receipt.json
    --image REGISTRY.azurecr.io/corgtex/site@sha256:HEX
    --expected-current-image REGISTRY.azurecr.io/corgtex/site@sha256:HEX --out NEW_DIRECTORY
  Add --execute --confirm-target EXACT_RESOURCE_ID for an authorized image-only update.
  Reconcile: --target target.json --reconcile PRIOR_DIRECTORY --out NEW_DIRECTORY
  Rollback: --target target.json --rollback-from PRIOR_DIRECTORY
    --expected-current-image CURRENT_DIGEST_REFERENCE --out NEW_DIRECTORY
    [--execute --confirm-target EXACT_RESOURCE_ID]
  Polling: --wait-seconds 300 (1-1800), --poll-seconds 5 (1-30).
  No imports, infrastructure deployment, public probes, automatic rollback or retries of writes.
  See infra/azure/hosting/README.md for the explicit target schema and evidence limits.`;

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, options: {
    target: { type: "string" }, receipt: { type: "string" }, image: { type: "string" },
    "expected-current-image": { type: "string" }, out: { type: "string" }, execute: { type: "boolean" },
    "confirm-target": { type: "string" }, reconcile: { type: "string" }, "rollback-from": { type: "string" },
    "wait-seconds": { type: "string" }, "poll-seconds": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(HELP); return; }
  if (!values.target || !values.out || (values.reconcile && values["rollback-from"])) fail("TARGET_AND_NEW_OUTPUT_DIRECTORY_REQUIRED");
  const json = async (path) => JSON.parse(await readFile(path, "utf8"));
  const priorDirectory = values.reconcile || values["rollback-from"];
  const prior = priorDirectory ? await json(join(priorDirectory, "intent.json")) : null;
  const options = { target: await json(values.target), receipt: values.receipt ? await json(values.receipt) : null,
    image: values.image, expectedCurrentImage: values["expected-current-image"], execute: values.execute,
    confirmTarget: values["confirm-target"], reconcile: values.reconcile ? prior : null,
    rollback: values["rollback-from"] ? prior : null,
    waitSeconds: values["wait-seconds"] === undefined ? undefined : Number(values["wait-seconds"]),
    pollSeconds: values["poll-seconds"] === undefined ? undefined : Number(values["poll-seconds"]),
  };
  const directory = resolve(values.out);
  await mkdir(directory, { mode: 0o700 }); // Exclusive directory; never overwrite recovery evidence.
  const result = await releaseSite(options, { save: (name, data) => writeFile(join(directory, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" }) });
  console.log(JSON.stringify(result, null, 2));
  if (!["PLANNED", "READY"].includes(result.status)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof ReleaseError ? error.message : "SITE_RELEASE_FAILED: check inputs and private evidence; reconcile any submitted update before another write.");
    process.exitCode = 1;
  });
}
