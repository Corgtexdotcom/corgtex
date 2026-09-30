import { identityHash, sha256, validatePin, validateReceipt } from "../accepted-core-baseline.mjs";
import { recoveryStage } from "./core-recovery.mjs";

export const CORE_RETIREMENT_TARGET = Object.freeze({
  projectId: "0c843902-611a-4141-be91-b049a36d9617",
  environmentId: "03856ec6-a881-47de-bd71-44207a266ac7",
  webServiceId: "dafd9062-3f96-4a42-813a-c194ac867858",
  workerServiceId: "42de000e-f64d-4700-9a07-05d0ca42873e",
});
export const CORE_DEPLOYMENT_ID = "24051f06-3acd-40f5-98e3-e0afbdab4680";
export const CORE_SOURCE_SHA = "d0a3896ef917b50f2fec2d797908f29aa026a058";
export const CORE_BEFORE = Object.freeze({ web: "66444bbd-cd25-41f6-9972-56eccd5cb08c", worker: "c1145a3d-6476-4408-86fb-d220e1fece5e" });
export const ROLES = ["worker", "web"];
export const need = (ok, code) => { if (!ok) throw new Error(`CORE_RETIREMENT_${code}`); };
const same = (a, b) => identityHash(a) === identityHash(b);
const HASH = /^[a-f0-9]{64}$/;

// Serialized into the provider's command override. Built-in HTTP only: no app,
// Prisma, queue, webhook, model, OAuth, database or external network dependency.
export function sourceFreezeServer(role, proofSha256) {
  const http = require("node:http");
  const status = JSON.stringify({ status: "ok", mode: "source-freeze-utility", applicationWrites: false,
    businessWorker: false, role, proofSha256 });
  const page = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Corgtex has moved</title><main><h1>Continue to Corgtex</h1><p>Your active workspace is available on Corgtex Selfserve.</p><p><a href="https://selfserve.corgtex.com">Open Corgtex Selfserve</a></p><p>Sign in there to continue.</p></main></html>';
  const server = http.createServer((request, response) => {
    const read = request.method === "GET" || request.method === "HEAD";
    const path = new URL(request.url, "http://localhost").pathname;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (read && path === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(request.method === "HEAD" ? "" : status); return;
    }
    if (read && role === "web" && !/^\/(?:api|mcp|oauth)(?:\/|$)/i.test(path)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? "" : page); return;
    }
    response.writeHead(503, { "Content-Type": "application/json", "Retry-After": "3600" });
    response.end(request.method === "HEAD" ? "" : JSON.stringify({ error: "source_frozen", applicationWrites: false }));
  });
  server.listen(Number(process.env.PORT || 3000), "0.0.0.0");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

export function retirementCommand(role, proofSha256) {
  need(ROLES.includes(role) && HASH.test(proofSha256), "COMMAND_BINDING");
  const source = `(${sourceFreezeServer.toString()})(${JSON.stringify(role)},${JSON.stringify(proofSha256)})`;
  return `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH /usr/local/bin/node -e "eval(Buffer.from('${Buffer.from(source).toString("base64")}','base64').toString())"`;
}

export function validateRetirementBaseline({ pin, receipt, receiptBytes, now = Date.now() }) {
  validatePin(pin); validateReceipt(receipt, pin);
  need(sha256(receiptBytes) === pin.receiptSha256 && same(JSON.parse(receiptBytes.toString()), receipt), "RECEIPT_BYTES");
  need(Object.entries(CORE_RETIREMENT_TARGET).every(([key, value]) => receipt.evidence.target[key] === value)
    && receipt.evidence.sourceSha === CORE_SOURCE_SHA, "BASELINE_TARGET");
  const age = now - Date.parse(receipt.acceptance.acceptedAt);
  need(age >= 0 && age <= 86400000, "FRESH_ACCEPTED_BASELINE_REQUIRED");
}

export function retirementStage(data, target, role, command = null) {
  const original = data?.instance?.startCommand;
  need(original === (command || `npm run start --workspace=@corgtex/${role}`), "START_COMMAND_DRIFT");
  // Reuse exact source/registry/variables/deployment parsing without loosening
  // recovery's own allowed start command. Only this adapter accepts our command.
  const normalized = structuredClone(data);
  normalized.instance.startCommand = `npm run start --workspace=@corgtex/${role}`;
  const stage = recoveryStage(normalized, target, role);
  return { ...stage, startCommand: original };
}

export function assertQuietTriggers(snapshot) {
  need(snapshot?.staged?.empty === true && snapshot.staged.status === "STAGED"
    && snapshot.pendingWork?.length === 0, "PENDING_PROVIDER_WORK");
  need(same(snapshot.services?.map(service => service.serviceId).sort(), [CORE_RETIREMENT_TARGET.webServiceId, CORE_RETIREMENT_TARGET.workerServiceId].sort()) && snapshot.services.every(service =>
    [CORE_RETIREMENT_TARGET.webServiceId, CORE_RETIREMENT_TARGET.workerServiceId].includes(service.serviceId) && service.autoDeployEnabled === false
    && [null, "disabled"].includes(service.autoUpdatesType) && service.cronSchedule === null
    && service.configuredCronSchedule === null && service.nextCronRunAt === null
    && !service.fileConfig?.cronSchedule
    && service.deployments.every(deployment => ["SUCCESS", "REMOVED", "FAILED", "CRASHED", "SKIPPED"].includes(deployment.status))), "TRIGGERS_OR_PENDING_DEPLOYMENT");
}

