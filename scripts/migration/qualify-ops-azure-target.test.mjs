import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { RESOURCE, HOST } from "./probe-ops-azure-target.mjs";
import { Azure, SERVER, prepare, qualify, cleanup, validateIntent, validateServer, validateEnvironment, validIp, validateRecoveryEvidence } from "./qualify-ops-azure-target.mjs";

const baseline = () => ({ id: RESOURCE, name: SERVER, fullyQualifiedDomainName: HOST, administratorLogin: "corgtexadmin", version: "18",
  location: "westus3", sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" }, storage: { storageSizeGb: 128 },
  highAvailability: { mode: "Disabled" }, backup: { backupRetentionDays: 7 }, network: { publicNetworkAccess: "Enabled" },
  tags: { authority: "non-authoritative-restore-target", purpose: "railway-to-azure-migration-foundation", managedBy: "github-oidc" }, state: "Stopped" });
const inputs = { runId: "12345", runAttempt: "1", ipv4: "203.0.113.7" };
const setup = () => {
  const events = [], server = baseline(); let rules = [];
  const c = { time: 1700000000000, now() { return this.time; }, async sleep(ms) { this.time += ms; } };
  const api = {
    events, current: server,
    async identity() { events.push("identity"); }, async boundary() { events.push("boundary"); },
    async server() { events.push("server"); return structuredClone(server); }, async rules() { events.push("rules"); return structuredClone(rules); },
    async start() { events.push("start"); server.state = "Ready"; },
    async stop() { events.push("stop"); server.state = "Stopped"; },
    async createRule(i) { events.push("create"); rules = [{ id: `${RESOURCE}/firewallRules/${i.firewallName}`, name: i.firewallName, startIpAddress: i.ipv4, endIpAddress: i.ipv4 }]; },
    async deleteRule() { events.push("delete"); rules = []; },
    setRules(value) { rules = value; },
  };
  return { api, c, events };
};

