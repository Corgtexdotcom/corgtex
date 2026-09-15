import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Identity input attestation has independent coverage. Keep the entrypoint,
// intent validation, local ownership checks and real temp removal under test.
vi.mock("./qualify-ops-azure-target.mjs", async original => ({ ...await original(), validateEnvironment: vi.fn() }));
import { Azure, validateEnvironment } from "./qualify-ops-azure-target.mjs";
import { main, syntheticIntent } from "./qualify-synthetic-ops.mjs";
import { SyntheticSubprocesses } from "./synthetic-subprocess.mjs";
import { HOST, RESOURCE, ProbeError } from "./probe-ops-azure-target.mjs";
import { LABEL } from "./bootstrap-synthetic-ops.mjs";

let root, env, directory, owned, localCalls;
beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "synthetic-entry-")); directory = resolve(root, "evidence");
  env = { RUNNER_TEMP: root, GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1", SYNTHETIC_TEMP_DIR: resolve(root, "synthetic-ops-12345-1") };
  mkdirSync(directory); mkdirSync(env.SYNTHETIC_TEMP_DIR);
  writeFileSync(resolve(env.SYNTHETIC_TEMP_DIR, "credential"), "dummy-local-only");
  const createdAt = Date.now();
  const lifecycle = { schemaVersion: "1.0.0", kind: "ops-target-qualification", resource: RESOURCE, host: HOST, database: "postgres",
    runId: "12345", runAttempt: "1", initialState: "Stopped", firewallName: "corgtex-target-qualification-12345-1", ipv4: "203.0.113.7",
    createdAt, deadline: createdAt + 3600000, workDeadline: createdAt + 2700000, transitionCapUsd: 5 };
  const id = "12345678-1234-1234-1234-123456789abc";
  owned = { id, network: `syn-ops-${id}`, container: `syn-source-${id}` };
  for (const [file, data] of Object.entries({ "synthetic-intent.json": syntheticIntent(lifecycle), "start-attempt.json": { runId: "12345", runAttempt: "1" }, "local-owner.json": owned })) {
    writeFileSync(resolve(directory, file), JSON.stringify(data));
  }
  localCalls = [];
  let removed = false, networkRemoved = false;
  vi.spyOn(SyntheticSubprocesses.prototype, "run").mockImplementation(async (command, args) => {
    expect(command).toBe("docker"); localCalls.push(args);
    if (args[0] === "ps") return removed ? "" : "owned-container";
    if (args[0] === "inspect") return JSON.stringify([{ Config: { Labels: { [LABEL]: owned.id } } }]);
    if (args[0] === "rm") { removed = true; return ""; }
    if (args[0] === "network" && args[1] === "ls") return networkRemoved ? "" : JSON.stringify({ ID: "owned-network" });
    if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([{ Labels: { [LABEL]: owned.id }, Name: owned.network, Containers: {} }]);
    if (args[0] === "network" && args[1] === "rm") { networkRemoved = true; return ""; }
    throw new Error("unexpected local command");
  });
  vi.spyOn(Azure.prototype, "identity").mockResolvedValue();
  vi.spyOn(Azure.prototype, "boundary").mockResolvedValue();
  vi.spyOn(Azure.prototype, "server").mockResolvedValue({});
  vi.spyOn(Azure.prototype, "rules").mockResolvedValue([]);
  for (const method of ["start", "stop", "createRule", "deleteRule", "call"]) {
    vi.spyOn(Azure.prototype, method).mockRejectedValue(new Error("provider write must never run"));
  }
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("cleanup entrypoint after START and failed provider preflight", () => {
  it.each(["AZURE_ACCOUNT_SHOW_FAILED", "TARGET_DRIFT"])("retains %s and removes only owned local resources/temp without provider writes", async code => {
    if (code === "AZURE_ACCOUNT_SHOW_FAILED") Azure.prototype.identity.mockRejectedValue(new ProbeError(code));
    await expect(main(["cleanup", directory], env)).rejects.toMatchObject({ code });
    expect(validateEnvironment).toHaveBeenCalledWith(env, false);
    expect(localCalls).toContainEqual(["rm", "-f", "-v", "owned-container"]);
    expect(localCalls).toContainEqual(["network", "rm", "owned-network"]);
    expect(existsSync(env.SYNTHETIC_TEMP_DIR)).toBe(false);
    expect(JSON.parse(readFileSync(resolve(directory, "local-owner.json")))).toEqual(owned);
    expect(existsSync(resolve(directory, "synthetic-intent.json"))).toBe(true);
    expect(existsSync(resolve(directory, "cleanup.json"))).toBe(false);
    for (const method of ["start", "stop", "createRule", "deleteRule", "call"]) expect(Azure.prototype[method]).not.toHaveBeenCalled();
  });
  it("retains the provider failure even when local ownership drift blocks removal", async () => {
    owned.id = "different-owner";
    Azure.prototype.identity.mockRejectedValue(new ProbeError("AZURE_ACCOUNT_SHOW_FAILED"));
    await expect(main(["cleanup", directory], env)).rejects.toMatchObject({ code: "AZURE_ACCOUNT_SHOW_FAILED" });
    expect(localCalls.some(args => args[0] === "rm")).toBe(false);
    expect(existsSync(env.SYNTHETIC_TEMP_DIR)).toBe(false);
    expect(existsSync(resolve(directory, "cleanup.json"))).toBe(false);
  });
  it("also removes temp after local cleanup fails before START, without any provider call", async () => {
    rmSync(resolve(directory, "start-attempt.json")); owned.id = "different-owner";
    await expect(main(["cleanup", directory], env)).rejects.toMatchObject({ code: "FIXTURE_CLEANUP_OWNER_MISMATCH" });
    expect(existsSync(env.SYNTHETIC_TEMP_DIR)).toBe(false);
    expect(Azure.prototype.identity).not.toHaveBeenCalled();
  });
});
