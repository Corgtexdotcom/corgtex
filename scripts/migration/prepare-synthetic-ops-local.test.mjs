import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

vi.mock("./synthetic-ops-source.mjs", async original => ({ ...await original(), verifyBundle: vi.fn() }));
import { SOURCE_PINS, verifyBundle } from "./synthetic-ops-source.mjs";
import { prepareLocal, cleanupPreparation, localPreparationEnvironment } from "./prepare-synthetic-ops-local.mjs";
import { SyntheticSubprocesses } from "./synthetic-subprocess.mjs";
import { LABEL } from "./bootstrap-synthetic-ops.mjs";

const platform = Object.getOwnPropertyDescriptor(process, "platform"), arch = Object.getOwnPropertyDescriptor(process, "arch");
let root, directory, calls, owned, ready, childError, ownerMismatch, cleanupFailure;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" }); Object.defineProperty(process, "arch", { value: "arm64" });
  root = mkdtempSync(resolve(tmpdir(), "local-prep-test-")); directory = resolve(root, "evidence"); calls = [];
  owned = { id: "12345678-1234-1234-1234-123456789abc", network: "syn-ops-12345678-1234-1234-1234-123456789abc" };
  ready = { status: "SYNTHETIC_SOURCE_PREPARED", pins: SOURCE_PINS, owned, privateExtra: "never-upload",
    runtime: "PG18.6/en_US.utf8/libc2.41/vector0.8.2/linux-arm64", tlsVerified: true, disconnected: true, noDefaultRoute: true,
    comparison: { observationsEqual: true, indexesValid: true, privateExtra: "never-upload" },
    clientTransport: { status: "LOCAL_CLIENT_TRANSPORT_PASS", privateExtra: "never-upload" } };
  childError = ownerMismatch = cleanupFailure = undefined;
  verifyBundle.mockReset();
  let removed = false;
  vi.spyOn(SyntheticSubprocesses.prototype, "run").mockImplementation(async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "git") return "a".repeat(40);
    if (command === process.execPath) {
      expect(args[1]).toBe("source");
      const input = JSON.parse(readFileSync(args[2]));
      writeFileSync(resolve(input.evidenceDirectory, "local-owner.json"), JSON.stringify(owned));
      if (childError === "signal") { process.emit("SIGTERM"); throw { code: "CHILD_INTERRUPTED" }; }
      if (childError) throw { code: childError };
      writeFileSync(resolve(input.directory, "source-ready.json"), JSON.stringify(ready)); return "";
    }
    expect(command).toBe("docker");
    if (cleanupFailure) throw { code: "CHILD_FAILED" };
    if (args[0] === "ps") return removed ? "" : "local-container";
    if (args[0] === "inspect") return JSON.stringify([{ Config: { Labels: { [LABEL]: ownerMismatch ? "unowned" : owned.id } } }]);
    if (args[0] === "rm") { removed = true; return ""; }
    if (args[0] === "network" && args[1] === "ls") return "";
    throw new Error("unexpected command");
  });
});
afterEach(() => {
  // Evidence retains the exact temp path even on failure; no actual Docker ran.
  const intent = resolve(directory, "local-intent.json");
  if (existsSync(intent)) {
    const temp = JSON.parse(readFileSync(intent)).temp;
    if (temp.startsWith(resolve(tmpdir(), "corgtex-synthetic-local-"))) rmSync(temp, { recursive: true, force: true });
  }
  vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", arch);
  rmSync(root, { recursive: true, force: true });
});

