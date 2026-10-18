import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { CONTAINER, LOCAL_IMAGE, PG16_MANIFESTS, PG_MAJORS, imageArchitecture, pg18RehearsalImage, prepareImage, prepareImages, smokeWarmImages, startDatabase, verifyImage } from "./ci-pgvector-image.mjs";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(architecture = "amd64", major = 16) {
  const directory = mkdtempSync(join(tmpdir(), "ci-pgvector-test-"));
  directories.push(directory);
  const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const blob = (bytes) => {
    const descriptor = { digest: hash(bytes), size: bytes.length };
    writeFileSync(join(directory, descriptor.digest.slice(7)), bytes);
    return descriptor;
  };
  const config = blob(Buffer.from(JSON.stringify({ os: "linux", architecture, config: { Env: [`PG_MAJOR=${major}`] } })));
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
      ["docker", ["tag", f.config.digest, "pgvector/pgvector:pg16"]],
      ["docker", ["image", "inspect", "pgvector/pgvector:pg16"]],
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
    const run = transport("sha256:" + "0".repeat(64));
    await expect(prepareImage(f.directory, "amd64", { run, verify: () => f.config.digest }))
      .rejects.toThrow("identity mismatch");
    expect(run.mock.calls.some(([, args]) => args[0] === "tag")).toBe(false);
  });

  it("rejects a mismatched legacy alias before downstream consumers run", async () => {
    const f = fixture();
    const run = transport(f.config.digest);
    run.mockImplementation((program, args) => program === "docker" && args[0] === "image"
      ? JSON.stringify([{ Id: args[2] === LOCAL_IMAGE ? f.config.digest : "sha256:" + "0".repeat(64), Os: "linux", Architecture: "amd64" }]) : "");
    await expect(prepareImage(f.directory, "amd64", { run, verify: () => f.config.digest })).rejects.toThrow("identity mismatch");
  });

  it.each(PG_MAJORS)("checks major %s and refuses a mismatched cache", (major) => {
    const f = fixture("amd64", major);
    expect(verifyImage(f.directory, "amd64", f.pins, major)).toBe(f.config.digest);
    expect(() => verifyImage(f.directory, "amd64", f.pins, major === 16 ? 17 : 16)).toThrow("major mismatch");
  });

  it("starts only a loopback fixture with pull disabled and exercises pgvector", async () => {
    const run = vi.fn(() => "");
    await startDatabase("corgtex_test", { run });
    expect(run.mock.calls[0]).toEqual(["docker", ["run", "--detach", "--pull=never", "--name", CONTAINER,
      "--publish", "127.0.0.1:5432:5432", "--env", "POSTGRES_USER=postgres", "--env", "POSTGRES_PASSWORD=postgres",
      "--env", "POSTGRES_DB=corgtex_test", LOCAL_IMAGE, "postgres", "-c", "shared_preload_libraries=pg_stat_statements"]]);
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
    expect(action).toContain("ci-pgvector-image.mjs warm-smoke");
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const check = workflow.slice(workflow.indexOf("  check:\n"), workflow.indexOf("  db-sync:\n"));
    const dbSync = workflow.slice(workflow.indexOf("  db-sync:\n"), workflow.indexOf("  build:\n"));
    expect(check).toContain('tenant-transfer: "true"');
    expect(dbSync).not.toContain('tenant-transfer: "true"');
  });

  // Parse the real downstream docker run arguments so the inventory cannot
  // silently drift into testing a second handwritten copy of the consumers.
  function consumerArguments(path, major) {
    const file = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const runs = [];
    const argument = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
      if (ts.isIdentifier(node) && node.text === "name") return "owned-test-id";
      if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => {
        const expression = span.expression.getText(file);
        if (["major", "postgresMajor"].includes(expression)) return major + span.literal.text;
        if (expression === "randomUUID()") return "owned-test-id" + span.literal.text;
        throw new Error(`Unrecognized consumer template ${expression}`);
      }).join("");
      throw new Error(`Unrecognized consumer argument ${node.getText(file)}`);
    };
    const walk = (node) => {
      if (ts.isCallExpression(node) && ["command", "execFileSync"].includes(node.expression.getText(file))) {
        for (const array of node.arguments.filter(ts.isArrayLiteralExpression)) {
          if (array.elements[0]?.getText(file) === '"run"') runs.push(array.elements.map(argument));
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
    expect(runs).toHaveLength(1);
    return runs[0];
  }

  it("supplies every real tenant fixture and converter alias from warm blobs with registry access denied", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-pgvector-consumers-"));
    directories.push(root);
    const fixtures = new Map(PG_MAJORS.map((major) => [major, fixture("amd64", major)]));
    for (const [major, f] of fixtures) cpSync(f.directory, join(root, `pg${major}`), { recursive: true });
    const images = new Map([["pgvector/pgvector:pg16", "old-unverified-image"]]);
    const run = vi.fn((program, args) => {
      if (program === "skopeo") {
        if (!args[1].startsWith("dir:")) throw new Error("Registry access denied");
        const major = Number(args[2].match(/pg(\d+)$/)[1]);
        images.set(args[2].slice("docker-daemon:".length), fixtures.get(major).config.digest);
      } else if (program === "docker" && args[0] === "image") {
        if (!images.has(args[2])) throw new Error("Image not present");
        return JSON.stringify([{ Id: images.get(args[2]), Os: "linux", Architecture: "amd64" }]);
      } else if (program === "docker" && args[0] === "tag") {
        expect([...images.values()]).toContain(args[1]);
        images.set(args[2], args[1]);
      } else if (program === "docker" && args[0] === "run") {
        const image = args.find((arg) => /^pgvector\/pgvector:pg\d+$/.test(arg));
        // Docker's missing/default policy would pull here if preparation failed
        // to assign the consumer's actual reference. The simulated daemon denies
        // every such registry fallback rather than returning fabricated success.
        if (!images.has(image)) throw new Error("Mutable registry fallback denied");
        return images.get(image);
      } else throw new Error("Unexpected image transport operation");
      return "";
    });
    const verify = (directory, arch, _pins, major) => verifyImage(directory, arch, fixtures.get(major).pins, major);
    const ids = await prepareImages(root, "amd64", { run, verify });
    await smokeWarmImages(root, "amd64", { run, verify });
    const consumers = [
      ["./migration/shared-tenant-export.integration.test.ts", [16]],
      ["./migration/shared-tenant-import.integration.test.ts", [16]],
      ["./migration/shared-tenant-source-copy.integration.test.ts", PG_MAJORS],
      ["./migration/shared-tenant-source-copy.ts", PG_MAJORS],
    ];
    const tenantCommand = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts["test:tenant-transfer"];
    const scheduledSuites = [...tenantCommand.matchAll(/scripts\/migration\/[^\s]+\.integration\.test\.ts/g)].map(([path]) => path).sort();
    expect(scheduledSuites).toEqual(consumers.slice(0, 3).map(([path]) => `scripts/${path.slice(2)}`).sort());
    for (const [path, majors] of consumers) {
      for (const major of majors) expect(run("docker", consumerArguments(path, major))).toBe(ids.get(major));
    }
    expect(run.mock.calls.some(([program, args]) => program === "skopeo" && args[1].startsWith("docker://"))).toBe(false);
    images.delete("pgvector/pgvector:pg16");
    expect(() => run("docker", consumerArguments(consumers[0][0], 16))).toThrow("Mutable registry fallback denied");
  });

  it("fails warm proof instead of pulling when a required cache entry disappears", async () => {
    const f = fixture();
    const run = vi.fn();
    await expect(smokeWarmImages(f.directory, "amd64", { run, wait: vi.fn(), warn: vi.fn() })).rejects.toThrow("must not contact a registry");
    expect(run).not.toHaveBeenCalled();
  });

  it("hands only the verified local PG18 config ID to both actual rehearsal containers with no pull fallback", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(pg18RehearsalImage(digest)).toEqual({ image: digest, pullArgs: ["--pull=never"] });
    expect(pg18RehearsalImage()).toEqual({ image: "pgvector/pgvector:pg18@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a", pullArgs: [] });
    for (const invalid of ["", "pgvector/pgvector:pg18", "sha256:bad", "sha256:" + "A".repeat(64)]) {
      expect(() => pg18RehearsalImage(invalid)).toThrow("Invalid verified");
    }
    const source = readFileSync(new URL("./migration/postgres-restore-rehearsal-smoke.mjs", import.meta.url), "utf8");
    expect(source).toContain("pg18RehearsalImage(process.env.CI_PGVECTOR_PG18_CONFIG_ID)");
    const file = ts.createSourceFile("rehearsal.mjs", source, ts.ScriptTarget.Latest, true);
    const runs = [];
    const walk = (node) => {
      if (ts.isCallExpression(node) && ["run", "runDockerSourceStart"].includes(node.expression.getText(file))) {
        for (const args of node.arguments.filter(ts.isArrayLiteralExpression)) {
          if (args.elements[0]?.getText(file) === '"run"') runs.push(args.elements.map((argument) => argument.getText(file)));
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
    expect(runs).toHaveLength(2);
    for (const args of runs) {
      expect(args).toContain("...REHEARSAL_PULL_ARGS");
      expect(args).toContain("SERVER_IMAGE");
      expect(args.filter((arg) => /pull/i.test(arg))).toEqual(["...REHEARSAL_PULL_ARGS"]);
    }
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(workflow).toContain("CI_PGVECTOR_PG18_CONFIG_ID: ${{ steps.pgvector.outputs.pg18-config-id }}");
    const action = readFileSync(new URL("../.github/actions/ci-pgvector/action.yml", import.meta.url), "utf8");
    expect(action).toContain("value: ${{ steps.prepare.outputs.pg18-config-id }}");
    const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
    expect(scripts["test:migration:ops-core"]).toContain("npm run test:migration:postgres-smoke");
    expect(scripts["test:migration:postgres-smoke"]).toContain("postgres-restore-rehearsal-smoke.mjs");
  });
});
