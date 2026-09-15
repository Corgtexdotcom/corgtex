import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Azure, SUBSCRIPTION, TENANT } from "./qualify-ops-azure-target.mjs";
import { sanitize } from "./probe-ops-azure-target.mjs";

// Actual child-process transport, but never Azure CLI, credentials or network.
const fakeAz = `
const fs = require('node:fs');
const [path, mode, subscription, tenant, ...args] = process.argv.slice(1);
let s = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : { refresh: 0, selected: false, calls: [] };
s.calls.push(args);
const save = () => fs.writeFileSync(path, JSON.stringify(s));
const fail = () => { save(); process.stderr.write('synthetic-private-token-should-never-escape'); process.exit(9); };
const output = v => { save(); process.stdout.write(JSON.stringify(v)); };
const op = args.slice(0, 2).join(' ');
if (op === 'account list') {
  if (!args.includes('--refresh') || args.includes('--subscription')) fail();
  s.refresh++;
  if (mode === 'refresh-failure') fail();
  let a = { id: subscription, tenantId: mode === 'foreign-tenant' ? 'other' : tenant, state: mode === 'disabled' ? 'Disabled' : 'Enabled' };
  output(mode === 'missing' || (mode === 'delayed' && s.refresh < 3) ? [] : mode === 'duplicate' ? [a,a] : [a]);
} else if (op === 'account set') {
  if (!s.refresh || args[args.indexOf('--subscription')+1] !== subscription || mode === 'select-failure') fail();
  s.selected = true; output(null);
} else if (op === 'account show') {
  if (!s.selected) fail();
  output({ id: subscription, tenantId: tenant, state: 'Enabled' });
} else fail();
`;

async function fixture(mode, run) {
  const dir = mkdtempSync(join(tmpdir(), "corgtex-fake-az-")), state = join(dir, "state.json"), sleeps = [];
  const execute = (_file, args, options, callback) => execFile(process.execPath,
    ["-e", fakeAz, state, mode, SUBSCRIPTION, TENANT, ...args], options, callback);
  const api = new Azure({}, { execute, sleep: async ms => { sleeps.push(ms); } });
  try { await run(api, () => JSON.parse(readFileSync(state, "utf8")), sleeps); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("exact subscription preflight with fake az", () => {
  it("reproduces uncached account-show failure, then selects exact refreshed subscription", async () => {
    await fixture("normal", async (api, state) => {
      await expect(api.call(["account", "show"])).rejects.toThrow("AZURE_ACCOUNT_SHOW_FAILED");
      await api.selectSubscription();
      expect(await api.call(["account", "show"])).toEqual({ id: SUBSCRIPTION, tenantId: TENANT, state: "Enabled" });
      expect(state().calls.map(a => a.slice(0, 2).join(" "))).toEqual(["account show", "account list", "account set", "account show"]);
    });
  });
  it("runs selection in shared identity before token/role checks and attributes next failure safely", async () => {
    await fixture("normal", async (api, state) => {
      let failure; try { await api.identity(); } catch (error) { failure = error; }
      expect(sanitize(failure).code).toBe("AZURE_TOKEN_READ_FAILED");
      expect(JSON.stringify(sanitize(failure))).not.toContain("synthetic-private");
      expect(state().calls.map(a => a.slice(0, 2).join(" "))).toEqual(["account list", "account set", "account show", "account get-access-token"]);
    });
  });
  it("reuses four bounded refresh attempts and 25-second waits", async () => {
    await fixture("delayed", async (api, state, sleeps) => {
      await api.selectSubscription(); expect(state().refresh).toBe(3); expect(sleeps).toEqual([25000, 25000]);
    });
  });
  it.each(["missing", "refresh-failure"])("bounds %s without selection or fallback", async mode => {
    await fixture(mode, async (api, state, sleeps) => {
      await expect(api.selectSubscription()).rejects.toThrow();
      expect(state().refresh).toBe(4); expect(state().selected).toBe(false); expect(sleeps).toHaveLength(3);
    });
  });
  it.each(["foreign-tenant", "disabled", "duplicate"])("fails immediately on %s", async mode => {
    await fixture(mode, async (api, state, sleeps) => {
      await expect(api.selectSubscription()).rejects.toThrow();
      expect(state().refresh).toBe(1); expect(state().selected).toBe(false); expect(sleeps).toEqual([]);
    });
  });
  it("attributes selection error and suppresses stderr", async () => {
    await fixture("select-failure", async api => {
      let error; try { await api.selectSubscription(); } catch (failure) { error = failure; }
      expect(sanitize(error).code).toBe("AZURE_ACCOUNT_SELECT_FAILED");
      expect(JSON.stringify(error)).not.toContain("synthetic-private");
    });
  });
  it("does not sleep across an existing lifecycle deadline", async () => {
    await fixture("missing", async (api, state, sleeps) => {
      api.deadline = Date.now() + 10000;
      await expect(api.selectSubscription()).rejects.toThrow("AZURE_OPERATION_DEADLINE");
      expect(state().refresh).toBe(1); expect(sleeps).toEqual([]);
    });
  });
  it("uses fixed operation-only output diagnostics without raw arguments", async () => {
    const api = new Azure({}, { execute: (_file, _args, _options, callback) => callback(null, "private invalid output") });
    await expect(api.call(["group", "show", "--name", "private-name"])).rejects.toThrow("AZURE_GROUP_READ_OUTPUT_INVALID");
    await expect(api.call(["unsupported", "private"])).rejects.toThrow("AZURE_OPERATION_UNSUPPORTED");
  });
});