describe("provider-free native preparation entrypoint", () => {
  it("runs the shared source worker with deadlines, cleans owned resources and emits only minimized evidence", async () => {
    const result = await prepareLocal(root, directory, { PATH: process.env.PATH, AZURE_CONFIG_DIR: "/private", GITHUB_TOKEN: "private", DOCKER_HOST: "tcp://remote" });
    expect(result).toMatchObject({ status: "LOCAL_PREPARATION_PASS", cleanup: "LOCAL_CLEANED", azureComparison: "NOT_RUN", providerEffects: 0, productionAccepted: false });
    expect(JSON.stringify(result)).not.toMatch(/never-upload|syn-ops|12345678|privateExtra/u);
    const intent = JSON.parse(readFileSync(resolve(directory, "local-intent.json")));
    expect(existsSync(intent.temp)).toBe(false);
    expect(intent.cleanupDeadline - intent.workDeadline).toBe(120000);
    for (const call of calls) {
      expect(Object.keys(call.options.env).sort()).toEqual(["HOME", "PATH", "TMPDIR"]);
      expect(call.options.deadline).toBeLessThanOrEqual(intent.cleanupDeadline);
    }
    expect(calls.find(c => c.command === process.execPath).options.deadline).toBe(intent.workDeadline);
    expect(calls.some(c => c.args[0] === "rm")).toBe(true);
    expect(existsSync(resolve(directory, "source-ready.json"))).toBe(true);
  });
  it.each([["darwin", "arm64"], ["linux", "x64"]])("rejects %s/%s before hashes or effects", async (p, a) => {
    Object.defineProperty(process, "platform", { value: p }); Object.defineProperty(process, "arch", { value: a });
    await expect(prepareLocal(root, directory)).rejects.toMatchObject({ code: "SOURCE_BOOTSTRAP_REQUIRES_LINUX_ARM64" });
    expect(verifyBundle).not.toHaveBeenCalled(); expect(calls).toEqual([]); expect(existsSync(directory)).toBe(false);
  });
  it("fails closed on missing or mismatched public inputs before claiming local resources", async () => {
    verifyBundle.mockImplementation(() => { throw { code: "SOURCE_INPUT_PIN_MISMATCH" }; });
    await expect(prepareLocal(root, directory)).rejects.toMatchObject({ code: "SOURCE_INPUT_PIN_MISMATCH" });
    expect(calls).toEqual([]); expect(existsSync(directory)).toBe(false);
  });
  it.each(["CHILD_DEADLINE", "CHILD_FAILED", "signal"])("retains %s failure while cleaning partial bootstrap", async failure => {
    childError = failure;
    await expect(prepareLocal(root, directory)).rejects.toMatchObject({ code: failure === "signal" ? "LOCAL_PREPARATION_INTERRUPTED" : failure });
    expect(JSON.parse(readFileSync(resolve(directory, "public-summary.json")))).toMatchObject({ status: "LOCAL_PREPARATION_FAILED", cleanup: "LOCAL_CLEANED" });
    expect(calls.some(c => c.args[0] === "rm")).toBe(true);
  });
  it.each(["tlsVerified", "disconnected", "noDefaultRoute"])("requires actual %s source evidence", async field => {
    ready[field] = false;
    await expect(prepareLocal(root, directory)).rejects.toMatchObject({ code: "LOCAL_PREPARATION_UNPROVEN" });
  });
  it("never claims successful cleanup after ownership mismatch, retaining recovery identity", async () => {
    ownerMismatch = true;
    await expect(prepareLocal(root, directory)).rejects.toMatchObject({ code: "FIXTURE_CLEANUP_OWNER_MISMATCH" });
    expect(calls.some(c => c.args[0] === "rm")).toBe(false);
    expect(existsSync(resolve(directory, "local-cleanup.json"))).toBe(false);
    expect(existsSync(resolve(directory, "local-owner.json"))).toBe(true);
    expect(JSON.parse(readFileSync(resolve(directory, "public-summary.json"))).cleanup).toBe("UNPROVEN");
  });
  it("retries cleanup after a failed Docker call using retained identity, without rewriting failed preparation as PASS", async () => {
    cleanupFailure = true;
    await expect(prepareLocal(root, directory)).rejects.toMatchObject({ code: "CHILD_FAILED" });
    cleanupFailure = false;
    await expect(cleanupPreparation(directory)).resolves.toMatchObject({ status: "LOCAL_CLEANED" });
    expect(JSON.parse(readFileSync(resolve(directory, "public-summary.json"))).status).toBe("LOCAL_PREPARATION_FAILED");
  });
  it("does not invent success when cancellation left no intent", async () => {
    await expect(cleanupPreparation(directory)).resolves.toEqual({ status: "LOCAL_NOT_STARTED" });
    expect(calls).toEqual([]); expect(existsSync(resolve(directory, "public-summary.json"))).toBe(false);
  });
  it("refuses a symlinked temporary directory", async () => {
    await prepareLocal(root, directory);
    const intent = JSON.parse(readFileSync(resolve(directory, "local-intent.json")));
    symlinkSync(root, intent.temp);
    calls.length = 0;
    await expect(cleanupPreparation(directory)).rejects.toMatchObject({ code: "LOCAL_CLEANUP_OWNER_UNPROVEN" });
    expect(calls).toEqual([]); expect(existsSync(root)).toBe(true);
  });
  it("uses a fresh HOME and omits inherited provider, Docker and Node configuration", () => {
    expect(localPreparationEnvironment(root, { PATH: "/bin", HOME: "/private", NODE_OPTIONS: "bad", DOCKER_CONTEXT: "remote", AZURE_CONFIG_DIR: "/private" }))
      .toEqual({ PATH: "/bin", HOME: resolve(root, "home"), TMPDIR: root });
  });
});

