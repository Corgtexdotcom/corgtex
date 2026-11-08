import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { validateHotfixTarget } from "./selfserve-hotfix-source.mjs";
import { createHotfixCiReceipt, discoverHotfixCi, validateHotfixCiContext, validateHotfixCiEvidence } from "./hotfix-candidate-ci.mjs";
const repository = "Corgtexdotcom/corgtex";
const sha = (c) => c.repeat(40), hex = (c) => c.repeat(64);
const context = () => ({ GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/heads/main`, GITHUB_SHA: sha("a"), GITHUB_RUN_ID: "12", GITHUB_RUN_ATTEMPT: "1" });
function source(ops = false) {
  const uuid = (c) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
  const target = ops ? { admissionId: "ops-release-authority", provider: "railway", targetId: "synthetic-ops", origin: "https://ops.corgtex.com", deploymentId: null,
    railway: { projectId: uuid("1"), environmentId: uuid("2"), webServiceId: uuid("3"), workerServiceId: uuid("4") } }
    : { admissionId: "selfserve-switcher", provider: "azure", targetId: "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16", origin: "https://selfserve.corgtex.com" };
  return { schemaVersion: 1, repository, admission: "hotfix", toolingSha: sha("a"), sourceSha: sha("b"), sourceTree: sha("c"), prismaTree: sha("d"), schemaSha256: hex("e"), manifestSha256: hex("f"), recoverySha: sha("1"), ...validateHotfixTarget(target, target) };
}
function fixture(ops = false) {
  const s = source(ops), expected = { ...s, candidateSha: s.sourceSha, candidateTree: s.sourceTree, runId: 12, runAttempt: 1, artifactId: 34 };
  const run = { id: 12, run_attempt: 1, event: "push", head_branch: "main", head_sha: s.toolingSha, path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", repository: { id: 56, full_name: repository }, head_repository: { id: 56, full_name: repository }, workflow_id: 78 };
  const workflow = { id: 78, path: run.path };
  const jobs = [`hotfix-candidate / Exact admitted candidate checks (${s.admissionId})`, "Lint, Typecheck & Test"].map((name) => ({ name, run_id: 12, run_attempt: 1, head_sha: run.head_sha, status: "completed", conclusion: "success" }));
  const artifact = { id: 34, name: `exact-hotfix-ci-${s.admissionId}-12-1`, expired: false, digest: `sha256:${hex("2")}`, workflow_run: { id: 12, head_sha: run.head_sha, head_branch: "main", repository_id: 56, head_repository_id: 56 } };
  return { data: { run, workflow, jobs, artifact, receipt: createHotfixCiReceipt(s, context()) }, expected };
}
for (const ops of [false, true]) test(`accepts exact complete ${ops ? "Ops" : "selfserve"} canonical-main CI evidence`, () => {
  const { data, expected } = fixture(ops);
  assert.equal(validateHotfixCiEvidence(data, expected).sourceSha, expected.candidateSha);
  assert.ok(data.receipt.checks.includes("migration-fixtures"));
  assert.ok(data.receipt.checks.includes("seed-fixtures"));
  assert.equal(data.receipt.checks.includes("switcher-browser"), !ops);
});
test("discovery selects only present closed manifests without inventing Ops pins", () => {
  const root = mkdtempSync(join(tmpdir(), "hotfix-ci-"));
  try {
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github/selfserve-switcher-hotfix.json"), "{}");
    writeFileSync(join(root, ".github/untrusted-hotfix.json"), "{}");
    assert.deepEqual(discoverHotfixCi(root), { include: [{ admissionId: "selfserve-switcher" }] });
    writeFileSync(join(root, ".github/ops-release-authority-hotfix.json"), "{}");
    assert.equal(discoverHotfixCi(root).include.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const [key, value] of [["GITHUB_REPOSITORY", "fork/corgtex"], ["GITHUB_EVENT_NAME", "pull_request"], ["GITHUB_EVENT_NAME", "merge_group"], ["GITHUB_REF", "refs/heads/hotfix"], ["GITHUB_WORKFLOW_REF", `${repository}/.github/workflows/ci.yml@refs/heads/hotfix`]]) test(`cannot seal CI receipt with ${key}=${value}`, () => {
  assert.throws(() => validateHotfixCiContext({ ...context(), [key]: value }), /CONTEXT_UNTRUSTED/);
});
for (const [key, value] of [["event", "pull_request"], ["event", "merge_group"], ["head_branch", "hotfix"], ["head_sha", sha("2")], ["run_attempt", 2], ["conclusion", "failure"], ["path", ".github/workflows/release-images.yml"]]) test(`rejects wrong CI run ${key}=${value}`, () => {
  const { data, expected } = fixture(); data.run[key] = value;
  assert.throws(() => validateHotfixCiEvidence(data, expected), /RUN_UNTRUSTED/);
});
test("requires successful exact candidate and aggregate jobs from same attempt", () => {
  for (const alter of [(d) => { d.jobs.pop(); }, (d) => { d.jobs[0].run_attempt = 2; }, (d) => { d.jobs[0].conclusion = "skipped"; }, (d) => { d.jobs[0].name = "hotfix-candidate / Exact admitted candidate checks (ops-release-authority)"; }]) {
    const { data, expected } = fixture(); alter(data);
    assert.throws(() => validateHotfixCiEvidence(data, expected), /JOB_UNPROVEN/);
  }
});
test("rejects wrong run/head/artifact digest/name and missing producing repository", () => {
  for (const alter of [(d) => { d.artifact.workflow_run.id++; }, (d) => { d.artifact.workflow_run.head_sha = sha("2"); }, (d) => { d.artifact.digest = "sha256:bad"; }, (d) => { d.artifact.name = "exact-hotfix-ci-ops-release-authority-12-1"; }, (d) => { delete d.artifact.workflow_run.repository_id; }]) {
    const { data, expected } = fixture(); alter(data);
    assert.throws(() => validateHotfixCiEvidence(data, expected), /ARTIFACT_UNTRUSTED/);
  }
});
test("rejects cross-candidate/schema/provider/target/fixture-check substitution", () => {
  for (const [key, value] of [["sourceSha", sha("2")], ["schemaSha256", hex("2")], ["prismaTree", sha("2")], ["provider", "railway"], ["targetId", "other"], ["checks", ["unit"]], ["toolingSha", sha("2")], ["runAttempt", 2]]) {
    const { data, expected } = fixture(); data.receipt[key] = value;
    assert.throws(() => validateHotfixCiEvidence(data, expected), /RECEIPT_MISMATCH/);
  }
  const { data, expected } = fixture(true); delete data.receipt.deploymentId;
  assert.throws(() => validateHotfixCiEvidence(data, expected), /RECEIPT_MISMATCH/);
});
test("candidate workflow has no production authority and seals only after exact fixture checks", () => {
  const workflow = YAML.parse(readFileSync(new URL("../../.github/workflows/selfserve-hotfix-check.yml", import.meta.url), "utf8"));
  const candidate = workflow.jobs.candidate;
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(candidate.environment, undefined);
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\.|id-token|packages.*write/);
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
  const steps = candidate.steps, verify = steps.findIndex((s) => s.run?.endsWith("hotfix-candidate-ci.mjs verify"));
  const install = steps.findIndex((s) => s.run === "npm ci"), seal = steps.findIndex((s) => s.run?.endsWith("hotfix-candidate-ci.mjs finish"));
  assert.ok(verify >= 0 && verify < install);
  for (const fragment of ["check:migration-fixtures", "check:seed-fixtures", "--project integration", "npm run build", "gitleaks\" git"]) {
    const check = steps.findIndex((s) => s.run?.includes(fragment));
    assert.ok(check >= 0 && check < seal, fragment);
  }
  assert.match(steps[seal].if, /github.event_name == 'push'/);
  assert.match(steps[seal].if, /github.ref == 'refs\/heads\/main'/);
  const artifact = steps.find((s) => s.with?.name?.startsWith("exact-hotfix-ci-"));
  assert.equal(artifact.with.path, ".artifacts/hotfix-ci-receipt.json");
  assert.ok(steps.indexOf(artifact) > seal);
});

test("authenticates CI archive and historical manifest with separate producing tooling identity", async () => {
  const { createHash } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const { deflateRawSync } = await import("node:zlib");
  const { verifyHotfixCiEvidence } = await import("./hotfix-candidate-ci.mjs");
  const root = mkdtempSync(join(tmpdir(), "hotfix-ci-api-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  try {
    git("init"); mkdirSync(join(root, ".github"));
    const manifest = '{"synthetic":"reviewed fixture"}\n';
    writeFileSync(join(root, ".github/selfserve-switcher-hotfix.json"), manifest);
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "tooling");
    const producer = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", producer);
    const { data, expected } = fixture();
    data.run.head_sha = producer; data.jobs.forEach((job) => { job.head_sha = producer; });
    data.artifact.workflow_run.head_sha = producer;
    expected.manifestSha256 = hash(manifest);
    data.receipt = createHotfixCiReceipt({ ...source(), toolingSha: producer, manifestSha256: expected.manifestSha256 }, { ...context(), GITHUB_SHA: producer });
    const name = Buffer.from("hotfix-ci-receipt.json"), raw = Buffer.from(JSON.stringify(data.receipt)), body = deflateRawSync(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0x81a4 * 65536) >>> 0, 38);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + body.length, 16);
    const archive = Buffer.concat([local, name, body, central, name, end]); data.artifact.digest = `sha256:${hash(archive)}`;
    const fetchImpl = async (url, options) => {
      if (String(url).startsWith("https://ci.blob.core.windows.net/")) { assert.equal(options.headers, undefined); return new Response(archive); }
      assert.equal(options.headers.authorization, "Bearer synthetic-token");
      if (url.endsWith("/zip")) return new Response(null, { status: 302, headers: { location: "https://ci.blob.core.windows.net/archive?synthetic" } });
      const value = url.endsWith("/attempts/1") ? data.run : url.endsWith("/workflows/ci.yml") ? data.workflow
        : url.endsWith("/artifacts/34") ? data.artifact : url.endsWith("/approvals") ? [] : url.includes("/attempts/1/jobs?") ? { total_count: 2, jobs: data.jobs } : null;
      assert.notEqual(value, null, url); return Response.json(value);
    };
    const options = { expected, runId: 12, runAttempt: 1, artifactId: 34, toolingRoot: root, token: "synthetic-token", fetchImpl };
    const receipt = await verifyHotfixCiEvidence(options);
    assert.equal(receipt.toolingSha, producer); assert.notEqual(receipt.toolingSha, expected.toolingSha);
    await assert.rejects(verifyHotfixCiEvidence({ ...options, expected: { ...expected, manifestSha256: hex("3") } }), /CI_TOOLING_UNTRUSTED/);
    data.run.head_sha = sha("9");
    await assert.rejects(verifyHotfixCiEvidence(options), /CI_TOOLING_UNTRUSTED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
