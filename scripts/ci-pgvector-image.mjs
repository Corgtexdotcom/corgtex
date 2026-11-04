import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Verified children of the upstream index already audited in PR1510. Cache
// identity comes from these pins, never from metadata restored with the cache.
export const PG16_INDEX = "sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a";
export const PG16_MANIFESTS = {
  amd64: "sha256:a97d77306ff47cc1d8add4d000cec2207da2e110746318df3137ce53c337ca30",
  arm64: "sha256:a45475a5bc7882f19e9ca17d49b67f665fa04d500350de2c47af325662445aec",
};
export const PG_IMAGES = {
  16: { index: PG16_INDEX, manifests: PG16_MANIFESTS },
  17: {
    index: "sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d",
    manifests: {
      amd64: "sha256:cd4ccfdaf62cbfeb5c6ee19ef0dd663406d4ed740c320b324d016a90e85385b3",
      arm64: "sha256:215ae4d47393a980e9ef7ff7760f7dad53ec3e84bceb9fbd45cef34e50b5ba0f",
    },
  },
  18: {
    index: "sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a",
    manifests: {
      amd64: "sha256:1d50c689b0a6511b9ea0a15615281c81a59fd04a08eb35057ec8646fb3a2118a",
      arm64: "sha256:46481fb03d04f9160a2373d305f769eb34040fc866e7bd74b8f5b84a50cc2952",
    },
  },
};
export const PG_MAJORS = [16, 17, 18];
export const LOCAL_IMAGE = "corgtex-ci-pgvector:pg16";
export const CONTAINER = "corgtex-ci-postgres";

export function pg18RehearsalImage(configId) {
  if (configId === undefined) return { image: `pgvector/pgvector:pg18@${PG_IMAGES[18].index}`, pullArgs: [] };
  if (!/^sha256:[a-f0-9]{64}$/.test(configId)) throw new Error("Invalid verified CI PostgreSQL 18 config ID");
  return { image: configId, pullArgs: ["--pull=never"] };
}

export function imageArchitecture(value) {
  const architecture = { X64: "amd64", ARM64: "arm64", amd64: "amd64", arm64: "arm64" }[value];
  if (!architecture) throw new Error(`Unsupported CI image architecture: ${value}`);
  return architecture;
}

function verifiedFile(path, digest, size) {
  if (!lstatSync(path).isFile()) throw new Error(`Image entry must be a regular file: ${path}`);
  const bytes = readFileSync(path);
  if (size !== undefined && bytes.length !== size) throw new Error("Image blob size mismatch");
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) {
    throw new Error("Image blob digest mismatch");
  }
  return bytes;
}

// Skopeo's dir transport retains the original manifest and compressed blobs.
// Verify the complete descriptor chain before importing anything into Docker.
export function verifyImage(directory, architecture, pins = PG16_MANIFESTS, major = 16) {
  const manifest = JSON.parse(verifiedFile(join(directory, "manifest.json"), pins[architecture]));
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers)) throw new Error("Invalid image manifest");
  const readBlob = (descriptor) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(descriptor?.digest) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
      throw new Error("Invalid image descriptor");
    }
    return verifiedFile(join(directory, descriptor.digest.slice(7)), descriptor.digest, descriptor.size);
  };
  const config = JSON.parse(readBlob(manifest.config));
  if (config.os !== "linux" || config.architecture !== architecture) throw new Error("Image platform mismatch");
  if (!config.config?.Env?.includes(`PG_MAJOR=${major}`)) throw new Error("Image PostgreSQL major mismatch");
  for (const layer of manifest.layers) readBlob(layer);
  return manifest.config.digest;
}

