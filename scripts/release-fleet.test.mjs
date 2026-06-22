import { describe, expect, it, vi } from "vitest";

import { buildWorkflowInputs, runFleetReleaseDispatch } from "./release-fleet.mjs";

const SHA = "c9077ff031e8e672923c84d52eeef862368f3493";

describe("release fleet command", () => {
  it("defaults to latest-stable and all target groups", () => {
    expect(buildWorkflowInputs(["--reason", "Ship latest stable."])).toMatchObject({
      release: "latest-stable",
      targets: "railway-customers,azure-selfserve,ops,backup-app",
      reason: "Ship latest stable.",
      dryRun: false,
      concurrency: 2,
      forceAfterFailure: false,
      watch: true,
      ref: "main",
    });
  });

  it("validates explicit SHA and target groups", () => {
    expect(buildWorkflowInputs([
      "--release",
      SHA,
      "--targets",
      "ops,backup-app",
      "--dry-run",
      "--reason",
      "Plan release.",
      "--no-watch",
    ])).toMatchObject({
      release: SHA,
      targets: "ops,backup-app",
      dryRun: true,
      watch: false,
    });
  });

  it("dispatches the fleet release workflow through GitHub Actions", () => {
    const runCommand = vi.fn()
      .mockReturnValueOnce({ stdout: "", stderr: "" })
      .mockReturnValueOnce({ stdout: JSON.stringify([{ databaseId: 123, url: "https://github.test/run/123" }]), stderr: "" })
      .mockReturnValueOnce({ stdout: "", stderr: "" });

    runFleetReleaseDispatch(["--release", SHA, "--reason", "Deploy latest."], { runCommand });

    expect(runCommand).toHaveBeenNthCalledWith(1, "gh", expect.arrayContaining([
      "workflow",
      "run",
      "fleet-release.yml",
      "-f",
      `release=${SHA}`,
    ]));
    expect(runCommand).toHaveBeenNthCalledWith(3, "gh", ["run", "watch", "123", "--exit-status"], { stdio: "inherit" });
  });
});
