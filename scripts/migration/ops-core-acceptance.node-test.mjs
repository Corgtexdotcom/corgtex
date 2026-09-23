import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { CUTOVER_PHASES, createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { acceptanceEvidenceHash as hash, runOpsCoreAcceptance, validateOpsCoreAcceptanceBinding, verifyOpsCorePublicRouting } from "./ops-core-acceptance.mjs";
const H = char => char.repeat(64);
const release = { gitSha: "a".repeat(40), imageTag: `sha-${"a".repeat(40)}`, version: "fixture" };
const route = publicOrigin => ({ publicOrigin, azureOrigin: "https://fixture.env.azurecontainerapps.io", expectedCname: "fixture.env.azurecontainerapps.io" });
const binding = { domain: "ops", intentSha256: H("b"), targetBindingSha256: H("c"), sourceFenceSha256: H("d"), release, routes: [route("https://ops.corgtex.com")] };
function artifact(phase, b = binding) {
  return { schemaVersion: 1, phase, binding: structuredClone(b), issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(), attestations: [] };
}
async function fixture() {
  let text = JSON.stringify(createCutoverJournal({ domain: binding.domain, intentSha256: binding.intentSha256, evidenceSha256: H("e") })), etag = 0, lease;
  const records = new Map(), state = { failWrite: null, failStore: false, runtime: true, source: true, routing: true, probes: 0 };
  const blob = { async acquire() { assert(!lease); return lease = crypto.randomUUID(); }, async release(l) { assert.equal(l, lease); lease = null; },
    async renew(l) { assert.equal(l, lease); }, async read(l) { assert.equal(l, lease); return { text, etag }; },
    async write(next, conditions) { assert.equal(conditions.lease, lease); assert.equal(conditions.etag, etag); text = next; etag++;
      if (state.failWrite?.(JSON.parse(next))) { state.failWrite = null; throw new Error("PRIVATE_PROVIDER_TEXT"); } return { etag }; } };
  let custody = await openCutoverCustody(blob, binding.intentSha256);
  for (const phase of CUTOVER_PHASES.slice(1, 7)) { const p = await custody.begin(phase, H("e")); await custody.complete(p.operationId, phase === "SOURCE_FENCED" ? binding.sourceFenceSha256 : H("e")); }
  const store = { assertPrivate: async () => {}, readOptional: async k => records.get(k) ?? null,
    createOnly: async (k, v) => { assert(!records.has(k)); records.set(k, v); if (state.failStore) { state.failStore = false; throw new Error("PRIVATE_PROVIDER_TEXT"); } } };
  const options = () => ({ phase: "ROUTED", binding, custody, evidenceStore: store,
    observeRuntime: async ({ customDomains }) => { state.probes++; assert.deepEqual(customDomains, ["ops.corgtex.com"]); return { complete: state.runtime, domain: binding.domain, intentSha256: binding.intentSha256, targetBindingSha256: binding.targetBindingSha256, release, origins: { web: binding.routes[0].azureOrigin } }; },
    assertSourceFenced: async () => ({ complete: state.source, domain: binding.domain, intentSha256: binding.intentSha256, sourceFenceSha256: binding.sourceFenceSha256 }),
    verifyRouting: async () => ({ complete: state.routing, bindingSha256: hash(binding), observedAt: new Date().toISOString(), routes: binding.routes }) });
  const run = (a, overrides = {}) => runOpsCoreAcceptance({ ...options(), artifact: a, ...overrides });
  return { state, records, store, run, options, snapshot: () => custody.snapshot(), close: () => custody.close(),
    reopen: async () => { await custody.close(); custody = await openCutoverCustody(blob, binding.intentSha256); },
    get persisted() { return JSON.parse(text); },
    attest(a) { for (const kind of ["workflow", "data", "jobs", "callbacks", "backupRecovery", "updateRecovery"]) {
      const receipt = { schemaVersion: 1, binding, kind, name: `named ${kind} fixture`, observedAt: a.issuedAt, outcome: "passed", attestationType: "operator-reviewed",
        reviewedBy: "fixture-operator", details: { receipt: `bounded ${kind} acceptance test outcome` } };
      const h = hash(receipt); records.set(`acceptance/ops/${binding.intentSha256}/${h}.json`, JSON.stringify(receipt)); a.attestations.push({ kind, name: receipt.name, evidenceSha256: h });
    } },
  };
}

test("actual custody reaches ROUTED then ACCEPTED only with all full immutable reviewed receipts", async () => {
  const f = await fixture(); try {
    const r = artifact("ROUTED"); const routed = await f.run(r); assert.equal(routed.historical, false); assert.equal(f.snapshot().phase, "ROUTED");
    const a = artifact("ACCEPTED"); f.attest(a); const accepted = await f.run(a, { phase: "ACCEPTED" }); assert.equal(f.snapshot().phase, "ACCEPTED");
    const retained = JSON.parse(f.records.get(`acceptance/ops/${binding.intentSha256}/${accepted.evidenceSha256}.json`));
    assert.equal(retained.attestations.length, 6); assert.equal(retained.attestations[0].details.receipt, "bounded workflow acceptance test outcome");
    const before = f.state.probes; assert.equal((await f.run(a, { phase: "ACCEPTED" })).historical, true); assert.equal(f.state.probes, before);
  } finally { await f.close(); }
});
for (const boundary of ["begin", "complete"]) test(`lost ${boundary} acknowledgement reopens without journal editing`, async () => {
  const f = await fixture(), a = artifact("ROUTED"); try {
    f.state.failWrite = j => boundary === "begin" ? j.pending?.to === "ROUTED" : j.phase === "ROUTED";
    await assert.rejects(f.run(a), /^Error: ACCEPTANCE_RECONCILIATION_REQUIRED$/);
    await f.reopen(); const result = await f.run(a); assert.equal(result.historical, boundary === "complete"); assert.equal(f.snapshot().phase, "ROUTED");
  } finally { await f.close(); }
});
test("artifact retained before begin; lost storage acknowledgement makes no journal transition", async () => {
  const f = await fixture(), a = artifact("ROUTED"); try {
    f.state.failStore = true; await assert.rejects(f.run(a), /ACCEPTANCE_RECONCILIATION_REQUIRED/);
    assert.equal(f.snapshot().pending, null); assert.equal(f.state.probes, 0); assert.equal((await f.run(a)).complete, true);
  } finally { await f.close(); }
});
for (const failure of ["source", "runtime", "routing"]) test(`fresh ${failure} failure cannot complete routing`, async () => {
  const f = await fixture(); try { f.state[failure] = false; await assert.rejects(f.run(artifact("ROUTED")), /ACCEPTANCE_.*UNPROVEN/);
    assert.equal(f.snapshot().phase, "TARGET_ACTIVE"); assert.equal(f.snapshot().pending.to, "ROUTED");
  } finally { await f.close(); }
});
test("health alone and missing hashed receipts cannot authorize ACCEPTED", async () => {
  const f = await fixture(); try {
    await f.run(artifact("ROUTED")); const a = artifact("ACCEPTED"); await assert.rejects(f.run(a, { phase: "ACCEPTED" }), /ATTESTATIONS_REQUIRED/);
    f.attest(a); f.records.delete(`acceptance/ops/${binding.intentSha256}/${a.attestations[0].evidenceSha256}.json`);
    await assert.rejects(f.run(a, { phase: "ACCEPTED" }), /EVIDENCE_MISSING/); assert.equal(f.snapshot().pending, null);
  } finally { await f.close(); }
});
test("foreign receipt binding, wrong hash, expired and changed pending artifacts fail closed", async () => {
  const f = await fixture(); try {
    const expired = artifact("ROUTED"); expired.issuedAt = new Date(Date.now() - 10000).toISOString(); expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    await assert.rejects(f.run(expired), /ARTIFACT_EXPIRED/);
    f.state.routing = false; const a = artifact("ROUTED"); await assert.rejects(f.run(a));
    const changed = structuredClone(a); changed.issuedAt = new Date(Date.parse(a.issuedAt) - 1).toISOString();
    await assert.rejects(f.run(changed), /PHASE_MISMATCH/); f.state.routing = true; await f.run(a);
    const accepted = artifact("ACCEPTED"); f.attest(accepted); const ref = accepted.attestations[0], key = `acceptance/ops/${binding.intentSha256}/${ref.evidenceSha256}.json`;
    const altered = JSON.parse(f.records.get(key)); altered.binding.domain = "core"; f.records.set(key, JSON.stringify(altered));
    await assert.rejects(f.run(accepted, { phase: "ACCEPTED" }), /EVIDENCE_CHANGED/);
    ref.evidenceSha256 = hash(altered); f.records.set(`acceptance/ops/${binding.intentSha256}/${ref.evidenceSha256}.json`, JSON.stringify(altered));
    await assert.rejects(f.run(accepted, { phase: "ACCEPTED" }), /ATTESTATION_INVALID/);
  } finally { await f.close(); }
});
test("Core requires both app and mcp routes and cannot use another public hostname", () => {
  const b = { ...binding, domain: "core", routes: [route("https://app.corgtex.com")] };
  assert.throws(() => validateOpsCoreAcceptanceBinding(b), /ROUTES_INVALID/); b.routes.push(route("https://mcp.corgtex.com")); assert.deepEqual(validateOpsCoreAcceptanceBinding(b), b);
  b.routes[1].publicOrigin = "https://foreign.example"; assert.throws(() => validateOpsCoreAcceptanceBinding(b), /ROUTES_INVALID/);
});
function network({ cnames = [binding.routes[0].expectedCname], authorized = true, status = 200, body, huge = false } = {}) {
  let calls = 0;
  const resolver = { cancel() {}, async resolveCname(host) { assert.equal(host, "ops.corgtex.com"); return cnames; } };
  const request = (url, options, callback) => { calls++; assert.equal(url, "https://ops.corgtex.com/api/health"); assert.equal(options.rejectUnauthorized, true); assert.equal(options.method, "GET");
    const req = new EventEmitter(); req.end = () => { const r = new EventEmitter(); r.statusCode = status; r.headers = { "content-type": "application/json" }; r.destroy = () => {};
      r.socket = { authorized, getPeerCertificate: () => ({ fingerprint256: "fixture certificate fingerprint", valid_to: new Date(Date.now() + 60000).toISOString() }) };
      callback(r); if (status === 200 && authorized) { r.emit("data", Buffer.from(huge ? "x".repeat(32769) : JSON.stringify(body ?? {}))); r.emit("end"); } };
    return req;
  };
  return { resolver, request, calls: () => calls };
}
for (const [name, input] of [["foreign DNS", { cnames: ["other.example"] }], ["redirect", { status: 302 }], ["unverified TLS", { authorized: false }], ["oversized", { huge: true }], ["wrong release", { body: {} }]])
  test(`actual routing implementation rejects ${name} without following redirects`, async () => {
    const net = network(input); await assert.rejects(verifyOpsCorePublicRouting({ binding, signal: new AbortController().signal }, net), /ACCEPTANCE_/);
    assert.equal(net.calls(), name === "foreign DNS" ? 0 : 1);
  });
test("raw network/provider errors never escape", async () => {
  await assert.rejects(verifyOpsCorePublicRouting({ binding, signal: new AbortController().signal }, { resolver: { cancel() {}, resolveCname: async () => { throw new Error("PRIVATE_SECRET"); } } }), /^Error: ACCEPTANCE_ROUTING_UNPROVEN$/);
  const f = await fixture(); try { await assert.rejects(f.run(artifact("ROUTED"), { observeRuntime: async () => { throw new Error("PRIVATE_SECRET"); } }), /^Error: ACCEPTANCE_RECONCILIATION_REQUIRED$/); } finally { await f.close(); }
});

test("actual routing implementation retains TLS/DNS and exact healthy release hashes", async () => {
  const body = { status: "ok", service: "web", database: "up", schema: "ready", app: "corgtex", release };
  const net = network({ body });
  const proof = await verifyOpsCorePublicRouting({ binding, signal: new AbortController().signal }, net);
  assert.equal(proof.complete, true); assert.equal(proof.bindingSha256, hash(binding)); assert.equal(proof.routes[0].tlsAuthorized, true);
  assert.equal(proof.routes[0].healthSha256, hash(body)); assert.deepEqual(proof.routes[0].cnames, [binding.routes[0].expectedCname]);
});
test("aborted routing never starts DNS or HTTPS", async () => {
  const abort = new AbortController(); abort.abort(); const net = network();
  await assert.rejects(verifyOpsCorePublicRouting({ binding, signal: abort.signal }, net), /ACCEPTANCE_ROUTING_UNPROVEN/); assert.equal(net.calls(), 0);
});
test("full receipt storage acknowledgement loss remains pending and repeats only observations", async () => {
  const f = await fixture(), a = artifact("ROUTED"); try {
    const original = f.options().observeRuntime;
    await assert.rejects(f.run(a, { observeRuntime: async input => { f.state.failStore = true; return original(input); } }), /ACCEPTANCE_RECONCILIATION_REQUIRED/);
    assert.equal(f.snapshot().phase, "TARGET_ACTIVE"); assert.equal(f.snapshot().pending.to, "ROUTED");
    await f.reopen(); const result = await f.run(a); assert.equal(result.complete, true); assert.equal(f.state.probes, 2);
  } finally { await f.close(); }
});
test("completed phase refuses a different artifact and corrupted retained proof", async () => {
  const f = await fixture(), a = artifact("ROUTED"); try {
    const result = await f.run(a), changed = structuredClone(a); changed.expiresAt = new Date(Date.parse(a.expiresAt) + 1).toISOString();
    await assert.rejects(f.run(changed), /COMPLETED_INTENT_MISMATCH/);
    f.records.set(`acceptance/ops/${binding.intentSha256}/${result.evidenceSha256}.json`, JSON.stringify({ type: "OPS_CORE_ACCEPTANCE" }));
    await assert.rejects(f.run(a), /EVIDENCE_CHANGED/);
  } finally { await f.close(); }
});

test("fresh ARM origin must equal every retained route target even when release health matches", async () => {
  const f = await fixture(); try {
    const original = f.options().observeRuntime;
    await assert.rejects(f.run(artifact("ROUTED"), { observeRuntime: async input => ({ ...await original(input), origins: { web: "https://fixture.foreign.azurecontainerapps.io" } }) }), /RUNTIME_UNPROVEN/);
    assert.equal(f.snapshot().phase, "TARGET_ACTIVE");
  } finally { await f.close(); }
});


for (const phase of ["ROUTED","ACCEPTED"]) test(`expired admitted ${phase} artifact reconciles through fresh observations without replacing intent`, async t => {
  const f=await fixture();try {
    if(phase === "ACCEPTED") await f.run(artifact("ROUTED"));
    const a=artifact(phase);if(phase === "ACCEPTED")f.attest(a);
    f.state.routing=false;await assert.rejects(f.run(a,{phase}));
    const pending=f.snapshot().pending;const before=f.state.probes;
    t.mock.method(Date,"now",()=>Date.parse(a.expiresAt)+1000);
    f.state.routing=true;const result=await f.run(a,{phase});
    assert.equal(result.complete,true);assert.equal(f.state.probes,before+1);
    const last=f.snapshot().history.at(-1);assert.equal(last.operationId,pending.operationId);
    assert.equal(last.intentSha256,hash(a));
  } finally {await f.close();}
});
