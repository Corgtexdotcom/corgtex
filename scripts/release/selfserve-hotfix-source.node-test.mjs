import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalHotfixDiff, hotfixChangedFiles, validateHotfixAdmission, validateHotfixTarget, hotfixAdmissionProfile, verifyHotfixSource } from "./selfserve-hotfix-source.mjs";

const sha = (letter) => letter.repeat(40);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const targetId = "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16";
const origin = "https://selfserve.corgtex.com";
function fixture() {
  const manifest = { schemaVersion: 1, repository: "Corgtexdotcom/corgtex", targetId, origin,
    baseSha: sha("a"), candidateSha: sha("b"), candidateTree: sha("c"), diffSha256: "d".repeat(64),
    prismaTree: sha("e"), recoverySha: sha("a"), changedFiles: [
      { path: "apps/web/switcher.tsx", baseMode: null, baseBlob: null, candidateMode: "100644", candidateBlob: sha("f") },
    ] };
  const observed = { repository: manifest.repository, targetId, origin, sourceSha: manifest.candidateSha,
    sourceTree: manifest.candidateTree, parents: [manifest.baseSha], baseIsMainAncestor: true,
    recoveryIsMainAncestor: true, recoverySha: manifest.recoverySha,
    basePrismaTree: manifest.prismaTree, sourcePrismaTree: manifest.prismaTree, recoveryPrismaTree: manifest.prismaTree,
    diffSha256: manifest.diffSha256, changedFiles: structuredClone(manifest.changedFiles) };
  return { manifest, observed };
}

