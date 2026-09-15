import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { HOST } from "./probe-ops-azure-target.mjs";

const mocks = vi.hoisted(() => ({ run: vi.fn(), cleanup: vi.fn(), database: vi.fn(), pinned: vi.fn(), baseline: vi.fn(), corpus: vi.fn(), clientFiles: vi.fn(), probe: vi.fn(), pins: {} }));
vi.mock("./run-postgres-restore-rehearsal.mjs", async original => ({ ...await original(), runPostgresRestoreRehearsal: mocks.run, cleanupScratchDatabase: mocks.cleanup, writeClientFiles: mocks.clientFiles, probeTargetClientConnection: mocks.probe }));
vi.mock("./bootstrap-synthetic-ops.mjs", async original => ({ ...await original(), withDatabase: mocks.database }));
vi.mock("./synthetic-ops-source.mjs", async original => ({ ...await original(), pinnedBytes: mocks.pinned, readSourceBaseline: mocks.baseline, collectCorpus: mocks.corpus, SOURCE_PINS: mocks.pins }));
import { work } from "./synthetic-ops-worker.mjs";
import { LOCAL_CLIENT_HOST } from "./bootstrap-synthetic-ops.mjs";

let root, config;
const archive = Buffer.from("test-only synthetic archive");
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(resolve(tmpdir(), "synthetic-worker-"));
  writeFileSync(resolve(root, "synthetic.dump"), archive);
  config = { bundle: root, sourceConfig: { host: "127.0.0.1", port: 1234, database: "source", user: "fixture_reader", sslmode: "require" },
    targetAdminConfig: { host: HOST, database: "postgres", sslmode: "verify-full", targetTlsRootCert: "test-ca" },
    scratchName: "corgtex_rehearsal_syn_12345_1_1", stateFile: resolve(root, "state.json"), artifactDir: resolve(root, "evidence"), tempDir: resolve(root, "work"), dockerNetwork: "owned-internal-network" };
  mocks.pins["synthetic.dump"] = createHash("sha256").update(archive).digest("hex");
  mocks.pinned.mockReturnValue(archive);
  mocks.database.mockImplementation((_config, run) => run({ query: async () => ({ rows: [{ version: 180006, encoding: "UTF8", locale: "en_US.utf8", ctype: "en_US.utf8", provider: "c", recorded: "2.38", actual: "2.38", vector: "0.8.2", tls: true }] }) }));
  mocks.run.mockImplementation(async args => {
    mkdirSync(args.tempDir);
    writeFileSync(resolve(args.tempDir, "snapshot.dump"), "new dump must not be restored");
    await args.afterArchive();
    return { targetRef: "synthetic-target-ref" };
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("synthetic worker uses unchanged restore contracts", () => {
  it("restores pinned bytes through the existing hook and retains the frozen local snapshot", async () => {
    expect(await work("restore", config)).toMatchObject({ status: "SYNTHETIC_RESTORE_CAPTURED", validation: "PENDING_ACTUAL_CLEANUP" });
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ domain: "ops", sourceConfig: config.sourceConfig, dockerNetwork: "owned-internal-network", afterArchive: expect.any(Function) }));
    expect(readFileSync(resolve(config.tempDir, "snapshot.dump"))).toEqual(archive);
    expect(JSON.parse(readFileSync(resolve(config.artifactDir, "pinned-input.json")))).toEqual({ sha256: mocks.pins["synthetic.dump"], syntheticOnly: true });
    expect(mocks.pinned).toHaveBeenCalledTimes(2);
    expect(mocks.database.mock.calls[0][0].database).toBe(config.scratchName);
    const query = vi.fn(); await mocks.database.mock.calls[0][1]({ query });
    expect(query).toHaveBeenCalledWith("CREATE EXTENSION vector VERSION '0.8.2'");
  });
  it("does not turn a restore/structure guard failure into a successful capture", async () => {
    mocks.run.mockRejectedValue(Object.assign(new Error("guard"), { code: "SCHEMA_REPRESENTATION_UNPROVEN" }));
    await expect(work("restore", config)).rejects.toMatchObject({ code: "SCHEMA_REPRESENTATION_UNPROVEN" });
    expect(mocks.database).not.toHaveBeenCalled();
  });
  it("fails if the replacement bytes no longer match the pin", async () => {
    writeFileSync(resolve(root, "synthetic.dump"), "changed");
    await expect(work("restore", config)).rejects.toThrow("RESTORE_INPUT_NOT_PINNED");
  });
  it.each(["host", "database", "user", "sslmode"])("rejects non-fixture source %s before runner invocation", async field => {
    config.sourceConfig[field] = "production";
    await expect(work("restore", config)).rejects.toThrow("NON_SYNTHETIC_SOURCE_REJECTED");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("uses the unchanged scratch cleanup and exact expected identity", async () => {
    mocks.cleanup.mockResolvedValue({ scratchDatabase: { dropped: true } });
    expect(await work("cleanup", config)).toMatchObject({ scratchDatabase: { dropped: true } });
    expect(mocks.cleanup).toHaveBeenCalledWith({ ...config, expectedScratchName: config.scratchName });
  });
  it("rejects non-owned scratch names without creating or cleaning", async () => {
    config.scratchName = "corgtex";
    await expect(work("cleanup", config)).rejects.toThrow("SYNTHETIC_SCRATCH_NAME_INVALID");
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it("compares the corpus through the projected baseline reader, without a private receipt shape", async () => {
    const observations = { orderedIds: [2, 1] };
    mocks.baseline.mockReturnValue({ schemaVersion: 1, observations });
    mocks.corpus.mockResolvedValue({ observations, indexesValid: true });
    mocks.database.mockImplementation((_config, run) => run({ query: async () => ({ rowCount: 0, rows: [{ version: 180006, encoding: "UTF8", locale: "en_US.utf8", ctype: "en_US.utf8", provider: "c", recorded: "2.38", actual: "2.38", vector: "0.8.2", tls: true }] }) }));
    expect(await work("corpus", config)).toMatchObject({ status: "SYNTHETIC_CORPUS_MATCHED" });
    expect(mocks.baseline).toHaveBeenCalledWith(root);
  });
});

describe("provider-free client transport uses the unchanged runner probe", () => {
  const localConfig = () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    return { owned: { id, network: `syn-ops-${id}`, container: `syn-source-${id}` }, tempDir: root, artifactDir: root,
      sourceConfig: { dockerHost: `syn-source-${id}`, database: "source", user: "fixture_reader", sslmode: "require" },
      targetAdminConfig: { host: LOCAL_CLIENT_HOST, dockerHost: LOCAL_CLIENT_HOST, database: "source", user: "fixture_reader", password: "synthetic-local-only", sslmode: "verify-full", port: 4567 } };
  };
  it("uses the pinned client's one-query path with local TLS service credentials and the owned network", async () => {
    const cfg = localConfig(), files = { serviceFile: "test-service", passFile: "test-pass" };
    mocks.clientFiles.mockReturnValue(files);
    expect(await work("transport", cfg)).toEqual({ status: "LOCAL_CLIENT_QUERY_CLOSED", providerEffects: 0 });
    expect(mocks.clientFiles).toHaveBeenCalledWith(root, cfg.sourceConfig, cfg.targetAdminConfig, expect.any(Function));
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith({ tempDir: root, clientFiles: files, network: cfg.owned.network, artifactDir: root });
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.database).not.toHaveBeenCalled();
  });
  it.each(["host", "dockerHost", "database", "user", "sslmode"])("rejects a widened local transport %s before spawning a client", async field => {
    const cfg = localConfig(); cfg.targetAdminConfig[field] = field.includes("Host") || field === "host" ? HOST : "wrong";
    await expect(work("transport", cfg)).rejects.toThrow("LOCAL_CLIENT_CONFIG_MISMATCH");
    expect(mocks.clientFiles).not.toHaveBeenCalled(); expect(mocks.probe).not.toHaveBeenCalled();
  });
  it("propagates a real client transport failure instead of declaring preparation ready", async () => {
    mocks.probe.mockRejectedValueOnce(new Error("TARGET_CLIENT_CONNECTION_PROBE_FAILED"));
    await expect(work("transport", localConfig())).rejects.toThrow("TARGET_CLIENT_CONNECTION_PROBE_FAILED");
  });
});
