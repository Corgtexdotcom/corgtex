import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTAINER, LOCAL_IMAGE, PG16_MANIFESTS, imageArchitecture, prepareImage, startDatabase, verifyImage } from "./ci-pgvector-image.mjs";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(architecture = "amd64") {
  const directory = mkdtempSync(join(tmpdir(), "ci-pgvector-test-"));
  directories.push(directory);
  const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const blob = (bytes) => {
    const descriptor = { digest: hash(bytes), size: bytes.length };
    writeFileSync(join(directory, descriptor.digest.slice(7)), bytes);
    return descriptor;
  };
  const config = blob(Buffer.from(JSON.stringify({ os: "linux", architecture, config: { Env: ["PG_MAJOR=16"] } })));
  const layer = blob(Buffer.from("public upstream fixture layer"));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config, layers: [layer] }));
  writeFileSync(join(directory, "manifest.json"), manifest);
  return { directory, config, layer, manifest, pins: { [architecture]: hash(manifest) } };
}

describe("pinned public CI image supply", () => {
  it.each(["amd64", "arm64"])("verifies the manifest, config and layer chain on %s", (architecture) => {
    const f = fixture(architecture);
    expect(verifyImage(f.directory, architecture, f.pins)).toBe(f.config.digest);
  });

  it.each(["manifest", "config", "layer"])("rejects changed %s bytes", (entry) => {
    const f = fixture();
    const path = entry === "manifest" ? join(f.directory, "manifest.json") : join(f.directory, f[entry].digest.slice(7));
    writeFileSync(path, "tampered cache content");
    expect(() => verifyImage(f.directory, "amd64", f.pins)).toThrow(/mismatch/);
  });

  it("rejects incorrect platforms and blob symlinks", () => {
    const f = fixture("arm64");
    expect(() => verifyImage(f.directory, "amd64", { amd64: f.pins.arm64 })).toThrow("platform mismatch");
    const layerPath = join(f.directory, f.layer.digest.slice(7));
    rmSync(layerPath);
    symlinkSync(join(f.directory, f.config.digest.slice(7)), layerPath);
    expect(() => verifyImage(f.directory, "arm64", f.pins)).toThrow("regular file");
  });

  function transport(configDigest) {
    return vi.fn((program, args) => program === "docker" && args[0] === "image"
      ? JSON.stringify([{ Id: configDigest, Os: "linux", Architecture: "amd64" }]) : "");
  }

  it("uses verified cache without contacting a registry", async () => {
    const f = fixture();
    const run = transport(f.config.digest);
    await prepareImage(f.directory, "amd64", { run, verify: (dir, arch) => verifyImage(dir, arch, f.pins) });
    expect(run.mock.calls).toEqual([
      ["skopeo", ["copy", `dir:${f.directory}`, `docker-daemon:${LOCAL_IMAGE}`]],
      ["docker", ["image", "inspect", LOCAL_IMAGE]],
    ]);
  });

  it("recovers missing or corrupt cache with bounded immutable cold-fetch retries", async () => {
    const f = fixture();
    const verify = vi.fn().mockImplementationOnce(() => { throw new Error("corrupt"); })
      .mockReturnValue(f.config.digest);
    const run = transport(f.config.digest);
    run.mockImplementationOnce(() => { throw new Error("429"); });
    const wait = vi.fn();
    await prepareImage(f.directory, "amd64", { run, verify, wait, warn: vi.fn() });
    expect(run.mock.calls[0]).toEqual(["skopeo", ["copy", "--preserve-digests",
      `docker://docker.io/pgvector/pgvector@${PG16_MANIFESTS.amd64}`, `dir:${f.directory}`]]);
    expect(wait).toHaveBeenCalledWith(5_000);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("fails closed after three failed cold fetches and never imports corrupt blobs", async () => {
    const f = fixture();
    const run = vi.fn(() => { throw new Error("upstream unavailable"); });
    await expect(prepareImage(f.directory, "amd64", { run, verify: () => { throw new Error("invalid"); }, wait: vi.fn(), warn: vi.fn() }))
      .rejects.toThrow("upstream unavailable");
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.every(([, args]) => args[1] === "--preserve-digests")).toBe(true);
  });

  it("rejects an imported Docker identity mismatch", async () => {
    const f = fixture();
    await expect(prepareImage(f.directory, "amd64", { run: transport("sha256:" + "0".repeat(64)), verify: () => f.config.digest }))
      .rejects.toThrow("identity mismatch");
  });

  it("starts only a loopback fixture with pull disabled and exercises pgvector", async () => {
    const run = vi.fn(() => "");
    await startDatabase("corgtex_test", { run });
    expect(run.mock.calls[0]).toEqual(["docker", ["run", "--detach", "--pull=never", "--name", CONTAINER,
      "--publish", "127.0.0.1:5432:5432", "--env", "POSTGRES_USER=postgres", "--env", "POSTGRES_PASSWORD=postgres",
      "--env", "POSTGRES_DB=corgtex_test", LOCAL_IMAGE]]);
    expect(run.mock.calls[2][1].at(-1)).toContain("::vector");
    await expect(startDatabase("production", { run })).rejects.toThrow("Invalid isolated");
    expect(() => imageArchitecture("X86")).toThrow("Unsupported");
  });

  it("bounds readiness failures", async () => {
    const run = vi.fn().mockReturnValueOnce("").mockImplementation(() => { throw new Error("not ready"); });
    const wait = vi.fn();
    await expect(startDatabase("corgtex_ci", { run, wait })).rejects.toThrow("not ready");
    expect(wait).toHaveBeenCalledTimes(29);
  });

  it("caches upstream blobs before DB creation and saves only from main pushes", () => {
    const action = readFileSync(new URL("../.github/actions/ci-pgvector/action.yml", import.meta.url), "utf8");
    expect(action).toContain("actions/cache/restore@v4");
    expect(action).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(action).not.toMatch(/restore-keys:|secrets\.|packages:|docker\/build-push-action/);
    expect(action.indexOf("actions/cache/save@v4")).toBeLessThan(action.indexOf("ci-pgvector-image.mjs start"));
  });
});