const command = (program, args) => execFileSync(program, args, { encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

export async function prepareImage(directory, architecture, { major = 16, run = command, wait = pause, verify = verifyImage, warn = console.warn } = {}) {
  if (!PG_MAJORS.includes(major)) throw new Error("Unsupported CI PostgreSQL major");
  const pins = PG_IMAGES[major].manifests;
  const localImage = `corgtex-ci-pgvector:pg${major}`;
  const legacyImage = `pgvector/pgvector:pg${major}`;
  let configDigest;
  try {
    configDigest = verify(directory, architecture, pins, major);
  } catch {
    warn("CI image cache missing or invalid; fetching the pinned public upstream image.");
    for (let attempt = 0; attempt < 3; attempt++) {
      // This directory contains upstream blobs only; no running DB or repo files.
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(directory, { recursive: true });
      try {
        run("skopeo", ["copy", "--preserve-digests", `docker://docker.io/pgvector/pgvector@${pins[architecture]}`, `dir:${directory}`]);
        configDigest = verify(directory, architecture, pins, major);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        warn(`Pinned upstream fetch failed; retry ${attempt + 1}/2.`);
        await wait(5_000 * (attempt + 1));
      }
    }
  }
  run("skopeo", ["copy", `dir:${directory}`, `docker-daemon:${localImage}`]);
  const assertIdentity = (image) => {
    const imported = JSON.parse(run("docker", ["image", "inspect", image]))[0];
    if (imported?.Id !== configDigest || imported?.Os !== "linux" || imported?.Architecture !== architecture) {
      throw new Error("Imported Docker image identity mismatch");
    }
  };
  assertIdentity(localImage);
  // Tenant fixture and conversion consumers still use upstream-style names.
  // Assign their local alias from the verified config ID, never an unverified
  // tag, then verify it before allowing any downstream consumer to execute.
  run("docker", ["tag", configDigest, legacyImage]);
  assertIdentity(legacyImage);
  return configDigest;
}

export async function prepareImages(directory, architecture, dependencies = {}) {
  const identities = new Map();
  for (const major of dependencies.majors ?? PG_MAJORS) {
    identities.set(major, await prepareImage(join(directory, `pg${major}`), architecture, { ...dependencies, major }));
  }
  return identities;
}

export async function smokeWarmImages(directory, architecture, { run = command, ...dependencies } = {}) {
  const offline = (program, args) => {
    if ((program === "skopeo" && args.some((arg) => arg.startsWith("docker://"))) || (program === "docker" && args[0] === "pull")) {
      throw new Error("Warm image verification must not contact a registry");
    }
    return run(program, args);
  };
  const identities = await prepareImages(directory, architecture, { ...dependencies, run: offline });
  for (const [major, digest] of identities) {
    // All legacy names must work locally even with a runner's pulls disabled.
    run("docker", ["run", "--rm", "--pull=never", "--network=none", "--entrypoint", "postgres", `pgvector/pgvector:pg${major}`, "--version"]);
    console.log(`Verified warm pg${major} consumer alias: ${digest}`);
  }
}

export async function startDatabase(database, { run = command, wait = pause } = {}) {
  if (!/^corgtex_(test|ci)$/.test(database)) throw new Error("Invalid isolated CI database name");
  run("docker", ["run", "--detach", "--pull=never", "--name", CONTAINER,
    "--publish", "127.0.0.1:5432:5432", "--env", "POSTGRES_USER=postgres",
    "--env", "POSTGRES_PASSWORD=postgres", "--env", `POSTGRES_DB=${database}`, LOCAL_IMAGE,
    "postgres", "-c", "shared_preload_libraries=pg_stat_statements"]);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      run("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", database]);
      // Test the actual extension, not just TCP startup. Prisma migrations can
      // also issue CREATE EXTENSION IF NOT EXISTS against this fixture.
      run("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1",
        "-c", "CREATE EXTENSION IF NOT EXISTS vector; SELECT '[1,2]'::vector <-> '[1,2]'::vector;"]);
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await wait(2_000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const architecture = imageArchitecture(process.env.CI_IMAGE_ARCH);
  if (![undefined, "false", "true"].includes(process.env.CI_TENANT_TRANSFER)) throw new Error("Invalid tenant transfer image selection");
  const majors = process.env.CI_TENANT_TRANSFER === "true" ? PG_MAJORS : [16];
  const directory = join(process.env.RUNNER_TEMP, "ci-pgvector-images-v2");
  switch (process.argv[2]) {
    case "metadata":
      appendFileSync(process.env.GITHUB_OUTPUT, `path=${directory}\nkey=ci-pgvector-dir-v2-linux-${architecture}-${createHash("sha256").update(majors.map((major) => PG_IMAGES[major].manifests[architecture]).join("\n")).digest("hex")}\n`);
      break;
    case "prepare":
      {
        const identities = await prepareImages(directory, architecture, { majors });
        appendFileSync(process.env.GITHUB_OUTPUT, `pg18-config-id=${identities.get(18) ?? ""}\n`);
      }
      break;
    case "warm-smoke":
      await smokeWarmImages(directory, architecture, { majors });
      break;
    case "start":
      await startDatabase(process.env.CI_PG_DATABASE);
      break;
    default:
      throw new Error("Expected metadata, prepare, warm-smoke or start");
  }
}
