import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import net from "node:net";
import { parse } from "yaml";
import { SyntheticSubprocesses, localToolEnvironment, supervisedExecFile } from "./synthetic-subprocess.mjs";
import { SOURCE_PINS, SOURCE_IMAGE, SOURCE_BASELINE_RUNTIME, projectSourceBaseline, validateSourceBaseline, hash, pinnedBytes, assertRuntime, compareCorpus } from "./synthetic-ops-source.mjs";
import { HOST, RESOURCE, ProbeError } from "./probe-ops-azure-target.mjs";
import { syntheticIntent, validateSyntheticIntent, validateScratchState, validatePrivateTemp, ScratchRecovery, runSyntheticPasses, completeSyntheticCleanup } from "./qualify-synthetic-ops.mjs";
import { validateRecoveryEvidence } from "./qualify-ops-azure-target.mjs";
import { relay, inspectSource, cleanupLocal, clientTransport, LOCAL_CLIENT_HOST, LABEL } from "./bootstrap-synthetic-ops.mjs";
import { work } from "./synthetic-ops-worker.mjs";

const dirs = [];
const temporary = () => { const dir = mkdtempSync(resolve(tmpdir(), "syn-ops-test-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const lifecycle = () => {
  const createdAt = Date.now();
  return { schemaVersion: "1.0.0", kind: "ops-target-qualification", resource: RESOURCE, host: HOST, database: "postgres",
    runId: "12345", runAttempt: "1", initialState: "Stopped", firewallName: "corgtex-target-qualification-12345-1", ipv4: "203.0.113.7",
    createdAt, deadline: createdAt + 3600000, workDeadline: createdAt + 2700000, transitionCapUsd: 5 };
};

describe("synthetic child supervision", () => {
  it("runs and naturally closes a normal child", async () => {
    const s = new SyntheticSubprocesses();
    expect(await s.run(process.execPath, ["-e", "process.stdout.write('ok')"], { deadline: Date.now() + 2000, env: localToolEnvironment() })).toBe("ok");
    expect(s.active.size).toBe(0);
  });
  it("terminates a SIGTERM-ignoring child AND its grandchild at the deadline", async () => {
    const s = new SyntheticSubprocesses(), path = resolve(temporary(), "pid");
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(path)},String(child.pid));setInterval(()=>{},100);`;
    await expect(s.run(process.execPath, ["-e", code], { deadline: Date.now() + 500, env: localToolEnvironment() })).rejects.toThrow("CHILD_DEADLINE");
    expect(existsSync(path)).toBe(true);
    const pid = Number(readFileSync(path, "utf8"));
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } }).toBe(true);
    expect(s.active.size).toBe(0);
  });
  it("rejects oversized output and stops the process, not just the waiter", async () => {
    const s = new SyntheticSubprocesses();
    await expect(s.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},100)"], { deadline: Date.now() + 2000, maxBytes: 100, env: localToolEnvironment() })).rejects.toThrow("CHILD_OUTPUT_LIMIT");
    expect(s.active.size).toBe(0);
  });
  it("does not start another child after interruption", async () => {
    const s = new SyntheticSubprocesses(); s.stop();
    await expect(s.run("never-run", [], { deadline: Date.now() + 1000 })).rejects.toThrow("CHILD_INTERRUPTED");
  });
  it("adapts the existing Azure execFile contract to bounded process groups", async () => {
    const run = vi.fn().mockResolvedValue("{}"); const callback = vi.fn();
    supervisedExecFile({ run })("az", ["account", "show"], { timeout: 1000, maxBuffer: 99, env: { PATH: "/bin" } }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(null, "{}"));
    expect(run.mock.calls[0][2]).toMatchObject({ maxBytes: 99, env: { PATH: "/bin" } });
  });
  it("never inherits source/provider passwords or GitHub tokens into local tools", () => {
    expect(localToolEnvironment({ PATH: "/bin", HOME: "/tmp", GH_TOKEN: "secret", SOURCE_DATABASE_URL: "secret", TARGET_POSTGRES_ADMIN_PASSWORD: "secret" })).toEqual({ PATH: "/bin", HOME: "/tmp" });
  });
});

describe("fixed synthetic input and runtime guards", () => {
  it("rejects changed bytes and symlinks before loading a source image", () => {
    const dir = temporary(); writeFileSync(resolve(dir, "synthetic.dump"), "wrong");
    expect(() => pinnedBytes(dir, "synthetic.dump")).toThrow("SYNTHETIC_INPUT_PIN_MISMATCH");
    symlinkSync(resolve(dir, "synthetic.dump"), resolve(dir, "corpus.sql"));
    expect(() => pinnedBytes(dir, "corpus.sql")).toThrow();
    expect(() => pinnedBytes(dir, "production.dump")).toThrow("UNKNOWN_SYNTHETIC_INPUT");
  });
  const row = { version: 180006, encoding: "UTF8", locale: "en_US.utf8", ctype: "en_US.utf8", provider: "c", recorded: "2.41", actual: "2.41", vector: "0.8.2", tls: true };
  it("attests actual 2.41, not merely PostgreSQL18 or recorded metadata", () => { expect(() => assertRuntime(row, "2.41")).not.toThrow(); });
  it.each(["version", "locale", "ctype", "provider", "recorded", "actual", "vector", "tls"])("rejects wrong %s", field => {
    expect(() => assertRuntime({ ...row, [field]: "wrong" }, "2.41")).toThrow("SYNTHETIC_RUNTIME_MISMATCH");
  });
  it("does not confuse catalog-valid indexes with matching corpus behavior", () => {
    expect(compareCorpus({ observations: [2, 1], indexesValid: true }, { observations: [1, 2] })).toMatchObject({ observationsEqual: false, indexesValid: true, schemaGuardWaived: false });
    expect(compareCorpus({ observations: [1, 2], indexesValid: false }, { observations: [1, 2] })).toMatchObject({ observationsEqual: true, indexesValid: false });
  });
  it("projects only exact observations, source runtime and corpus binding from the private receipt", () => {
    const observations = { orderedIds: [2, 1], ranges: [{ lo: "a", hi: "z", ids: [1] }], expressions: [{ id: 1, lower: "61" }], lowerRange: [1] };
    const receipt = { id: "private-run", resources: { container: "private-id" }, cleanup: { details: "private" },
      probe: { database: { ...SOURCE_BASELINE_RUNTIME, installed_vector: "0.8.2", pid: 123 },
        baseline: { observations, corpusSha256: SOURCE_PINS["corpus.sql"], indexEvidence: { privatePlans: true } } } };
    const baseline = projectSourceBaseline(receipt);
    expect(baseline).toEqual({ schemaVersion: 1, sourceRuntime: SOURCE_BASELINE_RUNTIME, corpusSha256: SOURCE_PINS["corpus.sql"], observations });
    expect(baseline.observations).toBe(observations);
    expect(JSON.stringify(baseline.observations)).toBe(JSON.stringify(receipt.probe.baseline.observations));
    expect(JSON.stringify(baseline)).not.toMatch(/private|pid|indexEvidence|cleanup|resources/u);
  });
  it.each(["runtime", "corpus", "privateFields"])("rejects a projected baseline with changed %s binding", field => {
    const baseline = { schemaVersion: 1, sourceRuntime: { ...SOURCE_BASELINE_RUNTIME }, corpusSha256: SOURCE_PINS["corpus.sql"], observations: {} };
    if (field === "runtime") baseline.sourceRuntime.actual = "2.38";
    if (field === "corpus") baseline.corpusSha256 = "different";
    if (field === "privateFields") baseline.resources = {};
    expect(() => validateSourceBaseline(baseline)).toThrow("SOURCE_BASELINE_BINDING_MISMATCH");
  });
  it("rejects non-target worker configurations before connecting", async () => {
    await expect(work("restore", { targetAdminConfig: { host: "customer.invalid" } })).rejects.toThrow("SYNTHETIC_TARGET_CONFIG_MISMATCH");
  });
});

describe("run-owned scratch recovery", () => {
  const name = "corgtex_rehearsal_syn_12345_1_1";
  const state = () => ({ schemaVersion: "1.0.0", scratchName: name, targetRef: `sha256:${hash(`${HOST}\0${name}`).slice(0, 16)}`, phase: "ABSENCE_VERIFIED" });
  it("retains the original identity, pins and absolute deadlines", () => {
    const i = syntheticIntent(lifecycle());
    expect(validateSyntheticIntent(i, "12345", "1")).toBe(i);
    expect(i.pins).toEqual(SOURCE_PINS); expect(i.scratch).toHaveLength(3);
  });
  it.each(["pins", "scratch", "sourceRuntime", "targetRuntime", "productionAccepted"])("rejects changed intent %s", field => {
    const i = syntheticIntent(lifecycle()); i[field] = "changed";
    expect(() => validateSyntheticIntent(i, "12345", "1")).toThrow();
  });
  it.each([null, { ...state(), phase: "INTENT" }, { ...state(), scratchName: "corgtex" }, { ...state(), targetRef: "wrong" }])("never adopts unproven DB ownership %#", s => {
    expect(() => validateScratchState(s, name)).toThrow("DATABASE_OWNERSHIP_UNPROVEN");
  });
  it.each(["ABSENCE_VERIFIED", "CREATED"])("allows exact owned %s recovery", phase => {
    expect(() => validateScratchState({ ...state(), phase }, name)).not.toThrow();
  });
  it("never submits DELETE for an existing unowned database", async () => {
    const api = { identity: vi.fn(), boundary: vi.fn() };
    const recovery = new ScratchRecovery({}, api, Date.now() + 1000, {});
    recovery.matching = vi.fn().mockResolvedValue(true); recovery.command = vi.fn();
    await expect(recovery.drop(name, null)).rejects.toThrow("DATABASE_OWNERSHIP_UNPROVEN");
    expect(recovery.command).not.toHaveBeenCalled();
  });
  it("reconciles an ambiguous DELETE once and requires exact absence", async () => {
    const recovery = new ScratchRecovery({}, { identity: vi.fn(), boundary: vi.fn() }, Date.now() + 1000, {});
    recovery.matching = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    recovery.command = vi.fn().mockRejectedValue(new Error("ambiguous"));
    expect(await recovery.drop(name, state())).toMatchObject({ scratchDatabase: { dropped: true } });
    expect(recovery.command).toHaveBeenCalledTimes(1);
  });
  it("an absent database needs no ownership adoption or DELETE", async () => {
    const recovery = new ScratchRecovery({}, { identity: vi.fn(), boundary: vi.fn() }, Date.now() + 1000, {});
    recovery.matching = vi.fn().mockResolvedValue(false); recovery.command = vi.fn();
    await recovery.drop(name, null); expect(recovery.command).not.toHaveBeenCalled();
  });
  it("does not start a second restore before cleaning a partial first restore", async () => {
    const events = [], i = syntheticIntent(lifecycle());
    await runSyntheticPasses(i, async phase => { events.push(`run${phase}`); if (phase === "1") throw new ProbeError("RESTORE_FAILED"); }, async phase => { events.push(`clean${phase}`); }, async phase => { events.push(`record${phase}`); });
    expect(events).toEqual(["run1", "clean1", "record1", "run2", "clean2", "record2", "runcorpus", "cleancorpus", "recordcorpus"]);
    const execute = vi.fn();
    await expect(runSyntheticPasses(i, execute, async () => { throw new Error("not clean"); }, vi.fn())).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(["local", "databases"])("still removes firewall/stops after %s cleanup fails, but cannot claim success", async failing => {
    const events = [];
    const operations = Object.fromEntries(["local", "databases", "lifecycle"].map(key => [key, async () => { events.push(key); if (key === failing) throw new Error("failure"); return {}; }]));
    await expect(completeSyntheticCleanup(operations)).rejects.toThrow("failure");
    expect(events).toEqual(["local", "databases", "lifecycle"]);
  });
  it("rejects arbitrary temp cleanup paths and symlink roots", () => {
    const root = temporary(), env = { RUNNER_TEMP: root, GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1", SYNTHETIC_TEMP_DIR: root };
    expect(() => validatePrivateTemp(env, "/artifacts")).toThrow();
    env.SYNTHETIC_TEMP_DIR = resolve(root, "synthetic-ops-12345-1");
    expect(validatePrivateTemp(env, "/artifacts")).toBe(env.SYNTHETIC_TEMP_DIR);
    symlinkSync(root, env.SYNTHETIC_TEMP_DIR); expect(() => validatePrivateTemp(env, "/artifacts")).toThrow();
  });
});

describe("local fixture transport and ownership", () => {
  it("executes the shared Docker wrapper with only the local hostname/gateway and cleans its listener", async () => {
    const id = "12345678-1234-1234-1234-123456789abc", owned = { id, network: `syn-ops-${id}`, container: `syn-source-${id}` };
    const directory = temporary(), real = new SyntheticSubprocesses();
    const run = vi.fn(async (command, args) => {
      if (command === "which") return "/bin/echo";
      expect(command).toBe("docker");
      if (args[0] === "network") return JSON.stringify([{ Internal: true, EnableIPv6: false, Labels: { [LABEL]: id }, IPAM: { Config: [{ Gateway: "127.0.0.1" }] } }]);
      return JSON.stringify([{ Config: { Labels: { [LABEL]: id } }, Image: SOURCE_IMAGE, HostConfig: {}, NetworkSettings: { Networks: { [owned.network]: { IPAddress: "127.0.0.1" } } } }]);
    });
    const transport = await clientTransport({ supervisor: { run }, deadline: Date.now() + 5000, directory, owned, target: "local", env: { PATH: "/bin", GH_TOKEN: "not-inherited" } });
    try {
      const output = await real.run(resolve(directory, "client-bin/docker"), ["run", "--rm", "--network", owned.network, "pinned-client", "psql"], { deadline: Date.now() + 2000, env: transport.env });
      expect(output).toContain(`--pull=never --label ${LABEL}=${id} --add-host ${LOCAL_CLIENT_HOST}:127.0.0.1`);
      expect(output).toContain(`--network ${owned.network} pinned-client psql`);
      expect(output).not.toContain(HOST); expect(transport.env.GH_TOKEN).toBeUndefined();
      await expect(real.run(resolve(directory, "client-bin/docker"), ["pull", "anything"], { deadline: Date.now() + 2000, env: transport.env })).rejects.toThrow();
    } finally { await transport.close(); real.stop(); }
    expect(existsSync(resolve(directory, "client-bin"))).toBe(false);
    const error = await new Promise(done => { const s = net.connect({ host: "127.0.0.1", port: transport.port }); s.once("error", done); s.once("connect", () => { s.destroy(); done(null); }); });
    expect(error?.code).toBe("ECONNREFUSED");
  });
  it("forwards to only its fixed endpoint and cleanly closes actual sockets", async () => {
    const echo = net.createServer(s => s.pipe(s));
    await new Promise(r => echo.listen(0, "127.0.0.1", r));
    const bridge = await relay("127.0.0.1", "127.0.0.1", echo.address().port);
    try {
      const received = await new Promise((yes, no) => {
        const s = net.connect({ host: "127.0.0.1", port: bridge.port });
        s.on("connect", () => s.write("one-query")); s.on("error", no);
        s.once("data", bytes => { s.end(); yes(bytes.toString()); });
      });
      expect(received).toBe("one-query");
    } finally { await bridge.close(); await new Promise(r => echo.close(r)); }
  });
  it("rejects a source attached to an outbound network", async () => {
    const id = "12345678-1234-1234-1234-123456789abc", owned = { id, network: `syn-ops-${id}`, container: `syn-source-${id}` };
    const docker = vi.fn().mockResolvedValueOnce(JSON.stringify([{ Internal: false, Labels: { [LABEL]: id } }])).mockResolvedValueOnce(JSON.stringify([{ Config: { Labels: { [LABEL]: id } }, Image: SOURCE_IMAGE }]));
    await expect(inspectSource(docker, owned)).rejects.toThrow("FIXTURE_NETWORK_OR_OWNER_DRIFT");
  });
  it("never removes a Docker object with a mismatched label", async () => {
    const docker = vi.fn().mockResolvedValueOnce("container-id").mockResolvedValueOnce(JSON.stringify([{ Config: { Labels: { [LABEL]: "other" } } }]));
    await expect(cleanupLocal(docker, { id: "12345678-1234-1234-1234-123456789abc" })).rejects.toThrow("FIXTURE_CLEANUP_OWNER_MISMATCH");
    expect(docker.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
  });
});

describe("protected workflow and recovery compatibility", () => {
  it("keeps metadata/restore/synthetic jobs disjoint without new environment or permissions", () => {
    const w = parse(readFileSync(new URL("../../.github/workflows/azure-migration-postgres-rehearsal.yml", import.meta.url), "utf8"));
    expect(w.concurrency).toEqual({ group: "azure-migration-postgres-rehearsal", "cancel-in-progress": false });
    expect(w.permissions).toEqual({ actions: "read", contents: "read", "id-token": "write" });
    for (const job of Object.values(w.jobs)) expect(job.environment).toBe("azure-migration-foundation");
    expect(w.jobs.recovery.if).toContain("recovery_kind == 'restore'");
    expect(w.jobs["recover-synthetic"].if).toContain("recovery_kind == 'synthetic-qualification'");
    const text = JSON.stringify(w.jobs["qualify-synthetic"]);
    expect(text).not.toMatch(/RAILWAY|SOURCE_DATABASE_URL|SOURCE_TLS_ROOT_CERT|migrate deploy|db push/u);
    expect(text).toContain("secrets.AZURE_MIGRATION_POSTGRES_ADMIN_PASSWORD");
    expect(text).not.toMatch(/role assignment create|azure.extensions/u);
    expect(w.jobs["qualify-synthetic"]["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(w.jobs["qualify-synthetic"].if).toContain("inputs.operation == 'prepare-synthetic'");
    const providerSteps = w.jobs["qualify-synthetic"].steps.filter(s => s.uses === "azure/login@v2" || ["Prepare exact synthetic lifecycle and scratch ownership", "Persist synthetic intent before START", "Start target and compare pinned synthetic source"].includes(s.name));
    expect(providerSteps).toHaveLength(4);
    for (const step of providerSteps) expect(step.if).toBe("inputs.operation == 'qualify-synthetic'");
  });
  it("requires the synthetic native job/steps, rejecting metadata receipts and later runs", () => {
    const i = lifecycle(), common = { path: ".github/workflows/azure-migration-postgres-rehearsal.yml", head_branch: "main", event: "workflow_dispatch", workflow_id: 7, run_attempt: 1 };
    const source = { ...common, id: 12345, status: "completed", created_at: new Date(i.createdAt - 1000).toISOString() };
    const current = { ...common, id: 12346, status: "in_progress", created_at: new Date(i.createdAt + 1000).toISOString() };
    const evidence = { source, current, runs: { total_count: 2, workflow_runs: [source, current] }, marker: { runId: "12345", runAttempt: "1" }, receipt: null,
      jobs: { total_count: 1, jobs: [{ name: "Qualify pinned synthetic Ops archive only", status: "completed", steps: [
        { name: "Start target and compare pinned synthetic source", status: "completed", conclusion: "failure" },
        { name: "Remove synthetic scratch databases and stop target", status: "completed", conclusion: "failure" },
      ] }] } };
    const env = { GITHUB_RUN_ID: "12346", GITHUB_RUN_ATTEMPT: "1" };
    expect(() => validateRecoveryEvidence(i, env, evidence, "synthetic")).not.toThrow();
    expect(() => validateRecoveryEvidence(i, env, evidence)).toThrow("RECOVERY_JOB_UNPROVEN");
    evidence.runs.workflow_runs.push({ ...source, id: 12347 }); evidence.runs.total_count++;
    expect(() => validateRecoveryEvidence(i, env, evidence, "synthetic")).toThrow("RECOVERY_SUPERSEDED");
  });
});