test("admits only exact reviewed source with same complete Prisma tree and compatible distinct recovery", () => {
  const { manifest, observed } = fixture();
  assert.deepEqual(validateHotfixAdmission(manifest, observed), {
    admission: "hotfix", sourceSha: sha("b"), sourceTree: sha("c"), targetId, origin, recoverySha: sha("a"), prismaTree: sha("e"),
    admissionId: "selfserve-switcher", provider: "azure",
    targetDigest: hash(JSON.stringify({ admissionId: "selfserve-switcher", provider: "azure", targetId, origin })),
  });
});
for (const [name, alter, code] of [
  ["different source SHA", (m, o) => { o.sourceSha = sha("9"); }, "HOTFIX_SOURCE_MISMATCH"],
  ["same SHA claimed with another tree", (m, o) => { o.sourceTree = sha("9"); }, "HOTFIX_SOURCE_MISMATCH"],
  ["merge parent", (m, o) => { o.parents.push(sha("9")); }, "HOTFIX_PARENT_MISMATCH"],
  ["wrong live base", (m, o) => { o.parents = [sha("9")]; }, "HOTFIX_PARENT_MISMATCH"],
  ["base outside main", (m, o) => { o.baseIsMainAncestor = false; }, "HOTFIX_ANCESTRY_REQUIRED"],
  ["recovery outside main", (m, o) => { o.recoveryIsMainAncestor = false; }, "HOTFIX_ANCESTRY_REQUIRED"],
  ["wrong recovery", (m, o) => { o.recoverySha = sha("9"); }, "HOTFIX_ANCESTRY_REQUIRED"],
  ["candidate schema changed", (m, o) => { o.sourcePrismaTree = sha("9"); }, "HOTFIX_SCHEMA_CHANGED"],
  ["baseline schema changed", (m, o) => { o.basePrismaTree = sha("9"); }, "HOTFIX_SCHEMA_CHANGED"],
  ["recovery schema changed", (m, o) => { o.recoveryPrismaTree = sha("9"); }, "HOTFIX_SCHEMA_CHANGED"],
  ["different target", (m, o) => { o.targetId = "other"; }, "HOTFIX_TARGET_MISMATCH"],
  ["redirect origin", (m, o) => { o.origin += "/"; }, "HOTFIX_TARGET_MISMATCH"],
  ["missing explicit target", (m, o) => { delete o.targetId; }, "HOTFIX_TARGET_MISMATCH"],
  ["another repository", (m, o) => { o.repository = "fork/corgtex"; }, "HOTFIX_TARGET_MISMATCH"],
  ["different binary diff", (m, o) => { o.diffSha256 = "9".repeat(64); }, "HOTFIX_DIFF_MISMATCH"],
  ["additional file", (m, o) => { o.changedFiles.push({ ...o.changedFiles[0], path: "extra.ts" }); }, "HOTFIX_DIFF_MISMATCH"],
  ["missing file", (m, o) => { o.changedFiles = []; }, "HOTFIX_DIFF_MISMATCH"],
  ["different content blob", (m, o) => { o.changedFiles[0].candidateBlob = sha("9"); }, "HOTFIX_DIFF_MISMATCH"],
  ["unexpected executable bit", (m, o) => { o.changedFiles[0].candidateMode = "100755"; }, "HOTFIX_DIFF_MISMATCH"],
  ["symlink", (m) => { m.changedFiles[0].candidateMode = "120000"; }, "HOTFIX_MANIFEST_INVALID"],
  ["submodule", (m) => { m.changedFiles[0].candidateMode = "160000"; }, "HOTFIX_MANIFEST_INVALID"],
  ["duplicate paths", (m) => { m.changedFiles.push({ ...m.changedFiles[0] }); }, "HOTFIX_MANIFEST_INVALID"],
  ["path traversal", (m) => { m.changedFiles[0].path = "../secret"; }, "HOTFIX_MANIFEST_INVALID"],
  ["unknown manifest key", (m) => { m.allowAnyBranch = true; }, "HOTFIX_MANIFEST_INVALID"],
  ["candidate as recovery", (m) => { m.recoverySha = m.candidateSha; }, "HOTFIX_MANIFEST_INVALID"],
]) {
  test(`rejects ${name}`, () => {
    const { manifest, observed } = fixture(); alter(manifest, observed);
    assert.throws(() => validateHotfixAdmission(manifest, observed), { message: code });
  });
}

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Synthetic", GIT_AUTHOR_EMAIL: "synthetic@example.invalid", GIT_COMMITTER_NAME: "Synthetic", GIT_COMMITTER_EMAIL: "synthetic@example.invalid" },
}).trim();
async function gitFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hotfix-source-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source"), toolingRoot = join(root, "tooling");
  await mkdir(sourceRoot); git(sourceRoot, "init", "-b", "main");
  await mkdir(join(sourceRoot, "prisma", "migrations", "001"), { recursive: true });
  await writeFile(join(sourceRoot, "prisma", "schema.prisma"), "synthetic schema\n");
  await writeFile(join(sourceRoot, "prisma", "migrations", "001", "migration.sql"), "-- synthetic\n");
  await writeFile(join(sourceRoot, "app.ts"), "base\n");
  git(sourceRoot, "add", "."); git(sourceRoot, "commit", "-m", "synthetic base");
  const baseSha = git(sourceRoot, "rev-parse", "HEAD");
  git(sourceRoot, "switch", "-c", "switcher");
  await writeFile(join(sourceRoot, "app.ts"), "switcher\n");
  git(sourceRoot, "commit", "-am", "synthetic candidate");
  const sourceSha = git(sourceRoot, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", sourceRoot, toolingRoot);
  git(toolingRoot, "checkout", "--detach", baseSha);
  git(toolingRoot, "update-ref", "refs/remotes/origin/main", baseSha);
  const manifest = { schemaVersion: 1, repository: "Corgtexdotcom/corgtex", targetId, origin, baseSha,
    candidateSha: sourceSha, candidateTree: git(sourceRoot, "rev-parse", "HEAD^{tree}"),
    diffSha256: hash(canonicalHotfixDiff(sourceRoot, baseSha, sourceSha)),
    prismaTree: git(sourceRoot, "rev-parse", "HEAD:prisma"), recoverySha: baseSha,
    changedFiles: hotfixChangedFiles(sourceRoot, baseSha, sourceSha) };
  await mkdir(join(toolingRoot, ".github"));
  await writeFile(join(toolingRoot, ".github/selfserve-switcher-hotfix.json"), JSON.stringify(manifest));
  return { sourceRoot, toolingRoot, sourceSha, manifest, options: { sourceRoot, toolingRoot, sourceSha, targetId, origin } };
}

