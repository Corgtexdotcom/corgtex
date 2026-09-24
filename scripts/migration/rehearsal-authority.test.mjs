import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESOURCE, HOST } from "./probe-ops-azure-target.mjs";
import { REHEARSAL_GROUP_ID, REHEARSAL_TAGS, createRehearsalAuthorityGuard, rehearsalAuthorityForTarget } from "./rehearsal-authority.mjs";
import { Azure } from "./qualify-ops-azure-target.mjs";

const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), spawn: vi.fn() }));
vi.mock("pg", () => ({ default: { Client: class {
  async connect() {} async end() {} query(...args) { return mocks.query(...args); }
} } }));
vi.mock("node:child_process", async original => ({ ...await original(), execFile: (...args) => mocks.execute(...args), spawn: (...args) => mocks.spawn(...args) }));
import { cleanupScratchDatabase, createScratchDatabase, restoreArchiveSections, runPostgresRestoreRehearsal, loadTargetTlsRootCertificate } from "./run-postgres-restore-rehearsal.mjs";
import { work } from "./synthetic-ops-worker.mjs";
const resource = id => ({ id, tags: { ...REHEARSAL_TAGS } });
const snapshot = () => ({ group: resource(REHEARSAL_GROUP_ID), server: resource(RESOURCE) });
const read = state => async args => structuredClone(args[0] === "group" ? state.group : state.server);
const dirs = [];
afterEach(() => { vi.resetAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("fresh historical rehearsal authority", () => {
  it.each(["group", "server"])("rejects transferred %s after a successful initial observation", async kind => {
    const state = snapshot(), guard = createRehearsalAuthorityGuard({ read: read(state) });
    await guard(); state[kind].tags.authority = "production";
    await expect(guard()).rejects.toThrow("REHEARSAL_AUTHORITY_TRANSFERRED");
  });
  it.each(["group", "server"])("rejects wrong exact %s ID even with accepted tags", async kind => {
    const state = snapshot(); state[kind].id += "-foreign";
    await expect(createRehearsalAuthorityGuard({ read: read(state) })()).rejects.toThrow("REHEARSAL_AUTHORITY_ID_MISMATCH");
  });
  it.each([null, {}, { ...REHEARSAL_TAGS, production: "true" }])("missing/extra tags cannot grant old authority %#", async tags => {
    const state = snapshot(); state.server.tags = tags;
    await expect(createRehearsalAuthorityGuard({ read: read(state) })()).rejects.toThrow("REHEARSAL_AUTHORITY_TRANSFERRED");
  });
  it("ARM ID casing is immaterial and provider read errors fail closed", async () => {
    const state = snapshot(); state.server.id = RESOURCE.toUpperCase(); await createRehearsalAuthorityGuard({ read: read(state) })();
    await expect(createRehearsalAuthorityGuard({ read: async () => { throw new Error("unavailable"); } })()).rejects.toThrow();
  });
  for (const operation of ["start", "stop", "createRule", "deleteRule"]) for (const kind of ["group", "server"]) {
    it(`${operation} rereads ${kind} after identity and submits zero mutations following transfer`, async () => {
      const state = snapshot(), effects = [], api = new Azure({});
      api.call = async args => {
        if (args.includes("show")) return read(state)(args);
        effects.push(args); return {};
      };
      await api.authority();
      api.identity = async () => { state[kind].tags.authority = "production"; };
      await expect(api[operation]({ firewallName: "owned", ipv4: "203.0.113.7" })).rejects.toThrow("REHEARSAL_AUTHORITY_TRANSFERRED");
      expect(effects).toEqual([]);
    });
  }
  it("local fixtures and production custody never invoke rehearsal authority reads", async () => {
    const reader = vi.fn();
    await rehearsalAuthorityForTarget({ host: HOST }, { productionMode: true, read: reader })();
    await rehearsalAuthorityForTarget({ host: "localhost" }, { read: reader })();
    expect(reader).not.toHaveBeenCalled();
  });
  it("inner SQL cleanup rechecks tags after finding its owned scratch, before DROP", async () => {
    const state = snapshot(), dir = mkdtempSync(join(tmpdir(), "rehearsal-authority-")); dirs.push(dir);
    const name = "corgtex_rehearsal_123_1_ops";
    const stateFile = join(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ schemaVersion: "1.0.0", scratchName: name, phase: "CREATED",
      targetRef: `sha256:${createHash("sha256").update(`${HOST}\0${name}`).digest("hex").slice(0, 16)}` }));
    mocks.execute.mockImplementation((_bin, args, _opts, callback) => { callback(null, JSON.stringify(args[0] === "group" ? state.group : state.server)); });
    mocks.query.mockImplementation(async sql => {
      if (sql.startsWith("SELECT 1")) { state.server.tags.authority = "production"; return { rowCount: 1 }; }
      throw new Error("unexpected SQL effect");
    });
    await expect(cleanupScratchDatabase({ targetAdminConfig: { host: HOST, database: "postgres", user: "admin", sslmode: "disable" },
      stateFile, artifactDir: dir, expectedScratchName: name })).rejects.toThrow("REHEARSAL_AUTHORITY_TRANSFERRED");
    expect(mocks.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("restore refuses transferred rehearsal authority before opening any database", async () => {
    const state = snapshot(); state.group.tags.authority = "production";
    mocks.execute.mockImplementation((_bin, args, _opts, callback) => callback(null, JSON.stringify(args[0] === "group" ? state.group : state.server)));
    await expect(runPostgresRestoreRehearsal({ domain: "ops", targetAdminConfig: { host: HOST }, sourceConfig: {} })).rejects.toThrow("REHEARSAL_AUTHORITY_TRANSFERRED");
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("scratch CREATE rejects authority transferred during the SQL absence check", async () => {
    const state = snapshot(), guard = createRehearsalAuthorityGuard({ read: read(state) }); await guard();
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-create-")); dirs.push(dir);
    mocks.query.mockImplementation(async () => { state.group.tags.authority = "production"; return { rowCount: 0 }; });
    await expect(createScratchDatabase({ adminConfig: { host: HOST, sslmode: "disable" }, scratchName: "corgtex_rehearsal_123_ops",
      settings: { encoding: "UTF8", provider: "libc", collation: "C", ctype: "C", providerLocale: null, icuRules: null },
      stateFile: join(dir, "state.json"), targetRef: "opaque", artifactDir: dir, assertCustody: guard })).rejects.toThrow("REHEARSAL_AUTHORITY_TRANSFERRED");
    expect(mocks.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it.each([0, 1, 2])("restore stops before section %i if an earlier observation is stale", async completed => {
    const state = snapshot(), guard = createRehearsalAuthorityGuard({ read: read(state) }); await guard();
    let effects = 0;
    mocks.spawn.mockImplementation(() => {
      effects++;
      const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdout = new PassThrough();
      queueMicrotask(() => { if (effects === completed) state.server.tags.authority = "production"; child.emit("close", 0, null); });
      return child;
    });
    if (completed === 0) state.server.tags.authority = "production";
    await expect(restoreArchiveSections({ tempDir: "/private-fixture", artifactDir: "/private-fixture",
      clientFiles: { serviceFile: "pg_service.conf", passFile: "pgpass", sourceRootCertFile: null },
      assertCustody: guard })).rejects.toThrow("REHEARSAL_AUTHORITY_TRANSFERRED");
    expect(effects).toBe(completed);
  });
  it("rechecks cancellation after authority reads and opens no SQL session", async () => {
    const state = snapshot(), abort = new AbortController();
    await expect(runPostgresRestoreRehearsal({ domain: "ops", targetAdminConfig: { host: HOST }, signal: abort.signal,
      rehearsalAuthorityOptions: { read: async args => { const value = await read(state)(args); if (args[0] === "postgres") abort.abort(); return value; } },
    })).rejects.toThrow("RESTORE_ABORTED");
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("synthetic corpus authority uses its supervisor, actual CLI config and absolute child deadline before CREATE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-corpus-")); dirs.push(dir);
    const deadline = Date.now() + 9000, supervisor = { run: vi.fn(async () => { throw new Error("unavailable"); }) };
    mocks.query.mockResolvedValue({ rowCount: 0 });
    await expect(work("corpus", { targetAdminConfig: { host: HOST, database: "postgres", sslmode: "verify-full", targetTlsRootCert: loadTargetTlsRootCertificate() },
      scratchName: "corgtex_rehearsal_syn_123_1_corpus", artifactDir: dir, stateFile: join(dir, "state.json"), deadline }, supervisor)).rejects.toThrow("REHEARSAL_AUTHORITY_UNAVAILABLE");
    const [bin, args, options] = supervisor.run.mock.calls[0];
    expect(bin).toBe("az"); expect(args.slice(0, 2)).toEqual(["group", "show"]);
    expect(options.deadline).toBeLessThanOrEqual(deadline + 5);
    expect(options.env.HOME).toBe(process.env.HOME);
    expect(options.env.AZURE_CONFIG_DIR).toBe(process.env.AZURE_CONFIG_DIR);
    expect(options.env).not.toHaveProperty("TARGET_POSTGRES_ADMIN_PASSWORD");
    expect(mocks.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("expired authority deadlines perform no provider reads, including a deadline crossed by the final read", async () => {
    const reader = vi.fn();
    await expect(createRehearsalAuthorityGuard({ read: reader, deadline: Date.now() - 1 })()).rejects.toThrow("REHEARSAL_AUTHORITY_DEADLINE");
    expect(reader).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      const state = snapshot(), deadline = Date.now() + 100;
      await expect(createRehearsalAuthorityGuard({ deadline, read: async args => {
        const value = await read(state)(args); if (args[0] === "postgres") vi.setSystemTime(deadline); return value;
      } })()).rejects.toThrow("REHEARSAL_AUTHORITY_DEADLINE");
    } finally { vi.useRealTimers(); }
  });
  it("workflow recovery and always-cleanup guard every direct ARM write at its final boundary", () => {
    const lines = readFileSync(".github/workflows/azure-migration-postgres-rehearsal.yml", "utf8").split("\n");
    const mutations = lines.map((line, n) => /az postgres flexible-server (firewall-rule (create|delete)|db delete)/.test(line) ? n : -1).filter(n => n >= 0);
    expect(mutations).toHaveLength(4);
    for (const n of mutations) expect(lines[n - 1].trim()).toBe("node scripts/migration/rehearsal-authority.mjs");
  });
});