describe("target qualification lifecycle", () => {
  it("prepares a one-hour typed intent using reads only", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c);
    expect(events).toEqual(["identity", "boundary", "server", "rules"]);
    expect(i.deadline - i.createdAt).toBe(3600000); expect(i.deadline - i.workDeadline).toBe(900000);
    expect(i).not.toHaveProperty("scratchName"); expect(validateIntent(i, "12345", "1")).toBe(i);
  });
  it("requires durable attempt marking before START, and cleans exact resources", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c);
    const r = await qualify(api, i, async () => { events.push("probe"); return { status: "metadata" }; }, async () => { events.push("persist"); }, c);
    expect(r.status).toBe("metadata"); expect(events.indexOf("persist")).toBeLessThan(events.indexOf("start"));
    expect(events.indexOf("create")).toBeLessThan(events.indexOf("probe"));
    const out = await cleanup(api, i, c); expect(out.withinWindow).toBe(true);
    expect(out.firewallAbsent && out.serverStopped).toBe(true); expect(events.indexOf("delete")).toBeLessThan(events.indexOf("stop"));
  });
  it("failed local marker prevents all effects", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c);
    await expect(qualify(api, i, async () => {}, async () => { throw Error("disk"); }, c)).rejects.toThrow();
    expect(events).not.toContain("start");
  });
  it.each(["id", "fullyQualifiedDomainName", "administratorLogin", "version", "state"])("rejects %s drift", async (field) => {
    const { api, c } = setup(); api.current[field] = "wrong";
    await expect(prepare(api, inputs, c)).rejects.toThrow();
  });
  it("rejects Ready at preflight instead of taking over existing work", async () => {
    const { api, c } = setup(); api.current.state = "Ready";
    await expect(prepare(api, inputs, c)).rejects.toThrow("TARGET_NOT_STOPPED");
  });
  it.each(["kind", "resource", "runId", "runAttempt", "initialState", "firewallName", "deadline", "database"])("rejects altered intent %s", async (key) => {
    const { api, c } = setup(); const i = await prepare(api, inputs, c); i[key] = "wrong";
    expect(() => validateIntent(i, "12345", "1")).toThrow();
  });
  it("rejects restore-shaped or extra-field intents", async () => {
    const { api, c } = setup(); const i = await prepare(api, inputs, c);
    expect(() => validateIntent({ ...i, scratchName: "not_allowed" }, "12345", "1")).toThrow();
  });
  it("rejects foreign firewall ownership without deleting or stopping", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c);
    api.setRules([{ name: "foreign" }]); api.current.state = "Ready";
    await expect(cleanup(api, i, c)).rejects.toThrow(); expect(events).not.toContain("delete"); expect(events).not.toContain("stop");
  });
  it("cleans after failed probe without reading a source or creating a database", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c);
    await expect(qualify(api, i, async () => { throw Error("TLS"); }, async () => {}, c)).rejects.toThrow();
    expect((await cleanup(api, i, c)).serverStopped).toBe(true);
    expect(events).toContain("delete"); expect(events).toContain("stop");
  });
  it("cleans an accepted START whose CLI response failed", async () => {
    const { api, c } = setup(); const i = await prepare(api, inputs, c);
    api.start = async () => { api.current.state = "Ready"; throw Error("uncertain"); };
    await expect(qualify(api, i, async () => {}, async () => {}, c)).rejects.toThrow();
    expect((await cleanup(api, i, c)).serverStopped).toBe(true);
  });
  it("cleans an accepted firewall write whose CLI response failed", async () => {
    const { api, c } = setup(); const i = await prepare(api, inputs, c); const create = api.createRule;
    api.createRule = async (intent) => { await create(intent); throw Error("uncertain"); };
    await expect(qualify(api, i, async () => {}, async () => {}, c)).rejects.toThrow();
    expect((await cleanup(api, i, c)).firewallAbsent).toBe(true);
  });
  it("still stops owned compute if firewall delete fails, but rejects cleanup", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c);
    await qualify(api, i, async () => {}, async () => {}, c); api.deleteRule = async () => { throw Error("delete"); };
    await expect(cleanup(api, i, c)).rejects.toThrow("FIREWALL_NOT_ABSENT"); expect(events).toContain("stop");
  });
  it("reconciles accepted STOP with failed CLI response", async () => {
    const { api, c } = setup(); const i = await prepare(api, inputs, c);
    await qualify(api, i, async () => {}, async () => {}, c);
    api.stop = async () => { api.current.state = "Stopped"; throw Error("uncertain"); };
    expect((await cleanup(api, i, c)).serverStopped).toBe(true);
  });
  it("expires work before START and preserves cleanup reserve", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c); c.time = i.workDeadline;
    await expect(qualify(api, i, async () => {}, async () => {}, c)).rejects.toThrow("ABSOLUTE_DEADLINE_EXCEEDED"); expect(events).not.toContain("start");
  });
  it("times out readiness and stops after it becomes Ready during cleanup", async () => {
    const { api, c } = setup(); const i = await prepare(api, inputs, c); api.start = async () => { api.current.state = "Starting"; };
    c.time = i.workDeadline - 1;
    await expect(qualify(api, i, async () => {}, async () => {}, c)).rejects.toThrow("ABSOLUTE_DEADLINE_EXCEEDED");
    api.current.state = "Ready"; expect((await cleanup(api, i, c)).serverStopped).toBe(true);
  });
  it("recovery cleans but never resets original one-hour outcome", async () => {
    const { api, c } = setup(); const i = await prepare(api, inputs, c);
    api.verifyRecovery = async () => {};
    await qualify(api, i, async () => {}, async () => {}, c); c.time = i.deadline + 1;
    const r = await cleanup(api, i, c, true); expect(r.serverStopped).toBe(true); expect(r.withinWindow).toBe(false);
  });
  it("does not report pre-transition Stopped as cleanup after ambiguous START", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c);
    api.start = async () => { events.push("start"); throw Error("accepted but response lost"); };
    await expect(qualify(api, i, async () => {}, async () => {}, c)).rejects.toThrow();
    const sleep = c.sleep.bind(c);
    c.sleep = async (ms) => { await sleep(ms); if (c.time >= i.createdAt + 15000) api.current.state = "Ready"; };
    const result = await cleanup(api, i, c);
    expect(c.time).toBeGreaterThanOrEqual(i.createdAt + 15000);
    expect(result.serverStopped).toBe(true); expect(events.filter(e => e === "start")).toHaveLength(1);
    expect(events).toContain("stop");
  });
  it("leaves never-reconciled START explicitly unresolved without duplicate START", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c);
    api.start = async () => { events.push("start"); throw Error("ambiguous"); };
    await expect(qualify(api, i, async () => {}, async () => {}, c)).rejects.toThrow();
    c.time = i.deadline - 5001;
    await expect(cleanup(api, i, c)).rejects.toThrow("ABSOLUTE_DEADLINE_EXCEEDED");
    expect(events.filter(e => e === "start")).toHaveLength(1); expect(events).not.toContain("stop");
  });
  it("rejects recovery without execution ownership before any provider call", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c); events.length = 0; api.current.state = "Ready";
    await expect(cleanup(api, i, c, true)).rejects.toThrow("RECOVERY_OWNERSHIP_UNPROVEN"); expect(events).toEqual([]);
  });
  it("bounds failed STOP without repeated mutation attempts", async () => {
    const { api, c, events } = setup(); const i = await prepare(api, inputs, c); await qualify(api, i, async () => {}, async () => {}, c);
    api.stop = async () => { events.push("stop-failed"); throw Error("denied"); }; c.time = i.deadline - 1;
    await expect(cleanup(api, i, c)).rejects.toThrow("ABSOLUTE_DEADLINE_EXCEEDED"); expect(events.filter(e => e === "stop-failed")).toHaveLength(1);
  });
  it("binds every Azure write to a fresh identity check and exact CLI arguments", async () => {
    const api = new Azure({}); const calls = []; api.identity = async () => calls.push("identity"); api.call = async (args) => calls.push(args);
    const { api: fake, c } = setup(); const i = await prepare(fake, inputs, c);
    await api.start(); await api.createRule(i); await api.deleteRule(i); await api.stop();
    for (let n = 0; n < calls.length; n += 2) expect(calls[n]).toBe("identity");
    expect(calls[3]).toContain("--server-name"); expect(calls[3]).toContain(i.ipv4); expect(calls[5]).toContain(i.firewallName);
    expect(calls.flat().join(" ")).not.toMatch(/(?:database| db |grant|role assignment create)/u);
  });
  it("rejects invalid network addresses and unsupported protected inputs", () => {
    for (const ip of ["0.0.0.0", "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "::1", "bad", "224.0.0.1"]) expect(validIp(ip)).toBe(false);
    expect(() => validateEnvironment({ GITHUB_REF: "refs/heads/feature", DOMAIN: "ops" })).toThrow();
    expect(() => validateServer({ ...baseline(), network: { publicNetworkAccess: "Enabled", delegatedSubnetResourceId: "foreign" } })).toThrow();
  });
});

