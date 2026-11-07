import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { hotfixEvidenceManifestPath, decodeHotfixArchive, validateHotfixBuildEvidence, validateHotfixProofEvidence } from "./selfserve-hotfix-evidence.mjs";

import { validateHotfixTarget } from "./selfserve-hotfix-source.mjs";

const sha = (char) => char.repeat(40), hex = (char) => char.repeat(64);
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fixture(sourceRole = "candidate") {
  const expected = { repository: "Corgtexdotcom/corgtex", candidateSha: sha("a"), candidateTree: sha("b"),
    baseSha: sha("c"), recoverySha: sha("c"), toolingSha: sha("d"), manifestSha256: hex("e"),
    targetId: "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16", origin: "https://selfserve.corgtex.com",
    schemaSha256: hex("f"), prismaTree: sha("8"), sourceRole, runId: 123, runAttempt: 1, artifactId: 456 };
  const sourceSha = sourceRole === "candidate" ? expected.candidateSha : expected.recoverySha;
  const run = { id: 123, run_attempt: 1, event: "workflow_dispatch", head_branch: "main",
    head_sha: expected.toolingSha, status: "completed", conclusion: "success", path: ".github/workflows/release-images.yml", workflow_id: 789,
    repository: { full_name: expected.repository, id: 12 }, head_repository: { full_name: expected.repository, id: 12 },
    actor: { id: 10 }, triggering_actor: { id: 10 } };
  const workflow = { id: 789, path: run.path };
  const jobs = [{ name: "Build and publish web/worker images", run_id: 123, run_attempt: 1, head_sha: expected.toolingSha, status: "completed", conclusion: "success" }];
  const approvals = [{ state: "approved", user: { login: "beepto-codex", id: 278524841 }, environments: [{ id: 17085878745, name: "fleet-release-production" }] }];
  const artifact = { id: 456, name: "release-image-digests-123-1", expired: false, digest: `sha256:${hex("1")}`,
    workflow_run: { id: 123, head_sha: expected.toolingSha, head_branch: run.head_branch, repository_id: 12, head_repository_id: 12 } };
  const receipt = { schemaVersion: 2, mode: "candidate-build", admissionId: "selfserve-switcher", sourceRole, sourceSha,
    toolingSha: expected.toolingSha, runId: expected.runId, runAttempt: expected.runAttempt,
    source: { schemaVersion: 1, repository: expected.repository, admission: "hotfix", sourceSha: expected.candidateSha,
      sourceTree: expected.candidateTree, prismaTree: expected.prismaTree, schemaSha256: expected.schemaSha256,
      toolingSha: expected.toolingSha, manifestSha256: expected.manifestSha256, recoverySha: expected.recoverySha,
      ...validateHotfixTarget(expected, expected) },
    images: { web: { digest: `sha256:${hex("2")}` }, worker: { digest: `sha256:${hex("3")}` } } };
  return { data: { run, workflow, jobs, approvals, artifact, receipt, toolingTrusted: true }, expected };
}
for (const role of ["candidate", "recovery"]) test(`accepts exact approved ${role} image pair from the protected-main producer`, () => {
  const { data, expected } = fixture(role);
  const value = validateHotfixBuildEvidence(data, expected);
  assert.equal(value.kind, "selfserve-hotfix-build-proof");
  assert.equal(value.sourceRole, role);
  assert.equal(value.manifestSha256, expected.manifestSha256);
  assert.equal(value.images.web, `ghcr.io/corgtexdotcom/corgtex/web@sha256:${hex("2")}`);
});
const rejected = [
  ["another source SHA", (d) => { d.run.head_sha = sha("9"); }],
  ["fork", (d) => { d.run.head_repository.full_name = "other/corgtex"; }],
  ["wrong workflow", (d) => { d.run.workflow_id++; }],
  ["pull request event", (d) => { d.run.event = "pull_request"; }],
  ["failed run", (d) => { d.run.conclusion = "failure"; }],
  ["skipped publishing job", (d) => { d.jobs[0].conclusion = "skipped"; }],
  ["duplicate publisher", (d) => { d.jobs.push(d.jobs[0]); }],
  ["job from another attempt", (d) => { d.jobs[0].run_attempt = 2; }],
  ["rerun without attempt-bound approval", (d, e) => { d.run.run_attempt = e.runAttempt = 2; }],
  ["no protected approval", (d) => { d.approvals = []; }],
  ["self review", (d) => { d.run.actor.id = 278524841; }],
  ["other reviewer", (d) => { d.approvals[0].user.id++; }],
  ["other environment", (d) => { d.approvals[0].environments[0].id++; }],
  ["expired artifact", (d) => { d.artifact.expired = true; }],
  ["other artifact ID", (d) => { d.artifact.id++; }],
  ["artifact from another run", (d) => { d.artifact.workflow_run.id++; }],
  ["missing digest", (d) => { delete d.artifact.digest; }],
  ["other receipt source", (d) => { d.receipt.sourceSha = sha("9"); }],
  ["mutable image tag", (d) => { d.receipt.images.worker.digest = "latest"; }],
  ["extra receipt authority", (d) => { d.receipt.targetId = "another-target"; }],
  ["untrusted producer tooling", (d) => { d.toolingTrusted = false; }],
];
for (const [name, change] of rejected) test(`rejects ${name}`, () => {
  const { data, expected } = fixture(); change(data, expected);
  assert.throws(() => validateHotfixBuildEvidence(data, expected), /HOTFIX_/);
});