test("Git-backed verifier binds fixed trusted manifest, source checkout, schema and receipt hashes", async (t) => {
  const f = await gitFixture(t);
  const receipt = await verifyHotfixSource(f.options);
  assert.equal(receipt.admission, "hotfix");
  assert.equal(receipt.sourceTree, f.manifest.candidateTree);
  assert.equal(receipt.schemaSha256, hash("synthetic schema\n"));
  assert.equal(receipt.manifestSha256, hash(await readFile(join(f.toolingRoot, ".github/selfserve-switcher-hotfix.json"))));
  assert.equal(receipt.toolingSha, f.manifest.baseSha);
  await writeFile(join(f.sourceRoot, "app.ts"), "unreviewed\n");
  await assert.rejects(verifyHotfixSource(f.options), { message: "HOTFIX_CHECKOUT_DIRTY" });
});
test("rejects checkout substitutions and untracked build-context injection", async (t) => {
  const f = await gitFixture(t);
  await assert.rejects(verifyHotfixSource({ ...f.options, sourceSha: f.manifest.baseSha }), { message: "HOTFIX_CHECKOUT_MISMATCH" });
  await writeFile(join(f.sourceRoot, "injected.txt"), "untracked");
  await assert.rejects(verifyHotfixSource(f.options), { message: "HOTFIX_CHECKOUT_DIRTY" });
});
test("ordinary main ancestor needs no hotfix manifest or selfserve target binding", async (t) => {
  const f = await gitFixture(t);
  git(f.sourceRoot, "checkout", "--detach", f.manifest.baseSha);
  await rm(join(f.toolingRoot, ".github/selfserve-switcher-hotfix.json"));
  const receipt = await verifyHotfixSource({ ...f.options, sourceSha: f.manifest.baseSha, targetId: "another-target", origin: "https://example.invalid" });
  assert.equal(receipt.admission, "main");
  assert.equal(receipt.manifestSha256, null);
  assert.equal(receipt.targetId, "another-target");
});
test("cannot use candidate-owned manifest or a caller-selected branch as trusted main", async (t) => {
  const f = await gitFixture(t);
  await rm(join(f.toolingRoot, ".github/selfserve-switcher-hotfix.json"));
  await assert.rejects(verifyHotfixSource(f.options), { code: "ENOENT" });
  await assert.rejects(verifyHotfixSource({ ...f.options, mainRef: "switcher" }), { message: "HOTFIX_SOURCE_SHA_INVALID" });
});
test("diff digest ignores local diff/color configuration", async (t) => {
  const f = await gitFixture(t);
  git(f.sourceRoot, "config", "diff.algorithm", "histogram");
  git(f.sourceRoot, "config", "diff.context", "99");
  git(f.sourceRoot, "config", "color.ui", "always");
  assert.equal(hash(canonicalHotfixDiff(f.sourceRoot, f.manifest.baseSha, f.sourceSha)), f.manifest.diffSha256);
});

