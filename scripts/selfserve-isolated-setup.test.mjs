import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { isolatedDockerSetup, runIsolatedValidation } from "./selfserve-validation-isolated.mjs";

describe("bounded isolated Docker setup", () => {
  it("allows a real subprocess to finish after the old five-second probe budget", () => {
    const records = [];
    const result = isolatedDockerSetup("IDENTITY_CREATE", ["create"], {
      deadline: Date.now() + 20_000, record: (entry) => records.push(entry),
      command: (_binary, _args, options) => execFileSync(process.execPath,
        ["-e", 'setTimeout(() => process.stdout.write("created"), 5100)'], options),
    });
    expect(result).toBe("created");
    expect(records[0]).toMatchObject({ stage: "IDENTITY_CREATE", status: "passed", exitCode: 0 });
    expect(records[0].elapsedMs).toBeGreaterThan(5000);
    expect(records[0].timeoutMs).toBeLessThanOrEqual(20_000);
  });

  it("kills a real subprocess at the remaining overall deadline and reports a safe timeout", () => {
    const records = [];
    expect(() => isolatedDockerSetup("IDENTITY_COPY", ["cp"], {
      deadline: Date.now() + 200, record: (entry) => records.push(entry),
      command: (_binary, _args, options) => execFileSync(process.execPath,
        ["-e", "setInterval(() => {}, 1000)"], options),
    })).toThrow("ISOLATED_SETUP_IDENTITY_COPY_TIMEOUT");
    expect(records[0]).toMatchObject({ reason: "TIMEOUT", status: "failed", exitCode: null, signal: "SIGTERM" });
    expect(records[0].timeoutMs).toBeLessThanOrEqual(200);
  });

  it("refuses to start after the deadline and caps setup work at one minute", () => {
    const records = [], calls = [];
    const options = { now: () => 100, record: (entry) => records.push(entry),
      command: (...args) => { calls.push(args); return "created"; } };
    expect(() => isolatedDockerSetup("IDENTITY_CREATE", ["create"], { ...options, deadline: 100 }))
      .toThrow("ISOLATED_SETUP_IDENTITY_CREATE_DEADLINE");
    expect(calls).toHaveLength(0);
    isolatedDockerSetup("IDENTITY_CREATE", ["create"], { ...options, deadline: 1_000_000 });
    expect(calls[0][2].timeout).toBe(60_000);
  });

  it("rejects a command that returns after the overall deadline", () => {
    let time = 100;
    const records = [];
    expect(() => isolatedDockerSetup("IDENTITY_CREATE", ["create"], {
      deadline: 200, now: () => time, record: (entry) => records.push(entry),
      command: () => { time = 201; return "created"; },
    })).toThrow("ISOLATED_SETUP_IDENTITY_CREATE_DEADLINE");
    expect(records[0].status).toBe("failed");
  });

  it("retains exit status without storing sensitive arguments or subprocess errors", () => {
    const records = [];
    expect(() => isolatedDockerSetup("WEB_START", ["run", "-e", "PASSWORD=private-fixture-value"], {
      deadline: Date.now() + 60_000, record: (entry) => records.push(entry),
      command: () => { throw Object.assign(new Error("private-fixture-value"),
        { status: 125, stderr: "private-fixture-value", stdout: "private-fixture-value" }); },
    })).toThrow("ISOLATED_SETUP_WEB_START_EXIT");
    expect(records[0]).toMatchObject({ exitCode: 125, reason: "EXIT", status: "failed" });
    expect(JSON.stringify(records)).not.toContain("private-fixture-value");
  });

  it.each(["create", "cp"])("cleans up an owned identity container after uncertain %s failure without passing acceptance", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "isolated-setup-test-"));
    const source = join(directory, "source"), output = join(directory, "proof");
    const calls = [];
    let owned;
    try {
      await mkdir(join(source, "prisma/migrations/synthetic"), { recursive: true });
      await writeFile(join(source, "prisma/migrations/synthetic/migration.sql"), "SELECT 1;\n");
      await writeFile(join(source, "prisma/schema.prisma"), "// Synthetic source binding only.\n");
      const git = (args) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      git(["init", "-q"]); git(["add", "prisma"]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
      const env = { SELFSERVE_VALIDATION_EXPECTED_SHA: git(["rev-parse", "HEAD"]).trim(),
        SELFSERVE_VALIDATION_SOURCE_DIR: source, SELFSERVE_VALIDATION_OUT_DIR: output,
        GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1",
        ...Object.fromEntries(["WEB", "PG", "BROWSER"].map((role) =>
          [`SELFSERVE_ISOLATED_${role}_IMAGE`, `example.invalid/${role.toLowerCase()}@sha256:${"c".repeat(64)}`])) };
      const command = (_binary, args, options) => {
        calls.push({ args, timeout: options.timeout });
        if (args[0] === "image") return "linux/amd64";
        if (args[0] === "create") {
          owned = args[args.indexOf("--name") + 1];
          expect(args).toContain("--pull=never");
          expect(args[args.indexOf("--network") + 1]).toBe("none");
          if (failure !== "create") return "created";
        }
        if (args[0] === failure) throw Object.assign(new Error("private-fixture-value"), { code: "ETIMEDOUT", signal: "SIGTERM" });
        if (args[0] === "inspect" && args[1] === owned) {
          if (args.at(-1).includes(".Config.Labels")) return owned.replace(/-identity$/, "");
          return JSON.stringify({ memory: 1024 ** 3, nanoCpus: 1e9, oomKilled: false, exitCode: 0, ports: null });
        }
        if (args[0] === "rm" && args[2] === owned) { owned = undefined; return "removed"; }
        if (args[0] === "ps" || (args[0] === "network" && args[1] === "ls")) return owned || "";
        throw Object.assign(new Error("absent"), { status: 1 });
      };
      await expect(runIsolatedValidation(env, { command })).rejects.toThrow(
        `ISOLATED_SETUP_IDENTITY_${failure === "create" ? "CREATE" : "COPY"}_TIMEOUT`);
      expect(owned).toBeUndefined();
      const diagnostics = JSON.parse(await readFile(join(output, "setup-commands.json"), "utf8"));
      expect(diagnostics.at(-1)).toMatchObject({ status: "failed", reason: "TIMEOUT", timeoutMs: 60_000 });
      expect(JSON.stringify(diagnostics)).not.toContain("private-fixture-value");
      expect(JSON.parse(await readFile(join(output, "cleanup.json"), "utf8"))).toMatchObject({ remaining: [], expired: false });
      expect((await readdir(output)).some((name) => name.endsWith(".receipt.json"))).toBe(false);
      expect(calls.filter(({ args }) => args[0] === "rm")).toHaveLength(1);
      expect(calls.find(({ args }) => args[0] === "rm").timeout).toBe(5000);
      expect(calls.some(({ args }) => ["pull", "run"].includes(args[0]))).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