function proofFixture(role = "candidate") {
  const { data, expected } = fixture(role);
  const build = validateHotfixBuildEvidence(data, expected);
  data.run.head_branch = "main"; data.run.head_sha = expected.toolingSha;
  data.jobs[0].name = "Isolated immutable web and worker startup proof"; data.jobs[0].head_sha = expected.toolingSha;
  data.artifact.name = "immutable-startup-proof-123-1";
  data.artifact.workflow_run.head_branch = "main"; data.artifact.workflow_run.head_sha = expected.toolingSha;
  expected.migrationLedgerSha256 = hex("4"); expected.migrationCount = 3;
  const hotfix = Object.fromEntries(["manifestSha256", "candidateSha", "candidateTree", "sourceRole", "targetId", "origin", "recoverySha", "toolingSha", "runId", "runAttempt"].map((key) => [key, expected[key]]));
  Object.assign(hotfix, { buildRunId: build.runId, buildRunAttempt: build.runAttempt, buildArtifactId: build.artifactId });
  data.startup = { schemaVersion: 1, sourceSha: build.sourceSha, schemaSha: expected.baseSha,
    status: "passed", stage: "STARTUP", cleanup: "completed", schemaSha256: expected.schemaSha256,
    migrationLedgerSha256: expected.migrationLedgerSha256, migrationCount: 3,
    isolation: "internal-network;synthetic-only;normal-entrypoints;no-published-ports-or-host-mounts", hotfix,
    images: build.images, roles: {} };
  for (const r of ["web", "worker"]) data.startup.roles[r] = { image: build.images[r], bakedSha: build.sourceSha,
    normalEntrypoint: ["docker-entrypoint.sh"], normalCommand: r === "web" ? ["sh", "/app/deploy/entrypoint.sh"] : ["node", "/app/scripts/start-worker.mjs"],
    health: { status: "ok", database: "up", schema: "ready", phase: "running", tickCount: 1, lastError: null, lastSuccessfulTickAt: "2026-11-06T00:00:00Z",
      release: { runtime: { gitSha: build.sourceSha, evidence: "baked" }, configured: { gitSha: build.sourceSha }, drift: { gitSha: false, imageTag: false, version: false } } } };
  data.preparation = { status: "staged", authCleanup: "completed", runtimeStarted: false, sourceSha: build.sourceSha,
    schemaSha: expected.baseSha, images: build.images };
  return { data, expected, build };
}
for (const role of ["candidate", "recovery"]) test(`accepts ${role} startup only on identical live-base schema and authenticated build images`, () => {
  const { data, expected, build } = proofFixture(role);
  assert.equal(validateHotfixProofEvidence(data, expected, build).kind, "selfserve-hotfix-startup-proof");
});
for (const [name, change] of [
  ["schema substitution", (d) => { d.startup.schemaSha = sha("9"); }],
  ["migration substitution", (d) => { d.startup.migrationLedgerSha256 = hex("9"); }],
  ["different build run", (d) => { d.startup.hotfix.buildRunId++; }],
  ["different target", (d) => { d.startup.hotfix.targetId = "other"; }],
  ["different image", (d) => { d.startup.roles.web.image = "ghcr.io/other/web@sha256:" + hex("2"); }],
  ["unbaked worker", (d) => { d.startup.roles.worker.health.release.runtime.evidence = "configured"; }],
  ["no worker cycle", (d) => { d.startup.roles.worker.health.tickCount = 0; }],
  ["custom entrypoint", (d) => { d.startup.roles.web.normalCommand = ["true"]; }],
  ["incomplete cleanup", (d) => { d.startup.cleanup = "failed"; }],
  ["untrusted proof branch", (d) => { d.run.head_branch = "release/anything"; }],
]) test(`rejects proof ${name}`, () => { const { data, expected, build } = proofFixture(); change(data); assert.throws(() => validateHotfixProofEvidence(data, expected, build), /HOTFIX_/); });

