import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: execFileMock,
}));

describe("customer deployment bootstrap runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockImplementation((
      _command: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null) => void,
    ) => {
      callback(null);
      return undefined;
    });
  });

  it("runs the stable client seed through the repository-pinned TSX runtime", async () => {
    const { runStableClientSeed } = await import("./bootstrap-runner");
    const config = { envPrefix: "VALIDATION" };

    await runStableClientSeed(config, { VALIDATION_FLAG: "true" });

    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(process.cwd(), "scripts", "seed-client-stable.mjs"),
      ],
      expect.objectContaining({
        cwd: process.cwd(),
        env: expect.objectContaining({
          VALIDATION_FLAG: "true",
          CLIENT_SEED_CONFIG_JSON: JSON.stringify(config),
        }),
        timeout: 120_000,
        windowsHide: true,
      }),
      expect.any(Function),
    );
  });

  it("plain Node plus the pinned TSX runtime reaches seed configuration validation", async () => {
    const { stableClientSeedCommand } = await import("./bootstrap-runner");
    const seed = stableClientSeedCommand(process.cwd());
    const result = spawnSync(seed.command, seed.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLIENT_SEED_CONFIG_JSON: "",
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status).toBe(1);
    expect(output).toContain("CLIENT_SEED_CONFIG_JSON environment variable is required");
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension/i);
  });
});