function opsFixture() {
  const { manifest, observed } = fixture();
  const profile = hotfixAdmissionProfile("ops-release-authority");
  const railway = { projectId: "11111111-1111-4111-8111-111111111111", environmentId: "22222222-2222-4222-8222-222222222222",
    webServiceId: "33333333-3333-4333-8333-333333333333", workerServiceId: "44444444-4444-4444-8444-444444444444" };
  Object.assign(manifest, { schemaVersion: 2, admissionId: profile.admissionId, provider: "railway", deploymentId: null,
    targetId: "synthetic-ops-only", origin: profile.origin, baseSha: profile.baseSha, recoverySha: profile.baseSha,
    candidateTree: profile.candidateTree, railway });
  Object.assign(observed, { admissionId: profile.admissionId, provider: "railway", deploymentId: null,
    targetId: manifest.targetId, origin: manifest.origin, parents: [profile.baseSha], recoverySha: profile.baseSha,
    sourceTree: profile.candidateTree, railway: { ...railway } });
  return { manifest, observed };
}
test("closed Ops record uses explicit null deployment ID and exact Railway tuple in its digest", () => {
  const { manifest, observed } = opsFixture();
  const receipt = validateHotfixAdmission(manifest, observed);
  assert.equal(receipt.admissionId, "ops-release-authority");
  assert.equal(receipt.provider, "railway");
  assert.equal(receipt.deploymentId, null);
  assert.deepEqual(receipt.railway, manifest.railway);
  assert.equal(receipt.targetDigest, validateHotfixTarget(receipt, receipt).targetDigest);
  assert.notEqual(receipt.targetDigest, validateHotfixAdmission(fixture().manifest, fixture().observed).targetDigest);
});
for (const [name, mutate] of [
  ["implicit admission", (m, o) => { delete o.admissionId; }],
  ["implicit provider", (m, o) => { delete o.provider; }],
  ["Azure provider substitution", (m, o) => { o.provider = "azure"; }],
  ["selfserve target substitution", (m, o) => { o.targetId = targetId; }],
  ["selfserve origin substitution", (m, o) => { o.origin = origin; }],
  ["null operational target", (m, o) => { m.targetId = null; o.targetId = null; }],
  ["all selector", (m, o) => { m.targetId = "all"; o.targetId = "all"; }],
  ["missing record deployment ID", (m) => { delete m.deploymentId; }],
  ["missing observed deployment ID", (m, o) => { delete o.deploymentId; }],
  ["non-null deployment ID", (m, o) => { o.deploymentId = targetId; }],
  ["project substitution", (m, o) => { o.railway.projectId = o.railway.environmentId; }],
  ["environment substitution", (m, o) => { o.railway.environmentId = o.railway.projectId; }],
  ["web substitution", (m, o) => { o.railway.webServiceId = o.railway.workerServiceId; }],
  ["worker substitution", (m, o) => { o.railway.workerServiceId = o.railway.webServiceId; }],
  ["missing tuple field", (m, o) => { delete o.railway.workerServiceId; }],
  ["extra tuple field", (m, o) => { o.railway.secondWorker = o.railway.workerServiceId; }],
  ["same role service", (m, o) => { m.railway.workerServiceId = m.railway.webServiceId; o.railway.workerServiceId = o.railway.webServiceId; }],
  ["wrong pinned Ops base", (m, o) => { m.baseSha = sha("9"); o.parents = [m.baseSha]; }],
  ["wrong pinned Ops tree", (m, o) => { m.candidateTree = sha("9"); o.sourceTree = m.candidateTree; }],
  ["cross-candidate SHA", (m, o) => { o.sourceSha = sha("9"); }],
  ["Ops schema change", (m, o) => { o.sourcePrismaTree = sha("9"); }],
  ["Ops recovery schema change", (m, o) => { o.recoveryPrismaTree = sha("9"); }],
]) {
  test(`Ops rejects ${name}`, () => {
    const { manifest, observed } = opsFixture(); mutate(manifest, observed);
    assert.throws(() => validateHotfixAdmission(manifest, observed), /HOTFIX_/);
  });
}
test("selfserve defaults remain bounded; explicit Ops identity/provider/tuple never crosses", () => {
  const { manifest, observed } = fixture();
  for (const override of [{ admissionId: "ops-release-authority" }, { provider: "railway" }, { railway: opsFixture().manifest.railway }]) {
    assert.throws(() => validateHotfixAdmission(manifest, { ...observed, ...override }), /HOTFIX_TARGET_MISMATCH/);
  }
  assert.throws(() => hotfixAdmissionProfile("any-release-branch"), /HOTFIX_ADMISSION_UNKNOWN/);
});
test("missing trusted Ops record fails even for a main-ancestor source", async (t) => {
  const f = await gitFixture(t);
  git(f.sourceRoot, "checkout", "--detach", f.manifest.baseSha);
  const ops = opsFixture().manifest;
  await assert.rejects(verifyHotfixSource({ ...f.options, sourceSha: f.manifest.baseSha, admissionId: ops.admissionId,
    provider: ops.provider, targetId: ops.targetId, origin: ops.origin, railway: ops.railway, deploymentId: null }), { code: "ENOENT" });
  await assert.rejects(verifyHotfixSource({ ...f.options, provider: "railway" }), /HOTFIX_TARGET_MISMATCH/);
});