function zip(files, mode = 0x81a4) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const n = Buffer.from(name), raw = Buffer.from(JSON.stringify(value)), body = deflateRawSync(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE((mode * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, n, body); centrals.push(central, n); offset += local.length + n.length + body.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
test("decodes only the authenticated bounded regular-file entry set", () => {
  const files = { "startup.json": { passed: true }, "preparation.json": { staged: true } }, bytes = zip(files);
  assert.deepEqual(decodeHotfixArchive(bytes, digest(bytes), Object.keys(files)), files);
});
test("rejects changed archive bytes and unexpected archive entries", () => {
  const bytes = zip({ "release-image-digests.json": { schemaVersion: 1 } });
  assert.throws(() => decodeHotfixArchive(bytes, `sha256:${hex("0")}`, ["release-image-digests.json"]), /DIGEST_MISMATCH/);
  assert.throws(() => decodeHotfixArchive(bytes, digest(bytes), ["startup.json"]), /ZIP_INVALID/);
});
test("rejects archive symlinks and path traversal without extracting", () => {
  for (const bytes of [zip({ "release-image-digests.json": {} }, 0xa1ff), zip({ "../release-image-digests.json": {} })])
    assert.throws(() => decodeHotfixArchive(bytes, digest(bytes), ["release-image-digests.json"]), /ZIP_INVALID/);
});
test("rejects oversized decompressed content before inflation", () => {
  const bytes = zip({ "release-image-digests.json": { value: "x".repeat(70000) } });
  assert.throws(() => decodeHotfixArchive(bytes, digest(bytes), ["release-image-digests.json"]), /ZIP_INVALID/);
});

test("fetches the exact run attempt and digest-bound archive without forwarding its token", async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { verifyHotfixBuildEvidence } = await import("./selfserve-hotfix-evidence.mjs");
  const directory = await mkdtemp(join(tmpdir(), "hotfix-evidence-test-"));
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init"); await mkdir(join(directory, ".github/workflows"), { recursive: true });
    await writeFile(join(directory, ".github/workflows/release-images.yml"), "reviewed publisher\n");
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    await writeFile(join(directory, "candidate.txt"), "switcher\n");
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "candidate");
    const candidate = git("rev-parse", "HEAD");
    const { data, expected } = fixture(); expected.baseSha = expected.recoverySha = base; expected.candidateSha = candidate;
    const manifest = "fixture admitted candidate\n";
    await writeFile(join(directory, ".github/selfserve-switcher-hotfix.json"), manifest);
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "trusted tooling");
    const tooling = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", tooling);
    expected.toolingSha = tooling; expected.manifestSha256 = createHash("sha256").update(manifest).digest("hex");
    data.run.head_sha = data.jobs[0].head_sha = data.artifact.workflow_run.head_sha = tooling;
    data.receipt.sourceSha = candidate; data.receipt.toolingSha = tooling;
    Object.assign(data.receipt.source, { sourceSha: candidate, toolingSha: tooling, recoverySha: base, manifestSha256: expected.manifestSha256 });
    let archive = zip({ "release-image-digests.json": data.receipt }); data.artifact.digest = digest(archive);
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url === "https://proof.blob.core.windows.net/archive?signature=private") {
        assert.equal(options.headers, undefined); assert.equal(options.redirect, "error");
        return new Response(archive);
      }
      assert.equal(options.headers.authorization, "Bearer fixture-token");
      if (url.endsWith("/zip")) return new Response(null, { status: 302, headers: { location: "https://proof.blob.core.windows.net/archive?signature=private" } });
      const value = url.endsWith("/attempts/1") ? data.run : url.endsWith("/workflows/release-images.yml") ? data.workflow
        : url.endsWith("/artifacts/456") ? data.artifact : url.endsWith("/approvals") ? data.approvals
          : url.includes("/attempts/1/jobs?") ? { jobs: data.jobs, total_count: 1 } : null;
      assert.notEqual(value, null, url);
      return Response.json(value);
    };
    const result = await verifyHotfixBuildEvidence({ runId: 123, runAttempt: 1, artifactId: 456, expected,
      sourceRoot: directory, toolingRoot: directory, token: "fixture-token", fetchImpl });
    assert.equal(result.sourceSha, candidate);
    assert(calls.some(({ url }) => url.endsWith("/attempts/1")));
    const badDownload = async (url, options) => url.endsWith("/zip")
      ? new Response(null, { status: 302, headers: { location: "https://attacker.invalid/archive" } }) : fetchImpl(url, options);
    await assert.rejects(verifyHotfixBuildEvidence({ runId: 123, runAttempt: 1, artifactId: 456, expected,
      sourceRoot: directory, toolingRoot: directory, token: "fixture-token", fetchImpl: badDownload }), /DOWNLOAD_HOST_INVALID/);
    await assert.rejects(verifyHotfixBuildEvidence({ runId: 123, runAttempt: 1, artifactId: 456,
      expected: { ...expected, manifestSha256: hex("0") }, toolingRoot: directory,
      token: "fixture-token", fetchImpl }), /TOOLING_UNTRUSTED/);
    archive = zip({ "release-image-digests.json": { schemaVersion: 1, sourceSha: candidate, images: data.receipt.images } });
    data.artifact.digest = digest(archive);
    await assert.rejects(verifyHotfixBuildEvidence({ runId: 123, runAttempt: 1, artifactId: 456, expected,
      sourceRoot: directory, toolingRoot: directory, token: "fixture-token", fetchImpl }), /PRODUCER_VERSION_INVALID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Synthetic target identities only: no executable Ops admission is created.
function opsProofFixture(role = "candidate") {
  const result = proofFixture(role);
  const binding = { admissionId: "ops-release-authority", provider: "railway", deploymentId: null,
    targetId: "ops-fixture", origin: "https://ops.corgtex.com", railway: {
      projectId: "11111111-1111-4111-8111-111111111111", environmentId: "22222222-2222-4222-8222-222222222222",
      webServiceId: "33333333-3333-4333-8333-333333333333", workerServiceId: "44444444-4444-4444-8444-444444444444" } };
  for (const value of [result.expected, result.data.startup.hotfix]) Object.assign(value, structuredClone(validateHotfixTarget(binding, binding)));
  result.build = { ...result.build, ...structuredClone(validateHotfixTarget(binding, binding)) };
  return result;
}
for (const role of ["candidate", "recovery"]) test(`binds synthetic Ops ${role} startup to the exact Railway target and explicit absent deployment`, () => {
  const { data, expected, build } = opsProofFixture(role);
  const proof = validateHotfixProofEvidence(data, expected, build);
  assert.equal(proof.provider, "railway"); assert.equal(proof.deploymentId, null);
  assert.deepEqual(proof.railway, expected.railway);
});
for (const [name, change] of [
  ...["projectId", "environmentId", "webServiceId", "workerServiceId"].map((key) => [key, (d) => { d.startup.hotfix.railway[key] = "55555555-5555-4555-8555-555555555555"; }]),
  ["missing deploymentId", (d) => { delete d.startup.hotfix.deploymentId; }],
  ["invented deploymentId", (d) => { d.startup.hotfix.deploymentId = "deployment"; }],
  ["missing admission", (d) => { delete d.startup.hotfix.admissionId; }],
  ["wrong provider", (d) => { d.startup.hotfix.provider = "azure"; }],
  ["changed target", (d) => { d.startup.hotfix.targetId = "other-ops"; }],
  ["missing service", (d) => { delete d.startup.hotfix.railway.workerServiceId; }],
  ["extra service", (d) => { d.startup.hotfix.railway.other = "value"; }],
  ["aliased services", (d) => { d.startup.hotfix.railway.workerServiceId = d.startup.hotfix.railway.webServiceId; }],
  ["forged target digest", (d) => { d.startup.hotfix.targetDigest = hex("0"); }],
  ["historical ledger exception", (d) => { d.startup.migrationLedgerSha256 = hex("0"); }],
  ["schema substitution", (d) => { d.startup.schemaSha = sha("0"); }],
  ["recovery role substitution", (d) => { d.startup.hotfix.sourceRole = "recovery"; }],
]) test(`rejects Ops proof ${name}`, () => {
  const { data, expected, build } = opsProofFixture(); change(data);
  assert.throws(() => validateHotfixProofEvidence(data, expected, build), /HOTFIX_/);
});
test("rejects selfserve build reuse for Ops even with matching source and image digests", () => {
  const { data, expected } = opsProofFixture(); const { build } = proofFixture();
  assert.throws(() => validateHotfixProofEvidence(data, expected, build), /HOTFIX_/);
});
test("selects only closed fixed admission manifest paths", () => {
  assert.equal(hotfixEvidenceManifestPath(), ".github/selfserve-switcher-hotfix.json");
  assert.equal(hotfixEvidenceManifestPath("ops-release-authority"), ".github/ops-release-authority-hotfix.json");
  for (const id of ["all", "../ops", "toString", "selfserve-switcher/../../other"])
    assert.throws(() => hotfixEvidenceManifestPath(id), /HOTFIX_EVIDENCE_ADMISSION_INVALID/);
});

function protectedBuildFixture(ops = false, role = "candidate") {
  const { data, expected } = fixture(role);
  if (ops) Object.assign(expected, validateHotfixTarget(opsProofFixture().expected, opsProofFixture().expected));
  expected.prismaTree = sha("8");
  data.run.head_sha = data.jobs[0].head_sha = data.artifact.workflow_run.head_sha = expected.toolingSha;
  data.run.head_branch = data.artifact.workflow_run.head_branch = "main";
  data.toolingTrusted = true;
  data.receipt = { schemaVersion: 2, mode: "candidate-build", admissionId: expected.admissionId || "selfserve-switcher",
    sourceRole: role, sourceSha: role === "candidate" ? expected.candidateSha : expected.recoverySha,
    toolingSha: expected.toolingSha, runId: expected.runId, runAttempt: expected.runAttempt,
    source: { schemaVersion: 1, repository: expected.repository, admission: "hotfix", sourceSha: expected.candidateSha,
      sourceTree: expected.candidateTree, prismaTree: expected.prismaTree, schemaSha256: expected.schemaSha256,
      toolingSha: expected.toolingSha, manifestSha256: expected.manifestSha256, recoverySha: expected.recoverySha,
      ...validateHotfixTarget(expected, expected) }, images: data.receipt.images };
  return { data, expected };
}
for (const ops of [false, true]) for (const role of ["candidate", "recovery"]) test(`accepts protected-main schema2 ${ops ? "Ops" : "selfserve"} ${role} producing evidence`, () => {
  const { data, expected } = protectedBuildFixture(ops, role);
  assert.equal(validateHotfixBuildEvidence(data, expected).sourceSha, data.receipt.sourceSha);
});
for (const [name, change] of [
  ["unproven tooling ancestry", (d) => { d.toolingTrusted = false; }],
  ["nonmain producer", (d) => { d.run.head_branch = "feature"; }],
  ["substituted admission", (d) => { d.receipt.admissionId = "selfserve-switcher"; }],
  ["substituted source", (d) => { d.receipt.source.sourceSha = sha("0"); }],
  ["substituted source tree", (d) => { d.receipt.source.sourceTree = sha("0"); }],
  ["substituted schema tree", (d) => { d.receipt.source.prismaTree = sha("0"); }],
  ["substituted manifest", (d) => { d.receipt.source.manifestSha256 = hex("0"); }],
  ["source from other tooling", (d) => { d.receipt.source.toolingSha = sha("0"); }],
  ["different producing run", (d) => { d.receipt.runId++; }],
  ["different producing attempt", (d) => { d.receipt.runAttempt++; }],
  ["different target provider", (d) => { d.receipt.source.provider = "azure"; }],
  ["different target tuple", (d) => { d.receipt.source.railway.projectId = "55555555-5555-4555-8555-555555555555"; }],
  ["wrong selected role", (d) => { d.receipt.sourceRole = "recovery"; }],
]) test(`rejects protected publisher ${name}`, () => {
  const { data, expected } = protectedBuildFixture(true); change(data);
  assert.throws(() => validateHotfixBuildEvidence(data, expected), /HOTFIX_/);
});
for (const ops of [false, true]) test(`${ops ? "Ops" : "selfserve"} cannot fall back to a legacy publisher artifact`, () => {
  const { data, expected } = protectedBuildFixture(ops);
  data.receipt = { schemaVersion: 1, sourceSha: expected.candidateSha, images: data.receipt.images };
  // Even an unchanged publisher blob and branch approval cannot authorize v1.
  data.workflowUnchanged = true;
  assert.throws(() => validateHotfixBuildEvidence(data, expected), /PRODUCER_VERSION_INVALID/);
});
for (const ops of [false, true]) test(`${ops ? "Ops" : "selfserve"} rejects candidate-headed producer`, () => {
  const { data, expected } = protectedBuildFixture(ops);
  data.run.head_sha = data.jobs[0].head_sha = data.artifact.workflow_run.head_sha = expected.candidateSha;
  data.run.head_branch = data.artifact.workflow_run.head_branch = "candidate-branch";
  data.receipt.toolingSha = data.receipt.source.toolingSha = expected.candidateSha;
  assert.throws(() => validateHotfixBuildEvidence(data, expected), /TOOLING_UNTRUSTED/);
});
