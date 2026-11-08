import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REPOSITORY = "Corgtexdotcom/corgtex";
const TARGET = "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16";
const ORIGIN = "https://selfserve.corgtex.com";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RAILWAY_KEYS = ["projectId", "environmentId", "webServiceId", "workerServiceId"];
const PROFILES = Object.freeze({
  "selfserve-switcher": Object.freeze({ admissionId: "selfserve-switcher", provider: "azure",
    origin: ORIGIN, manifestPath: ".github/selfserve-switcher-hotfix.json" }),
  "ops-release-authority": Object.freeze({ admissionId: "ops-release-authority", provider: "railway",
    origin: "https://ops.corgtex.com", manifestPath: ".github/ops-release-authority-hotfix.json",
    baseSha: "1d3d49961ee85e8f37d8cc4fdf17c86d6aebd1bb", candidateTree: "9bdf38917f7ddad46fa2b0c2fcca67dcc37d472b" }),
});
const TOOLING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const requireValue = (value, code) => { if (!value) throw new Error(code); };
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const comparePaths = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function validFiles(files) {
  return Array.isArray(files) && files.length > 0 && files.length <= 100 && files.every((file, index) => {
    if (!exactKeys(file, ["path", "baseMode", "baseBlob", "candidateMode", "candidateBlob"])) return false;
    if (typeof file.path !== "string" || !file.path || /[\x00-\x1f\x7f\\]/.test(file.path)
      || file.path.split("/").some((part) => !part || part === "." || part === "..")
      || (index > 0 && comparePaths(files[index - 1].path, file.path) >= 0)) return false;
    for (const side of ["base", "candidate"]) {
      const mode = file[`${side}Mode`], blob = file[`${side}Blob`];
      if (mode === null ? blob !== null : !["100644", "100755"].includes(mode) || !SHA.test(blob ?? "")) return false;
    }
    return (file.baseMode !== null || file.candidateMode !== null)
      && (file.baseMode !== file.candidateMode || file.baseBlob !== file.candidateBlob);
  });
}
function sameFiles(left, right) {
  return validFiles(right) && left.length === right.length && left.every((file, index) =>
    ["path", "baseMode", "baseBlob", "candidateMode", "candidateBlob"].every((key) => file[key] === right[index][key]));
}

export function hotfixAdmissionProfile(admissionId = "selfserve-switcher") {
  requireValue(Object.hasOwn(PROFILES, admissionId), "HOTFIX_ADMISSION_UNKNOWN");
  return PROFILES[admissionId];
}

// Operational target identity is not a nullable control-plane deployment ID.
// No provider inference, all-target selector, or caller-supplied manifest path.
export function validateHotfixTarget(record, observed) {
  requireValue(plain(record) && plain(observed), "HOTFIX_TARGET_MISMATCH");
  const profile = hotfixAdmissionProfile(record.admissionId ?? "selfserve-switcher");
  const admissionId = observed.admissionId ?? "selfserve-switcher";
  requireValue(admissionId === profile.admissionId && record.origin === profile.origin
    && observed.origin === profile.origin && observed.targetId === record.targetId,
  "HOTFIX_TARGET_MISMATCH");
  let railway;
  if (profile.provider === "azure") {
    requireValue(record.targetId === TARGET && (record.provider === undefined || record.provider === "azure")
      && (observed.provider === undefined || observed.provider === "azure")
      && record.railway === undefined && observed.railway === undefined, "HOTFIX_TARGET_MISMATCH");
  } else {
    requireValue(record.admissionId === profile.admissionId && observed.admissionId === profile.admissionId
      && record.provider === "railway" && observed.provider === "railway"
      && Object.hasOwn(record, "deploymentId") && record.deploymentId === null
      && Object.hasOwn(observed, "deploymentId") && observed.deploymentId === null
      && typeof record.targetId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.targetId)
      && !["all", "default", "*"].includes(record.targetId.toLowerCase()) && record.targetId !== TARGET
      && exactKeys(record.railway, RAILWAY_KEYS) && exactKeys(observed.railway, RAILWAY_KEYS)
      && RAILWAY_KEYS.every((key) => UUID.test(record.railway[key] ?? "") && observed.railway[key] === record.railway[key])
      && record.railway.webServiceId !== record.railway.workerServiceId, "HOTFIX_TARGET_MISMATCH");
    railway = Object.fromEntries(RAILWAY_KEYS.map((key) => [key, record.railway[key]]));
  }
  const binding = { admissionId: profile.admissionId, provider: profile.provider, targetId: record.targetId,
    origin: profile.origin, ...(railway ? { deploymentId: null, railway } : {}) };
  return { ...binding, targetDigest: hash(JSON.stringify(binding)) };
}