describe("secretless PR workflow contract", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const scope = workflow.jobs["synthetic-scope"], prep = workflow.jobs["synthetic-preparation"];
  it("has only contents read, PR gating and native ARM64, without privileged environment or persisted credentials", () => {
    for (const job of [scope, prep]) {
      expect(job.permissions).toEqual({ contents: "read" }); expect(job.environment).toBeUndefined();
      expect(job.if).toContain("github.event_name == 'pull_request'");
      expect(job.steps.find(s => s.uses?.startsWith("actions/checkout")).with["persist-credentials"]).toBe(false);
      expect(JSON.stringify(job)).not.toMatch(/secrets\.|id-token|azure\/login|GITHUB_REF|docker\.sock|DOCKER_HOST/u);
    }
    expect(prep["runs-on"]).toBe("ubuntu-24.04-arm"); expect(prep.needs).toBe("synthetic-scope");
    expect(prep.if).toContain("needs.synthetic-scope.outputs.changed == 'true'");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    expect(workflow.on.pull_request_target).toBeUndefined();
  });
  it("downloads only the four anonymous fixed public assets and verifies pins before loading", () => {
    const download = prep.steps.find(s => s.name?.startsWith("Download PUBLIC"));
    expect(download.run).toContain("for asset in source-image.tar synthetic.dump corpus.sql source-baseline.json");
    expect(download.run).toContain("https://github.com/Corgtexdotcom/corgtex/releases/download/ops-synthetic-source-v1/$asset");
    expect(download.run).toContain("verifyBundle(process.env.LOCAL_BUNDLE)");
    expect(download.run).not.toMatch(/Authorization|GH_TOKEN|gh release/u);
    expect(prep.steps.find(s => s.name?.startsWith("Cache pinned")).run).toMatch(/postgres:18\.6@sha256:[a-f0-9]{64}$/u);
    expect(prep.steps.find(s => s.name?.startsWith("Install locked")).run).toBe("npm ci --ignore-scripts");
  });
  it("always attempts bounded owned cleanup and uploads only the sanitized summary, never treats absence as success", () => {
    const cleanup = prep.steps.find(s => s.name === "Retry owned local cleanup");
    expect(cleanup.if).toContain("always()"); expect(cleanup["timeout-minutes"]).toBe(2);
    const upload = prep.steps.find(s => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload.with.path).toBe("${{ env.LOCAL_EVIDENCE }}/public-summary.json");
    expect(upload.with["if-no-files-found"]).toBe("error");
  });
  it("path-gates additions, edits and deletions of harness/strict/workflow dependencies but not customer application edits", () => {
    // Execute the actual workflow shell against a local repository, no hosted call.
    const repo = resolve(root, "repo"); mkdirSync(repo);
    const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git(["init", "-q"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(resolve(repo, "README"), "fixture"); git(["add", "."]); git(["commit", "-qm", "base"]);
    const base = git(["rev-parse", "HEAD"]), output = resolve(root, "output");
    const run = (baseSha = base) => {
      writeFileSync(output, "");
      execFileSync("bash", ["-c", scope.steps.find(s => s.id === "scope").run], { cwd: repo, env: { ...process.env, BASE_SHA: baseSha, GITHUB_OUTPUT: output } });
      return readFileSync(output, "utf8").trim();
    };
    for (const path of ["scripts/migration/synthetic-new.mjs", "scripts/migration/postgres-schema-tokens.mjs", "scripts/migration/run-postgres-restore-rehearsal.mjs", ".github/workflows/ci.yml", "package-lock.json", "apps/web/customer.ts"]) {
      mkdirSync(resolve(repo, path, ".."), { recursive: true }); writeFileSync(resolve(repo, path), "fixture");
      git(["add", "."]); git(["commit", "-qm", "change"]);
      expect(run()).toBe(path.startsWith("apps/") ? "changed=false" : "changed=true");
      const beforeDeletion = git(["rev-parse", "HEAD"]);
      git(["rm", path]); git(["commit", "-qm", "remove"]);
      expect(run(beforeDeletion)).toBe(path.startsWith("apps/") ? "changed=false" : "changed=true");
      expect(run()).toBe("changed=false");
    }
  });
});
