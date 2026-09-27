import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SUBSCRIPTION = "227eb707-bc46-415e-a09b-7d2b69fb14b2";
const REGISTRY = "acrcorgtexcrprodwus3";
const REGISTRY_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-corgtex-corporate-rebels-production-wus3/providers/Microsoft.ContainerRegistry/registries/${REGISTRY}`;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const need = (condition, code) => { if (!condition) throw new Error(code); };

export function validateReleaseRun(run, { id, sha }) {
  need(String(run?.id) === id && run.name === "Release Images"
    && run.path === ".github/workflows/release-images.yml"
    && run.event === "workflow_dispatch" && run.head_branch === "main"
    && run.head_sha === sha && run.conclusion === "success", "IMAGE_RELEASE_NOT_PROVEN");
}

export function validateRegistry(account, registry) {
  need(account?.id === SUBSCRIPTION && registry?.id?.toLowerCase() === REGISTRY_ID.toLowerCase()
    && registry.loginServer === `${REGISTRY}.azurecr.io`
    && registry.adminUserEnabled === false && registry.provisioningState === "Succeeded",
  "IMAGE_REGISTRY_CHANGED");
}

export function validateReleaseBuild(build, { role, sha }) {
  need(build?.schemaVersion === 1 && build.role === role && build.gitSha === sha,
    "IMAGE_BUILD_IDENTITY_MISMATCH");
}

export function imageDigest(repo, repoDigests) {
  need(Array.isArray(repoDigests), "IMAGE_DIGEST_UNPROVEN");
  const matches = repoDigests.filter(value => typeof value === "string"
    && value.startsWith(`${repo}@`) && DIGEST.test(value.slice(repo.length + 1)));
  need(matches.length === 1, "IMAGE_DIGEST_UNPROVEN");
  return matches[0].slice(repo.length + 1);
}

async function command(binary, args, code, { timeout = 600_000 } = {}) {
  try {
    const { stdout } = await execFile(binary, args, { encoding: "utf8", timeout,
      maxBuffer: 4 * 1024 * 1024, shell: false });
    return stdout.trim();
  } catch { throw new Error(code); }
}

async function jsonCommand(binary, args, code) {
  try { return JSON.parse(await command(binary, args, code)); }
  catch { throw new Error(code); }
}

async function inspectImage(ref, repo) {
  const id = await command("docker", ["image", "inspect", "--format", "{{.Id}}", ref], "IMAGE_INSPECT_FAILED");
  need(DIGEST.test(id), "IMAGE_ID_INVALID");
  const repoDigests = await jsonCommand("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", ref], "IMAGE_INSPECT_FAILED");
  return { id, digest: imageDigest(repo, repoDigests) };
}

async function releaseBuildFromImage(ref) {
  const directory = await mkdtemp(join(tmpdir(), "opscore-image-"));
  let container;
  try {
    container = await command("docker", ["create", ref], "IMAGE_CREATE_FAILED");
    need(/^[a-f0-9]{64}$/.test(container), "IMAGE_CONTAINER_ID_INVALID");
    const file = join(directory, "release-build.json");
    await command("docker", ["cp", `${container}:/app/release-build.json`, file], "IMAGE_BUILD_IDENTITY_MISSING");
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (/^IMAGE_[A-Z_]+$/.test(error?.message ?? "")) throw error;
    throw new Error("IMAGE_BUILD_IDENTITY_MISSING");
  } finally {
    if (container && /^[a-f0-9]{64}$/.test(container)) {
      await command("docker", ["rm", container], "IMAGE_CONTAINER_CLEANUP_FAILED");
    }
    await rm(directory, { recursive: true, force: true });
  }
}

export async function promoteImages({ releaseRunId, receiptPath, env = process.env }) {
  need(/^[1-9][0-9]{0,19}$/.test(releaseRunId ?? "")
    && SHA.test(env.GITHUB_SHA ?? "") && env.GITHUB_REPOSITORY === "Corgtexdotcom/corgtex"
    && env.AZURE_SUBSCRIPTION_ID === SUBSCRIPTION, "IMAGE_PROMOTION_INPUT_INVALID");
  const sha = env.GITHUB_SHA;
  const run = await jsonCommand("gh", ["api", `repos/Corgtexdotcom/corgtex/actions/runs/${releaseRunId}`], "IMAGE_RELEASE_OBSERVATION_FAILED");
  validateReleaseRun(run, { id: releaseRunId, sha });
  const account = await jsonCommand("az", ["account", "show", "--output", "json"], "IMAGE_AZURE_OBSERVATION_FAILED");
  const registry = await jsonCommand("az", ["acr", "show", "--name", REGISTRY,
    "--subscription", SUBSCRIPTION, "--output", "json"], "IMAGE_AZURE_OBSERVATION_FAILED");
  validateRegistry(account, registry);
  const repositories = await jsonCommand("az", ["acr", "repository", "list", "--name", REGISTRY,
    "--output", "json"], "IMAGE_REGISTRY_OBSERVATION_FAILED");
  need(Array.isArray(repositories) && repositories.every(name => typeof name === "string"),
    "IMAGE_REGISTRY_OBSERVATION_FAILED");

  const images = {};
  for (const role of ["web", "worker"]) {
    const sourceRepo = `ghcr.io/corgtexdotcom/corgtex/${role}`;
    const targetRepo = `${REGISTRY}.azurecr.io/opscore/${role}`;
    const tag = `sha-${sha}`;
    const source = `${sourceRepo}:${tag}`;
    const target = `${targetRepo}:${tag}`;
    await command("docker", ["pull", "--quiet", source], "IMAGE_SOURCE_PULL_FAILED");
    const sourceImage = await inspectImage(source, sourceRepo);
    const build = await releaseBuildFromImage(source);
    validateReleaseBuild(build, { role, sha });

    if (repositories.includes(`opscore/${role}`)) {
      const tags = await jsonCommand("az", ["acr", "repository", "show-tags", "--name", REGISTRY,
        "--repository", `opscore/${role}`, "--output", "json"], "IMAGE_REGISTRY_OBSERVATION_FAILED");
      need(Array.isArray(tags), "IMAGE_REGISTRY_OBSERVATION_FAILED");
      if (tags.includes(tag)) {
        await command("docker", ["pull", "--quiet", target], "IMAGE_TARGET_PULL_FAILED");
        const existing = await inspectImage(target, targetRepo);
        need(existing.id === sourceImage.id, "IMAGE_TARGET_TAG_CONFLICT");
        images[role] = { source, sourceDigest: sourceImage.digest, target,
          targetDigest: existing.digest, imageId: sourceImage.id, releaseBuild: build };
        continue;
      }
    }
    await command("docker", ["tag", source, target], "IMAGE_TAG_FAILED");
    await command("docker", ["push", "--quiet", target], "IMAGE_TARGET_PUSH_FAILED");
    await command("docker", ["pull", "--quiet", target], "IMAGE_TARGET_PULL_FAILED");
    const promoted = await inspectImage(target, targetRepo);
    need(promoted.id === sourceImage.id, "IMAGE_TARGET_CONTENT_MISMATCH");
    images[role] = { source, sourceDigest: sourceImage.digest, target,
      targetDigest: promoted.digest, imageId: sourceImage.id, releaseBuild: build };
  }
  const receipt = { schemaVersion: 1, sourceSha: sha, releaseRunId,
    registryId: REGISTRY_ID, images };
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  promoteImages({ releaseRunId: process.argv[2], receiptPath: process.argv[3] }).then(result => {
    console.log(JSON.stringify({ status: "OPSCORE_IMAGES_PROMOTED", sourceSha: result.sourceSha,
      releaseRunId: result.releaseRunId,
      digests: Object.fromEntries(Object.entries(result.images).map(([role, image]) => [role, image.targetDigest])) }));
  }).catch(error => {
    console.error(JSON.stringify({ status: "OPSCORE_IMAGE_PROMOTION_FAILED",
      code: /^IMAGE_[A-Z_]+$/.test(error?.message ?? "") ? error.message : "IMAGE_PROMOTION_UNEXPECTED" }));
    process.exitCode = 1;
  });
}