// The caller owns trusted workflow/main provenance. This validates the one
// reviewed source record; neither a branch name nor candidate-owned JSON admits it.
export function validateHotfixAdmission(manifest, observed) {
  requireValue(plain(manifest), "HOTFIX_MANIFEST_INVALID");
  const profile = hotfixAdmissionProfile(manifest.admissionId ?? "selfserve-switcher");
  const ops = profile.provider === "railway";
  const keys = ["schemaVersion", "repository", "targetId", "origin", "baseSha", "candidateSha",
    "candidateTree", "diffSha256", "prismaTree", "recoverySha", "changedFiles"];
  requireValue(exactKeys(manifest, ops ? [...keys, "admissionId", "provider", "deploymentId", "railway"] : keys), "HOTFIX_MANIFEST_INVALID");
  requireValue(manifest.schemaVersion === (ops ? 2 : 1) && manifest.repository === REPOSITORY
    && [manifest.baseSha, manifest.candidateSha, manifest.candidateTree, manifest.prismaTree, manifest.recoverySha].every((v) => SHA.test(v ?? ""))
    && HASH.test(manifest.diffSha256 ?? "") && validFiles(manifest.changedFiles)
    && manifest.baseSha !== manifest.candidateSha && manifest.recoverySha !== manifest.candidateSha
    && (!ops || (manifest.baseSha === profile.baseSha && manifest.candidateTree === profile.candidateTree
      && manifest.recoverySha === manifest.baseSha)), "HOTFIX_MANIFEST_INVALID");
  requireValue(plain(observed) && observed.repository === REPOSITORY, "HOTFIX_TARGET_MISMATCH");
  const target = validateHotfixTarget(manifest, observed);
  requireValue(observed.sourceSha === manifest.candidateSha && observed.sourceTree === manifest.candidateTree,
    "HOTFIX_SOURCE_MISMATCH");
  requireValue(Array.isArray(observed.parents) && observed.parents.length === 1 && observed.parents[0] === manifest.baseSha,
    "HOTFIX_PARENT_MISMATCH");
  requireValue(observed.baseIsMainAncestor === true && observed.recoveryIsMainAncestor === true
    && observed.recoverySha === manifest.recoverySha, "HOTFIX_ANCESTRY_REQUIRED");
  requireValue(observed.basePrismaTree === manifest.prismaTree && observed.sourcePrismaTree === manifest.prismaTree
    && observed.recoveryPrismaTree === manifest.prismaTree, "HOTFIX_SCHEMA_CHANGED");
  requireValue(observed.diffSha256 === manifest.diffSha256 && sameFiles(manifest.changedFiles, observed.changedFiles),
    "HOTFIX_DIFF_MISMATCH");
  return { admission: "hotfix", sourceSha: manifest.candidateSha, sourceTree: manifest.candidateTree,
    ...target, recoverySha: manifest.recoverySha, prismaTree: manifest.prismaTree };
}

function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["--no-replace-objects", "-c", "core.quotePath=true", "-C", root, ...args], {
    env: { ...env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
}
const gitText = (root, args) => git(root, args).toString("utf8").trim();
function ancestor(root, source, main) {
  try { git(root, ["merge-base", "--is-ancestor", source, main]); return true; }
  catch (error) { if (error.status === 1) return false; throw new Error("HOTFIX_GIT_ANCESTRY_UNAVAILABLE"); }
}
export function canonicalHotfixDiff(sourceRoot, baseSha, candidateSha) {
  requireValue(SHA.test(baseSha) && SHA.test(candidateSha), "HOTFIX_SOURCE_SHA_INVALID");
  return git(sourceRoot, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--no-color", "--diff-algorithm=myers", "--no-indent-heuristic", "--unified=3", "--inter-hunk-context=0",
    "--src-prefix=a/", "--dst-prefix=b/", baseSha, candidateSha, "--"]);
}
function treeFiles(root, sha) {
  const entries = git(root, ["ls-tree", "-rz", "--full-tree", sha]).toString("utf8").split("\0").filter(Boolean);
  return new Map(entries.map((entry) => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    requireValue(match, "HOTFIX_TREE_INVALID");
    return [match[4], { mode: match[1], blob: match[3] }];
  }));
}
export function hotfixChangedFiles(sourceRoot, baseSha, candidateSha) {
  requireValue(SHA.test(baseSha) && SHA.test(candidateSha), "HOTFIX_SOURCE_SHA_INVALID");
  const base = treeFiles(sourceRoot, baseSha), candidate = treeFiles(sourceRoot, candidateSha);
  return [...new Set([...base.keys(), ...candidate.keys()])].sort(comparePaths).flatMap((path) => {
    const a = base.get(path), b = candidate.get(path);
    if (a?.mode === b?.mode && a?.blob === b?.blob) return [];
    return [{ path, baseMode: a?.mode ?? null, baseBlob: a?.blob ?? null,
      candidateMode: b?.mode ?? null, candidateBlob: b?.blob ?? null }];
  });
}

