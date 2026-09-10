import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { archiveDigest, convertSourceCopy } from "./shared-tenant-source-copy.ts";

const container = "a".repeat(64);
let directory;
let calls;
function commands({ stopFails = false, removeFails = false, exists = true, stopHangs = false } = {}) {
  mocks.spawn.mockImplementation((program, args) => {
    expect(program).toBe("docker"); calls.push(args);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = vi.fn((signal) => { if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", 137)); return true; });
    queueMicrotask(() => {
      if (args[0] === "stop" && stopHangs) return;
      const output = args[0] === "run" ? container : args[0] === "ps" && exists ? container : "";
      if (output) child.stdout.emit("data", Buffer.from(output));
      // Invalid port forces a primary conversion failure before any DB connection.
      const failed = args[0] === "stop" && stopFails || args[0] === "rm" && removeFails;
      if (failed) child.stderr.emit("data", Buffer.from("synthetic-private-provider-diagnostic"));
      child.emit("close", failed ? 1 : 0);
    });
    return child;
  });
}
async function convert(timeoutMs = 5000) {
  const archive = join(directory, "source.dump"); writeFileSync(archive, "synthetic", { mode: 0o600 });
  return convertSourceCopy({ archive, archiveSha256: await archiveDigest(archive), maxBytes: 1000, timeoutMs,
    convertedArchive: join(directory, "output.dump") });
}
describe("isolated copy cleanup", () => {
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "transfer-cleanup-")); calls = []; });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });

  it("keeps the primary failure when normal stop succeeds", async () => {
    commands();
    await expect(convert()).rejects.toThrow(/^TRANSFER_ISOLATED_PORT_INVALID$/);
    expect(calls.at(-1)).toEqual(["stop", "--time", "10", container]);
  });
  it("falls back to exact owned forced removal and preserves the primary failure", async () => {
    commands({ stopFails: true });
    await expect(convert()).rejects.toThrow(/^TRANSFER_ISOLATED_PORT_INVALID$/);
    expect(calls.at(-1)).toEqual(["rm", "--force", container]);
  });
  it("reports the exact remediation ID and safe primary context if cleanup fails", async () => {
    commands({ stopFails: true, removeFails: true });
    const error = await convert().catch((error) => error);
    expect(error.message).toContain(`TRANSFER_ISOLATED_CLEANUP_FAILED container=${container} primary=TRANSFER_ISOLATED_PORT_INVALID`);
    expect(error.message).toContain(`docker rm --force ${container}`);
    expect(error.message).not.toContain("synthetic-private-provider-diagnostic");
    expect(calls.at(-1)).toEqual(["ps", "--all", "--no-trunc", "--filter", `id=${container}`, "--format", "{{.ID}}"]);
  });
  it("accepts confirmed absence after ambiguous remove failure", async () => {
    commands({ stopFails: true, removeFails: true, exists: false });
    await expect(convert()).rejects.toThrow(/^TRANSFER_ISOLATED_PORT_INVALID$/);
  });
  it("escalates a hung stop and proceeds to forced removal within a bounded time", async () => {
    commands({ stopHangs: true });
    const started = Date.now();
    await expect(convert(10)).rejects.toThrow(/^TRANSFER_ISOLATED_PORT_INVALID$/);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(calls.at(-1)).toEqual(["rm", "--force", container]);
  });
});
