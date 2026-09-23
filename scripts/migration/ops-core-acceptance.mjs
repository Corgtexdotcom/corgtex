import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { validateCutoverJournal } from "./ops-core-custody.mjs";
import { managedAzureHealthReady } from "../release/managed-azure-release-transaction.mjs";

const HASH = /^[a-f0-9]{64}$/;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).sort().join() === keys.split(",").sort().join();
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : object(v)
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
export const acceptanceEvidenceHash = v => createHash("sha256").update(canonical(v)).digest("hex");
const same = (a, b) => canonical(a) === canonical(b);
class AcceptanceError extends Error {}
const need = (condition, code) => { if (!condition) throw new AcceptanceError(code); };
export const opsCoreAcceptanceDiagnostic = e => e instanceof AcceptanceError ? e.message : null;
const KINDS = ["workflow", "data", "jobs", "callbacks", "backupRecovery", "updateRecovery"];
const timestamp = v => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const label = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,159}$/.test(v);

export function validateOpsCoreAcceptanceBinding(value) {
  const b = structuredClone(value);
  need(exact(b, "domain,intentSha256,targetBindingSha256,release,sourceFenceSha256,routes")
    && ["core", "ops"].includes(b.domain) && [b.intentSha256, b.targetBindingSha256, b.sourceFenceSha256].every(v => HASH.test(v))
    && exact(b.release, "gitSha,imageTag,version") && /^[a-f0-9]{40}$/.test(b.release.gitSha)
    && b.release.imageTag === `sha-${b.release.gitSha}` && /^[A-Za-z0-9._+-]{1,128}$/.test(b.release.version)
    && Array.isArray(b.routes), "ACCEPTANCE_BINDING_INVALID");
  const required = b.domain === "core" ? ["https://app.corgtex.com", "https://mcp.corgtex.com"] : ["https://ops.corgtex.com"];
  need(same(b.routes.map(r => r?.publicOrigin).sort(), required.sort()), "ACCEPTANCE_ROUTES_INVALID");
  for (const r of b.routes) {
    need(exact(r, "publicOrigin,azureOrigin,expectedCname")
      && /^https:\/\/[a-z0-9-]+\.[a-z0-9.-]+\.azurecontainerapps\.io$/.test(r.azureOrigin)
      && !r.azureOrigin.includes(".internal.") && r.expectedCname === r.azureOrigin.slice(8), "ACCEPTANCE_ROUTES_INVALID");
  }
  return b;
}

/** Actual public DNS + TLS-authenticated HTTPS GET, no redirects or mutation.
 * CNAME must point directly at the bound ACA hostname. Flattened/apex/proxy DNS
 * is intentionally unsupported. Public health proves routing, not workflows. */
export async function verifyOpsCorePublicRouting({ binding, signal }, { resolver = new Resolver({ timeout: 5000, tries: 1 }), request = httpsRequest } = {}) {
  const b = validateOpsCoreAcceptanceBinding(binding);
  need(signal instanceof AbortSignal, "ACCEPTANCE_SIGNAL_REQUIRED");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const cancel = () => resolver.cancel(); bounded.addEventListener("abort", cancel, { once: true });
  try {
    const routes = [];
    for (const route of b.routes) {
      bounded.throwIfAborted();
      const host = new URL(route.publicOrigin).hostname;
      const cnames = (await resolver.resolveCname(host)).map(v => v.toLowerCase().replace(/\.$/, "")).sort();
      need(same(cnames, [route.expectedCname]), "ACCEPTANCE_DNS_UNPROVEN");
      const result = await new Promise((resolve, reject) => {
        let bytes = 0; const chunks = [];
        const req = request(`${route.publicOrigin}/api/health`, { method: "GET", signal: bounded, rejectUnauthorized: true,
          servername: host, headers: { Accept: "application/json" } }, response => {
          if (response.statusCode !== 200 || !response.socket?.authorized || !/application\/json/i.test(response.headers["content-type"] ?? "")) {
            response.destroy(); reject(new AcceptanceError("ACCEPTANCE_TLS_HEALTH_UNPROVEN")); return;
          }
          const peer = response.socket.getPeerCertificate();
          if (!peer.fingerprint256 || !Number.isFinite(Date.parse(peer.valid_to)) || Date.parse(peer.valid_to) <= Date.now()) {
            response.destroy(); reject(new AcceptanceError("ACCEPTANCE_TLS_HEALTH_UNPROVEN")); return;
          }
          response.on("error", reject);
          response.on("data", chunk => {
            bytes += chunk.length;
            if (bytes > 32768) { response.destroy(); reject(new AcceptanceError("ACCEPTANCE_RESPONSE_TOO_LARGE")); }
            else chunks.push(Buffer.from(chunk));
          });
          response.on("end", () => { try { resolve({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), fingerprint: peer.fingerprint256 }); } catch { reject(new AcceptanceError("ACCEPTANCE_HEALTH_INVALID")); } });
        });
        req.on("error", reject); req.end();
      });
      bounded.throwIfAborted();
      need(managedAzureHealthReady(result.body, b.release), "ACCEPTANCE_RELEASE_UNPROVEN");
      routes.push({ ...route, cnames, tlsAuthorized: true, certificateSha256: acceptanceEvidenceHash(result.fingerprint), healthSha256: acceptanceEvidenceHash(result.body) });
    }
    return { complete: true, bindingSha256: acceptanceEvidenceHash(b), observedAt: new Date().toISOString(), routes };
  } catch (e) { throw e instanceof AcceptanceError ? e : new AcceptanceError("ACCEPTANCE_ROUTING_UNPROVEN"); }
  finally { bounded.removeEventListener("abort", cancel); }
}