export async function verifyHotfixSource({ toolingRoot = TOOLING_ROOT, sourceRoot, sourceSha, targetId, origin, admissionId = "selfserve-switcher", provider, railway, deploymentId, mainRef = "origin/main" }) {
  const profile = hotfixAdmissionProfile(admissionId);
  requireValue(provider === undefined ? profile.provider === "azure" : provider === profile.provider, "HOTFIX_TARGET_MISMATCH");
  requireValue(profile.provider !== "azure" || railway === undefined, "HOTFIX_TARGET_MISMATCH");
  requireValue(typeof sourceRoot === "string" && SHA.test(sourceSha ?? "") && typeof mainRef === "string"
    && /^(?:[a-f0-9]{40}|origin\/main|refs\/remotes\/origin\/main|refs\/heads\/main)$/.test(mainRef), "HOTFIX_SOURCE_SHA_INVALID");
  const mainSha = gitText(toolingRoot, ["rev-parse", "--verify", `${mainRef}^{commit}`]);
  const toolingSha = gitText(toolingRoot, ["rev-parse", "HEAD"]);
  requireValue(gitText(sourceRoot, ["rev-parse", "HEAD"]) === sourceSha, "HOTFIX_CHECKOUT_MISMATCH");
  requireValue(git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).length === 0, "HOTFIX_CHECKOUT_DIRTY");
  const sourceTree = gitText(sourceRoot, ["rev-parse", `${sourceSha}^{tree}`]);
  const prismaTree = gitText(sourceRoot, ["rev-parse", `${sourceSha}:prisma`]);
  requireValue(gitText(sourceRoot, ["cat-file", "-t", prismaTree]) === "tree", "HOTFIX_SCHEMA_CHANGED");
  const schemaSha256 = hash(git(sourceRoot, ["show", `${sourceSha}:prisma/schema.prisma`]));
  const common = { schemaVersion: 1, repository: REPOSITORY, toolingSha, sourceSha, sourceTree, prismaTree, schemaSha256 };
  if (profile.provider === "azure" && ancestor(sourceRoot, sourceSha, mainSha)) return { ...common, admission: "main", manifestSha256: null,
    targetId: targetId ?? null, origin: origin ?? null, recoverySha: null };
  const manifestPath = resolve(toolingRoot, profile.manifestPath);
  requireValue((await lstat(manifestPath)).isFile(), "HOTFIX_MANIFEST_INVALID");
  const bytes = await readFile(manifestPath);
  requireValue(bytes.length <= 64 * 1024, "HOTFIX_MANIFEST_INVALID");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("HOTFIX_MANIFEST_INVALID"); }
  // Validate identifiers before using any manifest values as Git revisions.
  requireValue(plain(manifest) && SHA.test(manifest.baseSha ?? "") && SHA.test(manifest.recoverySha ?? ""), "HOTFIX_MANIFEST_INVALID");
  const observed = { repository: REPOSITORY, sourceSha, sourceTree, targetId, origin, admissionId, provider, railway, deploymentId,
    parents: gitText(sourceRoot, ["show", "--no-patch", "--format=%P", sourceSha]).split(" ").filter(Boolean),
    baseIsMainAncestor: ancestor(sourceRoot, manifest.baseSha, mainSha),
    recoveryIsMainAncestor: ancestor(sourceRoot, manifest.recoverySha, mainSha), recoverySha: manifest.recoverySha,
    basePrismaTree: gitText(sourceRoot, ["rev-parse", `${manifest.baseSha}:prisma`]), sourcePrismaTree: prismaTree,
    recoveryPrismaTree: gitText(sourceRoot, ["rev-parse", `${manifest.recoverySha}:prisma`]),
    diffSha256: hash(canonicalHotfixDiff(sourceRoot, manifest.baseSha, sourceSha)),
    changedFiles: hotfixChangedFiles(sourceRoot, manifest.baseSha, sourceSha) };
  return { ...common, ...validateHotfixAdmission(manifest, observed), manifestSha256: hash(bytes) };
}

async function cli(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    requireValue(["--source-root", "--source-sha", "--target-id", "--origin", "--output", "--admission-id", "--provider",
      "--deployment-id", "--railway-project-id", "--railway-environment-id", "--railway-web-service-id", "--railway-worker-service-id"].includes(key)
      && typeof value === "string" && !Object.hasOwn(args, key), "HOTFIX_ARGUMENT_INVALID");
    args[key] = value;
  }
  const receipt = await verifyHotfixSource({ sourceRoot: args["--source-root"], sourceSha: args["--source-sha"],
    targetId: args["--target-id"], origin: args["--origin"], admissionId: args["--admission-id"], provider: args["--provider"],
    ...(Object.hasOwn(args, "--deployment-id") ? { deploymentId: args["--deployment-id"] === "null" ? null : args["--deployment-id"] } : {}),
    ...(Object.keys(args).some((key) => key.startsWith("--railway-")) ? { railway: {
      projectId: args["--railway-project-id"], environmentId: args["--railway-environment-id"],
      webServiceId: args["--railway-web-service-id"], workerServiceId: args["--railway-worker-service-id"],
    } } : {}) });
  const output = `${JSON.stringify(receipt)}\n`;
  if (args["--output"]) {
    await mkdir(dirname(resolve(args["--output"])), { recursive: true });
    await writeFile(args["--output"], output, { flag: "wx" });
  }
  process.stdout.write(output);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${/^HOTFIX_[A-Z_]+$/.test(error.message) ? error.message : "HOTFIX_SOURCE_UNAVAILABLE"}\n`);
    process.exitCode = 1;
  });
}