describe("recovery execution ownership", () => {
  async function evidence() {
    const { api, c } = setup(), i = await prepare(api, inputs, c);
    const common = { path: ".github/workflows/azure-migration-postgres-rehearsal.yml", head_branch: "main", event: "workflow_dispatch", workflow_id: 7, run_attempt: 1 };
    const source = { ...common, id: 12345, status: "completed", created_at: new Date(i.createdAt - 1000).toISOString() };
    const current = { ...common, id: 12346, status: "in_progress", created_at: new Date(i.createdAt + 1000).toISOString() };
    return { api, c, i, env: { GITHUB_RUN_ID: "12346", GITHUB_RUN_ATTEMPT: "1" }, value: {
      source, current, runs: { total_count: 2, workflow_runs: [source, current] }, marker: { runId: "12345", runAttempt: "1" }, receipt: null,
      jobs: { total_count: 1, jobs: [{ name: "Qualify existing Ops target metadata only", status: "completed", steps: [
        { name: "Start target, open single-IP access and read metadata once", status: "completed", conclusion: "failure" },
        { name: "Remove qualification access and return target to Stopped", status: "completed", conclusion: "failure" },
      ] }] },
    } };
  }
  it("accepts the exact unresolved originating attempt", async () => {
    const { i, env, value } = await evidence(); expect(() => validateRecoveryEvidence(i, env, value)).not.toThrow();
  });
  const workflow = ".github/workflows/azure-migration-postgres-rehearsal.yml";
  it.each([workflow, `${workflow}@main`, `${workflow}@refs/heads/main`,
    `Corgtexdotcom/corgtex/${workflow}`, `Corgtexdotcom/corgtex/${workflow}@main`,
    `Corgtexdotcom/corgtex/${workflow}@refs/heads/main`])("accepts exact main workflow path %s", async (path) => {
    const { i, env, value } = await evidence();
    for (const run of [value.source, value.current]) {
      run.path = path; run.repository = { full_name: "Corgtexdotcom/corgtex" }; run.head_repository = run.repository;
    }
    expect(() => validateRecoveryEvidence(i, env, value)).not.toThrow();
  });
  it.each([`${workflow}@feature`, `${workflow}@refs/tags/main`, `${workflow}@refs/heads/feature`,
    `foreign/repo/${workflow}@main`, `Corgtexdotcom/other/${workflow}@main`,
    ".github/workflows/other.yml@main", `${workflow}@main@main`, `${workflow}@main/extra`])("rejects foreign or malformed workflow path %s", async (path) => {
    for (const side of ["source", "current"]) {
      const { i, env, value } = await evidence(); value[side].path = path;
      expect(() => validateRecoveryEvidence(i, env, value)).toThrow();
    }
  });
  it.each(["repository", "head_repository"])("rejects foreign %s even with an allowed bare path", async (key) => {
    for (const side of ["source", "current"]) {
      const { i, env, value } = await evidence(); value[side][key] = { full_name: "foreign/repo" };
      expect(() => validateRecoveryEvidence(i, env, value)).toThrow();
    }
  });
  it.each(["completed", "prepare-only", "superseded", "rerun", "incomplete-list", "other-workflow", "active-source"])("rejects %s before stopping later Ready use", async (mode) => {
    const { api, c, i, env, value } = await evidence();
    if (mode === "completed") value.receipt = { status: "TARGET_QUALIFICATION_CLEANED" };
    if (mode === "prepare-only") value.marker = null;
    if (mode === "superseded") { value.runs.workflow_runs.push({ id: 12347, run_attempt: 1 }); value.runs.total_count++; }
    if (mode === "rerun") value.source.run_attempt = 2;
    if (mode === "incomplete-list") value.runs.total_count = 101;
    if (mode === "other-workflow") value.current.workflow_id = 9;
    if (mode === "active-source") value.source.status = "in_progress";
    api.current.state = "Ready"; api.events.length = 0;
    api.verifyRecovery = async () => validateRecoveryEvidence(i, env, value);
    await expect(cleanup(api, i, c, true)).rejects.toThrow(); expect(api.events).toEqual([]);
  });
  it("rejects successful native cleanup even if receipt was omitted", async () => {
    const { i, env, value } = await evidence(); value.jobs.jobs[0].steps[1].conclusion = "success";
    expect(() => validateRecoveryEvidence(i, env, value)).toThrow("RECOVERY_NOT_UNRESOLVED");
  });
  it("rejects skipped START even with a claimed marker", async () => {
    const { i, env, value } = await evidence(); value.jobs.jobs[0].steps[0].conclusion = "skipped";
    expect(() => validateRecoveryEvidence(i, env, value)).toThrow("RECOVERY_NOT_UNRESOLVED");
  });
});