export function assertBefore(stages, receipt) {
  for (const role of ROLES) {
    const stage = stages[role];
    const expected = { id: CORE_BEFORE[role], status: "SUCCESS" };
    need(same(stage.latestDeployment, expected) && same(stage.activeDeployments, [expected])
      && stage.history.some(row => row.id === expected.id && row.status === "SUCCESS" && row.digest === receipt.evidence.images[role].digest), "CURRENT_DEPLOYMENT_CHANGED");
    need(stage.image === `ghcr.io/corgtexdotcom/corgtex/${role}@${receipt.evidence.images[role].digest}`
      || stage.image === `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${CORE_SOURCE_SHA}`, "CURRENT_IMAGE_CHANGED");
    need(stage.releaseSettings.CORGTEX_RELEASE_GIT_SHA === CORE_SOURCE_SHA
      && stage.releaseSettings.CORGTEX_RELEASE_IMAGE_TAG === `sha-${CORE_SOURCE_SHA}`
      && stage.releaseSettings.CORGTEX_RELEASE_VERSION === `main-${CORE_SOURCE_SHA.slice(0, 12)}`
      && stage.releaseSettings.CORGTEX_STARTUP_MODE === "web", "RELEASE_SETTINGS_CHANGED");
  }
}

export function validateRetirementApproval(approval, plan, expectedHash, now = Date.now()) {
  need(approval?.schemaVersion === 1 && approval.kind === "core-logical-retirement"
    && HASH.test(expectedHash) && identityHash(approval) === expectedHash, "REVIEWED_APPROVAL_REQUIRED");
  need(approval.baselineReceiptSha256 === plan.baselineReceiptSha256
    && approval.providerBeforeSha256 === plan.providerBeforeSha256 && approval.opsSnapshotSha256 === plan.opsSnapshotSha256
    && approval.imageStartupProofSha256 === plan.imageStartupProofSha256, "APPROVAL_EVIDENCE_CHANGED");
  need(["publicSelfserveEvidenceSha256", "providerDispositionSha256", "sourceDataDispositionSha256"].every(key => HASH.test(approval[key])), "DISPOSITION_PROOF_REQUIRED");
  need(approval.sourceDataDisposition === "retain-unchanged" && approval.customerTargets === "selfserve-only"
    && approval.physicalServices === "retain" && approval.databaseChanges === false, "SCOPE_NOT_APPROVED");
  const age = now - Date.parse(approval.reviewedAt);
  need(age >= 0 && age <= 3600000, "REVIEWED_APPROVAL_STALE");
}

export async function retireCore({ pin, receipt, receiptBytes, approval, approvalHash, dryRun = true }, deps) {
  validateRetirementBaseline({ pin, receipt, receiptBytes, now: deps.now?.() });
  const opsSnapshotSha256 = await deps.assertContext();
  const imageStartupProofSha256 = await deps.verifyImages(receipt.evidence);
  const initial = await deps.readState();
  assertQuietTriggers(initial.fence); assertBefore(initial.stages, receipt);
  const plan = { kind: "core-logical-retirement-plan", baselineReceiptSha256: pin.receiptSha256,
    providerBeforeSha256: identityHash(initial), opsSnapshotSha256, imageStartupProofSha256,
    target: CORE_RETIREMENT_TARGET, before: CORE_BEFORE, databaseChanges: false, physicalServices: "retain",
    exclusion: "fleet-release-concurrency-and-fresh-ops-no-active-leases" };
  if (dryRun) return { ...plan, dryRun: true, mutations: 0 };
  validateRetirementApproval(approval, plan, approvalHash, deps.now?.());
  const reservation = await deps.reserveIntent({ approvalHash, ...plan });
  need(reservation === true, "DURABLE_INTENT_REQUIRED");
  let expected = initial;
  const writes = [];
  for (const role of ROLES) {
    need(await deps.assertContext() === opsSnapshotSha256, "OPS_SNAPSHOT_CHANGED");
    const fresh = await deps.readState();
    need(same(fresh, expected), "PROVIDER_DRIFT");
    const command = retirementCommand(role, approvalHash);
    await deps.setCommand(role, command); writes.push(`command:${role}`);
    const staged = await deps.readState();
    const wanted = structuredClone(expected); wanted.stages[role].startCommand = command;
    // The raw provider-config hash changes only for this command. The adapter
    // verifies config and variables separately before returning this projection.
    need(same(staged, wanted), "COMMAND_READBACK");
    need(await deps.assertContext() === opsSnapshotSha256, "OPS_SNAPSHOT_CHANGED");
    const deploymentId = await deps.deploy(role);
    need(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(deploymentId), "DEPLOYMENT_OUTCOME_UNCERTAIN");
    writes.push(`deploy:${role}`);
    expected = await deps.verifyRuntime(role, deploymentId, command, expected);
  }
  await deps.verifyPublic(approvalHash);
  need(await deps.assertContext() === opsSnapshotSha256, "OPS_SNAPSHOT_CHANGED");
  need(same(await deps.readState(), expected), "FINAL_PROVIDER_DRIFT");
  return { ...plan, kind: "core-logical-retirement-verified", approvalHash, writes,
    afterSha256: identityHash(expected), applicationWrites: false, businessWorker: false };
}
