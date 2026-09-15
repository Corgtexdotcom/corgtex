import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import net from "node:net";

const db = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock("pg", () => ({ default: { Client: class { connect = db.connect; query = db.query; end = db.end; } } }));
import { probeLocalClientTransport, LOCAL_CLIENT_HOST, LABEL } from "./bootstrap-synthetic-ops.mjs";
import { SOURCE_IMAGE } from "./synthetic-ops-source.mjs";
import { HOST, ProbeError } from "./probe-ops-azure-target.mjs";

let directory, owned, calls, captured, failure, leftover;
beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(resolve(tmpdir(), "synthetic-client-")); mkdirSync(resolve(directory, "tls"));
  // Public CA bytes are only input to the mocked child here, not a fixture TLS
  // acceptance claim. The native bootstrap generates its own CA and server SAN.
  const ca = readFileSync(new URL("../../infra/azure/migration-foundation/azure-postgres-root-ca.pem", import.meta.url), "utf8");
  writeFileSync(resolve(directory, "tls/ca.crt"), ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/u)[0]);
  const id = "12345678-1234-1234-1234-123456789abc";
  owned = { id, network: `syn-ops-${id}`, container: `syn-source-${id}` };
  calls = []; captured = null; failure = false; leftover = false;
  db.query.mockResolvedValue({ rows: [{ count: 0 }] });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const supervisor = () => ({ run: vi.fn(async (command, args, options) => {
  calls.push([command, args, options]);
  if (command === "which") return "/bin/echo";
  if (command === process.execPath) {
    expect(args[0]).toMatch(/synthetic-ops-worker\.mjs$/u); expect(args[1]).toBe("transport");
    captured = JSON.parse(readFileSync(args[2], "utf8"));
    expect(readFileSync(resolve(directory, "client-bin/docker"), "utf8")).toContain(`--add-host '${LOCAL_CLIENT_HOST}:127.0.0.1'`);
    if (failure) throw new ProbeError("CHILD_DEADLINE");
    return JSON.stringify({ status: "LOCAL_CLIENT_QUERY_CLOSED" });
  }
  expect(command).toBe("docker");
  if (args[0] === "network") return JSON.stringify([{ Internal: true, EnableIPv6: false, Labels: { [LABEL]: owned.id }, IPAM: { Config: [{ Gateway: "127.0.0.1" }] } }]);
  if (args[0] === "ps") return leftover ? "source\nleftover" : "source";
  if (args[1] === "leftover") return JSON.stringify([{ Name: "/leftover", Config: { Labels: { [LABEL]: owned.id } } }]);
  return JSON.stringify([{ Name: `/${owned.container}`, Config: { Labels: { [LABEL]: owned.id } }, Image: SOURCE_IMAGE,
    HostConfig: {}, NetworkSettings: { Networks: { [owned.network]: { IPAddress: "127.0.0.1" } } } }]);
}) });
const options = s => ({ supervisor: s, deadline: Date.now() + 10000, directory, owned, config: { host: "127.0.0.1" }, env: { PATH: "/bin", GH_TOKEN: "excluded", TARGET_POSTGRES_ADMIN_PASSWORD: "excluded" } });
async function expectClosed() {
  expect(existsSync(resolve(directory, "transport-input.json"))).toBe(false);
  expect(existsSync(resolve(directory, "transport-client"))).toBe(false);
  expect(existsSync(resolve(directory, "client-bin"))).toBe(false);
  const error = await new Promise(done => { const s = net.connect({ host: "127.0.0.1", port: captured.targetAdminConfig.port }); s.once("error", done); s.once("connect", () => { s.destroy(); done(null); }); });
  expect(error?.code).toBe("ECONNREFUSED");
}

describe("provider-free client probe orchestration", () => {
  it("uses one bounded client child, exact local TLS hostname, owned network and clean disconnect", async () => {
    const s = supervisor(), opt = options(s);
    const result = await probeLocalClientTransport(opt);
    expect(result).toMatchObject({ status: "LOCAL_CLIENT_TRANSPORT_PASS", tlsMode: "verify-full", disconnected: true, providerEffects: 0 });
    expect(captured.owned).toEqual(owned);
    expect(captured.targetAdminConfig).toMatchObject({ host: LOCAL_CLIENT_HOST, dockerHost: LOCAL_CLIENT_HOST, user: "fixture_reader", database: "source", sslmode: "verify-full" });
    const children = calls.filter(([command]) => command === process.execPath);
    expect(children).toHaveLength(1); expect(children[0][2].deadline).toBe(opt.deadline);
    expect(children[0][2].env.PATH).toContain("client-bin");
    expect(children[0][2].env.GH_TOKEN).toBeUndefined(); expect(children[0][2].env.TARGET_POSTGRES_ADMIN_PASSWORD).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(HOST);
    expect(db.connect).toHaveBeenCalledTimes(1); expect(db.end).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='fixture_reader'");
    await expectClosed();
  });
  it("closes its gateway and removes credentials/wrapper when the actual client subprocess fails", async () => {
    failure = true;
    await expect(probeLocalClientTransport(options(supervisor()))).rejects.toMatchObject({ code: "CHILD_DEADLINE" });
    expect(db.connect).not.toHaveBeenCalled(); await expectClosed();
  });
  it("does not claim clean disconnect if a daemon-owned client container remains", async () => {
    leftover = true;
    await expect(probeLocalClientTransport(options(supervisor()))).rejects.toThrow("LOCAL_CLIENT_CLOSE_UNPROVEN");
    await expectClosed();
  });
});
