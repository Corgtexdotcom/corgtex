import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function run(directory, runtime) {
  const config = join(directory, "config.json");
  writeFileSync(config, JSON.stringify({ runtime }), { mode: 0o600 });
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/migration/core-lead-transfer-cli.ts",
    "prepare", config, join(directory, "bundle.json")], {
    cwd: resolve("."), encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, TRANSFER_SOURCE_DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/source",
      TRANSFER_TARGET_DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/target" },
  });
  expect(result.status).toBe(1);
  return result.stderr.trim();
}
describe("private lead transfer CLI preflight", () => {
  it.each([undefined, {}, { source: {} }, { target: {} }, { source: {}, target: {}, unexpected: {} }])(
    "requires both exact runtime entries before health or database connections (%j)", (runtime) => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "core-lead-cli-")));
      try { expect(run(directory, runtime)).toBe("EXACT_SOURCE_AND_TARGET_RUNTIME_REQUIRED"); }
      finally { rmSync(directory, { recursive: true }); }
    });
  it("rejects a repository directory whose name starts with two dots", () => {
    const directory = resolve(`..core-lead-cli-${process.pid}`);
    mkdirSync(directory, { mode: 0o700 });
    try { expect(run(directory, {})).toBe("PRIVATE_DIRECTORY_OUTSIDE_REPOSITORY_REQUIRED"); }
    finally { rmSync(directory, { recursive: true }); }
  });
});