/** Independent private evidence store has assertPrivate/readOptional/createOnly.
 * All keys are acceptance/<domain>/<global-intent>/<canonical-content-hash>.json.
 * Attestations are full retained operator-reviewed receipts, not claims that
 * this module exercised business workflows. Fresh network/runtime/source checks
 * are distinct. Reconciliation never changes DNS or runtime configuration.
 * Private worker observation may run an immutable read-only probe job under the
 * actual pending phase; unknown start acknowledgement follows its own recorder.
 */
export async function runOpsCoreAcceptance({ phase, binding: input, custody, evidenceStore: store, artifact: inputArtifact,
  observeRuntime, assertSourceFenced, verifyRouting = verifyOpsCorePublicRouting }) {
  try {
    const b = validateOpsCoreAcceptanceBinding(input), artifact = structuredClone(inputArtifact), digest = acceptanceEvidenceHash, signal = custody?.signal;
    need(["ROUTED", "ACCEPTED"].includes(phase) && signal instanceof AbortSignal
      && [custody?.assertOwned, custody?.snapshot, custody?.begin, custody?.complete, store?.assertPrivate, store?.readOptional,
        store?.createOnly, observeRuntime, assertSourceFenced, verifyRouting].every(f => typeof f === "function"), "ACCEPTANCE_OPTIONS_INVALID");
    const key = h => `acceptance/${b.domain}/${b.intentSha256}/${h}.json`;
    async function owned() {
      signal.throwIfAborted(); await custody.assertOwned(); signal.throwIfAborted();
      const j = validateCutoverJournal(custody.snapshot(), b.intentSha256);
      need(j.domain === b.domain && j.destinationMayHaveWritten === true
        && j.history.find(x => x.phase === "SOURCE_FENCED")?.evidenceSha256 === b.sourceFenceSha256, "ACCEPTANCE_CUSTODY_MISMATCH");
      return j;
    }
    async function read(h) {
      need(HASH.test(h), "ACCEPTANCE_EVIDENCE_INVALID"); await owned(); await store.assertPrivate();
      const text = await store.readOptional(key(h), signal); await owned();
      need(typeof text === "string" && Buffer.byteLength(text) <= 512 * 1024, "ACCEPTANCE_EVIDENCE_MISSING");
      const value = JSON.parse(text); need(digest(value) === h, "ACCEPTANCE_EVIDENCE_CHANGED"); return value;
    }
    async function retain(value) {
      const h = digest(value), text = JSON.stringify(value); need(Buffer.byteLength(text) <= 512 * 1024, "ACCEPTANCE_EVIDENCE_TOO_LARGE");
      await owned(); await store.assertPrivate();
      const old = await store.readOptional(key(h), signal); await owned();
      if (old === null) { await store.createOnly(key(h), text, signal); await owned(); }
      need(same(await read(h), value), "ACCEPTANCE_EVIDENCE_CHANGED"); return h;
    }
    need(exact(artifact, "schemaVersion,phase,binding,issuedAt,expiresAt,attestations") && artifact.schemaVersion === 1
      && artifact.phase === phase && same(artifact.binding, b) && timestamp(artifact.issuedAt) && timestamp(artifact.expiresAt)
      && Date.parse(artifact.expiresAt) > Date.parse(artifact.issuedAt)
      && Date.parse(artifact.expiresAt) - Date.parse(artifact.issuedAt) <= 24 * 60 * 60 * 1000
      && Array.isArray(artifact.attestations), "ACCEPTANCE_ARTIFACT_INVALID");
    const artifactSha256 = digest(artifact), initial = await owned();
    // A lost completion acknowledgement is historical readback, never a fresh
    // health claim or authorization for another effect.
    const completed = initial.history.find(x => x.phase === phase);
    if (completed) {
      need(completed.intentSha256 === artifactSha256, "ACCEPTANCE_COMPLETED_INTENT_MISMATCH");
      const receipt = await read(completed.evidenceSha256);
      need(receipt.type === "OPS_CORE_ACCEPTANCE" && receipt.phase === phase && receipt.artifactSha256 === artifactSha256
        && receipt.operationId === completed.operationId && same(receipt.binding, b) && same(await read(artifactSha256), artifact), "ACCEPTANCE_RECEIPT_INVALID");
      return { complete: true, historical: true, phase, domain: b.domain, evidenceSha256: completed.evidenceSha256 };
    }
    const fresh = () => need(Date.parse(artifact.issuedAt) <= Date.now() && Date.parse(artifact.expiresAt) > Date.now(), "ACCEPTANCE_ARTIFACT_EXPIRED");
    // Expiry governs admission only. A pending observation-only phase retains
    // its original intent and must remain reconcilable after a long outage.
    if (!initial.pending) fresh();
    need(initial.phase === (phase === "ROUTED" ? "TARGET_ACTIVE" : "ROUTED")
      && (!initial.pending || initial.pending.to === phase && initial.pending.intentSha256 === artifactSha256), "ACCEPTANCE_PHASE_MISMATCH");
    if (initial.pending) need(same(await read(artifactSha256), artifact), "ACCEPTANCE_EVIDENCE_CHANGED");
    need(phase === "ACCEPTED" ? same(artifact.attestations.map(a => a?.kind).sort(), [...KINDS].sort()) : artifact.attestations.length === 0, "ACCEPTANCE_ATTESTATIONS_REQUIRED");
    const attestations = [];
    for (const ref of artifact.attestations) {
      need(exact(ref, "kind,name,evidenceSha256") && KINDS.includes(ref.kind) && label(ref.name) && HASH.test(ref.evidenceSha256), "ACCEPTANCE_ATTESTATION_INVALID");
      const a = await read(ref.evidenceSha256);
      need(exact(a, "schemaVersion,binding,kind,name,observedAt,outcome,attestationType,reviewedBy,details")
        && a.schemaVersion === 1 && same(a.binding, b) && a.kind === ref.kind && a.name === ref.name
        && timestamp(a.observedAt) && Date.parse(a.observedAt) <= Date.parse(artifact.issuedAt) && a.outcome === "passed"
        && a.attestationType === "operator-reviewed" && label(a.reviewedBy) && object(a.details) && Object.keys(a.details).length > 0,
      "ACCEPTANCE_ATTESTATION_INVALID"); attestations.push(a);
    }
    await retain(artifact); // Durable exact intent before the journal transition.
    const pending = initial.pending ?? await custody.begin(phase, artifactSha256);
    const guard = async () => { const j = await owned(); need(j.pending?.operationId === pending.operationId
      && j.pending?.to === phase && j.pending?.intentSha256 === artifactSha256, "ACCEPTANCE_PHASE_CHANGED"); };
    async function source() {
      await guard(); const s = await assertSourceFenced(); await guard();
      need(s?.complete === true && s.domain === b.domain && s.intentSha256 === b.intentSha256 && s.sourceFenceSha256 === b.sourceFenceSha256, "ACCEPTANCE_SOURCE_UNPROVEN");
      return { complete: true, domain: s.domain, intentSha256: s.intentSha256, sourceFenceSha256: s.sourceFenceSha256 };
    }
    await source();
    const runtime = await observeRuntime({ customDomains: b.routes.map(r => new URL(r.publicOrigin).hostname), signal }); await guard();
    need(runtime?.complete === true && runtime.domain === b.domain && runtime.intentSha256 === b.intentSha256
      && runtime.targetBindingSha256 === b.targetBindingSha256 && same(runtime.release, b.release)
      && b.routes.every(r => r.azureOrigin === runtime.origins?.web), "ACCEPTANCE_RUNTIME_UNPROVEN");
    const routing = await verifyRouting({ binding: structuredClone(b), signal }); await guard();
    need(routing?.complete === true && routing.bindingSha256 === digest(b) && timestamp(routing.observedAt)
      && Date.parse(routing.observedAt) >= Date.parse(artifact.issuedAt) && Date.parse(routing.observedAt) <= Date.now()
      && Array.isArray(routing.routes) && same(routing.routes.map(r => ({ publicOrigin: r.publicOrigin, azureOrigin: r.azureOrigin, expectedCname: r.expectedCname })), b.routes), "ACCEPTANCE_ROUTING_UNPROVEN");
    const sourceProof = await source();
    const receipt = { schemaVersion: 1, type: "OPS_CORE_ACCEPTANCE", phase, binding: b, artifactSha256,
      operationId: pending.operationId, observedAt: new Date().toISOString(), routing, runtime, source: sourceProof, attestations };
    const evidenceSha256 = await retain(receipt); await guard();
    await custody.complete(pending.operationId, evidenceSha256);
    return { complete: true, historical: false, phase, domain: b.domain, evidenceSha256 };
  } catch (e) { throw e instanceof AcceptanceError ? e : new AcceptanceError("ACCEPTANCE_RECONCILIATION_REQUIRED"); }
}