describe("protected workflow integration", () => {
  const yaml = readFileSync(".github/workflows/azure-migration-postgres-rehearsal.yml", "utf8"), w = parse(yaml);
  const q = w.jobs["qualify-target"], r = w.jobs["recover-target-qualification"];
  it("keeps the existing environment, main-only gate, concurrency and permissions", () => {
    expect(w.concurrency).toEqual({ group: "azure-migration-postgres-rehearsal", "cancel-in-progress": false });
    expect(w.permissions).toEqual({ actions: "read", contents: "read", "id-token": "write" });
    for (const job of [q, r]) { expect(job.environment).toBe("azure-migration-foundation"); expect(job.if).toContain("github.ref == 'refs/heads/main'"); }
    expect(w.jobs.rehearsal.if).toContain("inputs.operation == 'rehearse'");
    expect(w.jobs.recovery.if).toContain("inputs.recovery_kind != 'target-qualification'");
    expect(r.if).toContain("inputs.recovery_kind == 'target-qualification'");
  });
  it("isolates source secrets and all scratch/restore effects", () => {
    for (const job of [q, r]) expect(JSON.stringify(job)).not.toMatch(/RAILWAY_|SOURCE_DATABASE|SOURCE_TLS|pg_dump|docker pull|scratch|run-postgres-restore-rehearsal|db delete/u);
    expect(JSON.stringify(r)).not.toContain("POSTGRES_ADMIN_PASSWORD");
  });
  it("checks credential before login/effects and persists intent before run", () => {
    const steps = q.steps; const credential = steps.findIndex(s => s.name?.includes("credential presence"));
    const login = steps.findIndex(s => s.uses === "azure/login@v2");
    const intent = steps.findIndex(s => s.id === "qualification_intent"); const run = steps.findIndex(s => s.name?.startsWith("Start target"));
    expect(credential).toBeLessThan(login); expect(intent).toBeLessThan(run);
    expect(steps[credential].run).toContain('-n "$TARGET_POSTGRES_ADMIN_PASSWORD"');
    expect(steps[intent].with["if-no-files-found"]).toBe("error");
    const cleanup = steps.find(s => s.name?.startsWith("Remove qualification")); expect(cleanup.if).toContain("always()");
    expect(run).toBeLessThan(steps.indexOf(cleanup));
  });
  it("recovers exact typed artifact without a new standalone workflow", () => {
    const download = r.steps.find(s => s.uses === "actions/download-artifact@v5");
    expect(download.with.name).toBe("azure-target-qualification-${{ inputs.recovery_run_id }}-${{ inputs.recovery_run_attempt }}"); expect(download.with["run-id"]).toContain("inputs.recovery_run_id");
    expect(q.steps.find(s => s.name?.startsWith("Start target"))["timeout-minutes"]).toBe(45);
    expect(JSON.stringify(r)).not.toContain("npm ci");
  });
  it("loads qualification cleanup with no installed packages or DB client", () => {
    const dir = mkdtempSync(join(tmpdir(), "corgtex-target-cleanup-"));
    try {
      for (const name of ["qualify-ops-azure-target.mjs", "probe-ops-azure-target.mjs", "validate-postgres-restore-rehearsal.mjs",
        "validate-azure-what-if.mjs", "postgres-schema-representation.mjs", "postgres-schema-tokens.mjs", "postgres-check-structure.mjs"]) {
        copyFileSync(`scripts/migration/${name}`, join(dir, name));
      }
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", "const m=await import('./qualify-ops-azure-target.mjs');if(typeof m.cleanup!=='function')process.exit(1)"],
        { cwd: dir, encoding: "utf8", timeout: 10000 });
      expect(r.status).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
